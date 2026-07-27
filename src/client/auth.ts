/**
 * Passkey gate.
 *
 * Being on the tailnet only means you can reach the box; it should not mean you get a root
 * shell. So once a passkey is enrolled, the app stays locked behind a WebAuthn assertion
 * (phone biometrics) and the bearer token alone no longer opens it.
 */
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

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
	const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", {
		label,
	});
	const response = await startRegistration({ optionsJSON: options });
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
			overlay.append(card);
			document.body.append(overlay);
			// Conditional/one-tap flows are unreliable across Android versions, so we make
			// the user tap once — which also satisfies the user-gesture requirement.
			if (state.supported) button.focus();
		})();
	});
}
