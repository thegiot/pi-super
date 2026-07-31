/**
 * Passkey gate.
 *
 * Being on the tailnet only means you can reach the box; it should not mean you get a root
 * shell. So once a passkey is enrolled, the app stays locked behind a WebAuthn assertion
 * (phone biometrics) and the bearer token alone no longer opens it.
 */
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { nativeApp } from "./native-call.js";

export interface AuthState {
	enrolled: boolean;
	required: boolean;
	authenticated: boolean;
	canEnroll: boolean;
	supported: boolean;
	rpID: string;
	session?: { label: string; expiresAt: number };
	credentials: Array<{ id: string; label: string; createdAt: string }>;
}

const api = async <T>(path: string, body?: unknown): Promise<T> => {
	const res = await fetch(path, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `${path}: ${res.status}`);
	return data;
};

export const authState = (): Promise<AuthState> => api<AuthState>("/api/auth/state");

export async function enrollPasskey(label: string): Promise<string> {
	const create = async (anyAuthenticator: boolean) => {
		const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", {
			label,
			anyAuthenticator,
		});
		return startRegistration({ optionsJSON: options });
	};
	let response: Awaited<ReturnType<typeof create>>;
	try {
		response = await create(false); // the device's own authenticator (biometrics)
	} catch (e) {
		// NotAllowedError is the user cancelling — respect it. Anything else (e.g. Xiaomi's
		// NotReadableError from a broken credential manager) gets one retry that lets the
		// user pick any UV-capable authenticator (hybrid/QR, security key).
		if ((e as DOMException).name === "NotAllowedError") throw e;
		response = await create(true);
	}
	const result = await api<{ credential: { label: string } }>("/api/auth/register/verify", { response, label });
	return result.credential.label;
}

export async function loginWithPasskey(): Promise<string> {
	const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/login/options", {});
	const response = await startAuthentication({ optionsJSON: options });
	const result = await api<{ label: string }>("/api/auth/login/verify", { response });
	return result.label;
}

export const logout = (): Promise<unknown> => api("/api/auth/logout", {});

/**
 * Finish an app sign-in that is being done in this browser on the app's behalf.
 *
 * The Android wrapper cannot run the passkey ceremony itself — Credential Manager only
 * lets an app claim an RP ID that Google can crawl, and a tailnet box cannot be crawled —
 * so it opens this page in a real browser with `?handoff=<pkce challenge>`. We mint a
 * one-time code and bounce it back over the app's scheme, where the app redeems it with
 * the verifier only it knows.
 *
 * **This asks, every time, and asks with the passkey.** The challenge in the URL is
 * whatever opened this page, and on Android that is whichever app claimed the `pi-super:`
 * scheme — not necessarily ours. PKCE stops an eavesdropper from stealing an honest app's
 * code; it says nothing about who wrote the challenge. So the only thing standing between
 * a hostile app and a shell is that exporting a session costs a deliberate, named,
 * user-verified approval. Never make this silent.
 */
async function completeHandoff(): Promise<boolean> {
	const challenge = new URLSearchParams(location.search).get("handoff");
	if (!challenge) return false;

	const overlay = document.createElement("div");
	overlay.id = "lock";
	const card = document.createElement("div");
	card.className = "lock-card";
	const title = document.createElement("h1");
	title.textContent = "Sign in the app?";
	const msg = document.createElement("p");
	msg.textContent =
		"An app on this phone is asking for a pi-super session — a session is a shell. Approve only if you just tapped “Unlock in browser” in the pi-super app.";
	const button = document.createElement("button");
	button.className = "primary";
	button.textContent = "Approve with passkey";
	const err = document.createElement("p");
	err.className = "err";
	button.onclick = () => {
		void (async () => {
			button.disabled = true;
			err.textContent = "";
			try {
				// A fresh assertion, even if this browser is already unlocked: the server only
				// mints a handoff for a session minutes old, so approval means a biometric now.
				await loginWithPasskey();
				const { code } = await api<{ code: string }>("/api/auth/handoff", { challenge });
				const url = `pi-super://handoff?code=${encodeURIComponent(code)}`;
				// The passkey ceremony and the fetch can outlive this page's user activation, and a
				// browser may then refuse to leave for a custom scheme without saying so. Offer the
				// tap as well as attempting the jump, or the sign-in dead-ends on “Sent”.
				const link = document.createElement("a");
				link.className = "primary";
				link.id = "handoff-return";
				link.href = url;
				link.textContent = "Return to the pi-super app";
				msg.textContent = "Approved. If the app does not come back by itself, tap below.";
				button.replaceWith(link);
				location.href = url;
			} catch (e) {
				err.textContent = String((e as Error).message);
				button.disabled = false;
			}
		})();
	};
	card.append(title, msg, button, err);
	overlay.append(card);
	document.body.append(overlay);
	return true;
}

/**
 * Blocks the app with a lock screen until a passkey assertion succeeds.
 * Resolves immediately when no passkey is required.
 */
export function gate(): Promise<void> {
	return new Promise((resolve) => {
		void (async () => {
			let state: AuthState;
			try {
				state = await authState();
			} catch {
				resolve(); // server too old / unreachable: let the normal error paths show
				return;
			}
			// The app's errand, and nothing else: this tab does not become a live pi-super.
			if (state.supported && (await completeHandoff())) return;
			if (state.authenticated || !state.required) {
				resolve();
				return;
			}

			const overlay = document.createElement("div");
			overlay.id = "lock";
			const card = document.createElement("div");
			card.className = "lock-card";
			const title = document.createElement("h1");
			title.textContent = "pi-super";
			const msg = document.createElement("p");
			msg.textContent = state.supported
				? "Unlock with your passkey."
				: `WebAuthn needs HTTPS (or localhost) — this page is plain http on ${state.rpID}.`;
			const button = document.createElement("button");
			button.className = "primary";
			button.textContent = "Unlock";
			button.disabled = !state.supported;
			const err = document.createElement("p");
			err.className = "err";

			const attempt = async () => {
				button.disabled = true;
				err.textContent = "";
				try {
					await loginWithPasskey();
					overlay.remove();
					resolve();
				} catch (e) {
					err.textContent = String((e as Error).message);
					button.disabled = false;
				}
			};
			button.onclick = () => void attempt();
			card.append(title, msg, button, err);

			// Inside the Android wrapper the button above cannot work: WebView will not run a
			// passkey ceremony for an RP it cannot prove it owns. Send the user to a browser,
			// which has no such trouble, and take the session back afterwards.
			if (nativeApp.available) {
				msg.textContent = "Signing in needs your browser: Android only lets an app use a passkey for a site Google can reach, and this one is private.";
				button.textContent = "Unlock in browser";
				button.disabled = false;
				button.onclick = () => {
					nativeApp.send({ type: "login" });
					err.textContent = "Finish signing in in the browser; this comes back on its own.";
				};
			}
			overlay.append(card);
			document.body.append(overlay);
			// Conditional/one-tap flows are unreliable across Android versions, so we make
			// the user tap once — which also satisfies the user-gesture requirement.
			if (state.supported) button.focus();
		})();
	});
}
