import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { BeeperError } from "./beeper.js";
import { type ChatFilter, type ChatsUpdate, type InboxService, type InboxState, InboxError, type MessageView } from "./service.js";
import { readBody } from "../uploads.js";
import { type Assistant, AssistantError, buildContext, type HistoryTurn } from "./assistant.js";
import type { Outbox, OutboxIntentView } from "./outbox.js";

/*
 * HTTP and WebSocket surface of the inbox. Mounted by server.ts behind the same auth,
 * origin and socket-revocation rules as the rest of pi-super; this file only routes.
 */

export interface InboxHttpDeps {
	inbox: InboxService;
	/** undefined when the assistant is not wired; the route then answers assistant_unconfigured */
	assistant?: Assistant;
	/** the controlled-send journal; the /outbox routes 404 when it is not wired */
	outbox?: Outbox;
	json: (res: ServerResponse, status: number, body: unknown) => void;
	securityHeaders: Record<string, string>;
}

const FILTERS = new Set<string>(["reply", "unread", "all"]);
const JSON_BODY_LIMIT = 4096;
const ASSISTANT_BODY_LIMIT = 64 * 1024;
/** draft text can be 20 000 chars plus envelope */
const OUTBOX_BODY_LIMIT = 48 * 1024;
const PROMPT_MAX = 2000;
const HISTORY_MAX = 10;
const TURN_MAX = 4000;
const ASSISTANT_STATUS: Record<string, number> = {
	assistant_unconfigured: 503,
	assistant_busy: 429,
	assistant_timeout: 504,
	assistant_failed: 502,
};

export async function handleInboxApi(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	deps: InboxHttpDeps,
): Promise<void> {
	const { inbox, json } = deps;
	const path = url.pathname.slice("/api/inbox".length);
	const method = req.method ?? "GET";
	try {
		if (method === "GET" && path === "/state") {
			json(res, 200, inbox.state());
			return;
		}
		if (method === "POST" && path === "/refresh") {
			await inbox.refreshNow();
			json(res, 200, inbox.state());
			return;
		}
		if (method === "GET" && path === "/chats") {
			const filter = url.searchParams.get("filter") ?? "reply";
			if (!FILTERS.has(filter)) {
				json(res, 400, { error: "filter must be reply, unread or all" });
				return;
			}
			json(
				res,
				200,
				inbox.list({
					filter: filter as ChatFilter,
					network: url.searchParams.get("network") ?? undefined,
					q: url.searchParams.get("q") ?? undefined,
				}),
			);
			return;
		}
		if (path === "/outbox" || path.startsWith("/outbox/")) {
			await outboxRoute(req, res, deps, path, method);
			return;
		}
		const attachment = /^\/attachments\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path);
		if (method === "GET" && attachment) {
			await streamAttachment(res, deps, decodeSegment(attachment[1]!), decodeSegment(attachment[2]!), Number(attachment[3]));
			return;
		}
		const chat = /^\/chats\/([^/]+)(?:\/(.*))?$/.exec(path);
		if (chat) {
			await chatRoute(req, res, url, deps, decodeSegment(chat[1]!), `${method} ${chat[2] ?? ""}`.trim());
			return;
		}
		json(res, 404, { error: "not found" });
	} catch (err) {
		sendError(res, err, json);
	}
}

async function chatRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	deps: InboxHttpDeps,
	chatID: string,
	route: string,
): Promise<void> {
	const { inbox, json } = deps;
	switch (route.replace(/\/$/, "")) {
		case "GET": {
			const chat = inbox.chat(chatID);
			json(res, chat ? 200 : 404, chat ?? { error: "chat not found" });
			return;
		}
		case "GET messages": {
			const direction = url.searchParams.get("direction");
			if (direction !== null && direction !== "before") {
				json(res, 400, { error: "direction must be before" });
				return;
			}
			json(res, 200, await inbox.messages(chatID, url.searchParams.get("cursor") ?? undefined));
			return;
		}
		case "POST no-reply":
			json(res, 200, inbox.setNoReply(chatID, true));
			return;
		case "DELETE no-reply":
			json(res, 200, inbox.setNoReply(chatID, false));
			return;
		case "POST snooze": {
			const body = await jsonBody(req);
			if (typeof body.until !== "string") {
				json(res, 400, { error: "until must be an ISO time" });
				return;
			}
			json(res, 200, inbox.snooze(chatID, body.until));
			return;
		}
		case "DELETE snooze":
			json(res, 200, inbox.snooze(chatID, null));
			return;
		case "POST assistant":
			await askAssistant(req, res, deps, chatID);
			return;
		case "POST mark":
		case "POST priority": {
			const body = await jsonBody(req);
			if (typeof body.on !== "boolean") {
				json(res, 400, { error: "on must be a boolean" });
				return;
			}
			const summary = route === "POST mark" ? inbox.mark(chatID, body.on) : inbox.priority(chatID, body.on);
			json(res, 200, summary);
			return;
		}
		default:
			json(res, 404, { error: "not found" });
	}
}

/**
 * The outbox endpoints (PRD §12.2). Only `confirm` can reach Beeper; every other
 * route works on the journal. Public views never carry the message text — the
 * client typed it and holds it, and after a final state the server no longer does.
 */
async function outboxRoute(
	req: IncomingMessage,
	res: ServerResponse,
	deps: InboxHttpDeps,
	path: string,
	method: string,
): Promise<void> {
	const { outbox, json } = deps;
	if (!outbox) {
		json(res, 404, { error: "not found" });
		return;
	}
	if (method === "POST" && path === "/outbox") {
		const body = await jsonBody(req, OUTBOX_BODY_LIMIT);
		json(
			res,
			200,
			await outbox.create({
				key: body.key,
				chatID: body.chatID,
				text: body.text,
				replyToMessageID: body.replyToMessageID,
			}),
		);
		return;
	}
	const m = /^\/outbox\/([^/]+)(?:\/(confirm|cancel|reissue|reconcile))?$/.exec(path);
	if (!m) {
		json(res, 404, { error: "not found" });
		return;
	}
	const id = decodeSegment(m[1]!);
	const action = m[2];
	if (!action) {
		if (method !== "GET") {
			json(res, 404, { error: "not found" });
			return;
		}
		json(res, 200, outbox.get(id));
		return;
	}
	if (method !== "POST") {
		json(res, 404, { error: "not found" });
		return;
	}
	const body = action === "confirm" || action === "reissue" ? await jsonBody(req, OUTBOX_BODY_LIMIT) : {};
	switch (action) {
		case "confirm":
			json(res, 200, await outbox.confirm(id, body.confirmToken));
			return;
		case "cancel":
			json(res, 200, outbox.cancel(id));
			return;
		case "reissue":
			json(res, 200, outbox.reissue(id, body.text));
			return;
		case "reconcile":
			json(res, 200, await outbox.reconcile(id));
			return;
	}
}

async function streamAttachment(
	res: ServerResponse,
	deps: InboxHttpDeps,
	chatID: string,
	messageID: string,
	index: number,
): Promise<void> {
	const upstream = await deps.inbox.attachment(chatID, messageID, index);
	if (!upstream.body) {
		deps.json(res, 502, { error: "attachment unavailable" });
		return;
	}
	const length = upstream.headers.get("content-length");
	res.writeHead(200, {
		"content-type": safeContentType(upstream.headers.get("content-type")),
		"cache-control": "private, max-age=300",
		...deps.securityHeaders,
		...(length ? { "content-length": length } : {}),
	});
	const body = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
	body.on("error", () => res.destroy());
	body.pipe(res);
}

/**
 * Bytes from Beeper are a remote file: anything that could run in our origin (SVG, HTML,
 * anything unknown) is served as an opaque download instead.
 */
function safeContentType(raw: string | null): string {
	const ok = /^(?:image\/(?!svg)[\w.+-]+|video\/[\w.+-]+|audio\/[\w.+-]+)(?:;.*)?$/i;
	return raw && ok.test(raw) ? raw : "application/octet-stream";
}

async function jsonBody(req: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
	const parsed = JSON.parse((await readBody(req, limit)).toString("utf8") || "{}") as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("body must be an object");
	return parsed as Record<string, unknown>;
}

/**
 * The model sees only the chat named in the path, built here from what the service has read;
 * the browser contributes its own question and earlier turns, nothing else.
 */
async function askAssistant(req: IncomingMessage, res: ServerResponse, deps: InboxHttpDeps, chatID: string): Promise<void> {
	const { inbox, json, assistant } = deps;
	if (!assistant || !assistant.configured()) {
		json(res, 503, { error: "assistant_unconfigured" });
		return;
	}
	const body = await jsonBody(req, ASSISTANT_BODY_LIMIT);
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (prompt.length < 1 || prompt.length > PROMPT_MAX) {
		json(res, 400, { error: "prompt must be 1 to 2000 characters" });
		return;
	}
	const history = parseHistory(body.history);
	if (history === undefined) {
		json(res, 400, { error: "history must be at most 10 turns of user or assistant text" });
		return;
	}
	if (!inbox.chat(chatID)) {
		json(res, 404, { error: "chat not found" });
		return;
	}
	let source;
	try {
		source = await inbox.assistantSource(chatID);
	} catch (err) {
		if (err instanceof InboxError) throw err;
		json(res, 503, { error: "beeper_unavailable" });
		return;
	}
	const context = buildContext(source);
	try {
		const answer = await assistant.ask({ prompt, history, context });
		json(res, 200, {
			reply: answer.reply,
			draft: answer.draftText.trim() === "" ? null : { text: answer.draftText, language: answer.draftLanguage },
			context: { messages: context.messages, from: context.from, to: context.to },
			model: answer.model,
		});
	} catch (err) {
		if (err instanceof AssistantError) {
			json(res, ASSISTANT_STATUS[err.code] ?? 502, { error: err.code });
			return;
		}
		throw err;
	}
}

function parseHistory(raw: unknown): HistoryTurn[] | undefined {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length > HISTORY_MAX) return undefined;
	const out: HistoryTurn[] = [];
	for (const t of raw) {
		const turn = t as { role?: unknown; text?: unknown } | null;
		if (!turn || typeof turn !== "object") return undefined;
		if (turn.role !== "user" && turn.role !== "assistant") return undefined;
		if (typeof turn.text !== "string" || turn.text.length > TURN_MAX) return undefined;
		out.push({ role: turn.role, text: turn.text });
	}
	return out;
}

function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new InboxError(400, "malformed path");
	}
}

function sendError(res: ServerResponse, err: unknown, json: InboxHttpDeps["json"]): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	if (err instanceof InboxError) {
		json(res, err.status, { error: err.message });
		return;
	}
	if (err instanceof BeeperError) {
		const error =
			err.kind === "unauthorized"
				? "beeper refused the token"
				: err.kind === "unreachable"
					? "beeper unreachable"
					: "beeper request failed";
		json(res, 502, { error });
		return;
	}
	if (err instanceof SyntaxError) {
		json(res, 400, { error: "invalid JSON body" });
		return;
	}
	if (err instanceof Error && err.message === "payload too large") {
		json(res, 413, { error: "payload too large" });
		return;
	}
	json(res, 500, { error: "internal error" });
}

// ---------------------------------------------------------------- SPA

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

export function isInboxPath(pathname: string): boolean {
	return pathname === "/inbox" || pathname.startsWith("/inbox/");
}

/** `/inbox/*` from the built SvelteKit app, with an index.html fallback for client routes. */
export function serveInboxStatic(
	res: ServerResponse,
	pathname: string,
	dir: string,
	securityHeaders: Record<string, string>,
): void {
	const root = resolve(dir);
	let rel: string;
	try {
		rel = decodeURIComponent(pathname.slice("/inbox".length));
	} catch {
		res.writeHead(400).end("bad path");
		return;
	}
	const requested = resolve(root, `.${rel}`);
	if (requested !== root && !requested.startsWith(root + sep)) {
		res.writeHead(403).end("forbidden");
		return;
	}
	const file = isFile(requested) ? requested : join(root, "index.html");
	if (!existsSync(file)) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("inbox build missing — run the inbox build\n");
		return;
	}
	res.writeHead(200, {
		"content-type": MIME[extname(file)] ?? "application/octet-stream",
		"cache-control": file.endsWith("index.html") ? "no-store" : "max-age=300",
		...securityHeaders,
	});
	createReadStream(file).pipe(res);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------- websocket

/** Server → client: `state` and `chats` on connect and on every change, `messages` for upserts, `outbox` on intent transitions. */
export function serveInboxSocket(ws: WebSocket, inbox: InboxService, outbox?: Outbox): void {
	const send = (msg: unknown) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
	};
	const onState = (state: InboxState) => send({ t: "state", state });
	const onChats = (update: ChatsUpdate) => send({ t: "chats", ...update });
	const onMessages = (update: { chatID: string; messages: MessageView[] }) => send({ t: "messages", ...update });
	const onOutbox = (intent: OutboxIntentView) => send({ t: "outbox", intent });
	inbox.on("state", onState);
	inbox.on("chats", onChats);
	inbox.on("messages", onMessages);
	outbox?.on("intent", onOutbox);
	send({ t: "state", state: inbox.state() });
	send({ t: "chats", ...inbox.snapshot() });
	ws.on("message", (data) => {
		let msg: { t?: unknown };
		try {
			msg = JSON.parse(String(data)) as { t?: unknown };
		} catch {
			return;
		}
		if (msg.t === "ping") send({ t: "pong" });
	});
	ws.on("error", () => ws.close());
	ws.on("close", () => {
		inbox.off("state", onState);
		inbox.off("chats", onChats);
		inbox.off("messages", onMessages);
		outbox?.off("intent", onOutbox);
	});
}
