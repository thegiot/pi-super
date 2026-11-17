import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as webpush from "web-push";
import { InboxNotifications, InboxNotificationsError } from "../dist/server/inbox/notifications.js";

const epoch = Date.parse("2026-06-01T10:00:00Z");
function sub(id = "device", host = "fcm.googleapis.com") {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return { endpoint: `https://${host}/fcm/send/${id}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
function chat(version = "v1", extra = {}) {
	return { id: "synthetic-chat", title: "Synthetic person", lastInboundVersion: version, needsReply: true, important: true, ...extra };
}
function fixture(options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-push-"));
	let now = epoch;
	const deliveries = [];
	const defaults = { stateDir: dir, now: () => now, cooldownMs: 0, deliver: async (subscription, payload, options) => { deliveries.push({ subscription, payload: JSON.parse(payload), options }); } };
	const instance = new InboxNotifications({ ...defaults, ...options });
	return {
		dir, file: join(dir, "inbox-notifications.json"), instance, deliveries, defaults,
		tick: (ms) => { now += ms; },
		cleanup: async () => {
			await instance.close();
			assert.match(resolve(dir), /^\/tmp\/pi-super-push-/);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function fails(operation, status = 400) {
	assert.throws(operation, (error) => error instanceof InboxNotificationsError && error.status === status && !error.message.includes("fcm.googleapis.com"));
}

test("VAPID and subscriptions survive restart, atomic 0600 files contain no chat state", async () => {
	const f = fixture();
	try {
		const s = sub();
		const publicKey = f.instance.publicKey;
		assert.equal(Buffer.from(publicKey, "base64url").length, 65);
		assert.deepEqual(f.instance.subscribe({ ...s, beeperToken: "NEVER-COPY", title: "PRIVATE-TITLE" }), { subscribed: true });
		await f.instance.reconcile([chat("PRIVATE-VERSION", { title: "PRIVATE-TITLE", preview: { text: "PRIVATE-MESSAGE" }, reasons: ["PRIVATE-REASON"] })]);
		await f.instance.reconcile([chat("PRIVATE-VERSION-2", { title: "PRIVATE-TITLE" })]);
		await f.instance.close();
		assert.equal(statSync(f.file).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(f.dir), ["inbox-notifications.json"]);
		const raw = readFileSync(f.file, "utf8");
		for (const secret of ["PRIVATE-TITLE", "PRIVATE-MESSAGE", "PRIVATE-REASON", "PRIVATE-VERSION", "synthetic-chat", "NEVER-COPY"]) assert.equal(raw.includes(secret), false);
		const data = JSON.parse(raw);
		assert.deepEqual(Object.keys(data), ["version", "vapid", "subscriptions"]);
		assert.deepEqual(Object.keys(data.subscriptions[0]), ["subscription", "expiresAt"]);
		chmodSync(f.file, 0o644);
		const reopened = new InboxNotifications(f.defaults);
		try {
			assert.equal(reopened.publicKey, publicKey);
			assert.equal(statSync(f.file).mode & 0o777, 0o600);
			await reopened.reconcile([chat("PRIVATE-VERSION-2")]);
			const before = f.deliveries.length;
			await reopened.reconcile([chat("next")]);
			assert.equal(f.deliveries.length, before + 1);
			assert.deepEqual(reopened.unsubscribe({ endpoint: s.endpoint }), { subscribed: false });
			assert.deepEqual(reopened.unsubscribe({ endpoint: s.endpoint }), { subscribed: false });
			assert.deepEqual(JSON.parse(readFileSync(f.file)).subscriptions, []);
		} finally { await reopened.close(); }
	} finally { await f.cleanup(); }
});

test("first snapshot establishes silent baseline, only new important inbound versions notify", async () => {
	const f = fixture();
	try {
		f.instance.subscribe(sub());
		await f.instance.reconcile([chat(), chat("b1", { id: "b", important: false })]);
		await f.instance.reconcile([chat()]);
		assert.equal(f.deliveries.length, 0);
		await f.instance.reconcile([chat("v2", { important: false })]);
		await f.instance.reconcile([chat("v2", { needsReply: false })]);
		assert.equal(f.deliveries.length, 0);
		await f.instance.reconcile([chat("v2")]);
		assert.equal(f.deliveries.length, 1);
		await Promise.all(Array.from({ length: 20 }, () => f.instance.reconcile([chat("v2")])));
		assert.equal(f.deliveries.length, 1);
		await f.instance.reconcile([chat("v1")]);
		await f.instance.reconcile([chat("v2")]);
		assert.equal(f.deliveries.length, 1, "out-of-order snapshots do not replay consumed chat/version pairs");
		await f.instance.reconcile([chat("new", { id: "brand-new" })]);
		assert.equal(f.deliveries.length, 2);
	} finally { await f.cleanup(); }
});

test("payload allowlist contains only sanitized authorized titles and counts, never messages/reasons/ids", async () => {
	const f = fixture();
	try {
		f.instance.subscribe(sub());
		await f.instance.reconcile([chat()]);
		await f.instance.reconcile([chat("v2", {
			title: "<img src=x onerror=alert(1)>Synthetic\n\u202e PERSON\u0000<svg>name</svg>",
			message: "PRIVATE-MESSAGE", reason: "PRIVATE-REASON", beeperToken: "PRIVATE-TOKEN",
		})]);
		const payload = f.deliveries[0].payload;
		assert.deepEqual(Object.keys(payload), ["title", "body", "count", "url", "tag"]);
		assert.equal(payload.title, "Synthetic PERSON name");
		assert.equal(payload.count, 1);
		assert.equal(payload.url, "/inbox/");
		assert.equal(payload.tag, "inbox-important");
		for (const value of ["PRIVATE-MESSAGE", "PRIVATE-REASON", "PRIVATE-TOKEN", "synthetic-chat", "v2", "<", "\u202e", "\n"]) assert.equal(JSON.stringify(payload).includes(value), false);
		await f.instance.reconcile([chat("v3", { title: "😀".repeat(100) }), chat("v3", { id: "b", title: "<b>Other</b>" })]);
		const aggregate = f.deliveries[1].payload;
		assert.equal(aggregate.title, "2 chat importanti");
		assert.equal(aggregate.count, 2);
		assert.equal(aggregate.body, `${"😀".repeat(80)} · Other`);
		assert.ok(Buffer.byteLength(JSON.stringify(aggregate)) < 4096);
		assert.equal(f.deliveries[0].options.ttl, 300);
	} finally { await f.cleanup(); }
});

test("hostile endpoints cannot select arbitrary hosts, local addresses, credentials, schemes or ports", async () => {
	const f = fixture();
	try {
		const good = sub();
		for (const endpoint of [
			"http://fcm.googleapis.com/send/1", "https://127.0.0.1/send/1", "https://[::1]/send/1", "https://2130706433/send/1",
			"https://localhost/send/1", "https://fcm.googleapis.com.evil.invalid/send/1", "https://evilfcm.googleapis.com/send/1",
			"https://fcm.googleapis.com@127.0.0.1/send/1", "https://user:pass@fcm.googleapis.com/send/1", "https://fcm.googleapis.com:8443/send/1",
			"https://fcm.googleapis.com/send/1#fragment", "https://fcm.googleapis.com/", "https://fcm.googleapis.com\\@evil.invalid/send/1",
			"https://fcm.googleapis.com./send/1", "https://fcm.googleapis.com\n/send/1", "file:///tmp/secret", "data:text/plain,secret",
		]) {
			fails(() => f.instance.subscribe({ ...good, endpoint }));
			fails(() => f.instance.unsubscribe({ endpoint }));
		}
		for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "wns2-db5p.notify.windows.com"]) assert.deepEqual(f.instance.subscribe(sub(host, host)), { subscribed: true });
		assert.equal(f.deliveries.length, 0);
	} finally { await f.cleanup(); }
});

test("keys must be canonical base64url, correct sizes and an actual uncompressed P-256 point", async () => {
	const f = fixture();
	try {
		const s = sub();
		for (const input of [null, [], {}, { ...s, keys: null }, { ...s, keys: { ...s.keys, auth: "x" } },
			{ ...s, keys: { ...s.keys, auth: `${s.keys.auth}==` } }, { ...s, keys: { ...s.keys, p256dh: Buffer.alloc(65).toString("base64url") } },
			{ ...s, keys: { ...s.keys, p256dh: `!${s.keys.p256dh.slice(1)}` } }, { ...s, expirationTime: epoch },
			{ ...s, expirationTime: "later" }, { ...s, expirationTime: Infinity },
		]) fails(() => f.instance.subscribe(input));
	} finally { await f.cleanup(); }
});

test("subscription limits, local TTL, browser expiration and refresh are bounded and persisted", async () => {
	const f = fixture({ maxSubscriptions: 1, subscriptionTtlMs: 100 });
	try {
		const a = sub("a");
		f.instance.subscribe(a);
		fails(() => f.instance.subscribe(sub("b")), 429);
		f.tick(50);
		f.instance.subscribe(a);
		f.tick(75);
		fails(() => f.instance.subscribe(sub("b")), 429);
		f.tick(26);
		const b = sub("b");
		f.instance.subscribe({ ...b, expirationTime: epoch + 180 });
		assert.equal(JSON.parse(readFileSync(f.file)).subscriptions[0].expiresAt, epoch + 180);
		f.tick(30);
		await f.instance.reconcile([chat()]);
		assert.deepEqual(JSON.parse(readFileSync(f.file)).subscriptions, []);
	} finally { await f.cleanup(); }
});

test("404/410 delete only expired subscriptions; provider failure and redirect are never retried", async () => {
	const attempts = [];
	const f = fixture({ deliver: async (s) => {
		attempts.push(s.endpoint);
		const statusCode = s.endpoint.endsWith("gone") ? 410 : s.endpoint.endsWith("missing") ? 404 : s.endpoint.endsWith("redirect") ? 302 : 500;
		throw Object.assign(new Error("PRIVATE provider body and credentials"), { statusCode });
	} });
	try {
		for (const id of ["gone", "missing", "redirect", "temporary"]) f.instance.subscribe(sub(id));
		await f.instance.reconcile([chat()]);
		await f.instance.reconcile([chat("v2")]);
		await f.instance.reconcile([chat("v2")]);
		assert.equal(attempts.length, 4);
		const stored = JSON.parse(readFileSync(f.file));
		assert.deepEqual(stored.subscriptions.map((s) => s.subscription.endpoint.split("/").at(-1)).sort(), ["redirect", "temporary"]);
	} finally { await f.cleanup(); }
});

test("cooldown preserves current pending versions and hourly budget bounds network attempts", async () => {
	const f = fixture({ cooldownMs: 100, maxDeliveriesPerHour: 2 });
	try {
		f.instance.subscribe(sub());
		await f.instance.reconcile([chat()]);
		await f.instance.reconcile([chat("v2")]);
		await f.instance.reconcile([chat("v3")]);
		assert.equal(f.deliveries.length, 1);
		f.tick(100);
		await f.instance.reconcile([chat("v3")]);
		assert.equal(f.deliveries.length, 2);
		f.tick(100);
		await f.instance.reconcile([chat("v4")]);
		assert.equal(f.deliveries.length, 2);
		f.tick(3_600_000);
		await f.instance.reconcile([chat("v4")]);
		assert.equal(f.deliveries.length, 3);
	} finally { await f.cleanup(); }
});

test("concurrent reconciliation coalesces snapshots with at most three deliveries in flight", async () => {
	const releases = [];
	let active = 0;
	let maxActive = 0;
	let calls = 0;
	const f = fixture({ deliver: async () => {
		calls++; active++; maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => releases.push(resolve));
		active--;
	} });
	try {
		for (let i = 0; i < 6; i++) f.instance.subscribe(sub(String(i)));
		await f.instance.reconcile([chat()]);
		const first = f.instance.reconcile([chat("v2")]);
		const second = f.instance.reconcile([chat("v2")]);
		assert.equal(first, second);
		assert.equal(active, 3);
		while (calls < 6 || active > 0) {
			for (const resolve of releases.splice(0)) resolve();
			await new Promise((resolve) => setImmediate(resolve));
		}
		await first;
		assert.equal(calls, 6);
		assert.equal(maxActive, 3);
	} finally { await f.cleanup(); }
});

test("total timeout and close cancel delivery; a never-resolving fake cannot hang shutdown", async () => {
	const signals = [];
	const f = fixture({ deliveryTimeoutMs: 10, deliver: async (_s, _p, o) => { signals.push(o.signal); await new Promise(() => {}); } });
	try {
		f.instance.subscribe(sub());
		await f.instance.reconcile([chat()]);
		await f.instance.reconcile([chat("v2")]);
		assert.equal(signals[0].aborted, true);
		const sending = f.instance.reconcile([chat("v3")]);
		await f.instance.close();
		await sending;
		assert.equal(signals[1].aborted, true);
		fails(() => f.instance.subscribe(sub()), 503);
		fails(() => f.instance.unsubscribe({ endpoint: sub().endpoint }), 503);
		await f.instance.reconcile([chat("v4")]);
		assert.equal(signals.length, 2);
	} finally { await f.cleanup(); }
});

test("subscribing later never floods versions observed while no device was subscribed", async () => {
	const f = fixture();
	try {
		await f.instance.reconcile([chat()]);
		await f.instance.reconcile([chat("v2")]);
		f.instance.subscribe(sub());
		await f.instance.reconcile([chat("v2")]);
		assert.equal(f.deliveries.length, 0);
		await f.instance.reconcile([chat("v3")]);
		assert.equal(f.deliveries.length, 1);
	} finally { await f.cleanup(); }
});

test("production transport pins public DNS, encrypts payload, rejects private answers and never follows redirects", async () => {
	const originalLookup = dns.lookup;
	const originalRequest = https.request;
	let answers = [{ address: "127.0.0.1", family: 4 }];
	let requests = 0;
	let status = 302;
	const requestsSeen = [];
	dns.lookup = async () => answers;
	https.request = (url, options, callback) => {
		requests++;
		requestsSeen.push({ url, options });
		const req = new EventEmitter();
		req.end = (body) => {
			assert.ok(Buffer.isBuffer(body));
			assert.equal(body.includes(Buffer.from("Synthetic person")), false);
			assert.equal(options.headers.TTL, 300);
			assert.equal(options.headers["Content-Encoding"], "aes128gcm");
			options.lookup(url.hostname, {}, (error, address, family) => {
				assert.equal(error, null);
				assert.equal(address, "8.8.8.8");
				assert.equal(family, 4);
			});
			queueMicrotask(() => callback({ statusCode: status, destroy() {} }));
		};
		return req;
	};
	syncBuiltinESMExports();
	const f = fixture({ deliver: undefined });
	try {
		f.instance.subscribe(sub());
		await f.instance.reconcile([chat()]);
		for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.1.2", "192.168.1.1", "::1", "fd00::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
			answers = [{ address, family: address.includes(":") ? 6 : 4 }];
			await f.instance.reconcile([chat(address)]);
		}
		assert.equal(requests, 0);
		answers = [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
		await f.instance.reconcile([chat("mixed")]);
		assert.equal(requests, 0);
		answers = [{ address: "8.8.8.8", family: 4 }];
		await f.instance.reconcile([chat("public")]);
		assert.equal(requests, 1);
		assert.equal(requestsSeen[0].options.agent, false);
		assert.equal(requestsSeen[0].url.hostname, "fcm.googleapis.com");
		assert.equal(JSON.parse(readFileSync(f.file)).subscriptions.length, 1);
		status = 410;
		await f.instance.reconcile([chat("gone")]);
		assert.equal(requests, 2);
		assert.equal(JSON.parse(readFileSync(f.file)).subscriptions.length, 0);
	} finally {
		await f.cleanup();
		dns.lookup = originalLookup;
		https.request = originalRequest;
		syncBuiltinESMExports();
	}
});

test("corrupt, mismatched VAPID or symlink state fails closed, no rotations or fallback copies", async () => {
	const f = fixture();
	try {
		await f.instance.close();
		const valid = JSON.parse(readFileSync(f.file));
		for (const content of ["not JSON", JSON.stringify({ ...valid, vapid: { ...valid.vapid, privateKey: webpush.generateVAPIDKeys().privateKey } }), JSON.stringify({ ...valid, subscriptions: [{ subscription: sub(), expiresAt: "later" }] })]) {
			writeFileSync(f.file, content);
			assert.throws(() => new InboxNotifications(f.defaults), /^Error: Invalid push state$/);
			assert.equal(readFileSync(f.file, "utf8"), content);
			assert.deepEqual(readdirSync(f.dir), ["inbox-notifications.json"]);
		}
		const other = join(f.dir, "other");
		writeFileSync(other, JSON.stringify(valid));
		assert.equal(resolve(f.file), join(f.dir, "inbox-notifications.json"));
		rmSync(f.file);
		symlinkSync(other, f.file);
		assert.throws(() => new InboxNotifications(f.defaults), /^Error: Invalid push state$/);
		assert.equal(existsSync(other), true);
	} finally { await f.cleanup(); }
});
