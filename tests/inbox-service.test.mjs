import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { InboxError, InboxService } from "../dist/server/inbox/service.js";
import { MEDIA_PNG, startFakeBeeper } from "./fixtures/fake-beeper.mjs";

// Everything here runs against the synthetic fake in tests/fixtures; no real account is touched.

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

async function setup({ tokenFile = true, fake: fakeOpts = {}, service: svcOpts = {} } = {}) {
	const fake = await startFakeBeeper(fakeOpts);
	const dir = mkdtempSync(join(tmpdir(), "pi-super-inbox-"));
	const tokenPath = join(dir, "beeper-token");
	if (tokenFile) writeFileSync(tokenPath, `${fake.token}\n`, { mode: 0o600 });
	const logs = [];
	const svc = new InboxService({
		baseUrl: fake.url,
		tokenFile: tokenPath,
		stateDir: dir,
		log: (m) => logs.push(m),
		timeoutMs: 2000,
		refreshMs: 60_000,
		eventsMinDelayMs: 20,
		eventsMaxDelayMs: 200,
		...svcOpts,
	});
	return {
		fake,
		dir,
		tokenPath,
		logs,
		svc,
		async close() {
			svc.stop();
			await fake.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function started(env) {
	env.svc.start();
	await until(() => env.svc.state().beeper.status === "ok" && !env.svc.state().loading);
	return env;
}

const ids = (chats) => chats.map((c) => c.id).sort();

describe("read-only views", () => {
	let env;
	before(async () => {
		env = await started(await setup());
	});
	after(() => env.close());

	test("state reports ok, the token scope and every account", () => {
		const state = env.svc.state();
		assert.equal(state.beeper.status, "ok");
		assert.deepEqual(state.beeper.scope, ["read"]);
		assert.equal(state.accounts.length, 4);
		assert.deepEqual([...new Set(state.accounts.map((a) => a.network))].sort(), ["Beeper", "Telegram", "WeChat", "WhatsApp"]);
		assert.equal(typeof state.updatedAt, "string");
	});

	test("all chats: every network, merged duplicates hidden, newest activity first", () => {
		const { chats, counts, stale } = env.svc.list({ filter: "all" });
		assert.equal(chats.length, 12);
		assert.equal(counts.all, 12);
		assert.equal(stale, false);
		assert.equal(chats.some((c) => c.id === "!tg-dup:tg.test"), false, "a chat merged into another is not listed");
		assert.deepEqual([...new Set(chats.map((c) => c.network))].sort(), ["Beeper", "Telegram", "WeChat", "WhatsApp"]);
		const times = chats.map((c) => Date.parse(c.lastActivity ?? "") || 0);
		assert.deepEqual(times, [...times].sort((a, b) => b - a));
	});

	test("reply view is exactly what the rules put in front of the user, each with a reason", () => {
		const { chats, counts } = env.svc.list({ filter: "reply" });
		assert.deepEqual(ids(chats), [
			"!tg-friends:tg.test",
			"!wa-ana:wa.test",
			"!wa-marked:wa.test",
			"!wa-media:wa.test",
			"!wa-react:wa.test",
			"!wc-reply:wc.test",
		]);
		assert.equal(counts.reply, 6);
		const byId = Object.fromEntries(chats.map((c) => [c.id, c]));
		assert.deepEqual(byId["!tg-friends:tg.test"].labels.reasons, [{ code: "mention" }]);
		assert.deepEqual(byId["!wc-reply:wc.test"].labels.reasons, [{ code: "reply_to_you", messageID: "m-rp-3" }]);
		assert.equal(byId["!wa-react:wa.test"].labels.reasons[0].code, "dm_waiting", "a reaction as the newest event is looked past");
		assert.deepEqual(byId["!wa-marked:wa.test"].labels.reasons.map((r) => r.code), ["dm_waiting", "marked"]);
	});

	test("unread view: archived and low-priority only in all; muted only through a mention", () => {
		const { chats, counts } = env.svc.list({ filter: "unread" });
		assert.deepEqual(ids(chats), [
			"!tg-friends:tg.test",
			"!wa-ana:wa.test",
			"!wa-marked:wa.test",
			"!wa-media:wa.test",
			"!wa-react:wa.test",
			"!wc-noise:wc.test",
			"!wc-reply:wc.test",
		]);
		assert.equal(counts.unread, 7);
		assert.equal(ids(env.svc.list({ filter: "all" }).chats).includes("!wa-arch:wa.test"), true);
	});

	test("network and search filters narrow every view, case-insensitively", () => {
		const wa = env.svc.list({ filter: "all", network: "WhatsApp" });
		assert.equal(wa.chats.length, 6);
		assert.ok(wa.chats.every((c) => c.network === "WhatsApp"));
		assert.equal(wa.counts.all, 6);

		assert.deepEqual(ids(env.svc.list({ filter: "all", q: "ANA" }).chats), ["!wa-ana:wa.test"]);
		assert.deepEqual(ids(env.svc.list({ filter: "all", q: "friends" }).chats), ["!tg-friends:tg.test"]);
		assert.deepEqual(ids(env.svc.list({ filter: "all", q: "name bob" }).chats), ["!tg-bob:tg.test"], "participant names are searched");
	});

	test("chat detail lists participants and marks the user's own identity", () => {
		const chat = env.svc.chat("!wa-ana:wa.test");
		assert.ok(chat);
		assert.equal(chat.participants.find((p) => p.isSelf)?.id, "@self-wa:wa.test");
		assert.equal(chat.participants.find((p) => !p.isSelf)?.name, "Name ana");
		assert.equal(env.svc.chat("!nope:test.invalid"), undefined);
	});

	test("messages: kinds, reactions, and attachments addressed by the server's own paths", async () => {
		const media = await env.svc.messages("!wa-media:wa.test");
		assert.equal(media.nextCursor, null);
		const [m] = media.messages;
		assert.equal(m.kind, "image");
		assert.equal(m.text, "look at this");
		assert.deepEqual(
			m.attachments.map((a) => a.url),
			[
				"/api/inbox/attachments/!wa-media%3Awa.test/m-md-1/0",
				"/api/inbox/attachments/!wa-media%3Awa.test/m-md-1/1",
			],
		);
		assert.equal(m.attachments[0].width, 96);

		const react = await env.svc.messages("!wa-react:wa.test");
		assert.deepEqual(react.messages.map((x) => x.kind), ["text", "reaction"]);

		const notice = await env.svc.messages("!mx-news:mx.test");
		assert.equal(notice.messages[0].kind, "notice");
	});

	test("attachment proxy: serves mxc://, refuses file://, and never takes a client URL", async () => {
		const ok = await env.svc.attachment("!wa-media:wa.test", "m-md-1", 0);
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get("content-type"), "image/png");
		assert.deepEqual(Buffer.from(await ok.arrayBuffer()), MEDIA_PNG);

		await assert.rejects(env.svc.attachment("!wa-media:wa.test", "m-md-1", 1), (err) => err instanceof InboxError && err.status === 400);
		await assert.rejects(env.svc.attachment("!wa-media:wa.test", "m-md-1", 9), (err) => err instanceof InboxError && err.status === 404);
		await assert.rejects(env.svc.attachment("!wa-media:wa.test", "m-nope", 0), (err) => err instanceof InboxError && err.status === 404);
		await assert.rejects(env.svc.attachment("!nope:test.invalid", "m-md-1", 0), (err) => err instanceof InboxError && err.status === 404);

		const serves = env.fake.calls.filter((c) => c.path === "/v1/assets/serve").length;
		assert.equal(serves, 1, "only the mxc:// attachment reached Beeper");
	});

	test("reading never calls a write endpoint (CA2): only GETs, plus the one token introspection", () => {
		const writes = env.fake.calls.filter((c) => c.method !== "GET");
		assert.deepEqual(writes, [{ method: "POST", path: "/oauth/introspect" }]);
		const paths = new Set(env.fake.calls.map((c) => c.path));
		for (const p of paths) {
			assert.ok(
				/^\/v1\/(info|accounts|chats|chats\/[^/]+|chats\/[^/]+\/messages|assets\/serve)$|^\/oauth\/introspect$/.test(p),
				`unexpected path: ${p}`,
			);
		}
	});
});

describe("live updates", () => {
	let env;
	before(async () => {
		env = await started(await setup());
	});
	after(() => env.close());

	test("a new incoming message reaches the reply view through the event stream", async () => {
		const changes = [];
		const onChats = (u) => changes.push(...u.changed.map((c) => c.id));
		env.svc.on("chats", onChats);
		env.fake.addMessage(
			"!tg-bob:tg.test",
			{ id: "m-bob-2", senderID: "@bob:tg.test", senderName: "Name bob", timestamp: new Date().toISOString(), sortKey: "zz-bob-2", text: "hey" },
			{ emit: true },
		);
		await until(() => env.svc.list({ filter: "reply" }).chats.some((c) => c.id === "!tg-bob:tg.test"));
		env.svc.off("chats", onChats);
		assert.ok(changes.includes("!tg-bob:tg.test"));
	});

	test("a long history pages backwards with a cursor, newest page first", async () => {
		const chat = "!wa-ana:wa.test";
		const base = Date.now() - 60 * 60_000;
		for (let i = 0; i < 25; i++) {
			env.fake.addMessage(
				chat,
				{ id: `m-page-${i}`, senderID: "@ana:acc-wa.test", senderName: "Name ana", timestamp: new Date(base + i * 1000).toISOString(), sortKey: `p${String(i).padStart(3, "0")}`, text: `page ${i}` },
				{ emit: false, unread: false },
			);
		}
		env.fake.addMessage(
			chat,
			{ id: "m-page-last", senderID: "@ana:acc-wa.test", senderName: "Name ana", timestamp: new Date(base + 30_000).toISOString(), sortKey: "p999", text: "page last" },
			{ emit: true, unread: false },
		);
		await until(async () => (await env.svc.messages(chat)).messages.at(-1)?.id === "m-page-last");

		const first = await env.svc.messages(chat);
		assert.equal(first.messages.length, 20);
		assert.equal(first.messages.at(-1).id, "m-page-last");
		assert.notEqual(first.nextCursor, null);

		const older = await env.svc.messages(chat, first.nextCursor);
		assert.equal(older.nextCursor, null);
		assert.equal(first.messages.length + older.messages.length, 27);
		assert.ok(Date.parse(older.messages.at(-1).timestamp) <= Date.parse(first.messages[0].timestamp));
	});

	test("a lost event is repaired by the resync that follows a reconnect (CA6)", async () => {
		const chat = "!wc-noise:wc.test";
		env.fake.loseEvents(1);
		env.fake.addMessage(
			chat,
			{ id: "m-lost", senderID: "@q2:wc.test", senderName: "Name q2", timestamp: new Date(Date.now() + 1000).toISOString(), sortKey: "zz-lost", text: "lost in transit" },
			{ emit: true },
		);
		await sleep(300);
		assert.notEqual(env.svc.chat(chat).preview.text, "lost in transit", "the dropped event is not seen yet");

		env.fake.dropSockets();
		await until(() => env.svc.chat(chat).preview.text === "lost in transit");
		assert.ok(env.logs.filter((l) => l === "inbox: events connected").length >= 2, "the resync came from a reconnect");
	});

	test("corrections: no-reply removes a chat at once, and a newer incoming message brings it back (CA5)", async () => {
		const chat = "!wa-ana:wa.test";
		assert.equal(env.svc.list({ filter: "reply" }).chats.some((c) => c.id === chat), true);
		const after = env.svc.setNoReply(chat, true);
		assert.equal(after.labels.needsReply, false);
		assert.equal(after.labels.excludedBy, "no_reply_needed");
		assert.equal(env.svc.list({ filter: "reply" }).chats.some((c) => c.id === chat), false);

		env.fake.addMessage(
			chat,
			{ id: "m-ana-again", senderID: "@ana:acc-wa.test", senderName: "Name ana", timestamp: new Date(Date.now() + 60_000).toISOString(), sortKey: "zz-again", text: "again" },
			{ emit: true },
		);
		await until(() => env.svc.list({ filter: "reply" }).chats.some((c) => c.id === chat));
	});

	test("state carries the same counts as the list, and a correction pushes a new state", () => {
		const before = env.svc.state().counts;
		assert.deepEqual(before, {
			reply: env.svc.list({ filter: "reply" }).counts.reply,
			unread: env.svc.list({ filter: "unread" }).counts.unread,
			all: env.svc.list({ filter: "all" }).counts.all,
		});
		const seen = [];
		const onState = (st) => seen.push(st.counts.reply);
		env.svc.on("state", onState);
		env.svc.setNoReply("!wc-reply:wc.test", true);
		env.svc.off("state", onState);
		assert.equal(env.svc.state().counts.reply, before.reply - 1);
		assert.deepEqual(seen, [before.reply - 1]);
		env.svc.setNoReply("!wc-reply:wc.test", false);
	});

	test("priority is an important reason and does not change whether a chat needs a reply", () => {
		const out = env.svc.priority("!wa-old:wa.test", true);
		assert.deepEqual(out.labels.important, [{ code: "priority" }]);
		assert.equal(out.labels.needsReply, false);
		assert.equal(out.corrections.priority, true);
		env.svc.priority("!wa-old:wa.test", false);
	});

	test("logs and state carry no message text, chat titles, names or tokens (CA15)", () => {
		const text = env.logs.join("\n") + JSON.stringify(env.svc.state()) + JSON.stringify(env.svc.list({ filter: "all" }).counts);
		assert.equal(text.includes(env.fake.token), false, "token leaked");
		for (const secret of ["synthetic text", "lost in transit", "Ana Test", "Name ana", "look at this"]) {
			assert.equal(text.includes(secret), false, `leaked: ${secret}`);
		}
	});
});

describe("corrections survive a restart (CA5)", () => {
	test("a no-reply and a mark persist into a new service instance", async () => {
		const env = await started(await setup());
		try {
			env.svc.setNoReply("!wa-marked:wa.test", true);
			env.svc.mark("!tg-bob:tg.test", true);
			env.svc.stop();

			const again = new InboxService({
				baseUrl: env.fake.url,
				tokenFile: env.tokenPath,
				stateDir: env.dir,
				log: () => {},
				refreshMs: 60_000,
				eventsMinDelayMs: 20,
			});
			again.start();
			try {
				await until(() => again.state().beeper.status === "ok" && !again.state().loading);
				assert.equal(again.chat("!wa-marked:wa.test").labels.excludedBy, "no_reply_needed");
				assert.equal(again.chat("!tg-bob:tg.test").corrections.marked, true);
			} finally {
				again.stop();
			}
		} finally {
			await env.close();
		}
	});

	test("a snooze into the past is not a snooze, and an invalid one is refused", async () => {
		const env = await started(await setup());
		try {
			const snoozed = env.svc.snooze("!tg-friends:tg.test", new Date(Date.now() + 3_600_000).toISOString());
			assert.equal(snoozed.labels.excludedBy, "snoozed");
			assert.throws(() => env.svc.snooze("!tg-friends:tg.test", new Date(Date.now() - 1000).toISOString()), InboxError);
			assert.throws(() => env.svc.snooze("!tg-friends:tg.test", "soon"), InboxError);
			assert.equal(env.svc.snooze("!tg-friends:tg.test", null).labels.needsReply, true);
		} finally {
			await env.close();
		}
	});
});

describe("degraded states", () => {
	test("Beeper down: unreachable, the cache still answers, and recovery is picked up", async () => {
		const env = await started(await setup());
		try {
			assert.equal(env.svc.list({ filter: "all" }).chats.length, 12);
			await env.fake.down();
			await env.svc.refreshNow();
			assert.equal(env.svc.state().beeper.status, "unreachable");
			const cached = env.svc.list({ filter: "all" });
			assert.equal(cached.chats.length, 12, "the last good list is still served");
			assert.equal(cached.stale, true);
			await env.fake.up();
			await env.svc.refreshNow();
			await until(() => env.svc.state().beeper.status === "ok");
		} finally {
			await env.close();
		}
	});

	test("a refused token is unauthorized, and recovers once the token is accepted again", async () => {
		const env = await started(await setup());
		try {
			env.fake.setRejectAll(true);
			await env.svc.refreshNow();
			assert.equal(env.svc.state().beeper.status, "unauthorized");
			assert.equal(env.svc.list({ filter: "all" }).chats.length, 12);
			env.fake.setRejectAll(false);
			await env.svc.refreshNow();
			assert.equal(env.svc.state().beeper.status, "ok");
		} finally {
			await env.close();
		}
	});

	test("a slow Beeper is reported as slow, and the cache keeps serving", async () => {
		const env = await started(await setup({ service: { timeoutMs: 10_000 } }));
		try {
			env.fake.setLatency(2300, "/v1/chats");
			await env.svc.refreshNow();
			assert.equal(env.svc.state().beeper.status, "slow");
			assert.equal(env.svc.list({ filter: "all" }).chats.length, 12);
			env.fake.setLatency(0, "/v1/chats");
			await env.svc.refreshNow();
			assert.equal(env.svc.state().beeper.status, "ok");
		} finally {
			await env.close();
		}
	});

	test("no token file: unconfigured, and nothing is sent to Beeper; the token is picked up when it appears", async () => {
		const env = await setup({ tokenFile: false });
		try {
			env.svc.start();
			await sleep(200);
			assert.equal(env.svc.state().beeper.status, "unconfigured");
			assert.equal(env.fake.calls.length, 0);
			writeFileSync(env.tokenPath, `${env.fake.token}\n`, { mode: 0o600 });
			await env.svc.refreshNow();
			assert.equal(env.svc.state().beeper.status, "ok");
		} finally {
			await env.close();
		}
	});

	test("a token with write scope is reported in the log, not hidden", async () => {
		const env = await started(await setup({ fake: { scope: "read write" } }));
		try {
			assert.deepEqual(env.svc.state().beeper.scope, ["read", "write"]);
			assert.ok(env.logs.some((l) => l.includes("write scope")));
		} finally {
			await env.close();
		}
	});
});
