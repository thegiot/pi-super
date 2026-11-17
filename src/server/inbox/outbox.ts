import { EventEmitter } from "node:events";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BAccount, type BChat, type BeeperClient, BeeperError, type BMessage } from "./beeper.js";
import { InboxError } from "./service.js";

/*
 * Controlled send (PRD §12.2, F5–F6, RF17–RF23). The only place in the codebase that
 * can make Beeper write: `confirm` is the single caller of `BeeperClient.sendMessage`.
 *
 * - Two steps: `create` stores the intent and mints a single-use confirm token bound
 *   to the fingerprint of chat+text+replyTo; only `confirm` reaches Beeper.
 * - The client key makes `create` idempotent; the record is persisted BEFORE the
 *   Beeper call, so a restart mid-send lands on `uncertain`, never on a resend.
 * - D8: the text lives in the file only while the intent is non-final; afterwards
 *   only its sha256 and the metadata remain, and finalized intents are pruned
 *   after 30 days. `reissue` therefore asks the client for the text again and only
 *   accepts it if it hashes to the same value.
 * - Limits: one chat per intent, a fixed number of confirms per minute, no batch.
 * - Logs never carry text, titles or names — `inbox: send <state> intent=<id8> ms=<n>`.
 */

export type OutboxState =
	| "pending_confirm"
	| "sending"
	| "pending"
	| "uncertain"
	| "sent"
	| "failed"
	| "not_found"
	| "cancelled"
	| "expired";

const FINAL: ReadonlySet<OutboxState> = new Set(["sent", "failed", "not_found", "cancelled", "expired"]);
const REISSUABLE: ReadonlySet<OutboxState> = new Set(["failed", "not_found", "uncertain"]);

export interface RecipientPreview {
	network: string;
	accountID: string;
	accountLabel: string;
	title: string;
	type: "single" | "group";
	participantCount: number;
	/** the other party of a single chat, when resolvable */
	peerLabel?: string;
	/** the network's declared limit; null means "nessun limite dichiarato" */
	maxLength: number | null;
}

interface Intent {
	id: string;
	/** client idempotency key: the intent's identity, so a retried create never duplicates */
	key: string;
	chatID: string;
	/** present only while the state is non-final (D8) */
	text?: string;
	textHash: string;
	/** sha256 of chat+text+replyTo: what the confirm token is bound to */
	fingerprint: string;
	replyToMessageID?: string;
	createdAt: string;
	charCount: number;
	state: OutboxState;
	confirmToken?: string;
	confirmExpires?: string;
	resolvedChatID?: string;
	pendingMessageID?: string;
	sentAt?: string;
	finalState?: OutboxState;
	finalAt?: string;
	reason?: string;
	sendAttempts: number;
	reconcileMisses?: number;
	firstMissAt?: string;
	/** display snapshot kept for after the chat may have left the live cache */
	recipient: RecipientPreview;
	replyPreview?: { author?: string; text?: string };
}

export interface OutboxIntentView {
	id: string;
	key: string;
	chatID: string;
	state: OutboxState;
	finalState?: OutboxState;
	reason?: string;
	sendAttempts: number;
	charCount: number;
	textHash: string;
	createdAt: string;
	sentAt?: string;
	expiresAt?: string;
	resolvedChatID?: string;
	recipient: RecipientPreview;
	replyTo?: { author?: string; text?: string };
}

export interface OutboxCreated {
	intent: OutboxIntentView;
	confirmToken?: string;
	expiresAt?: string;
}

/** What the outbox needs from the inbox service: cached chats, accounts, self ids. */
export interface OutboxChatContext {
	chat: BChat;
	account?: BAccount;
	selfIDs: ReadonlySet<string>;
}

export interface OutboxChats {
	sendContext(chatID: string): OutboxChatContext | undefined;
	peekMessage(chatID: string, messageID: string): BMessage | undefined;
}

/** Injectable knobs, so tests can shrink the state machine's waits. */
export interface OutboxTunables {
	confirmTtlMs?: number;
	pollIntervalMs?: number;
	pollBudgetMs?: number;
	confirmPerMinute?: number;
	reconcileMaxMisses?: number;
	reconcileMinSpanMs?: number;
	retainFinalMs?: number;
	sweepMs?: number;
}

export interface OutboxOptions extends OutboxTunables {
	beeper: BeeperClient;
	chats: OutboxChats;
	stateDir: string;
	/** defaults to <stateDir>/outbox.json */
	file?: string;
	log: (msg: string) => void;
	now?: () => Date;
}

const MAX_KEY = 80;
const MAX_TEXT = 20_000;
const REPLY_SNIPPET = 120;
const RECONCILE_SLACK_MS = 5_000;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Outbox extends EventEmitter {
	private intents = new Map<string, Intent>();
	private readonly beeper: BeeperClient;
	private readonly chats: OutboxChats;
	private readonly file: string;
	private readonly optsLog: (msg: string) => void;
	private readonly clock: () => Date;
	private readonly confirmTtlMs: number;
	private readonly pollIntervalMs: number;
	private readonly pollBudgetMs: number;
	private readonly confirmPerMinute: number;
	private readonly reconcileMaxMisses: number;
	private readonly reconcileMinSpanMs: number;
	private readonly retainFinalMs: number;
	private readonly sweepMs: number;

	private confirmHits: number[] = [];
	private confirming = new Set<string>();
	private sends = new Map<string, Promise<void>>();
	private sweepTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;

	constructor(opts: OutboxOptions) {
		super();
		this.beeper = opts.beeper;
		this.chats = opts.chats;
		this.file = opts.file ?? join(opts.stateDir, "outbox.json");
		this.optsLog = opts.log;
		this.clock = opts.now ?? (() => new Date());
		this.confirmTtlMs = opts.confirmTtlMs ?? 120_000;
		this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
		this.pollBudgetMs = opts.pollBudgetMs ?? 30_000;
		this.confirmPerMinute = opts.confirmPerMinute ?? 10;
		this.reconcileMaxMisses = opts.reconcileMaxMisses ?? 3;
		this.reconcileMinSpanMs = opts.reconcileMinSpanMs ?? 120_000;
		this.retainFinalMs = opts.retainFinalMs ?? 30 * 24 * 3_600_000;
		this.sweepMs = opts.sweepMs ?? 30_000;
	}

	/**
	 * Loads the journal, demotes anything left mid-flight to `uncertain` (a restart
	 * must never resend) and runs one reconciliation pass over it.
	 */
	start(): void {
		this.stopped = false;
		this.load();
		const leftover = [...this.intents.values()].filter((i) => i.state === "sending" || i.state === "pending" || i.state === "uncertain");
		for (const intent of leftover) {
			if (intent.state !== "uncertain") this.transition(intent, "uncertain");
		}
		this.sweep();
		void (async () => {
			for (const intent of leftover) {
				await this.reconcile(intent.id).catch(() => {});
			}
		})();
		this.sweepTimer = setInterval(() => this.sweep(), this.sweepMs);
		this.sweepTimer.unref?.();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.sweepTimer);
		this.sweepTimer = undefined;
	}

	/** Test hook: resolves when the intent's in-flight send/poll has settled. */
	async settle(id: string): Promise<OutboxIntentView> {
		await this.sends.get(id);
		return this.get(id);
	}

	get(id: string): OutboxIntentView {
		const intent = this.require(id);
		this.expireIfNeeded(intent);
		return this.view(intent);
	}

	async create(args: { key: unknown; chatID: unknown; text: unknown; replyToMessageID?: unknown }): Promise<OutboxCreated> {
		const key = requireString(args.key, "key", 1, MAX_KEY);
		const chatID = requireString(args.chatID, "chatID", 1, 500);
		const text = requireString(args.text, "text", 1, MAX_TEXT);
		const replyToMessageID =
			args.replyToMessageID === undefined || args.replyToMessageID === null
				? undefined
				: requireString(args.replyToMessageID, "replyToMessageID", 1, 500);

		const existing = [...this.intents.values()].find((i) => i.key === key);
		if (existing) {
			this.expireIfNeeded(existing);
			// The key is the intent's identity: the same create twice is the same intent,
			// never a second way to Beeper — not even across a restart.
			return {
				intent: this.view(existing),
				...(existing.state === "pending_confirm" && existing.confirmToken
					? { confirmToken: existing.confirmToken, expiresAt: existing.confirmExpires }
					: {}),
			};
		}

		const ctx = this.chats.sendContext(chatID);
		if (!ctx) throw new InboxError(404, "chat not found");
		if (ctx.chat.isReadOnly === true || ctx.chat.isArchived === true) throw new InboxError(409, "chat_not_sendable");
		if (ctx.account && ctx.account.status !== "connected") throw new InboxError(409, "chat_not_sendable");

		const replyPreview = replyToMessageID ? await this.replyPreview(ctx, replyToMessageID) : undefined;
		const now = this.clock();
		const intent: Intent = {
			id: randomBytes(8).toString("hex"),
			key,
			chatID,
			text,
			textHash: sha256(text),
			fingerprint: fingerprint(chatID, text, replyToMessageID),
			...(replyToMessageID ? { replyToMessageID } : {}),
			createdAt: now.toISOString(),
			charCount: text.length,
			state: "pending_confirm",
			sendAttempts: 0,
			recipient: previewOf(ctx),
			...(replyPreview ? { replyPreview } : {}),
		};
		this.mintToken(intent);
		this.intents.set(intent.id, intent);
		this.transitioned(intent, "pending_confirm");
		return { intent: this.view(intent), confirmToken: intent.confirmToken, expiresAt: intent.confirmExpires };
	}

	/**
	 * The only path that can reach `sendMessage`. Everything is checked before the
	 * state flips to `sending`, and the journal is written before the network call.
	 */
	async confirm(id: string, token: unknown): Promise<OutboxIntentView> {
		const intent = this.require(id);
		// A confirm attempted on a stale token is the documented 410, not an idempotent read.
		if (intent.state === "pending_confirm" && this.isExpired(intent)) {
			this.transition(intent, "expired");
			throw new InboxError(410, "confirm_expired");
		}
		if (intent.state === "expired") throw new InboxError(410, "confirm_expired");
		// A repeat — including a retried request after a network error — returns the
		// recorded state (CA11): at most one Beeper call per intent.
		if (intent.state !== "pending_confirm") return this.view(intent);
		if (this.confirming.has(intent.id)) return this.view(intent);
		if (
			typeof token !== "string" ||
			!intent.confirmToken ||
			!timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(intent.confirmToken)))
		) {
			throw new InboxError(409, "confirm_invalid");
		}
		if (intent.text === undefined || fingerprint(intent.chatID, intent.text, intent.replyToMessageID) !== intent.fingerprint) {
			throw new InboxError(409, "confirm_invalid");
		}
		const nowMs = Date.now();
		this.confirmHits = this.confirmHits.filter((t) => nowMs - t < 60_000);
		if (this.confirmHits.length >= this.confirmPerMinute) throw new InboxError(429, "outbox_rate_limited");
		this.confirming.add(intent.id);
		try {
			// Pre-check: a dead Beeper cannot confirm a send, and the token stays usable.
			try {
				await this.beeper.info();
			} catch {
				throw new InboxError(503, "beeper_unavailable");
			}
			this.confirmHits.push(nowMs);
			const send = this.runSend(intent).finally(() => this.sends.delete(intent.id));
			this.sends.set(intent.id, send);
			return this.view(intent);
		} finally {
			this.confirming.delete(intent.id);
		}
	}

	cancel(id: string): OutboxIntentView {
		const intent = this.require(id);
		this.expireIfNeeded(intent);
		if (intent.state !== "pending_confirm") throw new InboxError(409, "outbox_state");
		this.transition(intent, "cancelled");
		return this.view(intent);
	}

	/**
	 * A retry still passes through the review sheet: back to `pending_confirm` with a
	 * fresh token. Finalized intents no longer hold the text (D8), so the client must
	 * present it again — and only the original text verifies against the stored hash.
	 */
	reissue(id: string, text: unknown): OutboxCreated {
		const intent = this.require(id);
		if (!REISSUABLE.has(intent.state)) throw new InboxError(409, "outbox_state");
		if (intent.text === undefined) {
			if (typeof text !== "string" || sha256(text) !== intent.textHash) throw new InboxError(409, "confirm_invalid");
			intent.text = text;
		}
		delete intent.confirmToken;
		delete intent.confirmExpires;
		delete intent.resolvedChatID;
		delete intent.pendingMessageID;
		delete intent.sentAt;
		delete intent.finalState;
		delete intent.finalAt;
		delete intent.reason;
		delete intent.reconcileMisses;
		delete intent.firstMissAt;
		this.mintToken(intent);
		this.transition(intent, "pending_confirm");
		return { intent: this.view(intent), confirmToken: intent.confirmToken, expiresAt: intent.confirmExpires };
	}

	/**
	 * Reconciliation for `uncertain`: look for our own message with the same text hash
	 * sent at or after the send attempt. Repeated misses (3 over ≥2 minutes by
	 * default) settle on `not_found`.
	 */
	async reconcile(id: string): Promise<OutboxIntentView> {
		const intent = this.require(id);
		if (intent.state !== "uncertain") return this.view(intent);
		let page: { items: BMessage[] };
		try {
			page = await this.beeper.listMessages(intent.resolvedChatID ?? intent.chatID);
		} catch (err) {
			if (err instanceof BeeperError) throw new InboxError(503, "beeper_unavailable");
			throw err;
		}
		const selfIDs = this.chats.sendContext(intent.chatID)?.selfIDs ?? new Set<string>();
		const sentAtMs = Date.parse(intent.sentAt ?? intent.createdAt);
		const match = page.items.find(
			(m) =>
				(m.isSender === true || selfIDs.has(m.senderID)) &&
				m.isDeleted !== true &&
				m.text !== undefined &&
				sha256(m.text) === intent.textHash &&
				Date.parse(m.timestamp) >= sentAtMs - RECONCILE_SLACK_MS,
		);
		if (match) {
			const status = match.sendStatus?.status;
			if (status === "FAIL_RETRIABLE" || status === "FAIL_PERMANENT") {
				intent.reason = match.sendStatus?.reason ?? status.toLowerCase();
				this.transition(intent, "failed");
			} else {
				this.transition(intent, "sent");
			}
			return this.view(intent);
		}
		intent.reconcileMisses = (intent.reconcileMisses ?? 0) + 1;
		intent.firstMissAt ??= this.clock().toISOString();
		this.save();
		this.log(`inbox: reconcile miss intent=${intent.id.slice(0, 8)} n=${intent.reconcileMisses}`);
		if (
			intent.reconcileMisses >= this.reconcileMaxMisses &&
			this.clock().getTime() - Date.parse(intent.firstMissAt) >= this.reconcileMinSpanMs
		) {
			this.transition(intent, "not_found");
		}
		return this.view(intent);
	}

	/** Expires stale tokens and prunes finalized intents past their retention. */
	sweep(): void {
		const now = this.clock().getTime();
		for (const intent of this.intents.values()) this.expireIfNeeded(intent);
		let pruned = false;
		for (const intent of [...this.intents.values()]) {
			if (intent.finalAt && now - Date.parse(intent.finalAt) > this.retainFinalMs) {
				this.intents.delete(intent.id);
				this.log(`inbox: send pruned intent=${intent.id.slice(0, 8)}`);
				pruned = true;
			}
		}
		if (pruned) this.save();
	}

	// ---------------------------------------------------------------- send

	/**
	 * `sending` is persisted before the POST; a caller that dies mid-flight restarts
	 * into `uncertain` (see start), so the send is attempted at most once, ever.
	 */
	private async runSend(intent: Intent): Promise<void> {
		const started = this.clock().getTime();
		intent.sendAttempts++;
		intent.sentAt = new Date(started).toISOString();
		this.transition(intent, "sending");
		let out: { chatID: string; pendingMessageID: string };
		try {
			out = await this.beeper.sendMessage(intent.chatID, {
				text: intent.text as string,
				...(intent.replyToMessageID ? { replyToMessageID: intent.replyToMessageID } : {}),
			});
		} catch (err) {
			// A definitive refusal (4xx, token refused) is a failed send; anything without
			// a clear answer — timeout, disconnect, 5xx — leaves the outcome unknown.
			if (err instanceof BeeperError && (err.kind === "unauthorized" || (err.kind === "failed" && (err.status ?? 0) < 500))) {
				intent.reason = err.kind === "unauthorized" ? "unauthorized" : `beeper_http_${err.status}`;
				this.transition(intent, "failed");
			} else {
				this.transition(intent, "uncertain");
			}
			return;
		}
		intent.resolvedChatID = out.chatID;
		intent.pendingMessageID = out.pendingMessageID;
		this.transition(intent, "pending");
		const deadline = started + this.pollBudgetMs;
		while (this.clock().getTime() < deadline) {
			await sleep(this.pollIntervalMs);
			let m: BMessage;
			try {
				m = await this.beeper.getMessage(intent.resolvedChatID, intent.pendingMessageID);
			} catch {
				continue;
			}
			const status = m.sendStatus?.status;
			if (status === "SUCCESS") {
				this.transition(intent, "sent");
				return;
			}
			if (status === "FAIL_RETRIABLE" || status === "FAIL_PERMANENT") {
				intent.reason = m.sendStatus?.reason ?? status.toLowerCase();
				this.transition(intent, "failed");
				return;
			}
		}
		this.transition(intent, "uncertain");
	}

	// ---------------------------------------------------------------- internals

	private require(id: string): Intent {
		const intent = this.intents.get(id);
		if (!intent) throw new InboxError(404, "intent not found");
		return intent;
	}

	private mintToken(intent: Intent): void {
		intent.confirmToken = randomBytes(24).toString("base64url");
		intent.confirmExpires = new Date(this.clock().getTime() + this.confirmTtlMs).toISOString();
	}

	private isExpired(intent: Intent): boolean {
		return intent.confirmExpires !== undefined && this.clock().getTime() > Date.parse(intent.confirmExpires);
	}

	private expireIfNeeded(intent: Intent): void {
		if (intent.state === "pending_confirm" && this.isExpired(intent)) {
			this.transition(intent, "expired");
		}
	}

	private transition(intent: Intent, state: OutboxState): void {
		intent.state = state;
		if (FINAL.has(state)) {
			intent.finalState = state;
			intent.finalAt = this.clock().toISOString();
			// D8: once the outcome is decided the text leaves the journal; the hash stays.
			delete intent.text;
			delete intent.confirmToken;
			delete intent.confirmExpires;
		}
		this.transitioned(intent, state);
	}

	private transitioned(intent: Intent, state: OutboxState): void {
		this.save();
		this.log(`inbox: send ${state} intent=${intent.id.slice(0, 8)} ms=${this.clock().getTime() - Date.parse(intent.createdAt)}`);
		if (!this.stopped) this.emit("intent", this.view(intent));
	}

	private async replyPreview(ctx: OutboxChatContext, messageID: string): Promise<Intent["replyPreview"]> {
		let m = this.chats.peekMessage(ctx.chat.id, messageID);
		if (!m) {
			try {
				m = await this.beeper.getMessage(ctx.chat.id, messageID);
			} catch {
				return undefined;
			}
		}
		const author = m.senderName ?? (m.isSender === true || ctx.selfIDs.has(m.senderID) ? "tu" : undefined);
		const text = m.isDeleted ? "Messaggio eliminato" : m.text === undefined ? undefined : m.text.slice(0, REPLY_SNIPPET);
		return { ...(author ? { author } : {}), ...(text ? { text } : {}) };
	}

	private view(intent: Intent): OutboxIntentView {
		// RF19: the sheet shows what the server resolves now, not what the client kept.
		const ctx = this.chats.sendContext(intent.resolvedChatID ?? intent.chatID);
		return {
			id: intent.id,
			key: intent.key,
			chatID: intent.chatID,
			state: intent.state,
			...(intent.finalState ? { finalState: intent.finalState } : {}),
			...(intent.reason ? { reason: intent.reason } : {}),
			sendAttempts: intent.sendAttempts,
			charCount: intent.charCount,
			textHash: intent.textHash,
			createdAt: intent.createdAt,
			...(intent.sentAt ? { sentAt: intent.sentAt } : {}),
			...(intent.state === "pending_confirm" && intent.confirmExpires ? { expiresAt: intent.confirmExpires } : {}),
			...(intent.resolvedChatID ? { resolvedChatID: intent.resolvedChatID } : {}),
			recipient: ctx ? previewOf(ctx) : intent.recipient,
			...(intent.replyPreview ? { replyTo: intent.replyPreview } : {}),
		};
	}

	private log(msg: string): void {
		this.optsLog(msg);
	}

	// ---------------------------------------------------------------- journal

	private load(): void {
		if (!existsSync(this.file)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: number; intents?: Intent[] };
			if (parsed.version !== 1 || !Array.isArray(parsed.intents)) throw new Error("unexpected shape");
			for (const intent of parsed.intents) this.intents.set(intent.id, intent);
		} catch {
			// Not silently discarded: moved aside so a human can look before the next save.
			const aside = `${this.file}.corrupt-${Date.now()}`;
			renameSync(this.file, aside);
			this.log(`inbox: outbox file unreadable — moved aside to ${aside}`);
		}
	}

	private save(): void {
		if (this.stopped) return;
		const data = { version: 1, intents: [...this.intents.values()] };
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
	}
}

function requireString(value: unknown, name: string, min: number, max: number): string {
	if (typeof value !== "string" || value.length < min || value.length > max) {
		throw new InboxError(400, `${name} must be a string of ${min} to ${max} characters`);
	}
	return value;
}

function fingerprint(chatID: string, text: string, replyToMessageID: string | undefined): string {
	return sha256(`${chatID}${text}${replyToMessageID ?? ""}`);
}

function previewOf(ctx: OutboxChatContext): RecipientPreview {
	const { chat, account } = ctx;
	const peer =
		chat.type === "single"
			? (chat.participants?.items ?? []).find((p) => p.isSelf !== true && !ctx.selfIDs.has(p.id))
			: undefined;
	const accountLabel = account?.user?.fullName ?? account?.user?.username ?? account?.user?.phoneNumber ?? chat.accountID;
	const peerLabel = peer ? (peer.fullName ?? peer.username ?? peer.phoneNumber ?? peer.id) : undefined;
	return {
		network: chat.network ?? account?.network ?? chat.accountID,
		accountID: chat.accountID,
		accountLabel,
		title: chat.title,
		type: chat.type,
		participantCount: chat.participants?.total ?? chat.participants?.items.length ?? 0,
		...(peerLabel ? { peerLabel } : {}),
		maxLength: chat.capabilities?.maxTextLength ?? null,
	};
}
