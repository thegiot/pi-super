import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

export const COOKIE_NAME = "pi_super";

export function ensureToken(stateDir: string, reset = false): string {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const file = join(stateDir, "token");
	if (!reset && existsSync(file)) {
		const tok = readFileSync(file, "utf8").trim();
		if (tok.length >= 32) return tok;
	}
	const tok = randomBytes(32).toString("base64url");
	writeFileSync(file, `${tok}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return tok;
}

export function tokenEquals(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return timingSafeEqual(ba, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx < 0) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		if (!k) continue;
		try {
			out[k] = decodeURIComponent(v);
		} catch {
			// malformed percent-encoding: keep the raw value rather than throwing
			// (this runs before authentication, so a throw here would be a free DoS)
			out[k] = v;
		}
	}
	return out;
}

/**
 * Token from ?token= (fresh link / QR), Authorization: Bearer, or the cookie.
 *
 * Explicit credentials win over the cookie on purpose: after `--reset-token` a stale
 * cookie must not be able to lock the browser out of a link carrying the new token.
 */
export function requestToken(req: IncomingMessage, url: URL): string | undefined {
	const q = url.searchParams.get("token");
	if (q) return q;
	const auth = req.headers.authorization;
	if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
	return parseCookies(req.headers.cookie)[COOKIE_NAME];
}

export function isAuthed(req: IncomingMessage, url: URL, token: string): boolean {
	const got = requestToken(req, url);
	return got !== undefined && tokenEquals(got, token);
}

/**
 * WebSocket/CSRF defence: cookies are sent cross-origin on WS handshakes, so we
 * require the Origin (when present) to match the Host we were reached on.
 */
export function originAllowed(req: IncomingMessage, allowed: string[] | undefined): boolean {
	const origin = req.headers.origin;
	if (!origin) return true; // non-browser client (curl, native app)
	if (allowed?.includes(origin)) return true;
	try {
		const o = new URL(origin);
		const host = req.headers.host;
		if (!host || o.host !== host) return false;
		// If we were reached over TLS, an http:// origin on the same host is not us.
		const secure = (req.socket as { encrypted?: boolean }).encrypted === true;
		return !secure || o.protocol === "https:";
	} catch {
		return false;
	}
}
