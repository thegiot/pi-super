import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { COOKIE_NAME, isAuthed, isSecureRequest, originAllowed, requestToken, tokenEquals } from "./auth.js";
import type { Config } from "./config.js";
import { buildVocabulary, dictationInstructions } from "./dictation.js";
import { readPeek } from "./files.js";
import { FleetMonitor, validateFleetRequest } from "./fleet.js";
import { HerdrError, herdrRun } from "./herdr.js";
import { type ChatItem, MetaAgent } from "./meta.js";
import { scrollBottomKey } from "./pi-keybindings.js";
import { PromptLog } from "./prompts.js";
import { SESSION_PREFIX, sweepStaleSessions, TermConnection } from "./term.js";
import { Tmux } from "./tmux.js";
import { MAX_UPLOAD_BYTES, readBody, storeUpload } from "./uploads.js";
import { detectVoiceConfig, negotiateOffer } from "./voice.js";
import { PasskeyStore, rpIdFor, SESSION_COOKIE } from "./webauthn.js";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

const WINDOW_POLL_MS = 1000;
const MAX_WS_BUFFER = 2 * 1024 * 1024;

/** Prefer reported foreground activity; one open client is an unambiguous fallback. */
export function chooseActiveMetaClient<T extends { readyState: number }>(
	clients: Iterable<T>,
	active?: T,
	inactive: ReadonlySet<T> = new Set(),
): T | undefined {
	if (active?.readyState === WebSocket.OPEN && !inactive.has(active)) return active;
	const eligible = [...clients].filter((client) => client.readyState === WebSocket.OPEN && !inactive.has(client));
	return eligible.length === 1 ? eligible[0] : undefined;
}

export interface SuperServer {
	http: Server;
	/** resume a previous meta session, if any — call once the port is bound (owned) */
	resumeMeta(): void;
	/** the cached view of the herdr fleet; undefined when herdr is disabled */
	fleet: FleetMonitor | undefined;
	close(): Promise<void>;
}

export function createServer(cfg: Config, token: string): SuperServer {
	const tmux = new Tmux(cfg.socketArgs);
	const live = new Set<TermConnection>();
	const passkeys = new PasskeyStore(cfg.stateDir);

	/**
	 * Reachability (Tailscale, LAN, tunnel) is not authorization. Once a passkey is
	 * enrolled, the bearer token alone stops being a way in — you need the phone.
	 */
	function passkeyRequired(): boolean {
		if (cfg.authMode === "passkey") return true;
		if (cfg.authMode === "token") return false;
		return passkeys.enrolled; // auto
	}

	type AuthResult = { ok: true; via: "session" | "token" } | { ok: false; reason: "none" | "passkey-required" };

	function authenticate(req: IncomingMessage, url: URL): AuthResult {
		if (passkeys.sessionFor(req)) return { ok: true, via: "session" };
		if (!isAuthed(req, url, token)) return { ok: false, reason: "none" };
		if (passkeyRequired() && !cfg.allowToken) return { ok: false, reason: "passkey-required" };
		return { ok: true, via: "token" };
	}
	const herdrMachines = cfg.herdrEnabled
		? cfg.herdrMachines
				.split(",")
				.map((m) => m.trim())
				.filter(Boolean)
		: [];
	const meta = new MetaAgent({
		metaDir: cfg.metaDir,
		socketArgs: cfg.socketArgs,
		model: cfg.metaModel,
		piBin: cfg.piBin,
		inheritExtensions: cfg.metaInheritExtensions,
		sessionDir: join(cfg.stateDir, "meta-sessions"),
		herdrMachines,
		herdrBin: cfg.herdrBin,
	});
	// The fleet view is cached, not per-request: the Agents page polls it, and a page
	// refresh must never turn into a burst of ssh sessions to every saved machine.
	const fleet = herdrMachines.length
		? new FleetMonitor({ machines: herdrMachines, stateDir: cfg.stateDir, herdrBin: cfg.herdrBin })
		: undefined;

	const prompts = new PromptLog(cfg.stateDir);
	/** prompt ids handed to the agent whose turn has not settled yet */
	let owed: string[] = [];
	/** ids surfaced into the chat but not yet in front of any client (see reportUnanswered) */
	let unread: string[] = [];

	/** when this process began running the code it is running (see serverStale()) */
	const startedAt = Date.now();

	/** journald adds timestamps/unit; we just add the facts worth grepping for */
	const log = (msg: string): void => {
		process.stdout.write(`${msg}\n`);
	};
	const clientIp = (req: IncomingMessage): string => {
		const fwd = String(req.headers["x-forwarded-for"] ?? "")
			.split(",")[0]
			?.trim();
		return fwd || req.socket.remoteAddress || "?";
	};
	const metaClients = new Set<WebSocket>();
	const inactiveMetaClients = new Set<WebSocket>();
	/** Last foreground/interacting browser; meta UI commands must never move every client. */
	let activeMetaClient: WebSocket | undefined;

	/**
	 * Crude per-peer bucket for the endpoints anyone can reach: 30 hits a minute.
	 *
	 * Keyed on the *socket* address, never on X-Forwarded-For: a header the client writes
	 * is a rate limit the client chooses.
	 */
	const authHits = new Map<string, { count: number; resetAt: number }>();
	function rateLimit(ip: string, limit = 30, windowMs = 60_000): boolean {
		const now = Date.now();
		for (const [k, v] of authHits) if (v.resetAt < now) authHits.delete(k);
		const hit = authHits.get(ip) ?? { count: 0, resetAt: now + windowMs };
		hit.count++;
		authHits.set(ip, hit);
		return hit.count <= limit;
	}

	/**
	 * A live WebSocket *is* the shell, and it was only ever authenticated at the upgrade.
	 * Revoking a passkey (or a session simply expiring) has to reach the sockets it opened,
	 * or revocation is a lie for as long as the tab stays open.
	 */
	const socketAuth = new Map<WebSocket, { kind: "session"; id: string } | { kind: "token" }>();
	const revalidate = setInterval(() => {
		for (const [ws, who] of socketAuth) {
			if (ws.readyState === WebSocket.CLOSED) {
				socketAuth.delete(ws);
				continue;
			}
			// A token-authenticated socket outlives the moment the token stops being enough:
			// enrolling the first passkey flips the policy, and the shell opened with the old
			// credential would otherwise keep running for as long as the tab stays open.
			const ok = who.kind === "token" ? !passkeyRequired() || cfg.allowToken : passkeys.sessionAlive(who.id);
			if (ok) continue;
			log(`auth: ${who.kind} no longer authorized — closing its socket`);
			socketAuth.delete(ws);
			ws.close(4001, "authorization revoked");
			setTimeout(() => ws.terminate(), 1000).unref?.();
		}
	}, 15_000);
	revalidate.unref?.();

	const broadcastMeta = (msg: unknown) => {
		const data = JSON.stringify(msg);
		for (const ws of metaClients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
	};
	meta.on("item", (item: ChatItem) => {
		if (item.kind === "system") log(`meta: ${item.text}`);
		broadcastMeta({ t: "item", item });
	});
	meta.on("log", (chunk: string) => process.stderr.write(`meta: ${chunk}`));
	meta.on("state", (state) => broadcastMeta({ t: "state", state }));
	meta.on("speak", (speak) => {
		log(`meta: speak/${(speak as { kind?: string }).kind}: ${preview((speak as { message: string }).message)}`);
		broadcastMeta({ t: "speak", ...(speak as object) });
	});
	meta.on("clientControl", (control) => {
		const request = control as { action: string; window: string; view: string };
		// If presence was lost to a reconnect, one client is unambiguous. With several,
		// doing nothing is better than switching the wrong person's desktop or phone.
		const target = chooseActiveMetaClient(metaClients, activeMetaClient, inactiveMetaClients);
		if (!target) {
			log(`meta: client control dropped (no unambiguous active client): ${request.action} ${request.window}`);
			meta.note(`could not switch the app to ${request.window}: no single active client`);
			return;
		}
		target.send(JSON.stringify({ t: "clientControl", ...request }));
		log(`meta: client control: ${request.action} ${request.window} (${request.view})`);
	});
	meta.on("exit", () => broadcastMeta({ t: "state", state: meta.state }));
	// A settled turn has answered everything queued behind it (steering folds prompts into
	// the turn in flight), so one settle clears the lot. A prompt that lands in the gap
	// between pi emitting agent_settled and us reading it is acked without having been
	// answered; the text itself is still in the log and the journal, only the replay hint
	// is lost, which is not worth correlating RPC ids for.
	meta.on("settled", () => {
		if (owed.length === 0) return;
		prompts.answered(owed);
		owed = [];
	});
	// If a previous meta session exists, resume it eagerly — it may owe the user a
	// report (an interrupted tmux_wait_idle), which must not wait for the app to open.
	// The caller invokes this only after listen() succeeds: holding the port proves we
	// are the only pi-super instance, so two `pi` children can't fight over the session.
	function resumeMeta(): void {
		if (!cfg.metaEnabled) return;
		if (meta.hasPreviousSession) {
			try {
				meta.start();
			} catch (err) {
				process.stderr.write(`pi-super: meta resume failed: ${String((err as Error).message)}\n`);
			}
		}
		// after start(): rehydration fills the transcript, and these belong on top of it
		reportUnanswered();
	}

	/**
	 * Prompts the previous process took and never finished a turn on — the agent was
	 * killed by the watchdog, or pi-super went down mid-turn. The resumed agent has no
	 * idea they existed, so put them back in front of the user *verbatim* instead of
	 * replaying them at the agent: some of them it may have half-done already, and a
	 * silent re-send is how you get two of everything.
	 */
	function reportUnanswered(): void {
		const pending = prompts.unanswered();
		if (pending.length === 0) return;
		for (const p of pending) {
			const when = new Date(p.at).toLocaleString();
			log(`meta: unanswered prompt from ${when} (${p.source}): ${preview(p.text)}`);
			meta.note(`unanswered since ${when} (${p.source}) — resend if it still matters:\n${p.text}`);
		}
		// The note lives in a transcript that dies with this process, so it is not "delivered"
		// until a client has actually been sent it. Acking here would lose the prompt for good
		// on a second restart before anyone opened the chat — the exact failure this is for.
		unread = pending.map((p) => p.id);
	}

	/** Base session to mirror: explicit config, else the first real (non-ours) session. */
	async function resolveBase(requested?: string | null): Promise<string> {
		const sessions = await tmux.listSessions();
		const real = sessions.filter((s) => !s.name.startsWith(SESSION_PREFIX));
		if (requested) {
			const hit = real.find((s) => s.name === requested);
			if (!hit) throw new Error(`no such tmux session: ${requested}`);
			return hit.name;
		}
		if (cfg.baseSession) {
			const hit = real.find((s) => s.name === cfg.baseSession);
			if (!hit) throw new Error(`configured session not found: ${cfg.baseSession}`);
			return hit.name;
		}
		const first = real[0];
		if (!first) throw new Error("no tmux sessions found — start tmux first");
		return first.name;
	}

	/**
	 * Jargon currently on the user's screen, to prime a dictation session with. Best effort:
	 * a session that mishears "pi-super" is worth far more than no session at all, so every
	 * failure here degrades to the bare core vocabulary.
	 */
	async function screenVocabulary(url: URL): Promise<string> {
		try {
			const windows = await tmux.listWindows(await resolveBase(url.searchParams.get("session")));
			const pane = url.searchParams.get("target") ?? windows.find((w) => w.active)?.paneId;
			const text = pane ? await tmux.capture(pane, { lines: 80 }) : "";
			return buildVocabulary(text, windows.map((w) => w.name));
		} catch {
			return buildVocabulary("", []);
		}
	}

	const http = createHttpServer((req, res) => {
		try {
			handle(req, res).catch((err) => sendJson(res, 500, { error: String(err?.message ?? err) }));
		} catch (err) {
			// e.g. a malformed Host header making URL parsing throw, pre-auth
			sendJson(res, 400, { error: String((err as Error).message) });
		}
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

		// The passkey ceremony itself must be reachable by a browser that has no session yet;
		// it is protected by the bearer token (enrolment) or by the challenge (login).
		if (url.pathname.startsWith("/api/auth/")) {
			await handleAuth(req, res, url);
			return;
		}

		const auth = authenticate(req, url);
		if (!auth.ok) {
			// A login page has to be reachable by someone who cannot log in yet: when passkeys
			// are the gate, serve the (secret-free) app bundle so it can run the ceremony.
			// Every API and WebSocket route stays shut.
			if (passkeyRequired() && !url.pathname.startsWith("/api/")) {
				serveStatic(res, url.pathname);
				return;
			}
			res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
			res.end(
				auth.reason === "passkey-required"
					? "pi-super: a passkey is required (open the app and unlock with your phone)\n"
					: "pi-super: unauthorized (append ?token=… once, or send Authorization: Bearer …)\n",
			);
			return;
		}
		// First visit with ?token= — pin it into an HttpOnly cookie and drop it from the URL.
		// SameSite=Lax, not Strict: navigations initiated from another app (QR scanner, chat
		// link) are cross-site in Chrome, and Strict would withhold the cookie on the very
		// redirect we are about to issue, 401-ing the first visit. Lax still keeps the cookie
		// off cross-site POSTs and WebSocket handshakes, which the Origin check covers anyway.
		if (url.searchParams.has("token") && !req.headers.cookie?.includes(`${COOKIE_NAME}=`)) {
			const clean = new URL(url);
			clean.searchParams.delete("token");
			const secure = isSecureRequest(req) ? " Secure;" : "";
			res.writeHead(302, {
				"set-cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=31536000`,
				location: `${clean.pathname}${clean.search}`,
			});
			res.end();
			return;
		}

		if (url.pathname.startsWith("/api/")) {
			await handleApi(req, res, url);
			return;
		}
		serveStatic(res, url.pathname);
	}

	/**
	 * Passkey enrolment + login.
	 *
	 * Enrolment is a *grant of shell access*, so under a passkey policy the bearer token
	 * must not be able to mint one: a leaked token would otherwise re-enrol its way in and
	 * the policy would be decoration. The one exception is bootstrap — with no passkey on
	 * file the token is all there is, and that is exactly how the first one gets added.
	 */
	async function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const { rpID, origin, secure } = rpIdFor(req);
		const route = `${req.method} ${url.pathname}`;
		const body = async () => JSON.parse((await readBody(req, 256 * 1024)).toString("utf8") || "{}");
		const session = passkeys.sessionFor(req);
		const tokenOk = isAuthed(req, url, token);
		// In `auto` (the default) this still allows the first, bootstrap enrolment, because
		// with no passkey on file no passkey is required yet. In `passkey` mode it does not:
		// that mode is documented as locking you out, and a token that could enrol would
		// quietly unlock it.
		const tokenMayEnroll = tokenOk && (!passkeyRequired() || cfg.allowToken);
		const canEnroll = session !== undefined || tokenMayEnroll;
		const nonce = PasskeyStore.challengeNonce(req);
		// Public ceremonies are cheap to ask for and not cheap to serve; a peer that can reach
		// us must not be able to spin them (or the log) at will.
		if (route.endsWith("/options") || route.endsWith("/verify")) {
			if (!rateLimit(req.socket.remoteAddress ?? "?")) {
				sendJson(res, 429, { error: "too many auth attempts, wait a minute" });
				return;
			}
		}

		switch (route) {
			case "GET /api/auth/state": {
				// --allow-token means a token-authenticated browser really is in; saying
				// otherwise made the client show a lock screen the server did not want.
				const authed = session !== undefined || (tokenOk && (!passkeyRequired() || cfg.allowToken));
				sendJson(res, 200, {
					enrolled: passkeys.enrolled,
					required: passkeyRequired(),
					authenticated: authed,
					session: session ? { label: session.label, expiresAt: session.expiresAt } : undefined,
					canEnroll,
					supported: secure || rpID === "localhost" || rpID === "127.0.0.1",
					rpID,
					// which devices the owner enrolled, and when, is nobody else's business:
					// the lock screen only needs to know that a passkey exists
					credentials:
						authed || canEnroll
							? passkeys.credentials.map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt }))
							: [],
				});
				return;
			}
			case "POST /api/auth/register/options": {
				if (!canEnroll) {
					sendJson(res, 401, {
						error: passkeys.enrolled
							? "enrolling another passkey needs an unlocked session (unlock with an existing passkey first)"
							: "enrolling a passkey needs the access token",
					});
					return;
				}
				if (!originAllowed(req, cfg.allowedOrigins)) {
					sendJson(res, 403, { error: "bad origin" });
					return;
				}
				const { label, anyAuthenticator } = (await body()) as { label?: string; anyAuthenticator?: boolean };
				const { options, nonce: issued } = await passkeys.registrationOptions(
					rpID,
					label ?? "",
					anyAuthenticator === true,
				);
				sendJson(res, 200, options, { "set-cookie": passkeys.challengeCookie(issued, secure) });
				return;
			}
			case "POST /api/auth/register/verify": {
				if (!canEnroll) {
					sendJson(res, 401, { error: "unauthorized" });
					return;
				}
				if (!originAllowed(req, cfg.allowedOrigins)) {
					sendJson(res, 403, { error: "bad origin" });
					return;
				}
				const { response, label } = (await body()) as { response: never; label?: string };
				const result = await passkeys.verifyRegistration(rpID, origin, response, label ?? "", nonce, secure);
				if (!result.ok) {
					log(`auth: passkey enrolment failed from ${clientIp(req)}: ${result.error}`);
					sendJson(res, 400, { error: result.error });
					return;
				}
				log(`auth: passkey "${result.credential.label}" enrolled from ${clientIp(req)}`);
				sendJson(
					res,
					200,
					{ ok: true, credential: { id: result.credential.id, label: result.credential.label } },
					{ "set-cookie": result.cookie },
				);
				return;
			}
			case "POST /api/auth/login/options": {
				if (!passkeys.enrolled) {
					sendJson(res, 409, { error: "no passkey enrolled yet" });
					return;
				}
				const { options, nonce: issued } = await passkeys.authenticationOptions(rpID);
				sendJson(res, 200, options, { "set-cookie": passkeys.challengeCookie(issued, secure) });
				return;
			}
			case "POST /api/auth/login/verify": {
				const { response } = (await body()) as { response: never };
				const result = await passkeys.verifyAuthentication(rpID, origin, response, secure, nonce);
				if (!result.ok) {
					log(`auth: passkey login failed from ${clientIp(req)}: ${result.error}`);
					sendJson(res, 401, { error: result.error });
					return;
				}
				log(`auth: passkey login "${result.label}" from ${clientIp(req)}`);
				res.writeHead(200, { "content-type": "application/json", "set-cookie": result.cookie });
				res.end(JSON.stringify({ ok: true, label: result.label }));
				return;
			}
			// --- moving a session from a real browser into the Android app -----------------
			case "POST /api/auth/handoff": {
				if (!originAllowed(req, cfg.allowedOrigins)) {
					sendJson(res, 403, { error: "bad origin" });
					return;
				}
				// A passkey session only: the token can already be pasted into the app, and a
				// leaked one must not be upgradable into a passkey-grade session.
				if (!session) {
					sendJson(res, 401, { error: "unlock with your passkey first" });
					return;
				}
				const { challenge } = (await body()) as { challenge?: string };
				const code = challenge ? passkeys.mintHandoff(session, challenge) : undefined;
				if (!code) {
					// Most likely the session is not fresh: signing the app in is a deliberate act
					// that must cost a passkey prompt, precisely because the app that asked for it
					// is whichever app claimed the pi-super: scheme.
					sendJson(res, 400, { error: "sign in again to approve this" });
					return;
				}
				log(`auth: handoff code minted for the app from ${clientIp(req)}`);
				sendJson(res, 200, { code });
				return;
			}
			case "POST /api/auth/handoff/redeem": {
				// Redeemed by a navigation inside the app's WebView, which is the only way the
				// cookie can land in *its* cookie jar (it shares nothing with Chrome). A POST
				// navigation, so the code and verifier stay out of URLs, proxy logs and history.
				const form = new URLSearchParams((await readBody(req, 4096)).toString("utf8"));
				const result = passkeys.redeemHandoff(form.get("code") ?? "", form.get("verifier") ?? "", secure);
				if (!result) {
					log(`auth: handoff redemption failed from ${clientIp(req)}`);
					sendJson(res, 400, { error: "this sign-in is used up or expired" });
					return;
				}
				log(`auth: app signed in as "${result.label}" from ${clientIp(req)}`);
				res.writeHead(303, {
					location: "/",
					"set-cookie": result.cookie,
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
				});
				res.end();
				return;
			}
			case "POST /api/auth/logout": {
				// Unauthenticated, this was a denial-of-service button: any reachable peer could
				// POST it (even cross-origin, no-cors) and log the owner's phone out for good.
				if (!originAllowed(req, cfg.allowedOrigins)) {
					sendJson(res, 403, { error: "bad origin" });
					return;
				}
				if (!session && !tokenOk) {
					sendJson(res, 401, { error: "unauthorized" });
					return;
				}
				// log out this browser; `--logout` on the box is how you evict everyone
				if (session) {
					passkeys.revokeSession(session.id);
					log(`auth: logout "${session.label}" from ${clientIp(req)}`);
				}
				res.writeHead(200, {
					"content-type": "application/json",
					"set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
				});
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			default:
				sendJson(res, 404, { error: "not found" });
		}
	}

	async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		switch (`${req.method} ${url.pathname}`) {
			case "GET /api/state": {
				const sessions = (await tmux.listSessions()).filter((s) => !s.name.startsWith(SESSION_PREFIX));
				const base = await resolveBase(url.searchParams.get("session"));
				sendJson(res, 200, {
					base,
					sessions,
					windows: await tmux.listWindows(base),
					tmux: await tmux.version(),
					host: req.headers.host,
				});
				return;
			}
			case "GET /api/capture": {
				const target = url.searchParams.get("target");
				if (!target) {
					sendJson(res, 400, { error: "target required" });
					return;
				}
				const lines = Number(url.searchParams.get("lines") ?? 2000);
				const text = await tmux.capture(target, { lines: Math.min(Math.max(lines, 0), 50000) });
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
				res.end(text);
				return;
			}
			case "GET /api/file": {
				const path = url.searchParams.get("path");
				if (!path) {
					sendJson(res, 400, { error: "path required" });
					return;
				}
				const peek = readPeek(path, url.searchParams.get("cwd") ?? undefined);
				if (!peek.ok) {
					sendJson(res, peek.status, { error: peek.error });
					return;
				}
				res.writeHead(200, {
					"content-type": peek.type,
					"cache-control": "no-store",
					...SECURITY_HEADERS,
					// the client shows the resolved path (it only knows the token it was tapped on)
					"x-peek-path": encodeURIComponent(peek.path),
					// a directory listing is JSON too, so the kind cannot be read off the content type
					"x-peek-kind": peek.kind,
					"x-peek-bytes": String(peek.bytes),
					"x-peek-truncated": peek.truncated ? "1" : "0",
				});
				res.end(peek.body);
				return;
			}
			case "GET /api/voice/config": {
				const voice = detectVoiceConfig();
				sendJson(res, 200, {
					...voice,
					enabled: voice.provider !== "none" && cfg.metaEnabled,
					// without a meta agent there is nothing for a voice front end to delegate to,
					// so the client must not fall back to browser speech either
					meta: cfg.metaEnabled,
				});
				return;
			}
			case "POST /api/voice/offer": {
				if (!originAllowed(req, cfg.allowedOrigins)) {
					sendJson(res, 403, { error: "bad origin" });
					return;
				}
				const voice = detectVoiceConfig();
				const sdp = (await readBody(req, 1024 * 1024)).toString("utf8");
				// same session, different job: ?mode=dictation asks the model to be a microphone
				const instructions =
					url.searchParams.get("mode") === "dictation"
						? dictationInstructions(cfg.metaDir, await screenVocabulary(url))
						: voiceInstructions(cfg.metaDir, meta.conversationTurns);
				const result = await negotiateOffer(voice, sdp, instructions);
				if (!result.ok) {
					sendJson(res, result.status >= 400 ? result.status : 502, { error: result.error });
					return;
				}
				res.writeHead(200, { "content-type": "application/sdp", "cache-control": "no-store" });
				res.end(result.sdp);
				return;
			}
			case "POST /api/upload": {
				if (!originAllowed(req, cfg.allowedOrigins)) {
					sendJson(res, 403, { error: "bad origin" });
					return;
				}
				let body: Buffer;
				try {
					body = await readBody(req, MAX_UPLOAD_BYTES);
				} catch (err) {
					sendJson(res, 413, { error: String((err as Error).message) });
					return;
				}
				if (body.length === 0) {
					sendJson(res, 400, { error: "empty body" });
					return;
				}
				const path = storeUpload(cfg.stateDir, body, url.searchParams.get("name"), req.headers["content-type"]);
				log(`upload: ${path} (${body.length} bytes) from ${clientIp(req)}`);
				sendJson(res, 200, { path, bytes: body.length });
				return;
			}
			case "GET /api/fleet": {
				if (!fleet) {
					sendJson(res, 404, { error: "herdr disabled" });
					return;
				}
				sendJson(res, 200, fleet.snapshot());
				return;
			}
			case "GET /api/fleet/read": {
				if (!fleet) {
					sendJson(res, 404, { error: "herdr disabled" });
					return;
				}
				const v = validateFleetRequest(fleet.machines, "read", {
					machine: url.searchParams.get("machine"),
					target: url.searchParams.get("target"),
					lines: url.searchParams.get("lines"),
				});
				if (!v.ok) {
					sendJson(res, v.status, { error: v.error });
					return;
				}
				try {
					const out = await herdrRun(v.machine, ["pane", "read", v.target, "--source", "recent-unwrapped", "--lines", String(v.lines)], {
						bin: cfg.herdrBin,
					});
					res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
					res.end(out);
				} catch (err) {
					sendJson(res, 502, { error: String((err as Error)?.message ?? err) });
				}
				return;
			}
			case "POST /api/fleet/prompt":
			case "POST /api/fleet/keys": {
				if (!originAllowed(req, cfg.allowedOrigins)) {
					sendJson(res, 403, { error: "bad origin" });
					return;
				}
				if (!fleet) {
					sendJson(res, 404, { error: "herdr disabled" });
					return;
				}
				const kind = url.pathname.endsWith("/prompt") ? "prompt" : "keys";
				let raw: Buffer;
				try {
					raw = await readBody(req, 64 * 1024);
				} catch (err) {
					sendJson(res, 413, { error: String((err as Error)?.message ?? err) });
					return;
				}
				let fields: { target?: unknown; text?: unknown; keys?: unknown; machine?: unknown };
				try {
					fields = JSON.parse(raw.toString("utf8") || "{}") as typeof fields;
				} catch {
					sendJson(res, 400, { error: "bad json" });
					return;
				}
				const v = validateFleetRequest(fleet.machines, kind, fields);
				if (!v.ok) {
					sendJson(res, v.status, { error: v.error });
					return;
				}
				try {
					const args =
						kind === "prompt"
							? ["agent", "prompt", v.target, v.text!, "--wait", "--until", "working", "--timeout", "60000"]
							: ["agent", "send-keys", v.target, ...v.keys!];
					await herdrRun(v.machine, args, { bin: cfg.herdrBin, timeoutMs: 90_000 });
					sendJson(res, 200, { ok: true });
				} catch (err) {
					// herdr's coded errors (agent_blocked, timeout, ...) are answers, not faults —
					// they go back as 200 so the UI can show the code; everything else is a 502
					if (err instanceof HerdrError) {
						sendJson(res, 200, { ok: false, code: err.code, error: err.message });
					} else {
						sendJson(res, 502, { error: String((err as Error)?.message ?? err) });
					}
				}
				return;
			}
			default:
				sendJson(res, 404, { error: "not found" });
		}
	}

	/**
	 * Identity of the client bundle we are serving (its hashed asset name). Sent in
	 * hello/pong so a phone that keeps the old bundle open across a redeploy notices
	 * and reloads itself — drafts and window selection survive reloads by design.
	 */
	function clientBuild(): string {
		try {
			return readFileSync(join(cfg.clientDir, "index.html"), "utf8").match(/assets\/index-[\w-]+\.js/)?.[0] ?? "";
		} catch {
			return "";
		}
	}

	/**
	 * Is the code on disk newer than the process running it?
	 *
	 * The client half of a redeploy lands by itself — files are streamed from disk and the
	 * build hash makes the phone reload. The server half does not: an old process keeps
	 * serving the new bundle, silently ignoring every control message and query parameter
	 * the new client sends. That failure is completely invisible from the phone (features
	 * simply do nothing), so it is worth one line of nagging.
	 */
	function serverStale(): boolean {
		try {
			const self = new URL("./server.js", import.meta.url).pathname;
			return statSync(self).mtimeMs > startedAt;
		} catch {
			return false;
		}
	}

	function serveStatic(res: ServerResponse, pathname: string): void {
		const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
		let file = join(cfg.clientDir, rel);
		if (!file.startsWith(cfg.clientDir)) {
			res.writeHead(403).end("forbidden");
			return;
		}
		if (!existsSync(file) || statSync(file).isDirectory()) file = join(cfg.clientDir, "index.html");
		if (!existsSync(file)) {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end("client build missing — run `npm run build`\n");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"cache-control": file.endsWith("index.html") ? "no-store" : "max-age=300",
			...SECURITY_HEADERS,
		});
		createReadStream(file).pipe(res);
	}

	// ---------------------------------------------------------------- websocket

	const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

	http.on("upgrade", (req, socket, head) => {
		// Everything in here runs before authentication: a throw would kill the process.
		let url: URL;
		let who: { kind: "session"; id: string } | { kind: "token" } | undefined;
		try {
			url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			const session = passkeys.sessionFor(req);
			const tok = requestToken(req, url);
			const tokenOk =
				!!tok && tokenEquals(tok, token) && (!passkeyRequired() || cfg.allowToken);
			if ((!session && !tokenOk) || !originAllowed(req, cfg.allowedOrigins)) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
			who = session ? { kind: "session", id: session.id } : { kind: "token" };
		} catch {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return;
		}
		if (url.pathname === "/ws/meta") {
			if (!cfg.metaEnabled) {
				socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				if (who) socketAuth.set(ws, who);
				onMetaConnection(ws, clientIp(req));
			});
			return;
		}
		if (url.pathname !== "/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			if (who) socketAuth.set(ws, who);
			void onConnection(ws, url, clientIp(req));
		});
	});

	async function onConnection(ws: WebSocket, url: URL, ip: string): Promise<void> {
		const send = (msg: unknown) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		};
		let base: string;
		try {
			base = await resolveBase(url.searchParams.get("session"));
		} catch (err) {
			send({ t: "fatal", error: String((err as Error).message) });
			ws.close();
			return;
		}

		const term = new TermConnection(tmux, {
			base,
			statusLine: cfg.statusLine,
			socketArgs: cfg.socketArgs,
			onData: (chunk) => {
				// Backpressure: a phone on a bad link must not make us buffer a noisy pane
				// without bound. tmux will redraw, so dropping frames is safe.
				if (ws.readyState !== WebSocket.OPEN) return;
				if (ws.bufferedAmount > MAX_WS_BUFFER) return;
				ws.send(chunk, { binary: true });
			},
			onGeometry: (cols, rows) => send({ t: "geometry", cols, rows }),
			onExit: () => {
				send({ t: "fatal", error: "tmux client exited" });
				ws.close();
			},
		});
		live.add(term);

		// Install teardown *before* any await: the socket can die mid-startup.
		let poll: ReturnType<typeof setInterval> | undefined;
		let closed = false;
		const cleanup = () => {
			if (closed) return;
			closed = true;
			log(`term: ${ip} detached (${term.sessionName})`);
			if (poll) clearInterval(poll);
			live.delete(term);
			void term.dispose();
		};
		ws.on("close", cleanup);
		ws.on("error", cleanup);

		const cols = Number(url.searchParams.get("cols") ?? 80);
		const rows = Number(url.searchParams.get("rows") ?? 24);
		const mode = url.searchParams.get("mode") === "claim" ? "claim" : "ignore";
		// only a tmux window id (@12) — anything else is somebody probing our tmux targets
		const wantWindow = url.searchParams.get("window");
		const window = wantWindow && /^@\d+$/.test(wantWindow) ? wantWindow : undefined;
		try {
			await term.start(cols, rows, mode, window);
		} catch (err) {
			send({ t: "fatal", error: `tmux attach failed: ${String((err as Error).message)}` });
			cleanup();
			ws.close();
			return;
		}
		if (closed) return; // browser gave up while we were attaching
		log(`term: ${ip} attached (${term.sessionName} → ${base}, ${term.mode})`);
		send({
			t: "hello",
			base,
			session: term.sessionName,
			mode: term.mode,
			build: clientBuild(),
			stale: serverStale(),
			...term.geometry,
		});

		let lastWindows = "";
		const pushWindows = async () => {
			const windows = await tmux.listWindows(term.sessionName);
			const json = JSON.stringify(windows);
			if (json !== lastWindows) {
				lastWindows = json;
				send({ t: "windows", windows });
			}
		};
		let polling = false;
		poll = setInterval(() => {
			if (polling) return; // never overlap: a slow tmux would spawn children forever
			polling = true;
			void (async () => {
				try {
					await pushWindows();
					await term.syncGeometry();
				} catch {
					/* transient tmux errors are fine */
				} finally {
					polling = false;
				}
			})();
		}, WINDOW_POLL_MS);

		ws.on("message", (data, isBinary) => {
			void (async () => {
				if (isBinary) {
					term.write(data as Buffer);
					return;
				}
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(String(data)) as Record<string, unknown>;
				} catch {
					return;
				}
				try {
					await onControl(term, msg, send, pushWindows);
				} catch (err) {
					send({ t: "error", error: String((err as Error).message) });
				}
			})();
		});

	}

	async function onControl(
		term: TermConnection,
		msg: Record<string, unknown>,
		send: (m: unknown) => void,
		refresh: () => Promise<void>,
	): Promise<void> {
		const s = term.sessionName;
		switch (msg.t) {
			case "input":
				term.write(String(msg.data ?? ""));
				return;
			case "resize":
				term.resize(Number(msg.cols), Number(msg.rows));
				return;
			case "mode":
				await term.setSizeMode(msg.mode === "claim" ? "claim" : "ignore", Number(msg.cols), Number(msg.rows));
				send({ t: "hello", session: s, mode: term.mode, build: clientBuild(), ...term.geometry });
				return;
			case "select":
				await tmux.selectWindow(s, String(msg.window));
				await refresh(); // don't make the tab highlight wait for the next poll
				return;
			case "moveWindow":
				await tmux.moveWindow(s, String(msg.window), String(msg.target), msg.where === "after" ? "after" : "before");
				await refresh();
				return;
			case "newWindow": {
				const windows = await tmux.listWindows(s);
				const index = windows.reduce((m, w) => Math.max(m, w.index), -1) + 1;
				const id = await tmux.newWindow(s, {
					cwd: msg.cwd ? String(msg.cwd) : undefined,
					name: msg.name ? String(msg.name) : undefined,
					command: msg.command ? String(msg.command) : undefined,
					index,
				});
				send({ t: "newWindow", window: id });
				await refresh();
				return;
			}
			case "killWindow": {
				// Grouped sessions share real windows: killing one kills it for the desktop
				// client too, and killing the last one would take the whole session down.
				const windows = await tmux.listWindows(s);
				if (windows.length <= 1) {
					send({ t: "error", error: "refusing to kill the last window of the session" });
					return;
				}
				await tmux.killWindow(`${s}:${String(msg.window)}`);
				await refresh();
				return;
			}
			case "renameWindow":
				await tmux.renameWindow(`${s}:${String(msg.window)}`, String(msg.name ?? ""));
				await refresh();
				return;
			case "paste":
				await tmux.pasteText(`${s}:`, String(msg.text ?? ""), { bracketed: msg.bracketed !== false });
				if (msg.enter) await tmux.sendKeys(`${s}:`, ["Enter"]);
				return;
			case "keys": {
				const keys = (msg.keys as string[] | undefined) ?? [];
				if (keys.length === 1 && keys[0] === "PageUp") await tmux.smartPageUp(`${s}:`);
				else if (keys.length === 1 && keys[0] === "ScrollBottom") await tmux.smartScrollBottom(`${s}:`, scrollBottomKey());
				else await tmux.sendKeys(`${s}:`, keys);
				return;
			}
			case "ping":
				send({ t: "pong", build: clientBuild() });
				return;
			default:
				send({ t: "error", error: `unknown message: ${String(msg.t)}` });
		}
	}

	function onMetaConnection(ws: WebSocket, ip: string): void {
		log(`meta ws: ${ip} connected`);
		metaClients.add(ws);
		const send = (msg: unknown) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		};
		send({ t: "init", transcript: meta.transcript, state: meta.state });
		// the recovered prompts have now reached a screen; stop carrying them
		if (unread.length > 0) {
			prompts.answered(unread);
			unread = [];
		}
		ws.on("message", (data) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(String(data)) as Record<string, unknown>;
			} catch {
				return;
			}
			try {
				switch (msg.t) {
					case "active":
						inactiveMetaClients.delete(ws);
						activeMetaClient = ws;
						break;
					case "inactive":
						inactiveMetaClients.add(ws);
						if (activeMetaClient === ws) activeMetaClient = undefined;
						break;
					case "prompt": {
						// A prompt identifies its client, but a background client remains ineligible;
						// it must report foreground activity before asking to move a screen.
						if (!inactiveMetaClients.has(ws)) activeMetaClient = ws;
						const text = String(msg.text ?? "");
						// The journal is the only place to see whether a *voice* prompt ever
						// reached the agent: the phone shows the chat, but when nothing comes
						// back there is no way to tell "never sent" from "agent wedged".
						log(`meta ws: ${ip} prompt${meta.state.busy ? " (busy, steering)" : ""}: ${preview(text)}`);
						const images = msg.images as Array<{ data: string; mimeType: string }> | undefined;
						// on disk before the agent gets it: a turn that wedges must not take the
						// user's words down with it (see PromptLog)
						owed.push(prompts.record(text, String(msg.source ?? "chat"), images?.length ? { images: images.length } : undefined));
						// a safety net nobody knows is torn is worse than no safety net
						if (prompts.broken) log(`meta ws: WARNING prompt log is not writable (${prompts.broken}) — ${prompts.file}`);
						meta.prompt(text, images);
						break;
					}
					case "abort":
						meta.abort();
						break;
					case "newSession":
						meta.newSession();
						send({ t: "init", transcript: meta.transcript, state: meta.state });
						break;
					case "start":
						meta.start();
						send({ t: "state", state: meta.state });
						break;
					case "stop":
						meta.stop();
						break;
				}
			} catch (err) {
				send({ t: "error", error: String((err as Error).message) });
			}
		});
		const drop = () => {
			if (activeMetaClient === ws) activeMetaClient = undefined;
			inactiveMetaClients.delete(ws);
			if (metaClients.delete(ws)) log(`meta ws: ${ip} disconnected`);
		};
		ws.on("close", drop);
		ws.on("error", drop);
	}

	void sweepStaleSessions(tmux, new Set()).catch(() => {});

	return {
		http,
		resumeMeta,
		fleet,
		async close() {
			fleet?.stop();
			clearInterval(revalidate);
			socketAuth.clear();
			await meta.stop();
			for (const ws of wss.clients) ws.terminate();
			for (const term of live) await term.dispose();
			live.clear();
			metaClients.clear();
			inactiveMetaClients.clear();
			activeMetaClient = undefined;
			wss.close();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		},
	};
}

/** One grep-friendly line: newlines folded, tail cut. */
function preview(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Instructions handed to the realtime voice model (server-side, not client-editable). */
export function voiceInstructions(metaDir: string, priorTurns: number): string {
	let base: string;
	try {
		base = readFileSync(join(metaDir, "voice-prompt.md"), "utf8");
	} catch {
		base = "You are the voice of super. Delegate anything substantive to the client and keep replies short and spoken.";
	}
	// A realtime session cannot be resumed: every dial — including the one after a page
	// reload two minutes ago — starts from these instructions and nothing else. super, on
	// the other hand, kept the whole conversation. Say so, or the voice greets a user it
	// has been talking to all morning as a stranger and makes them repeat themselves.
	if (priorTurns > 0) {
		base += `\n\n## This call joins a conversation already in progress\n\nYou have just been connected, with no memory of anything: this is a fresh speech session.\nsuper is not — it has been working with this user (${priorTurns} exchanges so far) and\nremembers all of it, as does the chat on their screen. They may well have reloaded the\npage mid-conversation, and to them nothing happened.\n\nSo before anything else, and without narrating any of the above, delegate a request for a\nshort catch-up: what has been going on, what is running, and whether anything is waiting\non the user. Greet them in one short sentence while that lands, then lead with it. Never\nask the user to tell you what you missed — super knows.\n`;
	}
	return base;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...SECURITY_HEADERS,
		...headers,
	});
	res.end(data);
}

/**
 * Sent on everything. This app hands out a shell: it must never be framed (clickjacking a
 * terminal is a shell), never be sniffed into a different content type, and never leak the
 * token in a Referer to whatever a captured pane happens to link to.
 */
const SECURITY_HEADERS: Record<string, string> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"content-security-policy": "frame-ancestors 'none'",
};
