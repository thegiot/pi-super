import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import WebSocket from "ws";
import { BeeperClient } from "../dist/server/inbox/beeper.js";
import { Outbox } from "../dist/server/inbox/outbox.js";
import { parseArgs } from "../dist/server/config.js";
import { createServer } from "../dist/server/server.js";
import { ACCOUNTS, startFakeBeeper } from "./fixtures/fake-beeper.mjs";

// The outbox state machine against the synthetic fake. No send ever leaves the
// machine: the only write endpoint the fake implements is POST /messages.

const CHAT = "!wa-ana:wa.test";
const READONLY_CHAT = "!mx-news:mx.test";
const ARCHIVED_CHAT = "!wa-arch:wa.test";
const TOKEN = `pi-super-test-${randomBytes(24).toString("base64url")}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, ms = 6000) {
	const t0 = Date.now();
	for (;;) {
		try {
			if (await pred()) return;
		} catch {
			// not yet
		}
		if (Date.now() - t0 > ms) throw new Error("until: timed out");
		await sleep(25);
	}
}

const SELF_IDS = new Set(ACCOUNTS.map((a) => a.user.id));

function chatsFrom(fake) {
	return {
		sendContext: (id) => {
			const chat = fake.world.chats.find((c) => c.id === id);
			if (!chat) return undefined;
			const account = ACCOUNTS.find((a) => a.accountID === chat.accountID);
			return { chat, account, selfIDs: SELF_IDS };
		},
		peekMessage: (chatID, messageID) => (fake.world.messages[chatID] ?? []).find((m) => m.id === messageID),
	};
}

const TUNABLES = {
	confirmTtlMs: 150,
	pollIntervalMs: 25,
	pollBudgetMs: 300,
	reconcileMinSpanMs: 0,
	sweepMs: 40,
};

async function setup({ tunables = {}, plan, stateDir } = {}) {
	const fake = await startFakeBeeper();
	const dir = stateDir ?? mkdtempSync(join(tmpdir(), "pi-super-outbox-"));
	const logs = [];
	const beeper = new BeeperClient({ baseUrl: fake.url, token: () => fake.token, timeoutMs: 600 });
	const outbox = new Outbox({
		beeper,
		chats: chatsFrom(fake),
		stateDir: dir,
		log: (m) => logs.push(m),
		...TUNABLES,
		...tunables,
	});
	if (plan) fake.setSendPlan(plan);
	outbox.start();
	return {
		fake,
		dir,
		logs,
		beeper,
		outbox,
		journal() {
			return JSON.parse(readFileSync(join(dir, "outbox.json"), "utf8"));
		},
		async close() {
			outbox.stop();
			await fake.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const key = () => `k-${randomBytes(8).toString("hex")}`;

/** The only non-GET calls Beeper may ever see: introspection and the outbox's POST. */
function assertOnlyReadsAndSends(fake) {
	const allowed = (c) => c.method === "GET" || (c.method === "POST" && (c.path === "/oauth/introspect" || /^\/v1\/chats\/[^/]+\/messages$/.test(c.path)));
	assert.deepEqual(fake.calls.filter((c) => !allowed(c)), []);
}

describe("outbox state machine", () => {
	test("happy path: pending_confirm → sending → pending → sent, text leaves the journal", async () => {
		const env = await setup();
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "ciao dal test" });
			assert.equal(created.intent.state, "pending_confirm");
			assert.ok(created.confirmToken.length >= 20);
			assert.ok(created.expiresAt);
			assert.equal(created.intent.recipient.network, "WhatsApp");
			assert.equal(created.intent.recipient.maxLength, 65536);
			assert.equal(created.intent.recipient.title, "Ana Test");
			// while it waits for confirmation the journal keeps the exact text
			assert.equal(env.journal().intents[0].text, "ciao dal test");

			const view = await env.outbox.confirm(created.intent.id, created.confirmToken);
			assert.ok(["sending", "pending"].includes(view.state));
			const settled = await env.outbox.settle(created.intent.id);
			assert.equal(settled.state, "sent");
			assert.equal(env.fake.sends.length, 1);
			assert.equal(env.fake.sends[0].body.text, "ciao dal test");
			// D8: after the final state only the hash and metadata remain
			const stored = env.journal().intents[0];
			assert.equal(stored.text, undefined);
			assert.match(stored.textHash, /^[0-9a-f]{64}$/);
			assert.equal(stored.finalState, "sent");
			// and no public view ever carries the text
			assert.equal("text" in settled, false);
			assertOnlyReadsAndSends(env.fake);
		} finally {
			await env.close();
		}
	});

	test("FAIL_RETRIABLE and FAIL_PERMANENT settle on failed, with zero auto-retry", async () => {
		for (const status of ["FAIL_RETRIABLE", "FAIL_PERMANENT"]) {
			const env = await setup({ plan: { statuses: ["PENDING", status] } });
			try {
				const created = await env.outbox.create({ key: key(), chatID: CHAT, text: `retry me ${status}` });
				await env.outbox.confirm(created.intent.id, created.confirmToken);
				const settled = await env.outbox.settle(created.intent.id);
				assert.equal(settled.state, "failed", status);
				assert.equal(settled.reason, status.toLowerCase());
				await sleep(150);
				assert.equal(env.fake.sends.length, 1, `${status}: no automatic resend`);
				assertOnlyReadsAndSends(env.fake);
			} finally {
				await env.close();
			}
		}
	});

	test("no HTTP response → uncertain → the message in history reconciles to sent", async () => {
		const env = await setup({ plan: { hang: true, deliver: false } });
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "did it go out?" });
			await env.outbox.confirm(created.intent.id, created.confirmToken);
			const settled = await env.outbox.settle(created.intent.id);
			assert.equal(settled.state, "uncertain");
			assert.equal(env.fake.sends.length, 1);
			// it did go out, late: the fake upserts what the network eventually delivered
			env.fake.addMessage(CHAT, {
				id: "m-late-1",
				senderID: "@self-wa:wa.test",
				isSender: true,
				text: "did it go out?",
				timestamp: new Date().toISOString(),
				sortKey: "999999999999999",
			});
			const after = await env.outbox.reconcile(created.intent.id);
			assert.equal(after.state, "sent");
		} finally {
			await env.close();
		}
	});

	test("three missed reconciliations settle on not_found", async () => {
		const env = await setup({ plan: { http: 200, statuses: ["PENDING"], deliver: false } });
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "vanished" });
			await env.outbox.confirm(created.intent.id, created.confirmToken);
			assert.equal((await env.outbox.settle(created.intent.id)).state, "uncertain");
			assert.equal((await env.outbox.reconcile(created.intent.id)).state, "uncertain");
			assert.equal((await env.outbox.reconcile(created.intent.id)).state, "uncertain");
			assert.equal((await env.outbox.reconcile(created.intent.id)).state, "not_found");
			assert.equal(env.fake.sends.length, 1);
		} finally {
			await env.close();
		}
	});

	test("a restart with the intent still 'sending' lands on uncertain and never resends", async () => {
		const first = await setup({ plan: { hang: true, deliver: false } });
		const dir = first.dir;
		try {
			const created = await first.outbox.create({ key: key(), chatID: CHAT, text: "mid-flight" });
			await first.outbox.confirm(created.intent.id, created.confirmToken);
			await until(() => first.journal().intents[0]?.state === "sending");
			first.outbox.stop();

			const second = await setup({ stateDir: dir });
			try {
				await until(() => {
					const stored = second.journal().intents[0];
					return stored && stored.state === "uncertain";
				});
				await sleep(200);
				assert.equal(second.fake.sends.length, 0, "the restarted server does not resend");
				assert.equal(first.fake.sends.length, 1, "exactly one send attempt overall");
			} finally {
				second.outbox.stop();
				await second.fake.close();
				rmSync(dir, { recursive: true, force: true });
			}
		} finally {
			await first.fake.close();
		}
	});

	test("expired token → 410 confirm_expired, intent settles expired", async () => {
		const env = await setup({ tunables: { confirmTtlMs: 60 } });
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "too late" });
			await sleep(90);
			await assert.rejects(env.outbox.confirm(created.intent.id, created.confirmToken), (e) => {
				assert.equal(e.status, 410);
				assert.equal(e.message, "confirm_expired");
				return true;
			});
			assert.equal(env.outbox.get(created.intent.id).state, "expired");
			assert.equal(env.fake.sends.length, 0);
		} finally {
			await env.close();
		}
	});

	test("wrong token → 409 confirm_invalid, nothing sent", async () => {
		const env = await setup();
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "guarded" });
			await assert.rejects(env.outbox.confirm(created.intent.id, "not-the-token"), (e) => {
				assert.equal(e.status, 409);
				assert.equal(e.message, "confirm_invalid");
				return true;
			});
			assert.equal(env.outbox.get(created.intent.id).state, "pending_confirm");
			assert.equal(env.fake.sends.length, 0);
		} finally {
			await env.close();
		}
	});

	test("double confirm produces exactly one POST", async () => {
		const env = await setup();
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "once only" });
			const [a, b] = await Promise.all([
				env.outbox.confirm(created.intent.id, created.confirmToken),
				env.outbox.confirm(created.intent.id, created.confirmToken),
			]);
			const settled = await env.outbox.settle(created.intent.id);
			assert.equal(settled.state, "sent");
			assert.equal(env.fake.sends.length, 1);
			// a late repeat returns the recorded state, not a second send
			const again = await env.outbox.confirm(created.intent.id, created.confirmToken);
			assert.equal(again.state, "sent");
			assert.equal(env.fake.sends.length, 1);
		} finally {
			await env.close();
		}
	});

	test("the client key dedupes create — even across a restart", async () => {
		const k = key();
		const env = await setup();
		try {
			const first = await env.outbox.create({ key: k, chatID: CHAT, text: "same intent" });
			const second = await env.outbox.create({ key: k, chatID: CHAT, text: "same intent" });
			assert.equal(second.intent.id, first.intent.id);
			assert.equal(second.confirmToken, first.confirmToken);
			const settled = await env.outbox.confirm(first.intent.id, first.confirmToken).then(() => env.outbox.settle(first.intent.id));
			assert.equal(settled.state, "sent");
			env.outbox.stop();

			const again = await setup({ stateDir: env.dir });
			try {
				const third = await again.outbox.create({ key: k, chatID: CHAT, text: "same intent" });
				assert.equal(third.intent.id, first.intent.id);
				assert.equal(third.intent.state, "sent");
				assert.equal(third.confirmToken, undefined);
				assert.equal(env.fake.sends.length, 1);
			} finally {
				again.outbox.stop();
				await again.fake.close();
			}
		} finally {
			await env.fake.close();
			rmSync(env.dir, { recursive: true, force: true });
		}
	});

	test("cancel works only from pending_confirm", async () => {
		const env = await setup();
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "never mind" });
			const cancelled = env.outbox.cancel(created.intent.id);
			assert.equal(cancelled.state, "cancelled");
			assert.throws(() => env.outbox.cancel(created.intent.id), { status: 409 });
			assert.equal(env.fake.sends.length, 0);

			const sent = await env.outbox.create({ key: key(), chatID: CHAT, text: "going through" });
			await env.outbox.confirm(sent.intent.id, sent.confirmToken);
			await env.outbox.settle(sent.intent.id);
			assert.throws(() => env.outbox.cancel(sent.intent.id), { status: 409 });
		} finally {
			await env.close();
		}
	});

	test("the confirm rate limit answers outbox_rate_limited", async () => {
		const env = await setup({ tunables: { confirmPerMinute: 3 } });
		try {
			for (let i = 0; i < 3; i++) {
				const c = await env.outbox.create({ key: key(), chatID: CHAT, text: `burst ${i}` });
				await env.outbox.confirm(c.intent.id, c.confirmToken);
			}
			const over = await env.outbox.create({ key: key(), chatID: CHAT, text: "one too many" });
			await assert.rejects(env.outbox.confirm(over.intent.id, over.confirmToken), (e) => {
				assert.equal(e.status, 429);
				assert.equal(e.message, "outbox_rate_limited");
				return true;
			});
			await env.outbox.settle(over.intent.id).catch(() => {});
			await sleep(150);
			assert.equal(env.fake.sends.length, 3);
		} finally {
			await env.close();
		}
	});

	test("read-only and archived chats are refused at create", async () => {
		const env = await setup();
		try {
			for (const id of [READONLY_CHAT, ARCHIVED_CHAT]) {
				await assert.rejects(env.outbox.create({ key: key(), chatID: id, text: "nope" }), (e) => {
					assert.equal(e.status, 409);
					assert.equal(e.message, "chat_not_sendable");
					return true;
				});
			}
			await assert.rejects(env.outbox.create({ key: key(), chatID: "!nowhere:x", text: "nope" }), { status: 404 });
			await assert.rejects(env.outbox.create({ key: key(), chatID: CHAT, text: "" }), { status: 400 });
			await assert.rejects(env.outbox.create({ key: key(), chatID: CHAT, text: "x".repeat(20_001) }), { status: 400 });
			assert.equal(env.fake.sends.length, 0);
		} finally {
			await env.close();
		}
	});

	test("reissue needs the exact text, goes through the sheet again, sends once more", async () => {
		const env = await setup({ plan: { statuses: ["FAIL_PERMANENT"] } });
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "try again" });
			await env.outbox.confirm(created.intent.id, created.confirmToken);
			assert.equal((await env.outbox.settle(created.intent.id)).state, "failed");
			assert.equal(env.journal().intents[0].text, undefined, "text gone after the final state");

			assert.throws(() => env.outbox.reissue(created.intent.id, "different text"), (e) => {
				assert.equal(e.status, 409);
				assert.equal(e.message, "confirm_invalid");
				return true;
			});
			const reissued = env.outbox.reissue(created.intent.id, "try again");
			assert.equal(reissued.intent.state, "pending_confirm");
			assert.notEqual(reissued.confirmToken, created.confirmToken);

			env.fake.setSendPlan({ statuses: ["SUCCESS"] });
			await env.outbox.confirm(created.intent.id, reissued.confirmToken);
			assert.equal((await env.outbox.settle(created.intent.id)).state, "sent");
			assert.equal(env.fake.sends.length, 2, "one send per confirm, none automatic");
		} finally {
			await env.close();
		}
	});

	test("a dead Beeper refuses the confirm before the send: beeper_unavailable", async () => {
		const env = await setup();
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "later" });
			await env.fake.down();
			await assert.rejects(env.outbox.confirm(created.intent.id, created.confirmToken), (e) => {
				assert.equal(e.status, 503);
				assert.equal(e.message, "beeper_unavailable");
				return true;
			});
			assert.equal(env.outbox.get(created.intent.id).state, "pending_confirm");
			await env.fake.up();
		} finally {
			await env.close();
		}
	});

	test("finalized intents are pruned after their retention, non-final are kept", async () => {
		const env = await setup({ tunables: { retainFinalMs: 80 } });
		try {
			const done = await env.outbox.create({ key: key(), chatID: CHAT, text: "short-lived" });
			await env.outbox.confirm(done.intent.id, done.confirmToken);
			await env.outbox.settle(done.intent.id);
			const waiting = await env.outbox.create({ key: key(), chatID: CHAT, text: "still here" });
			await sleep(120);
			env.outbox.sweep();
			assert.throws(() => env.outbox.get(done.intent.id), { status: 404 });
			assert.equal(env.outbox.get(waiting.intent.id).state, "pending_confirm");
		} finally {
			await env.close();
		}
	});

	test("log lines carry the state and id, never text or titles", async () => {
		const env = await setup();
		try {
			const created = await env.outbox.create({ key: key(), chatID: CHAT, text: "super secret words" });
			await env.outbox.confirm(created.intent.id, created.confirmToken);
			await env.outbox.settle(created.intent.id);
			const all = env.logs.join("\n");
			assert.match(all, /inbox: send sending intent=[0-9a-f]{8} ms=\d+/);
			assert.match(all, /inbox: send sent intent=[0-9a-f]{8} ms=\d+/);
			assert.equal(all.includes("super secret words"), false);
			assert.equal(all.includes("Ana Test"), false);
		} finally {
			await env.close();
		}
	});
});

// ---------------------------------------------------------------- HTTP + WS

function raw(port, path, { headers = {}, method = "GET", body } = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

const auth = { authorization: `Bearer ${TOKEN}` };
const jsonHeaders = { ...auth, "content-type": "application/json" };
const parse = (r) => JSON.parse(r.body.toString("utf8"));

describe("outbox over HTTP and the inbox socket", () => {
	let env;
	let dir;

	after(async () => {
		await env?.server.close();
		await env?.fake.close();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("boot", async () => {
		const fake = await startFakeBeeper();
		dir = mkdtempSync(join(tmpdir(), "pi-super-outbox-http-"));
		const tokenPath = join(dir, "beeper-token");
		writeFileSync(tokenPath, `${fake.token}\n`, { mode: 0o600 });
		const client = join(dir, "client");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(client, { recursive: true });
		const cfg = parseArgs([
			"--state-dir",
			dir,
			"--no-meta",
			"--no-herdr",
			"--beeper-url",
			fake.url,
			"--beeper-token-file",
			tokenPath,
		]);
		const server = createServer(
			{
				...cfg,
				clientDir: client,
				metaDir: client,
				inboxDir: client,
				inboxOutbox: { confirmTtlMs: 120, pollIntervalMs: 25, pollBudgetMs: 400 },
			},
			TOKEN,
		);
		await new Promise((resolve) => server.http.listen(0, "127.0.0.1", resolve));
		env = { fake, server, port: server.http.address().port };
		env.server.inbox.start();
		await until(() => env.server.inbox.state().beeper.status === "ok" && !env.server.inbox.state().loading);
	});

	test("create → view → confirm over HTTP; WS broadcasts the transitions", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${env.port}/ws/inbox`, { headers: auth });
		const outboxMsgs = [];
		ws.on("message", (data) => {
			const m = JSON.parse(String(data));
			if (m.t === "outbox") outboxMsgs.push(m.intent);
		});
		await new Promise((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
		});
		await sleep(300);

		const created = await raw(env.port, "/api/inbox/outbox", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ key: key(), chatID: CHAT, text: "over http", replyToMessageID: "m-ana-1" }),
		});
		assert.equal(created.status, 200);
		const c = parse(created);
		assert.equal(c.intent.state, "pending_confirm");
		assert.equal(c.intent.replyTo.text.startsWith("synthetic text"), true);
		assert.equal("text" in c.intent, false);
		assert.ok(c.confirmToken);

		const view = await raw(env.port, `/api/inbox/outbox/${c.intent.id}`, { headers: auth });
		assert.equal(view.status, 200);
		assert.equal("text" in parse(view), false);

		const confirm = await raw(env.port, `/api/inbox/outbox/${c.intent.id}/confirm`, {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ confirmToken: c.confirmToken }),
		});
		assert.equal(confirm.status, 200);
		await until(() => env.fake.sends.length > 0);
		assert.equal(env.fake.sends.at(-1).body.replyToMessageID, "m-ana-1");
		await until(() => outboxMsgs.some((i) => i.id === c.intent.id && i.state === "sent"));
		const states = outboxMsgs.filter((i) => i.id === c.intent.id).map((i) => i.state);
		assert.deepEqual(states, ["pending_confirm", "sending", "pending", "sent"]);
		ws.close();
	});

	test("expired and wrong tokens over HTTP answer 410 and 409", async () => {
		const created = await raw(env.port, "/api/inbox/outbox", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ key: key(), chatID: CHAT, text: "http expiry" }),
		});
		const c = parse(created);
		const wrong = await raw(env.port, `/api/inbox/outbox/${c.intent.id}/confirm`, {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ confirmToken: "bogus" }),
		});
		assert.equal(wrong.status, 409);
		assert.equal(parse(wrong).error, "confirm_invalid");
		await sleep(160);
		const late = await raw(env.port, `/api/inbox/outbox/${c.intent.id}/confirm`, {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ confirmToken: c.confirmToken }),
		});
		assert.equal(late.status, 410);
		assert.equal(parse(late).error, "confirm_expired");
	});

	test("cancel, unknown intents, and bad routes", async () => {
		const created = await raw(env.port, "/api/inbox/outbox", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ key: key(), chatID: CHAT, text: "cancel me" }),
		});
		const c = parse(created);
		const cancelled = await raw(env.port, `/api/inbox/outbox/${c.intent.id}/cancel`, { method: "POST", headers: auth });
		assert.equal(cancelled.status, 200);
		assert.equal(parse(cancelled).state, "cancelled");

		assert.equal((await raw(env.port, "/api/inbox/outbox/nope", { headers: auth })).status, 404);
		assert.equal((await raw(env.port, "/api/inbox/outbox/nope/confirm", { method: "POST", headers: jsonHeaders, body: "{}" })).status, 404);
		assert.equal((await raw(env.port, "/api/inbox/outbox", { headers: auth })).status, 404);
		assert.equal((await raw(env.port, "/api/inbox/outbox", { method: "DELETE", headers: auth })).status, 404);
		assertOnlyReadsAndSends(env.fake);
	});
});
