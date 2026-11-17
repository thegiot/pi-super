import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BAccount, type BAttachment, type BChat, BeeperClient, BeeperError, BeeperEvents, type BeeperDomainEvent, type BMessage } from "./beeper.js";
import { type ClassifyMessage, type Corrections, classify, DEFAULT_WINDOW_DAYS, isMeaningful, type Labels } from "./classify.js";
import { CorrectionsStore } from "./corrections.js";
import { ASSISTANT_MESSAGES, type AssistantSource } from "./assistant.js";
import { Outbox, type OutboxChatContext, type OutboxTunables } from "./outbox.js";

export type MessageKind =
	| "text"
	| "image"
	| "video"
	| "audio"
	| "file"
	| "sticker"
	| "location"
	| "notice"
	| "reaction"
	| "unknown";

export type ChatFilter = "reply" | "unread" | "all";

export interface ChatSummary {
	id: string;
	accountID: string;
	network: string;
	title: string;
	type: "single" | "group";
	participantCount: number;
	lastActivity?: string;
	unreadCount: number;
	mentions: number;
	preview: { kind: MessageKind; text?: string; senderName?: string; isSender: boolean; timestamp: string } | null;
	muted: boolean;
	archived: boolean;
	pinned: boolean;
	lowPriority: boolean;
	readOnly: boolean;
	maxTextLength?: number;
	labels: Labels;
	corrections: Corrections;
	accountStatus: string;
}

export interface ChatDetail extends ChatSummary {
	participants: { id: string; name: string; isSelf: boolean }[];
}

export interface MessageView {
	id: string;
	sortKey: string;
	timestamp: string;
	senderID: string;
	senderName?: string;
	isSender: boolean;
	kind: MessageKind;
	text?: string;
	edited: boolean;
	deleted: boolean;
	linkedMessageID?: string;
	attachments: {
		index: number;
		kind: MessageKind;
		name?: string;
		mime?: string;
		size?: number;
		width?: number;
		height?: number;
		url: string;
	}[];
	reactions: { key: string; count: number; mine: boolean }[];
}

export interface InboxState {
	beeper: { status: BeeperStatus; lastOkAt?: string; scope?: string[] };
	accounts: { id: string; network: string; status: string }[];
	updatedAt?: string;
	loading: boolean;
	/** the same numbers /api/inbox/chats reports, so the app's top bar needs one call */
	counts: ChatCounts;
	assistant: { status: "ok" | "unconfigured" };
}

export type BeeperStatus = "ok" | "slow" | "unreachable" | "unauthorized" | "unconfigured";

export interface ChatCounts {
	reply: number;
	unread: number;
	all: number;
}

export interface ChatsUpdate {
	changed: ChatSummary[];
	removed: string[];
	counts: ChatCounts;
}

export class InboxError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "InboxError";
	}
}

export interface InboxServiceOptions {
	baseUrl: string;
	tokenFile: string;
	stateDir: string;
	log: (msg: string) => void;
	timeoutMs?: number;
	/** safety net against a missed event (PRD §11.2) */
	refreshMs?: number;
	eventsMinDelayMs?: number;
	eventsMaxDelayMs?: number;
	windowDays?: number;
	now?: () => Date;
	/** presence of the assistant's key; read on every state build, never cached */
	assistantConfigured?: () => boolean;
	/** injectable outbox timings for tests */
	outbox?: OutboxTunables;
}

/** A refresh slower than this is reported as `slow`; the cache keeps serving meanwhile. */
const SLOW_MS = 2_000;
const REFRESH_MS = 5 * 60_000;
const CONFIG_RETRY_MS = 30_000;
const AUTH_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60_000;
const HISTORY_CONCURRENCY = 3;
const EVENT_BATCH_MS = 100;
const MAX_CACHED_CHATS = 200;
const MAX_CACHED_MESSAGES = 200;
const MAX_PREVIEW_CHARS = 300;
const ASSET_URL = /^(?:mxc|localmxc):\/\/[^\s/]+\/\S+$/;

/** Per chat: the newest page (oldest first) plus messages the browser has paged through. */
interface History {
	/** lastActivity of the chat when the newest page was fetched; stale once the chat moves on */
	key: string | undefined;
	newest: BMessage[];
	hasMore: boolean;
	oldestCursor?: string;
	byId: Map<string, BMessage>;
}

/**
 * Read-only view of Beeper, kept current from the event stream and resynced over HTTP on
 * every reconnect (events are at-most-once, with no replay). Nothing here writes to Beeper.
 */
export class InboxService extends EventEmitter {
	private readonly client: BeeperClient;
	private readonly corrections: CorrectionsStore;
	/**
	 * Controlled send (PRD §12.2): owned here so it shares the Beeper client, the chat
	 * cache and the service lifecycle. It is the only writer to Beeper, and only on
	 * the confirm path.
	 */
	readonly outbox: Outbox;
	private readonly clock: () => Date;
	private readonly refreshMs: number;
	private readonly windowDays: number;
	private events: BeeperEvents | undefined;

	private status: BeeperStatus = "unconfigured";
	private lastOkAt: string | undefined;
	private scope: string[] | undefined;
	private scopeToken: string | undefined;
	private failures = 0;
	private accounts = new Map<string, BAccount>();
	private selfIDs = new Set<string>();
	private chats = new Map<string, BChat>();
	private histories = new Map<string, History>();
	private inflight: Promise<void> | undefined;
	private rerun = false;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private pending = new Map<string, Set<string>>();
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** summaries as last broadcast, to send only what changed */
	private lastSent = new Map<string, string>();
	private lastCounts: string | undefined;

	constructor(private readonly opts: InboxServiceOptions) {
		super();
		this.client = new BeeperClient({
			baseUrl: opts.baseUrl,
			token: () => this.readToken(),
			timeoutMs: opts.timeoutMs,
		});
		this.corrections = new CorrectionsStore(join(opts.stateDir, "inbox-corrections.json"), opts.log);
		this.clock = opts.now ?? (() => new Date());
		this.refreshMs = opts.refreshMs ?? REFRESH_MS;
		this.windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
		this.outbox = new Outbox({
			beeper: this.client,
			chats: this,
			stateDir: opts.stateDir,
			log: opts.log,
			now: this.clock,
			...opts.outbox,
		});
	}

	start(): void {
		this.checkTokenFile();
		this.events = new BeeperEvents({
			baseUrl: this.opts.baseUrl,
			token: () => this.readToken(),
			minDelayMs: this.opts.eventsMinDelayMs,
			maxDelayMs: this.opts.eventsMaxDelayMs,
		});
		this.events.on("connected", () => {
			this.log("inbox: events connected");
			void this.refresh("reconnect");
		});
		this.events.on("disconnected", (reason: string) => this.log(`inbox: events disconnected: ${reason}`));
		this.events.on("serverError", (code: string) => this.log(`inbox: events server error: ${code}`));
		this.events.on("event", (ev: BeeperDomainEvent) => this.onEvent(ev));
		this.events.start();
		this.outbox.start();
		void this.refresh("start");
	}

	stop(): void {
		clearTimeout(this.refreshTimer);
		clearTimeout(this.flushTimer);
		this.refreshTimer = undefined;
		this.flushTimer = undefined;
		this.events?.stop();
		this.events = undefined;
		this.outbox.stop();
	}

	/** Re-reads Beeper now; scheduled refreshes are rearmed from the outcome. */
	refreshNow(): Promise<void> {
		return this.refresh("manual");
	}

	state(): InboxState {
		const now = this.clock();
		const counts = countsOf([...this.chats.values()].map((c) => ({ c, s: this.summarize(c, now) })));
		return {
			beeper: {
				status: this.status,
				...(this.lastOkAt ? { lastOkAt: this.lastOkAt } : {}),
				...(this.scope ? { scope: this.scope } : {}),
			},
			accounts: [...this.accounts.values()].map((a) => ({
				id: a.accountID,
				network: a.network ?? "",
				status: a.status,
			})),
			updatedAt: this.lastOkAt,
			loading: this.inflight !== undefined,
			counts,
			assistant: { status: this.opts.assistantConfigured?.() ? "ok" : "unconfigured" },
		};
	}

	list(query: { filter: ChatFilter; network?: string; q?: string }): {
		chats: ChatSummary[];
		counts: ChatCounts;
		updatedAt?: string;
		stale: boolean;
	} {
		const now = this.clock();
		const network = query.network?.trim().toLowerCase();
		const needle = query.q?.trim().toLowerCase();
		const rows = [...this.chats.values()]
			.map((c) => ({ c, s: this.summarize(c, now) }))
			.filter(({ c, s }) => {
				if (network && s.network.toLowerCase() !== network && s.accountID.toLowerCase() !== network) return false;
				return !needle || matchesText(c, s, needle);
			});
		const counts = countsOf(rows);
		const chats = rows
			.filter(({ c, s }) => {
				if (query.filter === "all") return true;
				if (query.filter === "reply") return s.labels.needsReply;
				return inUnreadView(c, s);
			})
			.map(({ s }) => s)
			.sort(byActivityDesc);
		return { chats, counts, updatedAt: this.lastOkAt, stale: this.status !== "ok" };
	}

	chat(id: string): ChatDetail | undefined {
		const c = this.chats.get(id);
		if (!c) return undefined;
		const participants = (c.participants?.items ?? []).map((p) => ({
			id: p.id,
			name: p.fullName || p.username || p.phoneNumber || p.id,
			isSelf: p.isSelf === true || this.selfIDs.has(p.id),
		}));
		return { ...this.summarize(c, this.clock()), participants };
	}

	/** Every chat, for a freshly connected socket. The per-socket view is not the broadcast diff. */
	snapshot(): ChatsUpdate {
		const now = this.clock();
		const rows = [...this.chats.values()].map((c) => ({ c, s: this.summarize(c, now) }));
		return { changed: rows.map((r) => r.s), removed: [], counts: countsOf(rows) };
	}

	/**
	 * The open chat as the assistant may see it: its own meaningful messages, the newest
	 * ASSISTANT_MESSAGES of them, and the classifier's verdict in plain codes. Nothing from other chats.
	 */
	async assistantSource(chatID: string): Promise<AssistantSource> {
		const c = this.requireChat(chatID);
		const h = this.freshHistory(c) ?? (await this.fetchNewest(c));
		let items = h.newest;
		let cursor = h.hasMore ? h.oldestCursor : undefined;
		for (let page = 0; cursor && page < 2 && items.filter((m) => isMeaningful(this.toClassify(m))).length < ASSISTANT_MESSAGES; page++) {
			const older = await this.client.listMessages(chatID, { cursor });
			items = [...sortMessages(older.items), ...items];
			cursor = older.hasMore ? (older.oldestCursor ?? undefined) : undefined;
		}
		const summary = this.summarize(c, this.clock());
		const meaningful = items.filter((m) => isMeaningful(this.toClassify(m))).slice(-ASSISTANT_MESSAGES);
		return {
			meta: {
				title: c.title,
				network: summary.network,
				type: c.type,
				participantCount: summary.participantCount,
				needsReply: summary.labels.needsReply,
				reasons: summary.labels.reasons.map((r) => (r.code === "dm_waiting" ? { code: r.code, since: r.since } : { code: r.code })),
				...(summary.labels.excludedBy ? { excludedBy: summary.labels.excludedBy } : {}),
				incomplete: summary.labels.incomplete,
			},
			messages: meaningful.map((m) => ({
				timestamp: m.timestamp,
				isSender: m.isSender === true || this.selfIDs.has(m.senderID),
				...(m.senderName ? { from: m.senderName } : {}),
				...(m.text !== undefined ? { text: m.text } : {}),
				attachments: (m.attachments ?? []).map((a) => ({ kind: attachmentKind(a), name: a.fileName })),
			})),
		};
	}

	async messages(chatID: string, cursor?: string): Promise<{ messages: MessageView[]; nextCursor: string | null }> {
		const c = this.requireChat(chatID);
		if (cursor === undefined) {
			const h = this.freshHistory(c) ?? (await this.fetchNewest(c));
			return { messages: this.views(chatID, h.newest), nextCursor: h.hasMore ? (h.oldestCursor ?? null) : null };
		}
		const page = await this.client.listMessages(chatID, { cursor });
		const items = sortMessages(page.items);
		const h = this.histories.get(chatID) ?? this.newHistory(undefined);
		for (const m of items) this.remember(h, m);
		this.touch(chatID, h);
		return { messages: this.views(chatID, items), nextCursor: page.hasMore ? (page.oldestCursor ?? null) : null };
	}

	setNoReply(chatID: string, on: boolean): ChatSummary {
		const c = this.requireChat(chatID);
		this.corrections.update(chatID, { noReplyAt: on ? this.newestKnownTimestamp(c) : undefined });
		return this.afterCorrection(chatID);
	}

	snooze(chatID: string, until: string | null): ChatSummary {
		this.requireChat(chatID);
		let snoozeUntil: string | undefined;
		if (until !== null) {
			const t = Date.parse(until);
			if (!Number.isFinite(t) || t <= this.clock().getTime()) throw new InboxError(400, "until must be a future time");
			snoozeUntil = new Date(t).toISOString();
		}
		this.corrections.update(chatID, { snoozeUntil });
		return this.afterCorrection(chatID);
	}

	mark(chatID: string, on: boolean): ChatSummary {
		this.requireChat(chatID);
		this.corrections.update(chatID, { marked: on });
		return this.afterCorrection(chatID);
	}

	priority(chatID: string, on: boolean): ChatSummary {
		this.requireChat(chatID);
		this.corrections.update(chatID, { priority: on });
		return this.afterCorrection(chatID);
	}

	/**
	 * The upstream response for one attachment of a message this service has read. The
	 * caller never supplies a URL: the source is taken from the cached message, and only
	 * Beeper's own asset schemes are passed on.
	 */
	async attachment(chatID: string, messageID: string, index: number): Promise<Response> {
		const c = this.requireChat(chatID);
		let msg = this.histories.get(chatID)?.byId.get(messageID);
		if (!msg) msg = (await this.fetchNewest(c)).byId.get(messageID);
		if (!msg || msg.isDeleted) throw new InboxError(404, "message not found");
		const att: BAttachment | undefined = msg.attachments?.[index];
		if (!att) throw new InboxError(404, "attachment not found");
		const src = att.srcURL;
		if (!src) throw new InboxError(404, "attachment has no source");
		if (!ASSET_URL.test(src)) throw new InboxError(400, "unsupported attachment source");
		try {
			return await this.client.serveAsset(src);
		} catch {
			throw new InboxError(502, "attachment unavailable");
		}
	}

	// ---------------------------------------------------------------- refresh

	private refresh(reason: string): Promise<void> {
		if (this.inflight) {
			this.rerun = true;
			return this.inflight;
		}
		this.inflight = this.doRefresh(reason).finally(() => {
			this.inflight = undefined;
			if (this.rerun) {
				this.rerun = false;
				void this.refresh("queued");
			}
		});
		return this.inflight;
	}

	private async doRefresh(reason: string): Promise<void> {
		clearTimeout(this.refreshTimer);
		const token = this.readToken();
		if (!token) {
			this.setStatus("unconfigured");
			this.scheduleRefresh(CONFIG_RETRY_MS);
			return;
		}
		const started = Date.now();
		try {
			await this.ensureScope(token);
			await this.client.info();
			const accounts = await this.client.accounts();
			const list = await this.client.listAllChats();
			this.accounts = new Map(accounts.map((a) => [a.accountID, a]));
			this.selfIDs = new Set(accounts.flatMap((a) => (a.user?.id ? [a.user.id] : [])));
			this.chats = new Map(list.filter((c) => !c.mergedIntoChatID).map((c) => [c.id, c]));
			const toFetch = [...this.chats.values()].filter((c) => this.needsHistory(c) && !this.freshHistory(c));
			await mapLimit(toFetch, HISTORY_CONCURRENCY, (c) => this.fetchNewestTolerant(c));
			const ms = Date.now() - started;
			this.lastOkAt = this.clock().toISOString();
			this.failures = 0;
			this.log(`inbox: refresh ${reason} ok chats=${this.chats.size} accounts=${accounts.length} history=${toFetch.length} ms=${ms}`);
			this.setStatus(ms > SLOW_MS ? "slow" : "ok");
			this.broadcastChats();
			this.scheduleRefresh(this.refreshMs);
		} catch (err) {
			const kind = err instanceof BeeperError ? err.kind : "other";
			this.failures++;
			this.log(
				`inbox: refresh ${reason} failed: ${kind}${err instanceof BeeperError && err.status ? ` HTTP ${err.status}` : ""} after ${Date.now() - started}ms`,
			);
			this.setStatus(kind === "unauthorized" ? "unauthorized" : "unreachable");
			this.scheduleRefresh(
				kind === "unauthorized" ? AUTH_RETRY_MS : Math.min(MAX_RETRY_MS, 5_000 * 2 ** (this.failures - 1)),
			);
		}
	}

	private async ensureScope(token: string): Promise<void> {
		if (this.scopeToken === token) return;
		const { active, scope } = await this.client.introspect();
		if (!active) throw new BeeperError("unauthorized", undefined, "token is not active");
		this.scope = scope.split(/\s+/).filter(Boolean);
		this.scopeToken = token;
		this.log(`inbox: token scope: ${this.scope.join(" ") || "(none)"}`);
		if (this.scope.includes("write")) {
			this.log("inbox: WARNING token has write scope — the inbox only reads, a read-only token is safer");
		}
	}

	private scheduleRefresh(ms: number): void {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => void this.refresh("timer"), ms);
		this.refreshTimer.unref?.();
	}

	private setStatus(status: BeeperStatus): void {
		this.status = status;
		this.emit("state", this.state());
	}

	private readToken(): string | undefined {
		try {
			return readFileSync(this.opts.tokenFile, "utf8").trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private checkTokenFile(): void {
		try {
			if ((statSync(this.opts.tokenFile).mode & 0o077) !== 0) {
				this.log(`inbox: token file ${this.opts.tokenFile} is readable by group/other — chmod 600 it`);
			}
		} catch {
			// no token file yet: reported as unconfigured
		}
	}

	// ---------------------------------------------------------------- events

	private onEvent(ev: BeeperDomainEvent): void {
		this.log(`inbox: event ${ev.type} ids=${ev.ids.length}`);
		if (ev.type === "chat.deleted") {
			for (const id of ev.ids) this.removeChat(id);
			this.broadcastChats();
			return;
		}
		if (ev.type === "chat.upserted") {
			for (const id of ev.ids) this.queue(id, undefined);
		} else {
			this.queue(ev.chatID, ev.ids);
		}
	}

	/** Coalesces bursts: a message event fans out to one chat fetch, not one per event. */
	private queue(chatID: string, messageIDs: string[] | undefined): void {
		const ids = this.pending.get(chatID) ?? new Set<string>();
		for (const id of messageIDs ?? []) ids.add(id);
		this.pending.set(chatID, ids);
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => void this.flush(), EVENT_BATCH_MS);
			this.flushTimer.unref?.();
		}
	}

	private async flush(): Promise<void> {
		this.flushTimer = undefined;
		const batch = this.pending;
		this.pending = new Map();
		for (const [chatID, messageIDs] of batch) {
			try {
				const fresh = await this.client.getChat(chatID);
				if (fresh.mergedIntoChatID) {
					this.removeChat(chatID);
					continue;
				}
				const prev = this.chats.get(chatID);
				const merged: BChat = { ...fresh, preview: fresh.preview ?? prev?.preview ?? null };
				this.chats.set(chatID, merged);
				if (messageIDs.size > 0 || this.needsHistory(merged)) {
					const h = messageIDs.size > 0 ? await this.fetchNewest(merged) : (this.freshHistory(merged) ?? (await this.fetchNewest(merged)));
					const views = [...messageIDs].flatMap((id) => {
						const m = h.byId.get(id);
						return m && !m.isHidden ? [m] : [];
					});
					if (views.length > 0) this.emit("messages", { chatID, messages: this.views(chatID, views) });
				}
			} catch (err) {
				if (err instanceof BeeperError && err.status === 404) {
					this.removeChat(chatID);
				} else {
					this.log(`inbox: event refresh failed for chat ${chatID}: ${err instanceof BeeperError ? err.kind : "other"}`);
					void this.refresh("event-error");
				}
			}
		}
		this.broadcastChats();
	}

	private removeChat(id: string): void {
		this.chats.delete(id);
		this.histories.delete(id);
	}

	// ---------------------------------------------------------------- history cache

	private needsHistory(c: BChat): boolean {
		if (c.type === "group") return c.unreadCount > 0 || (c.unreadMentionsCount ?? 0) > 0;
		return !(c.preview && isMeaningful(this.toClassify(c.preview)));
	}

	private freshHistory(c: BChat): History | undefined {
		const h = this.histories.get(c.id);
		return h && h.key !== undefined && h.key === c.lastActivity ? h : undefined;
	}

	private async fetchNewest(c: BChat): Promise<History> {
		const page = await this.client.listMessages(c.id);
		const sorted = sortMessages(page.items);
		const h = this.histories.get(c.id) ?? this.newHistory(c.lastActivity);
		h.key = c.lastActivity;
		h.newest = sorted;
		h.hasMore = page.hasMore;
		h.oldestCursor = page.oldestCursor ?? undefined;
		for (const m of sorted) this.remember(h, m);
		this.touch(c.id, h);
		const last = sorted.at(-1);
		if (last) c.preview = last;
		return h;
	}

	private async fetchNewestTolerant(c: BChat): Promise<void> {
		try {
			await this.fetchNewest(c);
		} catch (err) {
			// one unreadable chat must not hold back the whole list: it stays incomplete
			if (err instanceof BeeperError && err.kind === "failed") {
				this.log(`inbox: history unavailable for chat ${c.id} HTTP ${err.status ?? "?"}`);
				return;
			}
			throw err;
		}
	}

	private newHistory(key: string | undefined): History {
		return { key, newest: [], hasMore: false, byId: new Map() };
	}

	private remember(h: History, m: BMessage): void {
		h.byId.delete(m.id);
		h.byId.set(m.id, m);
		if (h.byId.size > MAX_CACHED_MESSAGES) h.byId.delete(h.byId.keys().next().value as string);
	}

	private touch(chatID: string, h: History): void {
		this.histories.delete(chatID);
		this.histories.set(chatID, h);
		if (this.histories.size > MAX_CACHED_CHATS) this.histories.delete(this.histories.keys().next().value as string);
	}

	// ---------------------------------------------------------------- views

	private requireChat(chatID: string): BChat {
		const c = this.chats.get(chatID);
		if (!c) throw new InboxError(404, "chat not found");
		return c;
	}

	// ---------------------------------------------------------------- outbox reads
	// What the outbox resolves recipients and reconciles sends from: the same cache
	// the UI sees (RF19), no extra read path.

	sendContext(chatID: string): OutboxChatContext | undefined {
		const chat = this.chats.get(chatID);
		if (!chat) return undefined;
		return { chat, account: this.accounts.get(chat.accountID), selfIDs: this.selfIDs };
	}

	peekMessage(chatID: string, messageID: string): BMessage | undefined {
		return this.histories.get(chatID)?.byId.get(messageID);
	}

	private toClassify(m: BMessage): ClassifyMessage {
		return {
			id: m.id,
			timestamp: m.timestamp,
			senderID: m.senderID,
			isSender: m.isSender === true,
			type: m.type ?? "TEXT",
			isDeleted: m.isDeleted === true,
			isHidden: m.isHidden === true,
			mentions: m.mentions ?? null,
			...(m.linkedMessageID ? { linkedMessageID: m.linkedMessageID } : {}),
		};
	}

	private summarize(c: BChat, now: Date): ChatSummary {
		const account = this.accounts.get(c.accountID);
		const h = this.freshHistory(c);
		const corrections = this.corrections.get(c.id);
		const labels = classify({
			chat: {
				id: c.id,
				type: c.type,
				isReadOnly: c.isReadOnly === true,
				isArchived: c.isArchived === true,
				isLowPriority: c.isLowPriority === true,
				isMuted: c.isMuted === true,
				isPinned: c.isPinned === true,
				isMarkedUnread: c.isMarkedUnread === true,
				unreadCount: c.unreadCount,
				unreadMentionsCount: c.unreadMentionsCount ?? 0,
				...(c.lastActivity ? { lastActivity: c.lastActivity } : {}),
			},
			preview: c.preview ? this.toClassify(c.preview) : null,
			...(h ? { history: h.newest.map((m) => this.toClassify(m)) } : {}),
			corrections,
			selfIDs: this.selfIDs,
			now,
			windowDays: this.windowDays,
		});
		return {
			id: c.id,
			accountID: c.accountID,
			network: c.network ?? account?.network ?? c.accountID,
			title: c.title,
			type: c.type,
			participantCount: c.participants?.total ?? c.participants?.items.length ?? 0,
			...(c.lastActivity ? { lastActivity: c.lastActivity } : {}),
			unreadCount: c.unreadCount,
			mentions: c.unreadMentionsCount ?? 0,
			preview: c.preview ? previewView(c.preview, this.selfIDs) : null,
			muted: c.isMuted === true,
			archived: c.isArchived === true,
			pinned: c.isPinned === true,
			lowPriority: c.isLowPriority === true,
			readOnly: c.isReadOnly === true,
			...(c.capabilities?.maxTextLength ? { maxTextLength: c.capabilities.maxTextLength } : {}),
			labels,
			corrections,
			accountStatus: account?.status ?? "unknown",
		};
	}

	private views(chatID: string, messages: BMessage[]): MessageView[] {
		return messages.filter((m) => !m.isHidden).map((m) => this.view(chatID, m));
	}

	private view(chatID: string, m: BMessage): MessageView {
		const deleted = m.isDeleted === true;
		const reactions = new Map<string, { count: number; mine: boolean }>();
		for (const r of m.reactions ?? []) {
			const cur = reactions.get(r.reactionKey) ?? { count: 0, mine: false };
			cur.count++;
			cur.mine ||= r.participantID !== undefined && this.selfIDs.has(r.participantID);
			reactions.set(r.reactionKey, cur);
		}
		return {
			id: m.id,
			sortKey: m.sortKey,
			timestamp: m.timestamp,
			senderID: m.senderID,
			...(m.senderName ? { senderName: m.senderName } : {}),
			isSender: m.isSender === true || this.selfIDs.has(m.senderID),
			kind: kindOf(m.type),
			...(!deleted && m.text !== undefined ? { text: m.text } : {}),
			edited: m.editedTimestamp !== undefined && m.editedTimestamp !== null,
			deleted,
			...(m.linkedMessageID ? { linkedMessageID: m.linkedMessageID } : {}),
			attachments: deleted
				? []
				: (m.attachments ?? []).map((a, index) => ({
						index,
						kind: attachmentKind(a),
						...(a.fileName ? { name: a.fileName } : {}),
						...(a.mimeType ? { mime: a.mimeType } : {}),
						...(a.fileSize !== undefined ? { size: a.fileSize } : {}),
						...(a.size?.width !== undefined ? { width: a.size.width } : {}),
						...(a.size?.height !== undefined ? { height: a.size.height } : {}),
						url: `/api/inbox/attachments/${encodeURIComponent(chatID)}/${encodeURIComponent(m.id)}/${index}`,
					})),
			reactions: [...reactions].map(([key, v]) => ({ key, ...v })),
		};
	}

	private newestKnownTimestamp(c: BChat): string {
		const candidates = [c.preview?.timestamp, this.histories.get(c.id)?.newest.at(-1)?.timestamp, c.lastActivity];
		let best: string | undefined;
		for (const t of candidates) {
			if (t && (best === undefined || Date.parse(t) > Date.parse(best))) best = t;
		}
		return best ?? this.clock().toISOString();
	}

	private afterCorrection(chatID: string): ChatSummary {
		this.broadcastChats();
		return this.summarize(this.requireChat(chatID), this.clock());
	}

	private broadcastChats(): void {
		const now = this.clock();
		const rows = [...this.chats.values()].map((c) => ({ c, s: this.summarize(c, now) }));
		const changed: ChatSummary[] = [];
		const seen = new Set<string>();
		for (const { s } of rows) {
			seen.add(s.id);
			const json = JSON.stringify(s);
			if (this.lastSent.get(s.id) !== json) {
				this.lastSent.set(s.id, json);
				changed.push(s);
			}
		}
		const removed = [...this.lastSent.keys()].filter((id) => !seen.has(id));
		for (const id of removed) this.lastSent.delete(id);
		const counts = countsOf(rows);
		const countsJson = JSON.stringify(counts);
		if (countsJson !== this.lastCounts) {
			this.lastCounts = countsJson;
			this.emit("state", this.state());
		}
		if (changed.length === 0 && removed.length === 0) return;
		this.emit("chats", { changed, removed, counts } satisfies ChatsUpdate);
	}

	private log(msg: string): void {
		this.opts.log(msg);
	}
}

function matchesText(c: BChat, s: ChatSummary, needle: string): boolean {
	if (s.title.toLowerCase().includes(needle)) return true;
	return (c.participants?.items ?? []).some((p) => `${p.fullName ?? ""} ${p.username ?? ""}`.toLowerCase().includes(needle));
}

/** The unread tab: archived and low-priority chats are only in "all"; muted ones only with a mention. */
function inUnreadView(c: BChat, s: ChatSummary): boolean {
	if (!(c.unreadCount > 0 || c.isMarkedUnread === true)) return false;
	if (s.archived || s.lowPriority) return false;
	return !s.muted || s.mentions > 0;
}

function countsOf(rows: { c: BChat; s: ChatSummary }[]): ChatCounts {
	let reply = 0;
	let unread = 0;
	for (const { c, s } of rows) {
		if (s.labels.needsReply) reply++;
		if (inUnreadView(c, s)) unread++;
	}
	return { reply, unread, all: rows.length };
}

function byActivityDesc(a: ChatSummary, b: ChatSummary): number {
	return (Date.parse(b.lastActivity ?? "") || 0) - (Date.parse(a.lastActivity ?? "") || 0);
}

function sortMessages(items: BMessage[]): BMessage[] {
	return [...items].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || (a.sortKey < b.sortKey ? -1 : 1));
}

function previewView(m: BMessage, selfIDs: ReadonlySet<string>): NonNullable<ChatSummary["preview"]> {
	const text = m.isDeleted || m.text === undefined ? undefined : truncate(m.text, MAX_PREVIEW_CHARS);
	return {
		kind: kindOf(m.type),
		...(text !== undefined ? { text } : {}),
		...(m.senderName ? { senderName: m.senderName } : {}),
		isSender: m.isSender === true || selfIDs.has(m.senderID),
		timestamp: m.timestamp,
	};
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function kindOf(type: string | undefined): MessageKind {
	switch (type) {
		case "TEXT":
			return "text";
		case "IMAGE":
			return "image";
		case "VIDEO":
			return "video";
		case "VOICE":
		case "AUDIO":
			return "audio";
		case "FILE":
			return "file";
		case "STICKER":
			return "sticker";
		case "LOCATION":
			return "location";
		case "NOTICE":
			return "notice";
		case "REACTION":
			return "reaction";
		default:
			return "unknown";
	}
}

function attachmentKind(a: BAttachment): MessageKind {
	if (a.isSticker) return "sticker";
	if (a.isVoiceNote) return "audio";
	switch (a.type) {
		case "img":
			return "image";
		case "video":
			return "video";
		case "audio":
			return "audio";
		default:
			return "unknown";
	}
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
