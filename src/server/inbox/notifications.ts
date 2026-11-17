import { ECDH, createECDH, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import * as webpush from "web-push";
import type { PushSubscription, VapidKeys } from "web-push";

/** The lead supplies the last meaningful inbound id/version, never its text or a reason. */
export interface NotificationChat {
	id: string;
	title: string;
	lastInboundVersion: string | null;
	needsReply: boolean;
	important: boolean;
}

export interface NotificationPayload {
	title: string;
	body: string;
	count: number;
	url: "/inbox/";
	tag: "inbox-important";
}

export interface NotificationDeliveryOptions {
	ttl: number;
	timeoutMs: number;
	signal: AbortSignal;
	vapidDetails: VapidKeys & { subject: string };
}

export type NotificationDelivery = (subscription: PushSubscription, payload: string, options: NotificationDeliveryOptions) => Promise<void>;

export interface InboxNotificationsOptions {
	stateDir: string;
	subject?: string;
	now?: () => number;
	/** Trusted server/test injection only; never an HTTP option. */
	deliver?: NotificationDelivery;
	maxSubscriptions?: number;
	subscriptionTtlMs?: number;
	cooldownMs?: number;
	maxDeliveriesPerHour?: number;
	deliveryTimeoutMs?: number;
	pushTtlSeconds?: number;
	/** Auth principal validity is rechecked before every delivery; IDs/hashes only. */
	ownerAlive?: (owner: string) => boolean;
}

export class InboxNotificationsError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = "InboxNotificationsError";
	}
}

interface StoredSubscription {
	subscription: PushSubscription;
	expiresAt: number;
	owner?: string;
}
interface StoredState {
	version: 1;
	vapid: VapidKeys;
	subscriptions: StoredSubscription[];
}
interface Seen {
	version: string;
	consumed: boolean;
	/** Bounded pair-dedup also tolerates a few stale/out-of-order snapshots. */
	consumedVersions: Set<string>;
	at: number;
}

function consume(item: Seen): void {
	item.consumed = true;
	item.consumedVersions.add(item.version);
	while (item.consumedVersions.size > 16) item.consumedVersions.delete(item.consumedVersions.values().next().value!);
}

const MAX_CHATS = 2_000;
const SEEN_TTL_MS = 7 * 86_400_000;
const MAX_FILE_BYTES = 256 * 1024;
const HOUR_MS = 3_600_000;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function key(value: unknown, bytes: number): string {
	if (typeof value !== "string" || value.length !== Math.ceil(bytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InboxNotificationsError(400, "Invalid push keys");
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length !== bytes || decoded.toString("base64url") !== value) throw new InboxNotificationsError(400, "Invalid push keys");
	return value;
}

function endpoint(value: unknown): string {
	if (typeof value !== "string" || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new InboxNotificationsError(400, "Invalid push endpoint");
	let url: URL;
	try { url = new URL(value); } catch { throw new InboxNotificationsError(400, "Invalid push endpoint"); }
	const host = url.hostname;
	// Deliberately closed list: unknown/self-hosted providers need an explicit server change.
	const provider = host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" || host === "web.push.apple.com"
		|| /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !provider || isIP(host) || url.pathname === "/") {
		throw new InboxNotificationsError(400, "Unsupported push endpoint");
	}
	return url.href;
}

function subscription(value: unknown, now: number): PushSubscription {
	if (!record(value) || !record(value.keys)) throw new InboxNotificationsError(400, "Invalid push subscription");
	const p256dh = key(value.keys.p256dh, 65);
	if (Buffer.from(p256dh, "base64url")[0] !== 4) throw new InboxNotificationsError(400, "Invalid push keys");
	try { ECDH.convertKey(Buffer.from(p256dh, "base64url"), "prime256v1"); }
	catch { throw new InboxNotificationsError(400, "Invalid push keys"); }
	const auth = key(value.keys.auth, 16);
	const expirationTime = value.expirationTime;
	if (expirationTime !== undefined && expirationTime !== null && (typeof expirationTime !== "number" || !Number.isSafeInteger(expirationTime) || expirationTime <= now)) {
		throw new InboxNotificationsError(400, "Invalid push expiration");
	}
	return { endpoint: endpoint(value.endpoint), expirationTime: expirationTime as number | null | undefined, keys: { p256dh, auth } };
}

/** Third-party names remain plain inert, one-line text; never HTML or bidi controls. */
function title(value: string): string {
	const clean = value.normalize("NFKC").replace(/<[^>]*>/g, " ").replace(/[<>\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
	return Array.from(clean).slice(0, 80).join("") || "Chat";
}

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(ip, prefix, "ipv4");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
function publicAddress(address: string, family: number): boolean {
	return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

/** web-push handles encryption/VAPID only. This transport never follows redirects or proxies. */
const deliverPush: NotificationDelivery = async (sub, payload, options) => {
	const url = new URL(endpoint(sub.endpoint));
	const addresses = await lookup(url.hostname, { all: true });
	if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address, entry.family))) throw new Error("Unsafe push address");
	if (options.signal.aborted) throw new Error("Push delivery stopped");
	const address = addresses[0]!;
	const details = webpush.generateRequestDetails(sub, payload, {
		TTL: options.ttl, urgency: "normal", vapidDetails: options.vapidDetails,
	});
	await new Promise<void>((resolve, reject) => {
		// Pin the validated DNS result; TLS still verifies the original provider hostname.
		const req = request(url, {
			method: "POST", headers: details.headers, signal: options.signal, agent: false, family: address.family,
			lookup: (_host, _opts, callback) => callback(null, address.address, address.family),
		}, (res) => {
			const statusCode = res.statusCode ?? 0;
			// A push response body is not needed and must not turn into an unbounded buffer/log.
			res.destroy();
			if (statusCode >= 200 && statusCode < 300) resolve();
			else reject(Object.assign(new Error("Push delivery rejected"), { statusCode }));
		});
		req.on("error", reject);
		req.end(details.body);
	});
};

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid notification configuration");
	return value;
}

/**
 * Auth and CSRF belong to the lead HTTP API. The only browser-visible credential is
 * publicKey. Disk holds only VAPID and browser subscriptions; chat dedup is RAM-only.
 * One stateDir has one owner instance (no cross-process locking).
 */
export class InboxNotifications {
	private readonly file: string;
	private readonly ownerAlive?: (owner: string) => boolean;
	private readonly clock: () => number;
	private readonly deliver: NotificationDelivery;
	private readonly subject: string;
	private readonly maxSubscriptions: number;
	private readonly subscriptionTtlMs: number;
	private readonly cooldownMs: number;
	private readonly maxDeliveries: number;
	private readonly deliveryTimeoutMs: number;
	private readonly pushTtl: number;
	private readonly vapid: VapidKeys;
	private subscriptions = new Map<string, StoredSubscription>();
	private readonly seen = new Map<string, Seen>();
	private baseline = false;
	private closed = false;
	private pending: NotificationChat[] | undefined;
	private flight: Promise<void> | undefined;
	private readonly controllers = new Set<AbortController>();
	private lastDelivery = -Infinity;
	private budgetStarted: number;
	private deliveries = 0;

	constructor(options: InboxNotificationsOptions) {
		this.file = join(options.stateDir, "inbox-notifications.json");
		this.ownerAlive = options.ownerAlive;
		this.clock = options.now ?? Date.now;
		this.deliver = options.deliver ?? deliverPush;
		this.subject = options.subject ?? "https://pi-super.invalid/inbox/";
		if (!/^(https:\/\/|mailto:)/.test(this.subject) || /[\s\u0000-\u001f]/.test(this.subject)) throw new Error("Invalid VAPID subject");
		this.maxSubscriptions = bounded(options.maxSubscriptions, 20, 1, 100);
		this.subscriptionTtlMs = bounded(options.subscriptionTtlMs, 90 * 86_400_000, 1, 365 * 86_400_000);
		this.cooldownMs = bounded(options.cooldownMs, 30_000, 0, HOUR_MS);
		this.maxDeliveries = bounded(options.maxDeliveriesPerHour, 60, 1, 1_000);
		this.deliveryTimeoutMs = bounded(options.deliveryTimeoutMs, 8_000, 1, 30_000);
		this.pushTtl = bounded(options.pushTtlSeconds, 300, 1, 3_600);
		this.budgetStarted = this.clock();
		mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
		const stored = this.load();
		this.vapid = stored?.vapid ?? webpush.generateVAPIDKeys();
		if (stored) for (const item of stored.subscriptions) this.subscriptions.set(item.subscription.endpoint, item);
		this.prune();
		this.save();
	}

	get publicKey(): string { return this.vapid.publicKey; }

	subscribe(input: unknown, owner?: string): { subscribed: true } {
		this.assertOpen();
		const now = this.clock();
		if (this.ownerAlive && (!owner || !this.ownerAlive(owner))) throw new InboxNotificationsError(403, "Push owner expired");
		const sub = subscription(input, now);
		this.prune();
		if (!this.subscriptions.has(sub.endpoint) && this.subscriptions.size >= this.maxSubscriptions) throw new InboxNotificationsError(429, "Push subscription limit reached");
		const previous = this.subscriptions.get(sub.endpoint);
		this.subscriptions.set(sub.endpoint, { subscription: sub, expiresAt: Math.min(now + this.subscriptionTtlMs, sub.expirationTime ?? Infinity), ...(owner ? { owner } : {}) });
		try { this.save(); } catch (error) {
			if (previous) this.subscriptions.set(sub.endpoint, previous); else this.subscriptions.delete(sub.endpoint);
			throw error;
		}
		return { subscribed: true };
	}

	unsubscribe(input: unknown): { subscribed: false } {
		this.assertOpen();
		if (!record(input)) throw new InboxNotificationsError(400, "Invalid push subscription");
		const url = endpoint(input.endpoint);
		const previous = this.subscriptions.get(url);
		this.subscriptions.delete(url);
		try { this.save(); } catch (error) { if (previous) this.subscriptions.set(url, previous); throw error; }
		return { subscribed: false };
	}

	/** Latest-snapshot coalescing keeps refresh storms bounded, and serializes dedup. */
	reconcile(snapshot: readonly NotificationChat[]): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.pending = snapshot.slice(0, MAX_CHATS).map((chat) => ({
			id: chat.id, title: title(chat.title), lastInboundVersion: chat.lastInboundVersion,
			needsReply: chat.needsReply === true, important: chat.important === true,
		}));
		if (!this.flight) this.flight = this.drain().finally(() => { this.flight = undefined; });
		return this.flight;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.pending = undefined;
		for (const controller of this.controllers) controller.abort();
		await this.flight;
		this.seen.clear();
	}

	private async drain(): Promise<void> {
		while (this.pending && !this.closed) {
			const snapshot = this.pending;
			this.pending = undefined;
			await this.process(snapshot);
		}
	}

	private async process(snapshot: readonly NotificationChat[]): Promise<void> {
		const now = this.clock();
		if (this.prune()) this.save();
		for (const [id, item] of this.seen) if (now - item.at > SEEN_TTL_MS) this.seen.delete(id);
		const eligible: { chat: NotificationChat; seen: Seen }[] = [];
		for (const chat of snapshot) {
			if (!chat.id || chat.id.length > 1024 || !chat.lastInboundVersion || chat.lastInboundVersion.length > 1024) continue;
			let item = this.seen.get(chat.id);
			if (!item) {
				// New/evicted chats are baseline only during startup; new arrivals later notify.
				item = { version: chat.lastInboundVersion, consumed: !this.baseline, consumedVersions: new Set(), at: now };
				if (item.consumed) consume(item);
				this.seen.set(chat.id, item);
			} else if (item.version !== chat.lastInboundVersion) {
				item.version = chat.lastInboundVersion;
				item.consumed = item.consumedVersions.has(chat.lastInboundVersion);
			}
			item.at = now;
			if (!item.consumed && chat.important && chat.needsReply) eligible.push({ chat, seen: item });
		}
		this.baseline = true;
		while (this.seen.size > MAX_CHATS) this.seen.delete(this.seen.keys().next().value!);
		if (!eligible.length) return;
		if (!this.subscriptions.size) { for (const item of eligible) consume(item.seen); return; }
		if (now - this.budgetStarted >= HOUR_MS) { this.budgetStarted = now; this.deliveries = 0; }
		if (now - this.lastDelivery < this.cooldownMs || this.deliveries >= this.maxDeliveries) return;
		const targets = [...this.subscriptions.values()].slice(0, this.maxDeliveries - this.deliveries);
		this.lastDelivery = now;
		// At-most-once attempts: failures are not retried with private titles in the background.
		for (const item of eligible) consume(item.seen);
		const count = eligible.length;
		const payload: NotificationPayload = {
			title: count === 1 ? eligible[0]!.chat.title : `${count} chat importanti`,
			body: count === 1 ? "Una chat importante attende risposta" : eligible.slice(0, 3).map((item) => item.chat.title).join(" · "),
			count, url: "/inbox/", tag: "inbox-important",
		};
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(3, targets.length) }, async () => {
			while (!this.closed) {
				const target = targets[next++];
				if (!target) break;
				if (this.subscriptions.get(target.subscription.endpoint) !== target ||
					(this.ownerAlive && (!target.owner || !this.ownerAlive(target.owner)))) continue;
				this.deliveries++;
				try { await this.send(target.subscription, JSON.stringify(payload)); }
				catch (error) {
					const status = record(error) ? error.statusCode : undefined;
					if ((status === 404 || status === 410) && this.subscriptions.get(target.subscription.endpoint) === target) {
						this.subscriptions.delete(target.subscription.endpoint);
						this.save();
					}
					// Never log provider errors: they can carry endpoints, credentials and payloads.
				}
			}
		}));
	}

	private async send(sub: PushSubscription, payload: string): Promise<void> {
		const controller = new AbortController();
		this.controllers.add(controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("Push delivery stopped")), { once: true });
			timer = setTimeout(() => controller.abort(), this.deliveryTimeoutMs);
		});
		try {
			await Promise.race([aborted, this.deliver({ ...sub, keys: { ...sub.keys } }, payload, {
				ttl: this.pushTtl, timeoutMs: this.deliveryTimeoutMs, signal: controller.signal,
				vapidDetails: { ...this.vapid, subject: this.subject },
			})]);
		} finally { clearTimeout(timer); this.controllers.delete(controller); }
	}

	private assertOpen(): void {
		if (this.closed) throw new InboxNotificationsError(503, "Push notifications closed");
	}

	private prune(): boolean {
		let changed = false;
		for (const [url, item] of this.subscriptions) if (item.expiresAt <= this.clock() ||
			(this.ownerAlive && (!item.owner || !this.ownerAlive(item.owner)))) { this.subscriptions.delete(url); changed = true; }
		return changed;
	}

	private load(): StoredState | undefined {
		let stat;
		try { stat = lstatSync(this.file); } catch (error) { if (record(error) && error.code === "ENOENT") return undefined; throw new Error("Cannot read push state"); }
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Invalid push state");
		try {
			chmodSync(this.file, 0o600);
			const data: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (!record(data) || data.version !== 1 || !record(data.vapid) || !Array.isArray(data.subscriptions) || data.subscriptions.length > 100) throw new Error();
			const publicKey = key(data.vapid.publicKey, 65);
			const privateKey = key(data.vapid.privateKey, 32);
			const ecdh = createECDH("prime256v1");
			ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
			if (ecdh.getPublicKey().toString("base64url") !== publicKey) throw new Error();
			const subscriptions: StoredSubscription[] = [];
			const now = this.clock();
			for (const item of data.subscriptions) {
				if (!record(item) || typeof item.expiresAt !== "number" || !Number.isSafeInteger(item.expiresAt)) throw new Error();
				if (item.expiresAt <= now) continue;
				const sub = subscription(item.subscription, now);
				if (item.owner !== undefined && (typeof item.owner !== "string" || item.owner.length > 256)) throw new Error();
				subscriptions.push({ subscription: sub, expiresAt: Math.min(item.expiresAt, now + this.subscriptionTtlMs, sub.expirationTime ?? Infinity),
					...(typeof item.owner === "string" ? { owner: item.owner } : {}) });
			}
			return { version: 1, vapid: { publicKey, privateKey }, subscriptions: subscriptions.slice(0, this.maxSubscriptions) };
		} catch { throw new Error("Invalid push state"); }
	}

	private save(): void {
		const tmp = `${this.file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
		let fd: number | undefined;
		try {
			fd = openSync(tmp, "wx", 0o600);
			const data: StoredState = { version: 1, vapid: this.vapid, subscriptions: [...this.subscriptions.values()] };
			writeFileSync(fd, `${JSON.stringify(data)}\n`);
			fsyncSync(fd);
			closeSync(fd); fd = undefined;
			renameSync(tmp, this.file);
		} catch {
			if (fd !== undefined) closeSync(fd);
			try { unlinkSync(tmp); } catch { /* No state/content is copied to a fallback path. */ }
			throw new Error("Cannot persist push state");
		}
	}
}
