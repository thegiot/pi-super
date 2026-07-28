/**
 * The Android wrapper's native call bridge (see `android/`).
 *
 * In the wrapper, voice mode is wrapped in a real self-managed Telecom call, which is what
 * makes a car kit route it over HFP, other apps' music stop rather than duck, and the
 * headset hang-up button reach us. In plain Chrome none of this exists and every method
 * here is a no-op, so voice.ts can call it unconditionally.
 */

interface NativeBridge {
	postMessage(message: string): void;
}

type NativeEvent =
	| { type: "callReady"; callId: string; mode: "telecom" | "audiofocus"; reason?: string }
	| { type: "disconnect" }
	| { type: "audioRoute"; route: string; routes: string[]; muted: boolean };

/** how long we wait for the OS to admit the call before dialling anyway */
const READY_TIMEOUT_MS = 3000;

const bridge = (window as unknown as { PiNative?: NativeBridge }).PiNative;

let callId: string | undefined;
let waiting: (() => void) | undefined;
let mode: "telecom" | "audiofocus" | undefined;

export interface NativeCallApi {
	readonly available: boolean;
	/** what the OS gave us, once a call is up: a real Telecom call, or bare audio focus */
	readonly mode: "telecom" | "audiofocus" | undefined;
	begin(): Promise<void>;
	/** the WebRTC session is up — promote the call from "dialing" to "active" */
	active(): void;
	end(): void;
	setMuted(muted: boolean): void;
	/** hang-up that came from the OS: headset button, car, notification, a real phone call */
	onDisconnect?: () => void;
	onRoute?: (route: string, routes: string[], muted: boolean) => void;
	/** the fallback reason, when the OS would not give us a Telecom call */
	onNotice?: (text: string) => void;
}

export const nativeCall: NativeCallApi = {
	available: typeof bridge?.postMessage === "function",
	get mode() {
		return mode;
	},
	begin,
	active,
	end,
	setMuted,
};

function send(msg: Record<string, unknown>): void {
	if (!bridge) return;
	bridge.postMessage(JSON.stringify(msg));
}

function begin(): Promise<void> {
	if (!nativeCall.available) return Promise.resolve();
	if (callId) return Promise.resolve(); // a reconnect inside the same call
	callId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	send({ type: "startCall", callId });
	// Don't let a wedged Telecom stop the user from talking: if the OS says nothing, dial
	// anyway and live with media-style audio.
	return new Promise((resolve) => {
		const done = () => {
			waiting = undefined;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(done, READY_TIMEOUT_MS);
		waiting = done;
	});
}

function active(): void {
	if (callId) send({ type: "markActive", callId });
}

function end(): void {
	if (!callId) return;
	send({ type: "endCall", callId });
	callId = undefined;
	mode = undefined;
	waiting?.();
}

function setMuted(muted: boolean): void {
	if (callId) send({ type: "setMuted", callId, muted });
}

if (nativeCall.available) {
	window.addEventListener("pi-native", (ev) => {
		const detail = (ev as CustomEvent<NativeEvent>).detail;
		if (!detail) return;
		switch (detail.type) {
			case "callReady":
				// a late admission for a call the user already hung up on
				if (!callId || (detail.callId && detail.callId !== callId)) break;
				mode = detail.mode;
				if (detail.reason) nativeCall.onNotice?.(`call: ${detail.mode} (${detail.reason})`);
				waiting?.();
				break;
			case "disconnect":
				callId = undefined;
				mode = undefined;
				waiting?.();
				nativeCall.onDisconnect?.();
				break;
			case "audioRoute":
				nativeCall.onRoute?.(detail.route, detail.routes, detail.muted);
				break;
		}
	});
}
