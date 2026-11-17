import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { parseArgs } from "../dist/server/config.js";
import { createServer } from "../dist/server/server.js";
import { MEDIA_PNG, startFakeBeeper } from "./fixtures/fake-beeper.mjs";

// The real HTTP stack (auth, origin, routing) in front of the inbox, against the fake Beeper.

const TOKEN = `pi-super-test-${randomBytes(24).toString("base64url")}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const json = (r) => JSON.parse(r.body.toString("utf8"));

async function boot({ extra = [], inboxDir, fakeUrl, tokenPath, stateDir }) {
	const cfg = parseArgs([
		"--state-dir",
		stateDir,
		"--no-meta",
		"--no-herdr",
		"--beeper-url",
		fakeUrl,
		"--beeper-token-file",
		tokenPath,
		...extra,
	]);
	const empty = join(stateDir, "client");
	mkdirSync(empty, { recursive: true });
	const server = createServer({ ...cfg, clientDir: empty, metaDir: empty, inboxDir }, TOKEN);
	await new Promise((resolve) => server.http.listen(0, "127.0.0.1", resolve));
	return { server, port: server.http.address().port };
}

describe("inbox HTTP + WebSocket", () => {
	let fake;
	let stateDir;
	let inboxDir;
	let env;

	before(async () => {
		fake = await startFakeBeeper();
		stateDir = mkdtempSync(join(tmpdir(), "pi-super-inbox-server-"));
		inboxDir = join(stateDir, "inbox-build");
		mkdirSync(inboxDir);
		writeFileSync(join(inboxDir, "index.html"), "<!doctype html><title>inbox</title>\n");
		const tokenPath = join(stateDir, "beeper-token");
		writeFileSync(tokenPath, `${fake.token}\n`, { mode: 0o600 });
		env = await boot({ inboxDir, fakeUrl: fake.url, tokenPath, stateDir });
		env.server.inbox.start();
		for (let i = 0; i < 200; i++) {
			if (env.server.inbox.state().beeper.status === "ok" && !env.server.inbox.state().loading) break;
			await sleep(25);
		}
		assert.equal(env.server.inbox.state().beeper.status, "ok");
	});

	after(async () => {
		await env?.server.close();
		await fake?.close();
		if (stateDir) rmSync(stateDir, { recursive: true, force: true });
	});

	test("every /api/inbox route refuses a request without the token", async () => {
		for (const path of ["/api/inbox/state", "/api/inbox/chats?filter=reply", "/api/inbox/chats/x/messages"]) {
			const r = await raw(env.port, path);
			assert.equal(r.status, 401, path);
		}
		const r = await raw(env.port, "/api/inbox/state", { headers: { authorization: "Bearer nope" } });
		assert.equal(r.status, 401);
	});

	test("state and chat lists answer with the token, and never echo it or the Beeper token", async () => {
		const state = await raw(env.port, "/api/inbox/state", { headers: auth });
		assert.equal(state.status, 200);
		assert.equal(json(state).beeper.status, "ok");

		const reply = await raw(env.port, "/api/inbox/chats?filter=reply", { headers: auth });
		assert.equal(reply.status, 200);
		const body = reply.body.toString("utf8");
		assert.equal(json(reply).counts.reply, 6);
		assert.equal(body.includes(fake.token), false);
		assert.equal(body.includes(TOKEN), false);
	});

	test("bad filters and bodies are answered with 400, unknown chats with 404", async () => {
		assert.equal((await raw(env.port, "/api/inbox/chats?filter=later", { headers: auth })).status, 400);
		const chat = encodeURIComponent("!wa-ana:wa.test");
		assert.equal((await raw(env.port, `/api/inbox/chats/${chat}/messages?direction=after`, { headers: auth })).status, 400);
		assert.equal((await raw(env.port, "/api/inbox/chats/%21nope/messages", { headers: auth })).status, 404);
		assert.equal((await raw(env.port, `/api/inbox/chats/${chat}/snooze`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ until: "soon" }) })).status, 400);
		assert.equal((await raw(env.port, `/api/inbox/chats/${chat}/mark`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ on: "yes" }) })).status, 400);
		assert.equal((await raw(env.port, `/api/inbox/chats/${chat}/mark`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{not json" })).status, 400);
	});

	test("corrections over HTTP move a chat out of the reply view and back, returning the updated chat", async () => {
		const id = "!wa-ana:wa.test";
		const chat = encodeURIComponent(id);
		const dismissed = await raw(env.port, `/api/inbox/chats/${chat}/no-reply`, { method: "POST", headers: auth });
		assert.equal(dismissed.status, 200);
		assert.equal(json(dismissed).labels.excludedBy, "no_reply_needed");

		const withoutIt = await raw(env.port, "/api/inbox/chats?filter=reply", { headers: auth });
		assert.equal(json(withoutIt).chats.some((c) => c.id === id), false);

		const restored = await raw(env.port, `/api/inbox/chats/${chat}/no-reply`, { method: "DELETE", headers: auth });
		assert.equal(json(restored).labels.needsReply, true);

		const snoozed = await raw(env.port, `/api/inbox/chats/${chat}/snooze`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ until: new Date(Date.now() + 3_600_000).toISOString() }),
		});
		assert.equal(json(snoozed).labels.excludedBy, "snoozed");
		await raw(env.port, `/api/inbox/chats/${chat}/snooze`, { method: "DELETE", headers: auth });

		const marked = await raw(env.port, `/api/inbox/chats/${chat}/mark`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ on: true }),
		});
		assert.equal(json(marked).corrections.marked, true);
		await raw(env.port, `/api/inbox/chats/${chat}/mark`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ on: false }) });
	});

	test("attachments: the image comes through with safe headers; a file:// source does not", async () => {
		const chat = encodeURIComponent("!wa-media:wa.test");
		const ok = await raw(env.port, `/api/inbox/attachments/${chat}/m-md-1/0`, { headers: auth });
		assert.equal(ok.status, 200);
		assert.equal(ok.headers["content-type"], "image/png");
		assert.equal(ok.headers["cache-control"], "private, max-age=300");
		assert.equal(ok.headers["x-content-type-options"], "nosniff");
		assert.deepEqual(ok.body, MEDIA_PNG);

		const local = await raw(env.port, `/api/inbox/attachments/${chat}/m-md-1/1`, { headers: auth });
		assert.equal(local.status, 400);
		assert.equal(local.body.toString("utf8").includes("FAKE-LOCAL-FILE-CONTENT"), false);
	});

	test("the API made no write call to Beeper: the only POST is the token introspection", () => {
		const writes = fake.calls.filter((c) => c.method !== "GET");
		assert.deepEqual(writes, [{ method: "POST", path: "/oauth/introspect" }]);
	});

	test("/inbox serves the built app with an index fallback, and refuses traversal", async () => {
		const page = await raw(env.port, "/inbox", { headers: auth });
		assert.equal(page.status, 200);
		assert.match(page.body.toString("utf8"), /<title>inbox<\/title>/);
		assert.equal(page.headers["cache-control"], "no-store");

		const route = await raw(env.port, "/inbox/chats/some-id", { headers: auth });
		assert.equal(route.status, 200);
		assert.match(route.body.toString("utf8"), /inbox/);

		const escape = await raw(env.port, "/inbox/%2e%2e%2f%2e%2e%2fetc%2fpasswd", { headers: auth });
		assert.equal(escape.status, 403);

		assert.equal((await raw(env.port, "/inbox")).status, 401, "the page is behind the same login");
	});

	test("the inbox WebSocket: refused without the token, and sends state, chats and pong with it", async () => {
		const url = `ws://127.0.0.1:${env.port}/ws/inbox`;
		await assert.rejects(
			new Promise((resolve, reject) => {
				const ws = new WebSocket(url);
				ws.on("open", () => reject(new Error("opened without a token")));
				ws.on("error", (err) => reject(err));
				ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
			}),
			/HTTP 401/,
		);

		const ws = new WebSocket(url, { headers: auth });
		const seen = [];
		const pending = new Map();
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data));
			seen.push(msg.t);
			pending.get(msg.t)?.(msg);
		});
		const waitFor = (t) => new Promise((resolve) => (seen.includes(t) ? resolve() : pending.set(t, resolve)));
		await new Promise((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
		});
		await waitFor("chats");
		assert.ok(seen.includes("state"));
		const pong = new Promise((resolve) => pending.set("pong", resolve));
		ws.send(JSON.stringify({ t: "ping" }));
		await pong;
		ws.close();
	});
});

describe("inbox configuration and degraded wiring", () => {
	test("the flags and their defaults", () => {
		const cfg = parseArgs(["--state-dir", "/var/tmp/x"]);
		assert.equal(cfg.inbox, true);
		assert.equal(cfg.beeperUrl, "http://127.0.0.1:23373");
		assert.equal(cfg.beeperTokenFile, "/var/tmp/x/beeper-token");

		const custom = parseArgs(["--no-inbox", "--beeper-url", "http://10.0.0.2:9", "--beeper-token-file", "/t/tok"]);
		assert.equal(custom.inbox, false);
		assert.equal(custom.beeperUrl, "http://10.0.0.2:9");
		assert.equal(custom.beeperTokenFile, "/t/tok");

		assert.throws(() => parseArgs(["--beeper-url", "ftp://x"]), /http\(s\) URL/);
	});

	test("the environment sets the same values", () => {
		const saved = { url: process.env.PI_SUPER_BEEPER_URL, tok: process.env.PI_SUPER_BEEPER_TOKEN_FILE };
		process.env.PI_SUPER_BEEPER_URL = "http://127.0.0.1:9999";
		process.env.PI_SUPER_BEEPER_TOKEN_FILE = "/env/token";
		try {
			const cfg = parseArgs([]);
			assert.equal(cfg.beeperUrl, "http://127.0.0.1:9999");
			assert.equal(cfg.beeperTokenFile, "/env/token");
		} finally {
			if (saved.url === undefined) delete process.env.PI_SUPER_BEEPER_URL;
			else process.env.PI_SUPER_BEEPER_URL = saved.url;
			if (saved.tok === undefined) delete process.env.PI_SUPER_BEEPER_TOKEN_FILE;
			else process.env.PI_SUPER_BEEPER_TOKEN_FILE = saved.tok;
		}
	});

	test("--no-inbox: no inbox API, and the socket is answered 503", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "pi-super-inbox-off-"));
		const { server, port } = await boot({
			extra: ["--no-inbox"],
			inboxDir: stateDir,
			fakeUrl: "http://127.0.0.1:9",
			tokenPath: join(stateDir, "none"),
			stateDir,
		});
		try {
			assert.equal(server.inbox, undefined);
			assert.equal((await raw(port, "/api/inbox/state", { headers: auth })).status, 404);
			await assert.rejects(
				new Promise((resolve, reject) => {
					const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/inbox`, { headers: auth });
					ws.on("open", () => reject(new Error("opened")));
					ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
					ws.on("error", reject);
				}),
				/HTTP 503/,
			);
		} finally {
			await server.close();
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	test("missing build: /inbox says what to run; a passkey policy sends the browser to the unlock page", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "pi-super-inbox-nobuild-"));
		const { server, port } = await boot({
			inboxDir: join(stateDir, "absent"),
			fakeUrl: "http://127.0.0.1:9",
			tokenPath: join(stateDir, "none"),
			stateDir,
		});
		try {
			const r = await raw(port, "/inbox", { headers: auth });
			assert.equal(r.status, 404);
			assert.match(r.body.toString("utf8"), /inbox build missing — run the inbox build/);
		} finally {
			await server.close();
			rmSync(stateDir, { recursive: true, force: true });
		}

		const strict = mkdtempSync(join(tmpdir(), "pi-super-inbox-passkey-"));
		const { server: s2, port: p2 } = await boot({
			extra: ["--auth", "passkey"],
			inboxDir: strict,
			fakeUrl: "http://127.0.0.1:9",
			tokenPath: join(strict, "none"),
			stateDir: strict,
		});
		try {
			const r = await raw(p2, "/inbox/anything");
			assert.equal(r.status, 302);
			assert.equal(r.headers.location, "/");
		} finally {
			await s2.close();
			rmSync(strict, { recursive: true, force: true });
		}
	});
});
