import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { COOKIE_NAME, isAuthed, originAllowed, requestToken, tokenEquals } from "./auth.js";
import type { Config } from "./config.js";
import { type ChatItem, MetaAgent } from "./meta.js";
import { SESSION_PREFIX, sweepStaleSessions, TermConnection } from "./term.js";
import { Tmux } from "./tmux.js";
import { MAX_UPLOAD_BYTES, readBody, storeUpload } from "./uploads.js";

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

export interface SuperServer {
	http: Server;
	close(): Promise<void>;
}

export function createServer(cfg: Config, token: string): SuperServer {
	const tmux = new Tmux(cfg.socketArgs);
	const live = new Set<TermConnection>();
	const meta = new MetaAgent({
		metaDir: cfg.metaDir,
		socketArgs: cfg.socketArgs,
		model: cfg.metaModel,
		inheritExtensions: cfg.metaInheritExtensions,
	});
	const metaClients = new Set<WebSocket>();

	const broadcastMeta = (msg: unknown) => {
		const data = JSON.stringify(msg);
		for (const ws of metaClients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
	};
	meta.on("item", (item: ChatItem) => broadcastMeta({ t: "item", item }));
	meta.on("state", (state) => broadcastMeta({ t: "state", state }));
	meta.on("speak", (speak) => broadcastMeta({ t: "speak", ...(speak as object) }));
	meta.on("exit", () => broadcastMeta({ t: "state", state: meta.state }));

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

	const http = createHttpServer((req, res) => {
		handle(req, res).catch((err) => {
			sendJson(res, 500, { error: String(err?.message ?? err) });
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

		if (!isAuthed(req, url, token)) {
			res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
			res.end("pi-super: unauthorized (append ?token=… once, or send Authorization: Bearer …)\n");
			return;
		}
		// First visit with ?token= — pin it into an HttpOnly cookie and drop it from the URL.
		if (url.searchParams.has("token") && !req.headers.cookie?.includes(`${COOKIE_NAME}=`)) {
			const clean = new URL(url);
			clean.searchParams.delete("token");
			res.writeHead(302, {
				"set-cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
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
				sendJson(res, 200, { path, bytes: body.length });
				return;
			}
			default:
				sendJson(res, 404, { error: "not found" });
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
		});
		createReadStream(file).pipe(res);
	}

	// ---------------------------------------------------------------- websocket

	const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

	http.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const tok = requestToken(req, url);
		if (!tok || !tokenEquals(tok, token) || !originAllowed(req, cfg.allowedOrigins)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		if (url.pathname === "/ws/meta") {
			if (!cfg.metaEnabled) {
				socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => onMetaConnection(ws));
			return;
		}
		if (url.pathname !== "/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			void onConnection(ws, url);
		});
	});

	async function onConnection(ws: WebSocket, url: URL): Promise<void> {
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
				if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
			},
			onGeometry: (cols, rows) => send({ t: "geometry", cols, rows }),
			onExit: () => {
				send({ t: "fatal", error: "tmux client exited" });
				ws.close();
			},
		});
		live.add(term);

		const cols = Number(url.searchParams.get("cols") ?? 80);
		const rows = Number(url.searchParams.get("rows") ?? 24);
		const mode = url.searchParams.get("mode") === "claim" ? "claim" : "ignore";
		try {
			await term.start(cols, rows, mode);
		} catch (err) {
			send({ t: "fatal", error: `tmux attach failed: ${String((err as Error).message)}` });
			live.delete(term);
			ws.close();
			return;
		}
		send({ t: "hello", base, session: term.sessionName, mode: term.mode, ...term.geometry });

		let lastWindows = "";
		const poll = setInterval(() => {
			void (async () => {
				try {
					const windows = await tmux.listWindows(term.sessionName);
					const json = JSON.stringify(windows);
					if (json !== lastWindows) {
						lastWindows = json;
						send({ t: "windows", windows });
					}
					await term.syncGeometry();
				} catch {
					/* transient tmux errors are fine */
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
					await onControl(term, msg, send);
				} catch (err) {
					send({ t: "error", error: String((err as Error).message) });
				}
			})();
		});

		const cleanup = () => {
			clearInterval(poll);
			live.delete(term);
			void term.dispose();
		};
		ws.on("close", cleanup);
		ws.on("error", cleanup);
	}

	async function onControl(
		term: TermConnection,
		msg: Record<string, unknown>,
		send: (m: unknown) => void,
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
				send({ t: "hello", session: s, mode: term.mode, ...term.geometry });
				return;
			case "select":
				await tmux.selectWindow(s, String(msg.window));
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
				return;
			}
			case "killWindow":
				await tmux.killWindow(`${s}:${String(msg.window)}`);
				return;
			case "renameWindow":
				await tmux.renameWindow(`${s}:${String(msg.window)}`, String(msg.name ?? ""));
				return;
			case "paste":
				await tmux.pasteText(`${s}:`, String(msg.text ?? ""), { bracketed: msg.bracketed !== false });
				if (msg.enter) await tmux.sendKeys(`${s}:`, ["Enter"]);
				return;
			case "keys":
				await tmux.sendKeys(`${s}:`, (msg.keys as string[] | undefined) ?? []);
				return;
			case "ping":
				send({ t: "pong" });
				return;
			default:
				send({ t: "error", error: `unknown message: ${String(msg.t)}` });
		}
	}

	function onMetaConnection(ws: WebSocket): void {
		metaClients.add(ws);
		const send = (msg: unknown) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
		};
		send({ t: "init", transcript: meta.transcript, state: meta.state });
		ws.on("message", (data) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(String(data)) as Record<string, unknown>;
			} catch {
				return;
			}
			try {
				switch (msg.t) {
					case "prompt":
						meta.prompt(
							String(msg.text ?? ""),
							msg.images as Array<{ data: string; mimeType: string }> | undefined,
						);
						break;
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
		const drop = () => metaClients.delete(ws);
		ws.on("close", drop);
		ws.on("error", drop);
	}

	void sweepStaleSessions(tmux, new Set()).catch(() => {});

	return {
		http,
		async close() {
			meta.stop();
			for (const term of live) await term.dispose();
			live.clear();
			wss.close();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		},
	};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(data);
}
