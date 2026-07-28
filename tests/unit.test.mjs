import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthed, originAllowed, parseCookies, requestToken, tokenEquals } from "../dist/server/auth.js";
import { parseArgs } from "../dist/server/config.js";
import { Tmux } from "../dist/server/tmux.js";
import { storeUpload } from "../dist/server/uploads.js";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- tmux output framing ---------------------------------------------------
// tmux >= 3.4 escapes control characters in non-tty output, so fields are framed
// by newlines and parsed positionally.

function parseRows(out, fields) {
	// mirror of the private Tmux.rows() framing rule
	const lines = out.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const records = [];
	for (let i = 0; i + fields <= lines.length; i += fields) records.push(lines.slice(i, i + fields));
	return records;
}

test("newline framing keeps empty trailing fields", () => {
	assert.deepEqual(parseRows("$0\n0\n\n$1\nwork\ngrp\n", 3), [
		["$0", "0", ""],
		["$1", "work", "grp"],
	]);
	assert.deepEqual(parseRows("", 3), []);
	assert.deepEqual(parseRows("a\nb\n", 2), [["a", "b"]]);
	assert.equal(typeof new Tmux([]).listSessions, "function");
});

// --- auth ------------------------------------------------------------------

test("parseCookies survives malformed percent-encoding", () => {
	// this runs before authentication: a throw here would be a free remote DoS
	assert.deepEqual(parseCookies("pi_super=%"), { pi_super: "%" });
	assert.deepEqual(parseCookies("a=1; b=%20x"), { a: "1", b: " x" });
	assert.deepEqual(parseCookies(undefined), {});
});

test("explicit credentials beat a stale cookie", () => {
	const url = new URL("http://h/?token=fresh");
	const req = { headers: { cookie: "pi_super=stale" } };
	assert.equal(requestToken(req, url), "fresh");
	assert.equal(requestToken({ headers: { authorization: "Bearer bear" } }, new URL("http://h/")), "bear");
	assert.equal(requestToken(req, new URL("http://h/")), "stale");
	assert.equal(isAuthed(req, url, "fresh"), true);
	assert.equal(isAuthed(req, new URL("http://h/"), "fresh"), false);
});

test("tokenEquals is length-safe", () => {
	assert.equal(tokenEquals("abc", "abc"), true);
	assert.equal(tokenEquals("abc", "abcd"), false);
	assert.equal(tokenEquals("", ""), true);
});

test("origin must match host, and scheme must not downgrade", () => {
	const plain = { headers: { host: "box:8722" }, socket: {} };
	assert.equal(originAllowed({ ...plain, headers: { ...plain.headers, origin: "http://box:8722" } }, undefined), true);
	assert.equal(originAllowed({ ...plain, headers: { ...plain.headers, origin: "http://evil:8722" } }, undefined), false);
	assert.equal(originAllowed(plain, undefined), true); // no Origin: native client
	const tls = { headers: { host: "box", origin: "http://box" }, socket: { encrypted: true } };
	assert.equal(originAllowed(tls, undefined), false);
	assert.equal(originAllowed({ ...tls, headers: { ...tls.headers, origin: "https://box" } }, undefined), true);
});

// --- uploads ---------------------------------------------------------------

test("uploads are sniffed, renamed and mode 0600", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-test-"));
	const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const path = storeUpload(dir, png, "../../etc/passwd", "text/plain");
	assert.ok(path.startsWith(join(dir, "uploads")), `${path} escaped the upload dir`);
	assert.ok(path.endsWith(".png"), "magic bytes win over a lying content-type");
	assert.ok(!path.includes("passwd"), "client-supplied name must not reach the filesystem");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(readFileSync(path).length, png.length);
});

// --- config ----------------------------------------------------------------

test("parseArgs maps flags and rejects nonsense", () => {
	const cfg = parseArgs(["-p", "9000", "-s", "work", "-L", "sock", "--status-line", "--no-meta"]);
	assert.equal(cfg.port, 9000);
	assert.equal(cfg.baseSession, "work");
	assert.deepEqual(cfg.socketArgs, ["-L", "sock"]);
	assert.equal(cfg.statusLine, true);
	assert.equal(cfg.metaEnabled, false);
	assert.equal(cfg.metaInheritExtensions, false);
	assert.throws(() => parseArgs(["--port", "0"]), /invalid --port/);
	assert.throws(() => parseArgs(["--nope"]), /unknown option/);
	assert.throws(() => parseArgs(["--port"]), /requires a value/);
});

// --- meta agent watchdog ---------------------------------------------------

test("a turn that goes silent is restarted and re-asked", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-meta-"));
	const log = join(dir, "prompts.log");
	// A pi that accepts a prompt, claims to start work, and then never says anything
	// again — exactly the wedged provider stream seen in the field.
	const fakePi = join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		`import { appendFileSync } from "node:fs";
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
	buf += c;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const cmd = JSON.parse(line);
		if (cmd.type !== "prompt") continue;
		appendFileSync(${JSON.stringify(log)}, cmd.message + "\\n");
		process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
		// ...and then silence, forever
	}
});
setInterval(() => {}, 1000);
`,
	);
	// a shell shim so the fake takes pi's real argv (which it ignores) without a new option
	const shim = join(dir, "pi");
	writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${fakePi}\n`, { mode: 0o755 });
	const { MetaAgent } = await import("../dist/server/meta.js");
	const meta = new MetaAgent({
		metaDir: join(import.meta.dirname, "..", "src", "meta"),
		socketArgs: [],
		piBin: shim,
		sessionDir: join(dir, "sessions"),
		stallMs: 300,
		watchdogMs: 50,
	});
	const systems = [];
	const spoken = [];
	meta.on("item", (item) => item.kind === "system" && systems.push(item.text));
	meta.on("speak", (s) => spoken.push(s.message));
	meta.prompt("what's running in the build window?");
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !systems.some((t) => /restarting/.test(t))) await new Promise((r) => setTimeout(r, 50));
	await new Promise((r) => setTimeout(r, 300));
	await meta.stop();

	assert.ok(systems.some((t) => /silent for .* mid-turn — restarting/.test(t)), systems.join(" | "));
	assert.ok(spoken.some((m) => /stuck/.test(m)), "the user is told out loud, not left in silence");
	const asked = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(asked.length, 2, "the stalled question is picked up again after the restart");
	// not a replay: a re-sent raw prompt would re-run whatever the killed turn already did
	assert.notEqual(asked[0], asked[1]);
	assert.match(asked[1], /do NOT repeat anything that already happened/);
	assert.ok(asked[1].includes(asked[0]), "the recovery prompt still carries the original request");
});

test("compaction is announced and survives the watchdog", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-compact-"));
	// Compaction is one long blocking summarization call: start event, then nothing on the
	// wire for as long as it takes. That silence must not be mistaken for a wedged stream.
	const fakePi = join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		`process.stdin.setEncoding("utf8");
let buf = "";
const say = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
process.stdin.on("data", (c) => {
	buf += c;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		if (JSON.parse(line).type !== "prompt") continue;
		say({ type: "agent_start" });
		say({ type: "compaction_start", reason: "threshold" });
		// far longer than stallMs, with not a byte in between
		setTimeout(() => {
			say({ type: "compaction_end", reason: "threshold", aborted: false, result: { tokensBefore: 150000, estimatedTokensAfter: 32000 } });
			say({ type: "agent_settled" });
		}, 900);
	}
});
setInterval(() => {}, 1000);
`,
	);
	const shim = join(dir, "pi");
	writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${fakePi}\n`, { mode: 0o755 });
	const { MetaAgent } = await import("../dist/server/meta.js");
	const meta = new MetaAgent({
		metaDir: join(import.meta.dirname, "..", "src", "meta"),
		socketArgs: [],
		piBin: shim,
		sessionDir: join(dir, "sessions"),
		stallMs: 200,
		watchdogMs: 50,
	});
	const systems = [];
	meta.on("item", (item) => item.kind === "system" && systems.push(item.text));
	meta.prompt("summarize the day");
	const deadline = Date.now() + 6000;
	while (Date.now() < deadline && !systems.some((t) => /compacted/.test(t))) await new Promise((r) => setTimeout(r, 50));
	await meta.stop();

	assert.ok(systems.some((t) => /compacting context \(threshold\)/.test(t)), systems.join(" | "));
	assert.ok(systems.some((t) => /context compacted: 150k → 32k tokens/.test(t)), systems.join(" | "));
	assert.ok(!systems.some((t) => /restarting/.test(t)), `the watchdog shot a healthy compaction: ${systems.join(" | ")}`);
});

// --- passkey store ---------------------------------------------------------

test("a second process's revocation is honoured, not overwritten", async () => {
	const { PasskeyStore } = await import("../dist/server/webauthn.js");
	const dir = mkdtempSync(join(tmpdir(), "pi-super-pk-"));
	const server = new PasskeyStore(dir);
	// hand-write a credential + session, as a real enrolment would leave behind
	writeFileSync(
		join(dir, "passkeys.json"),
		JSON.stringify({
			credentials: [{ id: "cred1", publicKey: "x", counter: 0, label: "phone", createdAt: "now" }],
			sessions: [{ id: "sid1", credentialId: "cred1", label: "phone", createdAt: 0, expiresAt: Date.now() + 3600_000 }],
		}),
	);
	assert.equal(server.enrolled, true, "the running server picks up the file it did not write");
	assert.equal(server.sessionAlive("sid1"), true);

	// `pi-super --remove-passkey` is a *different process* on the same file
	const cli = new PasskeyStore(dir);
	assert.equal(cli.removeCredential("phone"), true);

	assert.equal(server.enrolled, false, "revocation must reach the running server");
	assert.equal(server.sessionAlive("sid1"), false, "the credential's sessions go with it");
	server.revokeAllSessions(); // any save must not resurrect the removed credential
	assert.equal(new PasskeyStore(dir).credentials.length, 0);
});

test("one session logs out without evicting the others", async () => {
	const { PasskeyStore } = await import("../dist/server/webauthn.js");
	const dir = mkdtempSync(join(tmpdir(), "pi-super-pk2-"));
	const store = new PasskeyStore(dir);
	const sessions = ["a", "b"].map((id) => ({
		id,
		credentialId: "cred1",
		label: id,
		createdAt: 0,
		expiresAt: Date.now() + 3600_000,
	}));
	writeFileSync(
		join(dir, "passkeys.json"),
		JSON.stringify({ credentials: [{ id: "cred1", publicKey: "x", counter: 0, label: "phone", createdAt: "now" }], sessions }),
	);
	store.revokeSession("a");
	assert.equal(store.sessionAlive("a"), false);
	assert.equal(store.sessionAlive("b"), true);
});
