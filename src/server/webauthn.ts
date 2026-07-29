import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
/** ties a browser to the one ceremony it started, so nobody else can consume it */
export const CHALLENGE_COOKIE = "pi_super_chal";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** login options are mintable by anyone who can reach us; bound the memory they cost */
const MAX_CHALLENGES = 64;
/** a handoff code is redeemed by an app that is already waiting for it */
const HANDOFF_TTL_MS = 2 * 60 * 1000;
/**
 * How recently the browser must have verified the user before it may export a session.
 * The app's sign-in asks for a fresh assertion; this is the server insisting on it, so a
 * silent mint off an old cookie is not a thing that can happen.
 */
const HANDOFF_FRESHNESS_MS = 3 * 60 * 1000;
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

export interface Session {
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
	/** fingerprint of the file `data` came from; anything else on disk wins (syncFromDisk) */
	private loadedSig = "";
	private readonly challenges = new Map<string, { challenge: string; expires: number }>();
	/** one-time codes that move a session from the browser into the Android app */
	private readonly handoffs = new Map<
		string,
		{ sessionId: string; credentialId: string; label: string; challenge: string; expires: number }
	>();

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
			this.loadedSig = this.signature();
		} catch {
			/* corrupt file: start empty rather than locking the user out of registration */
		}
	}

	/**
	 * Re-read the store when someone else has written it.
	 *
	 * `pi-super --remove-passkey` runs in a *second process* against the same file. Without
	 * this the running server kept serving the revoked credential from memory and, on its
	 * next save, wrote it back — revocation looked like it worked and did nothing. Every
	 * read and every mutation goes through here, so the file is the source of truth.
	 */
	private syncFromDisk(): void {
		if (!existsSync(this.file)) return;
		if (this.signature() === this.loadedSig) return;
		this.load();
	}

	/** nanosecond mtime *and* size: two writes in the same millisecond are not rare here */
	private signature(): string {
		try {
			const st = statSync(this.file, { bigint: true });
			return `${st.mtimeNs}:${st.size}`;
		} catch {
			return "";
		}
	}

	private save(): void {
		// unique: two processes saving at once must not write the same temp file
		const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
		renameSync(tmp, this.file);
		this.loadedSig = this.signature();
	}

	get credentials(): StoredCredential[] {
		this.syncFromDisk();
		return this.data.credentials;
	}

	get enrolled(): boolean {
		return this.credentials.length > 0;
	}

	removeCredential(id: string): boolean {
		this.syncFromDisk();
		const before = this.data.credentials.length;
		this.data.credentials = this.data.credentials.filter((c) => c.id !== id && c.label !== id);
		this.data.sessions = this.data.sessions.filter((s) => this.data.credentials.some((c) => c.id === s.credentialId));
		this.save();
		return this.data.credentials.length !== before;
	}

	revokeAllSessions(): void {
		this.syncFromDisk();
		this.data.sessions = [];
		this.save();
	}

	/** Log out one browser, not the household. */
	revokeSession(id: string): void {
		this.syncFromDisk();
		this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
		this.save();
	}

	/**
	 * Is this session id still good? Live WebSockets are authenticated once, at upgrade,
	 * and a terminal socket *is* shell access — so they have to keep asking.
	 */
	sessionAlive(id: string): boolean {
		this.syncFromDisk();
		return this.data.sessions.some((s) => s.id === id && s.expiresAt > Date.now());
	}

	// ----------------------------------------------------------------- sessions

	private newSession(credentialId: string, label: string): string {
		this.syncFromDisk();
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

	// ------------------------------------------------------------------ handoff

	/**
	 * Mint a one-time code that turns a browser session into an app session.
	 *
	 * Android's WebView cannot do the passkey ceremony against a private host: Credential
	 * Manager asks *Google* to crawl `https://<rpID>/.well-known/assetlinks.json` before it
	 * will let an app claim an RP ID, and a tailnet-only box is not crawlable. So the
	 * wrapper sends the user to a real browser, where WebAuthn is plain WebAuthn, and the
	 * session earned there is carried back through this code.
	 *
	 * PKCE, because the code arrives over a custom scheme (`pi-super://handoff`) and any app
	 * on the phone may register the same scheme: the code alone is useless without the
	 * verifier, which never leaves the app that started the flow.
	 */
	mintHandoff(session: Session, challenge: string): string | undefined {
		if (!/^[A-Za-z0-9_-]{22,128}$/.test(challenge)) return undefined;
		const now = Date.now();
		// The session must be the product of an assertion the user has just performed — not
		// simply a browser that logged in this morning and has been sitting there since.
		if (now - session.createdAt > HANDOFF_FRESHNESS_MS) return undefined;
		for (const [k, v] of this.handoffs) {
			// One live code per challenge: a reloaded page must not leave a sibling code behind
			// that is still good after the real one has been redeemed.
			if (v.expires < now || v.challenge === challenge) this.handoffs.delete(k);
		}
		if (this.handoffs.size >= MAX_CHALLENGES) return undefined;
		const code = randomBytes(32).toString("base64url");
		this.handoffs.set(code, {
			sessionId: session.id,
			credentialId: session.credentialId,
			label: session.label,
			challenge,
			expires: now + HANDOFF_TTL_MS,
		});
		return code;
	}

	/** Redeem a handoff code for a session of the app's own — single use, whatever happens. */
	redeemHandoff(code: string, verifier: string, secure: boolean): { cookie: string; label: string } | undefined {
		const entry = this.handoffs.get(code);
		this.handoffs.delete(code);
		if (!entry || entry.expires < Date.now()) return undefined;
		const got = createHash("sha256").update(verifier).digest("base64url");
		const want = Buffer.from(entry.challenge);
		const have = Buffer.from(got);
		if (want.length !== have.length || !timingSafeEqual(want, have)) return undefined;
		this.syncFromDisk();
		// the passkey may have been revoked between the browser's login and this redemption
		if (!this.data.credentials.some((c) => c.id === entry.credentialId)) return undefined;
		// ...and so may the session it was minted from. `--logout` has to mean this too, or
		// revoking everything leaves a code in flight that hands out a fresh session after.
		if (!this.sessionAlive(entry.sessionId)) return undefined;
		// A session of its own, not a copy: logging the app out must not log the browser out.
		const sid = this.newSession(entry.credentialId, entry.label);
		return { cookie: this.sessionCookie(sid, secure), label: entry.label };
	}

	sessionFor(req: IncomingMessage): Session | undefined {
		const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
		if (!sid) return undefined;
		this.syncFromDisk();
		const now = Date.now();
		const sidBuf = Buffer.from(sid);
		for (const s of this.data.sessions) {
			const known = Buffer.from(s.id);
			if (known.length === sidBuf.length && timingSafeEqual(known, sidBuf) && s.expiresAt > now) return s;
		}
		return undefined;
	}

	sessionCookie(id: string, secure: boolean): string {
		// Lax, not Strict: navigations from other apps (QR scanner, chat link) are cross-site
		// in Chrome and Strict would hide the session on them, showing a spurious login page.
		const flags = ["HttpOnly", secure ? "Secure" : "", "SameSite=Lax", "Path=/", `Max-Age=${SESSION_TTL_MS / 1000}`]
			.filter(Boolean)
			.join("; ");
		return `${SESSION_COOKIE}=${id}; ${flags}`;
	}

	// --------------------------------------------------------------- ceremonies

	/**
	 * One challenge per ceremony, named by a nonce we hand back in a cookie.
	 *
	 * A single `auth:<rpID>` slot meant any unauthenticated request could overwrite the
	 * challenge the real user was mid-way through answering (and verification consumed it
	 * destructively), which is a free login-denial. The nonce also stops one browser from
	 * completing a ceremony another browser started.
	 */
	private putChallenge(kind: "reg" | "auth", rpID: string, challenge: string): string {
		const now = Date.now();
		for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
		// insertion-ordered: drop the oldest outstanding ceremonies first
		for (const k of this.challenges.keys()) {
			if (this.challenges.size < MAX_CHALLENGES) break;
			this.challenges.delete(k);
		}
		const nonce = randomBytes(18).toString("base64url");
		this.challenges.set(`${kind}:${rpID}:${nonce}`, { challenge, expires: now + CHALLENGE_TTL_MS });
		return nonce;
	}

	private takeChallenge(kind: "reg" | "auth", rpID: string, nonce: string | undefined): string | undefined {
		if (!nonce) return undefined;
		const key = `${kind}:${rpID}:${nonce}`;
		const entry = this.challenges.get(key);
		this.challenges.delete(key);
		if (!entry || entry.expires < Date.now()) return undefined;
		return entry.challenge;
	}

	/** Short-lived, HttpOnly: the browser proves it is the one that asked. */
	challengeCookie(nonce: string, secure: boolean): string {
		const flags = ["HttpOnly", secure ? "Secure" : "", "SameSite=Lax", "Path=/api/auth/", `Max-Age=${CHALLENGE_TTL_MS / 1000}`]
			.filter(Boolean)
			.join("; ");
		return `${CHALLENGE_COOKIE}=${nonce}; ${flags}`;
	}

	static challengeNonce(req: IncomingMessage): string | undefined {
		return parseCookies(req.headers.cookie)[CHALLENGE_COOKIE];
	}

	async registrationOptions(
		rpID: string,
		label: string,
		anyAuthenticator = false,
	): Promise<{ options: unknown; nonce: string }> {
		this.syncFromDisk();
		const options = await generateRegistrationOptions({
			rpName: RP_NAME,
			rpID,
			userName: label || "pi-super",
			userDisplayName: label || "pi-super",
			attestationType: "none",
			// one user, many devices: don't let the same authenticator enrol twice
			excludeCredentials: this.data.credentials.map((c) => ({ id: c.id })),
			// platform + required UV: the passkey must live in the enrolling device's own
			// authenticator behind its biometric/screen-lock. Without this, Android offers
			// a confusing "NFC/USB security key" chooser instead of the fingerprint prompt.
			// anyAuthenticator is the client's fallback when the device's credential manager
			// is broken (Xiaomi…): UV stays required, only the attachment pin is dropped.
			authenticatorSelection: {
				...(anyAuthenticator ? {} : { authenticatorAttachment: "platform" as const }),
				residentKey: "required",
				userVerification: "required",
			},
		});
		return { options, nonce: this.putChallenge("reg", rpID, options.challenge) };
	}

	async verifyRegistration(
		rpID: string,
		origin: string,
		response: Parameters<typeof verifyRegistrationResponse>[0]["response"],
		label: string,
		nonce: string | undefined,
		secure: boolean,
	): Promise<{ ok: true; credential: StoredCredential; cookie: string } | { ok: false; error: string }> {
		this.syncFromDisk();
		const expectedChallenge = this.takeChallenge("reg", rpID, nonce);
		if (!expectedChallenge) return { ok: false, error: "no pending registration (expired?)" };
		try {
			const result = await verifyRegistrationResponse({
				response,
				expectedChallenge,
				expectedOrigin: origin,
				expectedRPID: rpID,
				requireUserVerification: true,
			});
			if (!result.verified || !result.registrationInfo) return { ok: false, error: "registration not verified" };
			// the ceremony took a while; someone may have revoked in the meantime
			this.syncFromDisk();
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
			// Enrolling is a user-verified ceremony on this very device: give it a session, or
			// the browser that just added the passkey is locked out by the policy it enabled
			// (and its token-authenticated socket would be the only thing still working).
			const sid = this.newSession(credential.id, credential.label);
			this.save();
			return { ok: true, credential, cookie: this.sessionCookie(sid, secure) };
		} catch (err) {
			return { ok: false, error: String((err as Error).message) };
		}
	}

	async authenticationOptions(rpID: string): Promise<{ options: unknown; nonce: string }> {
		this.syncFromDisk();
		const options = await generateAuthenticationOptions({
			rpID,
			userVerification: "required",
			allowCredentials: this.data.credentials.map((c) => ({ id: c.id, transports: c.transports as never })),
		});
		return { options, nonce: this.putChallenge("auth", rpID, options.challenge) };
	}

	async verifyAuthentication(
		rpID: string,
		origin: string,
		response: Parameters<typeof verifyAuthenticationResponse>[0]["response"],
		secure: boolean,
		nonce: string | undefined,
	): Promise<{ ok: true; cookie: string; label: string; sessionId: string } | { ok: false; error: string }> {
		this.syncFromDisk();
		const expectedChallenge = this.takeChallenge("auth", rpID, nonce);
		if (!expectedChallenge) return { ok: false, error: "no pending login (expired?)" };
		const credential = this.data.credentials.find((c) => c.id === response.id);
		if (!credential) return { ok: false, error: "unknown passkey" };
		try {
			const result = await verifyAuthenticationResponse({
				response,
				expectedChallenge,
				expectedOrigin: origin,
				expectedRPID: rpID,
				requireUserVerification: true,
				credential: {
					id: credential.id,
					publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
					counter: credential.counter,
					transports: credential.transports as never,
				},
			});
			if (!result.verified) return { ok: false, error: "signature not verified" };
			// Revocation may have landed while we were verifying: a signature from a passkey
			// that no longer exists must not mint a session.
			this.syncFromDisk();
			const live = this.data.credentials.find((c) => c.id === response.id);
			if (!live) return { ok: false, error: "passkey was revoked" };
			// A counter that fails to advance can mean a cloned authenticator; many real
			// passkeys always report 0, so only enforce it once we've seen it move.
			const next = result.authenticationInfo.newCounter;
			if (live.counter > 0 && next <= live.counter) {
				return { ok: false, error: "passkey counter did not advance (possible clone)" };
			}
			live.counter = next;
			live.lastUsedAt = new Date().toISOString();
			const sid = this.newSession(live.id, live.label);
			this.save();
			return { ok: true, cookie: this.sessionCookie(sid, secure), label: credential.label, sessionId: sid };
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
