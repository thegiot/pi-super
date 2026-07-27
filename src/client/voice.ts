/**
 * Voice mode: a WebRTC call with a realtime speech model that delegates all real work
 * to the meta agent ("eco" pattern — the voice model never touches the machine).
 *
 * Two backends, same shape:
 *  - codex : ChatGPT/Codex realtime (gpt-live). Work is handed over by the server-side
 *            `delegation.created` event; progress goes back with `delegation.context.append`.
 *  - openai: standard Realtime API. Work arrives as an `ask_super` function call; progress
 *            is injected as conversation items.
 * Either way the credential stays on the server: we POST our SDP offer to pi-super, which
 * attaches auth + instructions and returns the answer.
 *
 * If the server has no realtime credential, we fall back to `local`: the browser's own
 * speech recognition + synthesis driving the meta agent directly. Half duplex (it stops
 * listening while it talks) and no barge-in, but it needs no API key and works on Android
 * Chrome today.
 */

import type { MetaApi } from "./meta.js";

export interface VoiceConfig {
	enabled: boolean;
	meta?: boolean;
	provider: "codex" | "openai" | "none" | "local";
	model: string;
	voice: string;
	delegation: "codex" | "tool";
}

export type VoiceState = "idle" | "connecting" | "live" | "error";

export interface VoiceApi {
	config: VoiceConfig | undefined;
	readonly state: VoiceState;
	start(): Promise<void>;
	stop(): void;
	toggleMute(): boolean;
	/** feed a spoken update from the meta agent into the live call */
	pushUpdate(text: string, kind: string): void;
	onState?: (state: VoiceState, detail?: string) => void;
	onTranscript?: (role: "user" | "assistant", text: string) => void;
	/** every realtime event, in and out — used by the e2e harness and by ?debug=1 */
	onEvent?: (direction: "in" | "out", ev: Record<string, unknown>) => void;
	/** the remote audio element, once the call is up (lets a test tap the stream) */
	readonly remoteAudio: HTMLAudioElement | undefined;
}

const MAX_CHUNK_BYTES = 400;

interface SpeechRecognitionEventLike {
	resultIndex: number;
	results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }>;
}

interface SpeechRecognitionLike {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
	onerror: ((ev: { error?: string }) => void) | null;
	onend: (() => void) | null;
	onstart: (() => void) | null;
	start(): void;
	stop(): void;
}

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
	const w = window as unknown as Record<string, new () => SpeechRecognitionLike>;
	return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Split into UTF-8-safe chunks the realtime backend will accept. */
function chunk(text: string): string[] {
	const words = text.split(/(\s+)/);
	const out: string[] = [];
	let cur = "";
	for (const w of words) {
		if (new TextEncoder().encode(cur + w).length > MAX_CHUNK_BYTES && cur) {
			out.push(cur);
			cur = w.trimStart();
		} else {
			cur += w;
		}
	}
	if (cur.trim()) out.push(cur);
	return out;
}

export function createVoice(meta: MetaApi): VoiceApi {
	let pc: RTCPeerConnection | undefined;
	let dc: RTCDataChannel | undefined;
	let mic: MediaStream | undefined;
	let audio: HTMLAudioElement | undefined;
	let wakeLock: { release(): Promise<void> } | undefined;
	let delegationId: string | undefined;
	let muted = false;
	let state: VoiceState = "idle";
	let assistantLine = "";
	let assistantFlush: ReturnType<typeof setTimeout> | undefined;
	let recognition: SpeechRecognitionLike | undefined;
	let speaking = false;
	let listening = false;
	/** bumped by stop(); an in-flight start() checks it and aborts */
	let generation = 0;

	const api: VoiceApi = {
		config: undefined,
		get state() {
			return state;
		},
		get remoteAudio() {
			return audio;
		},
		start,
		stop,
		toggleMute,
		pushUpdate,
	};

	function setState(next: VoiceState, detail?: string): void {
		state = next;
		api.onState?.(next, detail);
	}

	function sendEvent(ev: Record<string, unknown>): void {
		if (dc?.readyState !== "open") return;
		dc.send(JSON.stringify(ev));
		api.onEvent?.("out", ev);
	}

	async function loadConfig(): Promise<VoiceConfig> {
		if (api.config) return api.config;
		const cfg = (await (await fetch("/api/voice/config")).json()) as VoiceConfig;
		// no meta agent => nothing to delegate to, so no fallback either
		if (!cfg.enabled && cfg.meta !== false && speechRecognitionCtor()) {
			cfg.provider = "local";
			cfg.enabled = true;
			cfg.delegation = "tool";
		}
		api.config = cfg;
		return cfg;
	}

	async function start(): Promise<void> {
		if (state === "connecting" || state === "live") return;
		const gen = ++generation;
		const stale = () => gen !== generation;
		setState("connecting");
		try {
			const cfg = await loadConfig();
			if (!cfg.enabled) throw new Error("voice not configured on the server");
			if (cfg.provider === "local") {
				startLocal();
				return;
			}

			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (stale()) {
				for (const t of stream.getTracks()) t.stop();
				return;
			}
			mic = stream;
			pc = new RTCPeerConnection();
			pc.oniceconnectionstatechange = () => {
				if (pc && ["failed", "disconnected", "closed"].includes(pc.iceConnectionState) && state === "live") {
					setState("error", `connection ${pc.iceConnectionState}`);
					stop();
				}
			};
			pc.ontrack = (ev) => {
				if (!audio) {
					audio = document.createElement("audio");
					audio.autoplay = true;
					audio.setAttribute("playsinline", "");
					document.body.append(audio);
				}
				audio.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
				void audio.play().catch(() => {});
			};
			// addTrack already creates the sendrecv audio transceiver — adding another
			// would put a second m-line in the offer.
			for (const track of mic.getTracks()) pc.addTrack(track, mic);

			dc = pc.createDataChannel("oai-events");
			dc.onmessage = (ev) => {
				const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
				api.onEvent?.("in", msg);
				onEvent(msg);
			};

			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await iceComplete(pc);

			const res = await fetch("/api/voice/offer", {
				method: "POST",
				headers: { "content-type": "application/sdp" },
				body: pc.localDescription?.sdp ?? offer.sdp ?? "",
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
				throw new Error(err.error ?? `offer rejected (${res.status})`);
			}
			const answer = await res.text();
			if (stale()) return;
			await pc.setRemoteDescription({ type: "answer", sdp: answer });
			if (stale()) {
				stop();
				return;
			}

			await keepAwake();
			setState("live");
		} catch (err) {
			if (stale()) return;
			setState("error", String((err as Error).message));
			stop();
		}
	}

	function iceComplete(peer: RTCPeerConnection): Promise<void> {
		if (peer.iceGatheringState === "complete") return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				if (peer.iceGatheringState === "complete") {
					peer.removeEventListener("icegatheringstatechange", done);
					resolve();
				}
			};
			peer.addEventListener("icegatheringstatechange", done);
			// don't wait forever for a straggling relay candidate
			setTimeout(resolve, 2000);
		});
	}

	async function keepAwake(): Promise<void> {
		try {
			wakeLock = await (
				navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }
			).wakeLock?.request("screen");
		} catch {
			/* not fatal */
		}
		if ("mediaSession" in navigator) {
			navigator.mediaSession.metadata = new MediaMetadata({ title: "super", artist: "pi-super" });
			navigator.mediaSession.setActionHandler("stop", () => stop());
		}
	}

	// ------------------------------------------------------------- local fallback

	function startLocal(): void {
		const Ctor = speechRecognitionCtor();
		if (!Ctor) throw new Error("this browser has no speech recognition");
		const recog = new Ctor();
		recog.continuous = true;
		recog.interimResults = true;
		recog.lang = navigator.language || "en-US";
		recog.onresult = (ev: SpeechRecognitionEventLike) => {
			for (let i = ev.resultIndex; i < ev.results.length; i++) {
				const result = ev.results[i];
				if (!result?.isFinal) continue;
				const text = result[0]?.transcript?.trim();
				if (!text) continue;
				api.onTranscript?.("user", text);
				meta.send(text);
			}
		};
		recog.onerror = (ev: { error?: string }) => {
			if (ev.error === "no-speech" || ev.error === "aborted") return;
			setState("error", `speech: ${ev.error ?? "unknown"}`);
			stop();
		};
		// Chrome ends recognition on its own every so often; keep it alive.
		recog.onend = () => {
			listening = false;
			if (state === "live" && !speaking && !muted) {
				try {
					recog.start();
				} catch {
					/* already starting */
				}
			}
		};
		recog.onstart = () => {
			listening = true;
		};
		recognition = recog;
		recog.start();
		void keepAwake();
		setState("live");
	}

	function speakLocal(text: string): void {
		speaking = true;
		try {
			recognition?.stop();
		} catch {
			/* ignore */
		}
		const utter = new SpeechSynthesisUtterance(text);
		utter.lang = navigator.language || "en-US";
		const resume = () => {
			// more queued utterances: stay in "speaking" until the queue drains
			if (speechSynthesis.speaking || speechSynthesis.pending) return;
			speaking = false;
			if (state !== "live" || muted || listening) return;
			try {
				recognition?.start();
			} catch {
				/* already running */
			}
		};
		utter.onend = resume;
		utter.onerror = resume;
		api.onTranscript?.("assistant", text);
		speechSynthesis.speak(utter);
	}

	function stop(): void {
		generation++;
		muted = false;
		listening = false;
		if (recognition) {
			recognition.onend = null;
			try {
				recognition.stop();
			} catch {
				/* ignore */
			}
			recognition = undefined;
		}
		speaking = false;
		if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
		dc?.close();
		dc = undefined;
		pc?.close();
		pc = undefined;
		for (const t of mic?.getTracks() ?? []) t.stop();
		mic = undefined;
		if (audio) audio.srcObject = null;
		void wakeLock?.release().catch(() => {});
		wakeLock = undefined;
		delegationId = undefined;
		if (state !== "error") setState("idle");
	}

	function toggleMute(): boolean {
		if (api.config?.provider === "local") {
			muted = !muted;
			try {
				if (muted) recognition?.stop();
				else if (!speaking) recognition?.start();
			} catch {
				/* transitional state; onend will settle it */
			}
			return muted;
		}
		const track = mic?.getAudioTracks()[0];
		if (!track) return false;
		track.enabled = !track.enabled;
		return !track.enabled;
	}

	// ------------------------------------------------------------ realtime events

	function onEvent(ev: Record<string, unknown>): void {
		switch (ev.type) {
			// --- codex delegation contract -------------------------------------
			case "delegation.created": {
				const item = ev.item as { id?: string; content?: Array<{ text?: string }> } | undefined;
				const text = (item?.content ?? [])
					.map((c) => c.text ?? "")
					.join(" ")
					.trim();
				delegationId = item?.id;
				// no onTranscript here: turn.done already reported what the user said, and the
				// delegated text is a paraphrase of it
				if (text) meta.send(text);
				break;
			}
			// --- standard realtime function calling ----------------------------
			case "response.output_item.done": {
				const item = ev.item as { type?: string; name?: string; call_id?: string; arguments?: string } | undefined;
				if (item?.type !== "function_call" || item.name !== "ask_super") break;
				let request = "";
				try {
					request = (JSON.parse(item.arguments ?? "{}") as { request?: string }).request ?? "";
				} catch {
					/* ignore */
				}
				if (request) {
					api.onTranscript?.("user", request);
					meta.send(request);
				}
				sendEvent({
					type: "conversation.item.create",
					item: {
						type: "function_call_output",
						call_id: item.call_id,
						output: JSON.stringify({ status: "working", note: "super will report back; do not wait" }),
					},
				});
				sendEvent({ type: "response.create" });
				break;
			}
			// --- transcripts: gpt-live (V3) ------------------------------------
			// Both sides arrive as small fragments in `item.text`; the user's turn is
			// summed up for us in turn.done, the assistant's is not, so we debounce it.
			case "input_transcript.added":
				break; // superseded by turn.done
			case "turn.done": {
				const turn = ev.turn as { role?: string; transcript?: string } | undefined;
				const text = turn?.transcript?.trim();
				if (text && turn?.role === "user") api.onTranscript?.("user", text);
				break;
			}
			case "output_transcript.added": {
				const item = ev.item as { text?: string } | undefined;
				assistantLine += item?.text ?? "";
				if (assistantFlush) clearTimeout(assistantFlush);
				assistantFlush = setTimeout(() => {
					const text = assistantLine.trim();
					assistantLine = "";
					if (text) api.onTranscript?.("assistant", text);
				}, 1200);
				break;
			}
			// --- transcripts: standard Realtime names --------------------------
			case "response.output_audio_transcript.delta":
				assistantLine += String(ev.delta ?? "");
				break;
			case "response.output_audio_transcript.done":
				api.onTranscript?.("assistant", String(ev.transcript ?? assistantLine));
				assistantLine = "";
				break;
			case "conversation.item.input_audio_transcription.completed":
				api.onTranscript?.("user", String(ev.transcript ?? ""));
				break;
			case "error":
				setState("error", JSON.stringify(ev.error ?? ev).slice(0, 200));
				break;
		}
	}

	/** Route a `speak()` from the meta agent into the live call. */
	function pushUpdate(text: string, kind: string): void {
		if (state !== "live" || !text.trim()) return;
		if (api.config?.provider === "local") {
			speakLocal(text);
			return;
		}
		const channel = kind === "status" ? "commentary" : "speakable";
		if (api.config?.delegation === "codex" && delegationId) {
			for (const part of chunk(text)) {
				sendEvent({
					type: "delegation.context.append",
					delegation_item_id: delegationId,
					channel,
					content: [{ type: "input_text", text: part }],
				});
			}
			return;
		}
		sendEvent({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "system",
				content: [{ type: "input_text", text: `Update from super, relay it to the user: ${text}` }],
			},
		});
		sendEvent({ type: "response.create" });
	}

	return api;
}
