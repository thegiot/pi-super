/**
 * Dictation: the composer's microphone.
 *
 * Same realtime session as a voice call (`POST /api/voice/offer`, credential stays on the
 * server), but with `?mode=dictation` the model is instructed to be a microphone and say
 * nothing. We keep only the transcript of what *the user* said and stream it into the
 * textarea as they speak; the model's own audio is never attached to anything.
 *
 * Two habits of the backend shape this code:
 *  - it interjects anyway, now and then, and an interjection splits the user's speech into
 *    two turns. So we accumulate across turns and end only when the user taps stop —
 *    a split then makes no difference to what lands in the box.
 *  - it still tries to delegate and still generates a reply. Both are simply not wired to
 *    anything here.
 */

export type DictateState = "idle" | "connecting" | "listening";

export interface DictateApi {
	readonly state: DictateState;
	/** whether the server has a realtime backend we can dictate through */
	available(): Promise<boolean>;
	/** start if idle, stop if not; `target` is the pane whose jargon primes the session */
	toggle(target?: string): void;
	stop(): void;
	onState?: (state: DictateState, detail?: string) => void;
	/** fires once the mic is open, before any text — the moment to pin an insertion point */
	onStart?: () => void;
	/** the whole transcript so far, not a delta */
	onText?: (text: string) => void;
}

/** A forgotten open mic is worse than a truncated sentence. */
const MAX_MS = 120_000;

export function createDictation(): DictateApi {
	let pc: RTCPeerConnection | undefined;
	let dc: RTCDataChannel | undefined;
	let mic: MediaStream | undefined;
	let state: DictateState = "idle";
	let text = "";
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	/** bumped by stop(); an in-flight start() checks it and bails out */
	let generation = 0;
	let availability: Promise<boolean> | undefined;

	const api: DictateApi = {
		get state() {
			return state;
		},
		available,
		toggle,
		stop,
	};

	function setState(next: DictateState, detail?: string): void {
		state = next;
		api.onState?.(next, detail);
	}

	function available(): Promise<boolean> {
		availability ??= fetch("/api/voice/config")
			.then((res) => res.json() as Promise<{ enabled?: boolean; provider?: string }>)
			// `local` is the browser's own recogniser, which is the engine the phone keyboard
			// already uses: offering it as "better dictation" would be a lie.
			.then((cfg) => cfg.enabled === true && (cfg.provider === "codex" || cfg.provider === "openai"))
			.catch(() => false);
		return availability;
	}

	function toggle(target?: string): void {
		if (state === "idle") void start(target);
		else stop();
	}

	async function start(target?: string): Promise<void> {
		const gen = ++generation;
		const stale = () => gen !== generation;
		text = "";
		setState("connecting");
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (stale()) {
				for (const t of stream.getTracks()) t.stop();
				return;
			}
			mic = stream;
			pc = new RTCPeerConnection();
			for (const track of mic.getTracks()) pc.addTrack(track, mic);
			dc = pc.createDataChannel("oai-events");
			dc.onmessage = (ev) => onEvent(JSON.parse(String(ev.data)) as Record<string, unknown>);

			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await iceComplete(pc);

			const query = new URLSearchParams({ mode: "dictation" });
			if (target) query.set("target", target);
			const res = await fetch(`/api/voice/offer?${query}`, {
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
			capTimer = setTimeout(() => stop(), MAX_MS);
			api.onStart?.();
			setState("listening");
		} catch (err) {
			if (stale()) return;
			teardown();
			setState("idle", String((err as Error).message));
		}
	}

	function onEvent(ev: Record<string, unknown>): void {
		switch (ev.type) {
			// gpt-live: the user's words, one fragment at a time. `turn.delta` carries the
			// same fragments *and* the model's own speech, so it must not be used here.
			case "input_transcript.added": {
				append((ev.item as { text?: string } | undefined)?.text ?? "");
				break;
			}
			// standard Realtime API naming
			case "conversation.item.input_audio_transcription.delta":
				append(String(ev.delta ?? ""));
				break;
			case "error":
				setState(state, String((ev.error as { message?: string } | undefined)?.message ?? "dictation error"));
				break;
		}
	}

	function append(fragment: string): void {
		if (!fragment) return;
		text += fragment;
		// fragments arrive with their leading space attached (" pi", "-super"), which would
		// otherwise open the insertion with a stray blank
		api.onText?.(text.replace(/^\s+/, ""));
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
			setTimeout(resolve, 2000);
		});
	}

	function teardown(): void {
		if (capTimer) clearTimeout(capTimer);
		capTimer = undefined;
		if (dc) {
			dc.onmessage = null;
			dc.close();
			dc = undefined;
		}
		if (pc) {
			pc.close();
			pc = undefined;
		}
		// the mic indicator has to go out the moment dictation ends, or the phone looks bugged
		for (const t of mic?.getTracks() ?? []) t.stop();
		mic = undefined;
	}

	function stop(): void {
		generation++;
		teardown();
		if (state !== "idle") setState("idle");
	}

	return api;
}
