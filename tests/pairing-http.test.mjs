import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../dist/server/config.js";
import { createServer } from "../dist/server/server.js";

async function setup(t, mode = "token", extra = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-pair-test-"));
	mkdirSync(join(dir, "client"));
	const cfg = parseArgs(["--state-dir", dir, "--no-meta", "--no-herdr", "--no-inbox", "--auth", mode]);
	const server = createServer({ ...cfg, ...extra, clientDir: join(dir, "client"), metaDir: join(dir, "client") }, "TEST-TOKEN-SECRET");
	await new Promise(resolve => server.http.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.http.address().port}`;
	const post = (path, body, headers = {}) => fetch(base + "/api/auth/pair/" + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	t.after(async () => { await server.close(); assert.match(dir, /^\/tmp\/pi-super-pair-test-/); rmSync(dir, { recursive: true, force: true }); });
	return { dir, server, base, post };
}

test("pairing transports a temporary fragment ticket to a cookie, without GET consumption or token exposure", async t => {
	const f = await setup(t);
	const issue = await f.post("issue", { origin: f.base }, { authorization: "Bearer TEST-TOKEN-SECRET" });
	assert.equal(issue.status, 200);
	const data = await issue.json();
	assert.match(data.svg, /^<svg/);
	assert.ok(!JSON.stringify(data).includes("TEST-TOKEN-SECRET"));
	const link = new URL(data.url);
	const ticket = new URLSearchParams(link.hash.slice(1)).get("pair");
	assert.equal(link.pathname, "/pair");
	assert.equal(link.search, "");
	const entry = await fetch(data.url);
	assert.equal(entry.status, 200);
	assert.equal(entry.headers.get("set-cookie"), null, "camera preview cannot consume a grant");
	assert.equal(entry.headers.get("cache-control"), "no-store");
	assert.equal(entry.headers.get("referrer-policy"), "no-referrer");
	assert.ok(!(await entry.text()).includes(ticket));
	const redeemed = await f.post("redeem", { ticket });
	assert.equal(redeemed.status, 200);
	const cookie = redeemed.headers.get("set-cookie");
	assert.match(cookie, /pi_super=TEST-TOKEN-SECRET; HttpOnly; SameSite=Lax; Path=\//);
	const state = await fetch(f.base + "/api/auth/state", { headers: { cookie } }).then(r => r.json());
	assert.equal(state.authenticated, true);
	assert.equal((await f.post("redeem", { ticket })).status, 403);
});

test("pairing refuses unauthenticated issue, cross-site requests and unapproved origins", async t => {
	const f = await setup(t);
	assert.equal((await f.post("issue", { origin: f.base })).status, 401);
	const headers = { authorization: "Bearer TEST-TOKEN-SECRET" };
	assert.equal((await f.post("issue", { origin: "https://attacker.invalid" }, headers)).status, 400);
	assert.equal((await f.post("issue", { origin: f.base }, { ...headers, origin: "https://attacker.invalid" })).status, 403);
	const url = f.server.pairingUrl(f.base);
	const ticket = new URLSearchParams(new URL(url).hash.slice(1)).get("pair");
	assert.equal((await f.post("redeem", { ticket }, { origin: "https://attacker.invalid" })).status, 403);
	assert.equal((await f.post("redeem", { ticket }, { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await f.post("redeem", { ticket })).status, 200, "CSRF attempt cannot burn valid ticket");
	assert.equal(f.server.pairingUrl("http://192.168.1.2:8722"), undefined);
	const secureLink = f.server.pairingUrl("https://super.example");
	const secureTicket = new URLSearchParams(new URL(secureLink).hash.slice(1)).get("pair");
	const secure = await f.post("redeem", { ticket: secureTicket }, { "x-forwarded-proto": "https" });
	assert.equal(secure.status, 200);
	assert.match(secure.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
});

test("pairing never bypasses passkeys and pending token tickets die on first enrolment", async t => {
	const strict = await setup(t, "passkey");
	assert.equal(strict.server.pairingUrl(strict.base), undefined);
	assert.equal((await strict.post("issue", { origin: strict.base }, { authorization: "Bearer TEST-TOKEN-SECRET" })).status, 403);
	const f = await setup(t, "auto");
	const url = f.server.pairingUrl(f.base);
	const ticket = new URLSearchParams(new URL(url).hash.slice(1)).get("pair");
	writeFileSync(join(f.dir, "passkeys.json"), JSON.stringify({ credentials: [{ id: "cred", publicKey: "AA", counter: 0, label: "phone", createdAt: new Date().toISOString() }], sessions: [] }));
	assert.equal((await f.post("redeem", { ticket })).status, 403);
	assert.equal(f.server.pairingUrl(f.base), undefined);
});

test("fresh token link replaces stale cookies and always scrubs the URL", async t => {
	const f = await setup(t);
	const res = await fetch(f.base + "/?token=TEST-TOKEN-SECRET", { redirect: "manual", headers: { cookie: "pi_super=stale" } });
	assert.equal(res.status, 302);
	assert.equal(res.headers.get("location"), "/");
	assert.match(res.headers.get("set-cookie"), /pi_super=TEST-TOKEN-SECRET/);
	const pairToken = await fetch(f.base + "/pair?token=TEST-TOKEN-SECRET", { redirect: "manual" });
	assert.equal(pairToken.status, 302);
	assert.equal(pairToken.headers.get("location"), "/pair");
	assert.match(pairToken.headers.get("set-cookie"), /pi_super=TEST-TOKEN-SECRET/);
	const unauthed = await fetch(f.base + "/inbox/", { redirect: "manual" });
	assert.equal(unauthed.headers.get("location"), "/pair");
});

test("local authorized browser can generate the explicitly advertised HTTPS origin", async t => {
	const f = await setup(t, "token", { pairOrigin: "https://super.example" });
	const res = await f.post("issue", { origin: f.base }, { authorization: "Bearer TEST-TOKEN-SECRET" });
	assert.equal(res.status, 200);
	assert.match((await res.json()).url, /^https:\/\/super\.example\/pair#pair=/);
	const page = await fetch(f.base + "/pair", { headers: { authorization: "Bearer TEST-TOKEN-SECRET" } }).then(r => r.text());
	assert.ok(page.includes('const advertisedOrigin = "https://super.example";'));
});

test("pair-url validates reviewed reachable origin without changing bind", () => {
	assert.equal(parseArgs(["--pair-url", "https://super.example"]).pairOrigin, "https://super.example");
	assert.equal(parseArgs(["--pair-url", "https://super.example"]).host, "127.0.0.1");
	for (const origin of ["http://192.168.1.2", "https://u:p@super.example", "https://super.example/path", "https://super.example?token=x", "javascript:alert(1)"]) {
		assert.throws(() => parseArgs(["--pair-url", origin]));
	}
});
