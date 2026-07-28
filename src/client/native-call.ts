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
	| { type: "disconnect"; callId: string }
	| { type: "audioRoute"; callId: string; route: string; routes: string[]; muted: boolean };

/**
 * How long we wait for the OS to admit the call before dialling anyway. Deliberately
 * longer than the native side's own Telecom watchdog (CallHub.TELECOM_TIMEOUT_MS): if we
 * gave up first we would open the microphone while the fallback was still claiming the
 * audio route, which is the exact ordering this whole app exists to get right.
 */
const READY_TIMEOUT_MS = 6000;

const bridge = (window as unknown as { PiNative?: NativeBridge }).PiNative;

let callId: string | undefined;
let waiting: (() => void) | undefined;
let mode: "telecom" | "audiofocus" | undefined;

export interface NativeCallApi {
	readonly available: boolean;
	/** what the OS gave us, once a call is up: a real Telecom call, or bare audio focus */
	readonly mode: "telecom" | "audiofocus" | undefined;
	/**
	 * Open the native call and resolve with its token once the OS admitted it. The token
	 * scopes everything else: a dial that was abandoned while it waited must not be able to
	 * hang up the call that replaced it.
	 */
	begin(): Promise<string | undefined>;
	/** the WebRTC session is up — promote the call from "dialing" to "active" */
	active(): void;
	end(token?: string): void;
	setMuted(muted: boolean): void;
	/** speaker | earpiece | bluetooth | wired — Telecom mode only, best effort */
	setRoute(route: string): void;
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
	setRoute,
};

function send(msg: Record<string, unknown>): void {
	if (!bridge) return;
	bridge.postMessage(JSON.stringify(msg));
}

function begin(): Promise<string | undefined> {
	if (!nativeCall.available) return Promise.resolve(undefined);
	if (callId) return Promise.resolve(callId); // a reconnect inside the same call
	const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	callId = id;
	send({ type: "startCall", callId: id });
	// Don't let a wedged OS stop the user from talking: if it says nothing, dial anyway and
	// live with media-style audio.
	return new Promise((resolve) => {
		const done = () => {
			waiting = undefined;
			clearTimeout(timer);
			resolve(id);
		};
		const timer = setTimeout(done, READY_TIMEOUT_MS);
		waiting = done;
	});
}

function active(): void {
	if (callId) send({ type: "markActive", callId });
}

function end(token?: string): void {
	if (!callId || (token && token !== callId)) return;
	send({ type: "endCall", callId });
	callId = undefined;
	mode = undefined;
	waiting?.();
}

function setMuted(muted: boolean): void {
	if (callId) send({ type: "setMuted", callId, muted });
}

function setRoute(route: string): void {
	if (callId) send({ type: "setRoute", callId, route });
}

if (nativeCall.available) {
	window.addEventListener("pi-native", (ev) => {
		const detail = (ev as CustomEvent<NativeEvent>).detail;
		// Every event is call-scoped: one left over from a call that has already ended must
		// not stop, mute or re-route the call that replaced it.
		if (!detail || !callId || detail.callId !== callId) return;
		switch (detail.type) {
			case "callReady":
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
