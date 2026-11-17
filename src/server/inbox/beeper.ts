import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

/*
 * Client for Beeper Desktop's local Client API (spec 5.0.0, read from the app itself).
 * Field names follow that spec; the spec's `GetAccountsOutput` is a bare array and its
 * message list is "sorted by timestamp" without a stated direction, so callers sort.
 *
 * The only non-GET calls in the whole codebase are the token introspection (which
 * never changes Beeper state) and `sendMessage`, which exists solely for the outbox's
 * confirm path (PRD §12.2). There is deliberately no method for edit, delete,
 * archive, mark-as-read or any other write.
 */

export type BeeperErrorKind = "unreachable" | "unauthorized" | "failed";

/** The message never carries response bodies or tokens: only the kind and the status code. */
export class BeeperError extends Error {
	constructor(
		readonly kind: BeeperErrorKind,
		readonly status: number | undefined,
		message: string,
	) {
		super(message);
		this.name = "BeeperError";
	}
}

export interface BUser {
	id: string;
	username?: string;
	fullName?: string;
	phoneNumber?: string;
	isSelf?: boolean;
}

export interface BAccount {
	accountID: string;
	network?: string;
	status: string;
	user?: BUser;
}

export interface BAttachment {
	id?: string;
	type?: string;
	srcURL?: string;
	mimeType?: string;
	fileName?: string;
	fileSize?: number;
	isSticker?: boolean;
	isVoiceNote?: boolean;
	size?: { width?: number; height?: number };
}

export interface BReaction {
	id: string;
	reactionKey: string;
	participantID?: string;
}

export interface BMessage {
	id: string;
	chatID: string;
	accountID?: string;
	senderID: string;
	senderName?: string;
	timestamp: string;
	sortKey: string;
	type?: string;
	text?: string;
	editedTimestamp?: string;
	isSender?: boolean;
	/** present while a send is in flight and once it settles */
	sendStatus?: {
		status: "SUCCESS" | "PENDING" | "FAIL_RETRIABLE" | "FAIL_PERMANENT";
		reason?: string;
		message?: string;
		timestamp?: string;
	};
	isHidden?: boolean;
	isDeleted?: boolean;
	attachments?: BAttachment[];
	linkedMessageID?: string;
	/** null on legacy messages that Beeper could not attribute: text scanning would be needed */
	mentions?: string[] | null;
	reactions?: BReaction[];
}

export interface BChat {
	id: string;
	accountID: string;
	network?: string;
	title: string;
	type: "single" | "group";
	isReadOnly?: boolean;
	participants?: { items: (BUser & { isAdmin?: boolean })[]; hasMore?: boolean; total: number };
	lastActivity?: string;
	unreadCount: number;
	unreadMentionsCount?: number;
	isArchived?: boolean;
	isMarkedUnread?: boolean;
	isMuted?: boolean;
	isPinned?: boolean;
	isLowPriority?: boolean;
	capabilities?: { maxTextLength?: number };
	mergedIntoChatID?: string;
	/** present on list results; absent on GET /v1/chats/{id} */
	preview?: BMessage | null;
}

export interface BPage<T> {
	items: T[];
	hasMore: boolean;
	oldestCursor?: string | null;
	newestCursor?: string | null;
}

export interface BeeperClientOptions {
	baseUrl: string;
	/** read on every request, so a token file replaced on disk is picked up without a restart */
	token: () => string | undefined;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const CHAT_PAGE_LIMIT = 50;
const MAX_CHAT_PAGES = 100;

export class BeeperClient {
	private readonly base: string;
	private readonly timeoutMs: number;

	constructor(private readonly opts: BeeperClientOptions) {
		this.base = opts.baseUrl.replace(/\/+$/, "");
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async info(): Promise<{ version?: string }> {
		const res = await this.send("/v1/info", {});
		await res.body?.cancel();
		return { version: res.headers.get("x-beeper-desktop-version") ?? undefined };
	}

	async accounts(): Promise<BAccount[]> {
		return (await this.json<BAccount[]>("/v1/accounts", {})) ?? [];
	}

	/** Follows the cursor to the end. Beeper lists newest first; `before` walks back in time. */
	async listAllChats(): Promise<BChat[]> {
		const chats: BChat[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_CHAT_PAGES; page++) {
			const qs = new URLSearchParams({ limit: String(CHAT_PAGE_LIMIT) });
			if (cursor) qs.set("cursor", cursor);
			const out = await this.json<BPage<BChat>>(`/v1/chats?${qs}`, {});
			chats.push(...out.items);
			if (!out.hasMore || !out.oldestCursor || out.oldestCursor === cursor) return chats;
			cursor = out.oldestCursor;
		}
		throw new BeeperError("failed", undefined, "chat pagination did not terminate");
	}

	async getChat(chatID: string): Promise<BChat> {
		return this.json<BChat>(`/v1/chats/${encodeURIComponent(chatID)}`, {});
	}

	async listMessages(chatID: string, opts: { cursor?: string } = {}): Promise<BPage<BMessage>> {
		const qs = new URLSearchParams();
		if (opts.cursor) {
			qs.set("cursor", opts.cursor);
			qs.set("direction", "before");
		}
		const suffix = qs.size > 0 ? `?${qs}` : "";
		return this.json<BPage<BMessage>>(`/v1/chats/${encodeURIComponent(chatID)}/messages${suffix}`, {});
	}

	async getMessage(chatID: string, messageID: string): Promise<BMessage> {
		return this.json<BMessage>(`/v1/chats/${encodeURIComponent(chatID)}/messages/${encodeURIComponent(messageID)}`, {});
	}

	/**
	 * The single write this client can perform, called only from the outbox after the
	 * user's confirm token checks out. Beeper may reroute the send (merged chats), so
	 * the returned chatID is the *resolved* one. Same timeout as reads, no retries —
	 * a retry would risk a duplicate, which is exactly what the outbox exists to avoid.
	 */
	async sendMessage(
		chatID: string,
		body: { text: string; replyToMessageID?: string },
	): Promise<{ chatID: string; pendingMessageID: string }> {
		return this.json<{ chatID: string; pendingMessageID: string }>(`/v1/chats/${encodeURIComponent(chatID)}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/** Token scope words, e.g. `read`. Logged by the caller, never the token itself. */
	async introspect(): Promise<{ active: boolean; scope: string }> {
		const token = this.token();
		const res = await this.send("/oauth/introspect", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token }).toString(),
		});
		const out = (await res.json()) as { active?: boolean; scope?: string };
		return { active: out.active === true, scope: out.scope ?? "" };
	}

	/**
	 * Streams a Beeper asset. Only the caller decides which URL: the inbox passes an
	 * mxc:// or localmxc:// taken from a message it read itself. The timeout covers the
	 * response headers; the body streams for as long as the browser keeps reading.
	 */
	async serveAsset(url: string): Promise<Response> {
		const qs = new URLSearchParams({ url });
		return this.send(`/v1/assets/serve?${qs}`, {});
	}

	private token(): string {
		const token = this.opts.token();
		if (!token) throw new BeeperError("unauthorized", undefined, "no token configured");
		return token;
	}

	private async json<T>(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
		const res = await this.send(path, init);
		return (await res.json()) as T;
	}

	private async send(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
		const token = this.token();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let res: Response;
		try {
			res = await fetch(this.base + path, {
				...init,
				headers: { ...init.headers, authorization: `Bearer ${token}`, accept: "application/json, */*" },
				signal: controller.signal,
			});
		} catch (err) {
			const e = err as { name?: string; cause?: { code?: string }; code?: string };
			const why = e.name === "AbortError" ? "timeout" : (e.cause?.code ?? e.code ?? "error");
			throw new BeeperError("unreachable", undefined, `beeper unreachable (${why})`);
		} finally {
			clearTimeout(timer);
		}
		if (res.status === 401 || res.status === 403) {
			await res.body?.cancel();
			throw new BeeperError("unauthorized", res.status, `beeper refused the token (HTTP ${res.status})`);
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new BeeperError("failed", res.status, `beeper HTTP ${res.status} on ${path.split("?")[0]}`);
		}
		return res;
	}
}

export interface BeeperEventsOptions {
	/** http(s):// base URL of the Client API; converted to ws(s):// */
	baseUrl: string;
	token: () => string | undefined;
	minDelayMs?: number;
	maxDelayMs?: number;
}

export interface BeeperDomainEvent {
	type: "chat.upserted" | "chat.deleted" | "message.upserted" | "message.deleted";
	seq: number;
	ts: string;
	chatID: string;
	ids: string[];
}

/**
 * Event stream: `connected` once the subscription is acknowledged, `disconnected` on every
 * drop, `event` for each domain event. Delivery is at-most-once with no replay, so the
 * owner must resync over HTTP on every `connected`.
 */
export class BeeperEvents extends EventEmitter {
	private ws: WebSocket | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private delay: number;
	private readonly url: string;
	private readonly minDelayMs: number;
	private readonly maxDelayMs: number;

	constructor(private readonly opts: BeeperEventsOptions) {
		super();
		this.url = `${opts.baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/v1/ws`;
		this.minDelayMs = opts.minDelayMs ?? 1_000;
		this.maxDelayMs = opts.maxDelayMs ?? 30_000;
		this.delay = this.minDelayMs;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.connect();
	}

	stop(): void {
		this.running = false;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.ws?.terminate();
		this.ws = undefined;
	}

	private connect(): void {
		const token = this.opts.token();
		if (!token) {
			this.emit("disconnected", "unconfigured");
			this.schedule();
			return;
		}
		const ws = new WebSocket(this.url, {
			headers: { authorization: `Bearer ${token}` },
			handshakeTimeout: DEFAULT_TIMEOUT_MS,
		});
		this.ws = ws;
		let reason = "closed";
		ws.on("message", (data) => this.onMessage(ws, String(data)));
		ws.on("unexpected-response", (_req, res) => {
			reason = res.statusCode === 401 || res.statusCode === 403 ? "unauthorized" : `http-${res.statusCode}`;
			res.resume();
		});
		// 'error' precedes 'close' and carries the errno (ECONNREFUSED...); without a listener it would throw
		ws.on("error", (err) => {
			reason = (err as NodeJS.ErrnoException).code ?? "error";
		});
		ws.on("close", () => {
			if (this.ws === ws) this.ws = undefined;
			this.emit("disconnected", reason);
			if (this.running) this.schedule();
		});
	}

	private onMessage(ws: WebSocket, raw: string): void {
		let msg: { type?: string; code?: string } & Partial<Omit<BeeperDomainEvent, "type">>;
		try {
			msg = JSON.parse(raw) as typeof msg;
		} catch {
			return;
		}
		switch (msg.type) {
			case "ready":
				ws.send(JSON.stringify({ type: "subscriptions.set", chatIDs: ["*"], app: { state: true } }));
				return;
			case "subscriptions.updated":
				this.delay = this.minDelayMs;
				this.emit("connected");
				return;
			case "error":
				this.emit("serverError", msg.code ?? "unknown");
				return;
			case "chat.upserted":
			case "chat.deleted":
			case "message.upserted":
			case "message.deleted":
				this.emit("event", msg as BeeperDomainEvent);
				return;
			default:
				return;
		}
	}

	private schedule(): void {
		if (!this.running) return;
		const wait = this.delay;
		this.delay = Math.min(this.delay * 2, this.maxDelayMs);
		this.timer = setTimeout(() => this.connect(), wait);
		this.timer.unref?.();
	}
}
