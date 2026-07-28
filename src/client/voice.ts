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
	/**
	 * `clearError` marks an explicit hang-up: a failed dial deliberately *keeps* the error
	 * state so it stays on screen, but then only the user pressing hang up can retire it.
	 */
	stop(opts?: { clearError?: boolean }): void;
	toggleMute(): boolean;
	/** "stop talking" — an explicit interruption, never guessed from VAD */
	hush(): void;
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
/** how long ICE may sit in `disconnected` before we call it a dropped call */
const DISCONNECT_GRACE_MS = 6000;
/** redial attempts before we hang up for real */
const MAX_RECONNECT = 5;
/** an error arriving this soon after a hush is our own cancel bouncing, not a call fault */
const HUSH_ERROR_WINDOW_MS = 1500;

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
	let reconnectAttempts = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let hushedAt = 0;

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
		hush,
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
		reconnectAttempts = 0;
		await connect();
	}

	/** One dial attempt. `start()` owns the entry guard; reconnects re-enter here. */
	async function connect(): Promise<void> {
		const gen = ++generation;
		const stale = () => gen !== generation;
		setState("connecting", reconnectAttempts ? `reconnecting (${reconnectAttempts}/${MAX_RECONNECT})` : undefined);
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
				if (!pc || stale()) return;
				const ice = pc.iceConnectionState;
				if (ice === "connected" || ice === "completed") {
					clearGrace();
					reconnectAttempts = 0;
					return;
				}
				// `disconnected` is usually a passing blip — a tunnel, a wifi/5G handover. Let
				// ICE try to heal itself before we tear a working call down.
				if (ice === "disconnected") {
					if (!graceTimer) {
						graceTimer = setTimeout(() => {
							graceTimer = undefined;
							if (pc && !stale() && pc.iceConnectionState === "disconnected") scheduleReconnect("connection lost");
						}, DISCONNECT_GRACE_MS);
					}
					return;
				}
				if (ice === "failed") {
					clearGrace();
					scheduleReconnect("connection failed");
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
			// Mid-reconnect we keep trying: the mic may simply be held by a real phone call,
			// and getUserMedia will start working again the moment that call ends.
			if (reconnectAttempts > 0) {
				scheduleReconnect(String((err as Error).message));
				return;
			}
			setState("error", String((err as Error).message));
			stop();
		}
	}

	function clearGrace(): void {
		if (graceTimer) clearTimeout(graceTimer);
		graceTimer = undefined;
	}

	/**
	 * Drop the transport and redial after a backoff. The meta agent lives on the server and
	 * is untouched by this, so super keeps its memory across the blip; only the speech
	 * model's own short-term context is lost.
	 */
	function scheduleReconnect(reason: string): void {
		if (reconnectTimer) return;
		if (reconnectAttempts >= MAX_RECONNECT) {
			setState("error", reason);
			stop();
			return;
		}
		const gen = generation;
		const wait = Math.min(1000 * 2 ** reconnectAttempts, 8000);
		reconnectAttempts++;
		teardown();
		setState("connecting", `reconnecting (${reconnectAttempts}/${MAX_RECONNECT})`);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			if (gen !== generation) return; // hung up or restarted while we waited
			void connect();
		}, wait);
	}

	/**
	 * "Stop talking." Deliberate and user-initiated only — we never cancel the model on our
	 * own guess that speech started, because super talking over you is often the right call.
	 */
	function hush(): void {
		if (state !== "live") return;
		hushedAt = Date.now();
		// local mode: cancel() fires the utterance's onend, which resumes listening
		if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
		if (api.config?.provider === "local") return;
		sendEvent({ type: "response.cancel" });
		sendEvent({ type: "output_audio_buffer.clear" });
		// the server stops sending immediately, but a jitter-buffer tail is already local
		if (audio) {
			audio.muted = true;
			setTimeout(() => {
				if (audio) audio.muted = false;
			}, 300);
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
			navigator.mediaSession.playbackState = "playing";
			// A headset / steering-wheel button press arrives as play-pause. Mapping it to
			// "shut up" gives the one interruption that needs no screen at all.
			navigator.mediaSession.setActionHandler("pause", () => hush());
			navigator.mediaSession.setActionHandler("play", () => {
				navigator.mediaSession.playbackState = "playing";
			});
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

	/** Drop the transport but keep the call's identity — used by reconnect and by stop(). */
	function teardown(): void {
		clearGrace();
		listening = false;
		// the mic itself is going away, so nothing is muted any more
		muted = false;
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
		if (dc) {
			dc.onmessage = null;
			dc.close();
			dc = undefined;
		}
		if (pc) {
			// silence the handlers first: closing the peer fires them one last time
			pc.oniceconnectionstatechange = null;
			pc.ontrack = null;
			pc.close();
			pc = undefined;
		}
		for (const t of mic?.getTracks() ?? []) t.stop();
		mic = undefined;
		if (audio) {
			audio.srcObject = null;
			audio.muted = false;
		}
		// a redial is a new realtime session, so the old delegation handle is void
		delegationId = undefined;
	}

	function stop(opts?: { clearError?: boolean }): void {
		generation++;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
		reconnectAttempts = 0;
		teardown();
		// the wake lock spans reconnects, so it is only released on a real hang-up
		void wakeLock?.release().catch(() => {});
		wakeLock = undefined;
		if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
		if (state !== "error" || opts?.clearError) setState("idle");
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
				// Our own hush bouncing back ("no active response", or an event this backend
				// does not know) must not present itself as a broken call.
				if (Date.now() - hushedAt < HUSH_ERROR_WINDOW_MS) break;
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
