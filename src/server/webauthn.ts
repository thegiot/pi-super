import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { parseCookies } from "./auth.js";

export const SESSION_COOKIE = "pi_super_sid";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = "pi-super";

export interface StoredCredential {
	id: string; // base64url credential id
	publicKey: string; // base64url COSE public key
	counter: number;
	transports?: string[];
	label: string;
	createdAt: string;
	lastUsedAt?: string;
}

interface Session {
	id: string;
	credentialId: string;
	createdAt: number;
	expiresAt: number;
	label: string;
}

interface StoreFile {
	credentials: StoredCredential[];
	sessions: Session[];
}

/**
 * Passkey (WebAuthn) authentication.
 *
 * Why: a Tailscale tailnet gives *reachability*, not authorization — every device on the
 * tailnet, and anyone holding a leaked bearer token, would otherwise have a root shell.
 * A passkey is hardware-bound, phishing-proof, and unlocked by the phone's biometrics.
 *
 * Policy (mode "auto"): the bearer token is enough until the first passkey is registered;
 * after that only a passkey session opens the app. The token keeps working for scripts if
 * you pass --allow-token.
 */
export class PasskeyStore {
	private data: StoreFile = { credentials: [], sessions: [] };
	private readonly file: string;
	private readonly challenges = new Map<string, { challenge: string; expires: number }>();

	constructor(stateDir: string) {
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		this.file = join(stateDir, "passkeys.json");
		this.load();
	}

	private load(): void {
		if (!existsSync(this.file)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreFile>;
			this.data = {
				credentials: parsed.credentials ?? [],
				sessions: (parsed.sessions ?? []).filter((s) => s.expiresAt > Date.now()),
			};
		} catch {
			/* corrupt file: start empty rather than locking the user out of registration */
		}
	}

	private save(): void {
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
		renameSync(tmp, this.file);
	}

	get credentials(): StoredCredential[] {
		return this.data.credentials;
	}

	get enrolled(): boolean {
		return this.data.credentials.length > 0;
	}

	removeCredential(id: string): boolean {
		const before = this.data.credentials.length;
		this.data.credentials = this.data.credentials.filter((c) => c.id !== id && c.label !== id);
		this.data.sessions = this.data.sessions.filter((s) => this.data.credentials.some((c) => c.id === s.credentialId));
		this.save();
		return this.data.credentials.length !== before;
	}

	revokeAllSessions(): void {
		this.data.sessions = [];
		this.save();
	}

	// ----------------------------------------------------------------- sessions

	private newSession(credentialId: string, label: string): string {
		const id = randomBytes(32).toString("base64url");
		this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > Date.now());
		this.data.sessions.push({
			id,
			credentialId,
			label,
			createdAt: Date.now(),
			expiresAt: Date.now() + SESSION_TTL_MS,
		});
		this.save();
		return id;
	}

	sessionFor(req: IncomingMessage): Session | undefined {
		const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
		if (!sid) return undefined;
		const now = Date.now();
		const sidBuf = Buffer.from(sid);
		for (const s of this.data.sessions) {
			const known = Buffer.from(s.id);
			if (known.length === sidBuf.length && timingSafeEqual(known, sidBuf) && s.expiresAt > now) return s;
		}
		return undefined;
	}

	sessionCookie(id: string, secure: boolean): string {
		const flags = ["HttpOnly", secure ? "Secure" : "", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_TTL_MS / 1000}`]
			.filter(Boolean)
			.join("; ");
		return `${SESSION_COOKIE}=${id}; ${flags}`;
	}

	// --------------------------------------------------------------- ceremonies

	private putChallenge(key: string, challenge: string): void {
		const now = Date.now();
		for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
		this.challenges.set(key, { challenge, expires: now + CHALLENGE_TTL_MS });
	}

	private takeChallenge(key: string): string | undefined {
		const entry = this.challenges.get(key);
		this.challenges.delete(key);
		if (!entry || entry.expires < Date.now()) return undefined;
		return entry.challenge;
	}

	async registrationOptions(rpID: string, label: string): Promise<unknown> {
		const options = await generateRegistrationOptions({
			rpName: RP_NAME,
			rpID,
			userName: label || "pi-super",
			userDisplayName: label || "pi-super",
			attestationType: "none",
			// one user, many devices: don't let the same authenticator enrol twice
			excludeCredentials: this.data.credentials.map((c) => ({ id: c.id })),
			authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
		});
		this.putChallenge(`reg:${rpID}`, options.challenge);
		return options;
	}

	async verifyRegistration(
		rpID: string,
		origin: string,
		response: Parameters<typeof verifyRegistrationResponse>[0]["response"],
		label: string,
	): Promise<{ ok: true; credential: StoredCredential } | { ok: false; error: string }> {
		const expectedChallenge = this.takeChallenge(`reg:${rpID}`);
		if (!expectedChallenge) return { ok: false, error: "no pending registration (expired?)" };
		try {
			const result = await verifyRegistrationResponse({
				response,
				expectedChallenge,
				expectedOrigin: origin,
				expectedRPID: rpID,
				requireUserVerification: false,
			});
			if (!result.verified || !result.registrationInfo) return { ok: false, error: "registration not verified" };
			const info = result.registrationInfo;
			const credential: StoredCredential = {
				id: info.credential.id,
				publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
				counter: info.credential.counter,
				transports: info.credential.transports,
				label: label || `passkey-${this.data.credentials.length + 1}`,
				createdAt: new Date().toISOString(),
			};
			this.data.credentials.push(credential);
			this.save();
			return { ok: true, credential };
		} catch (err) {
			return { ok: false, error: String((err as Error).message) };
		}
	}

	async authenticationOptions(rpID: string): Promise<unknown> {
		const options = await generateAuthenticationOptions({
			rpID,
			userVerification: "preferred",
			allowCredentials: this.data.credentials.map((c) => ({ id: c.id, transports: c.transports as never })),
		});
		this.putChallenge(`auth:${rpID}`, options.challenge);
		return options;
	}

	async verifyAuthentication(
		rpID: string,
		origin: string,
		response: Parameters<typeof verifyAuthenticationResponse>[0]["response"],
		secure: boolean,
	): Promise<{ ok: true; cookie: string; label: string } | { ok: false; error: string }> {
		const expectedChallenge = this.takeChallenge(`auth:${rpID}`);
		if (!expectedChallenge) return { ok: false, error: "no pending login (expired?)" };
		const credential = this.data.credentials.find((c) => c.id === response.id);
		if (!credential) return { ok: false, error: "unknown passkey" };
		try {
			const result = await verifyAuthenticationResponse({
				response,
				expectedChallenge,
				expectedOrigin: origin,
				expectedRPID: rpID,
				requireUserVerification: false,
				credential: {
					id: credential.id,
					publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
					counter: credential.counter,
					transports: credential.transports as never,
				},
			});
			if (!result.verified) return { ok: false, error: "signature not verified" };
			// A counter that fails to advance can mean a cloned authenticator; many real
			// passkeys always report 0, so only enforce it once we've seen it move.
			const next = result.authenticationInfo.newCounter;
			if (credential.counter > 0 && next <= credential.counter) {
				return { ok: false, error: "passkey counter did not advance (possible clone)" };
			}
			credential.counter = next;
			credential.lastUsedAt = new Date().toISOString();
			const sid = this.newSession(credential.id, credential.label);
			this.save();
			return { ok: true, cookie: this.sessionCookie(sid, secure), label: credential.label };
		} catch (err) {
			return { ok: false, error: String((err as Error).message) };
		}
	}
}

/** WebAuthn ties a credential to an origin; derive both from how we were reached. */
export function rpIdFor(req: IncomingMessage): { rpID: string; origin: string; secure: boolean } {
	const host = req.headers.host ?? "localhost";
	const secure = (req.socket as { encrypted?: boolean }).encrypted === true;
	const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
	const proto = forwarded || (secure ? "https" : "http");
	const rpID = host.split(":")[0] ?? "localhost";
	return { rpID, origin: `${proto}://${host}`, secure: proto === "https" };
}
