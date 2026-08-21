import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthed, originAllowed, parseCookies, requestToken, tokenEquals } from "../dist/server/auth.js";
import { parseArgs } from "../dist/server/config.js";
import { buildVocabulary, dictationInstructions } from "../dist/server/dictation.js";
import { chooseActiveMetaClient, voiceInstructions } from "../dist/server/server.js";
import { piKeyToTmux, scrollBottomKey } from "../dist/server/pi-keybindings.js";
import { Tmux, appOwnsPageKeys } from "../dist/server/tmux.js";
import { storeUpload } from "../dist/server/uploads.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

test("meta client control targets foreground activity without guessing among clients", () => {
	const first = { readyState: 1, name: "first" };
	const second = { readyState: 1, name: "second" };
	const closed = { readyState: 3, name: "closed" };
	assert.equal(chooseActiveMetaClient([first, second], second), second, "reported foreground client wins");
	assert.equal(chooseActiveMetaClient([first, closed], closed), first, "one open client is an unambiguous fallback");
	assert.equal(chooseActiveMetaClient([first, second]), undefined, "do not move either of two clients without presence");
	assert.equal(chooseActiveMetaClient([first], first, new Set([first])), undefined, "a hidden client is not eligible even alone");
	assert.equal(
		chooseActiveMetaClient([first, second], first, new Set([first])),
		second,
		"the sole visible client wins when the formerly active one is hidden",
	);
	assert.equal(chooseActiveMetaClient([closed]), undefined, "closed clients are never targets");
});

test("a new window with blank cwd opens in home, not the server checkout", async () => {
	const calls = [];
	class RecordingTmux extends Tmux {
		async run(args) {
			calls.push(args);
			return "@42\n";
		}
	}
	const tmux = new RecordingTmux([]);
	assert.equal(await tmux.newWindow("work"), "@42");
	assert.deepEqual(calls[0].slice(-2), ["-c", homedir()]);

	await tmux.newWindow("work", { cwd: "" });
	assert.deepEqual(calls[1].slice(-2), ["-c", homedir()]);

	await tmux.newWindow("work", { cwd: "/tmp/intended" });
	assert.deepEqual(calls[2].slice(-2), ["-c", "/tmp/intended"]);
});

// --- PgUp routing ----------------------------------------------------------

test("PgUp reaches a full-screen app even when tmux ignores the alternate screen", () => {
	// fields of PANE_KEY_FORMAT: alt, in_mode, cursor, wrap, keypad_cursor, keypad, mouse, command
	const pane = (f) => f.join("\n") + "\n";
	// measured with `set -g alternate-screen off`, where alternate_on is stuck at 0
	assert.equal(appOwnsPageKeys(pane(["0", "0", "0", "0", "0", "0", "0", "pi"])), true, "pi");
	assert.equal(appOwnsPageKeys(pane(["0", "0", "1", "1", "1", "1", "0", "vim"])), true, "vim");
	assert.equal(appOwnsPageKeys(pane(["0", "0", "1", "1", "1", "1", "0", "less"])), true, "less");
	assert.equal(appOwnsPageKeys(pane(["0", "0", "0", "1", "1", "1", "0", "top"])), true, "top");
	// and the scrolling cases still get copy-mode
	assert.equal(appOwnsPageKeys(pane(["0", "0", "1", "1", "0", "0", "0", "-bash"])), false, "login shell");
	assert.equal(appOwnsPageKeys(pane(["0", "0", "1", "1", "0", "0", "0", "npm"])), false, "build output");
	// a shell left with just a hidden cursor by a crashed TUI must not lose its scrollback
	assert.equal(appOwnsPageKeys(pane(["0", "0", "0", "1", "0", "0", "0", "bash"])), false, "wedged shell");
	// a side-agent pane runs pi under a launch.sh wrapper, so tmux names the pane `bash`
	assert.equal(appOwnsPageKeys(pane(["0", "0", "0", "0", "0", "0", "0", "bash"])), true, "pi under a wrapper");
	// the plain alternate-screen answer still wins, and copy-mode keeps paging
	assert.equal(appOwnsPageKeys(pane(["1", "0", "1", "1", "0", "0", "0", "vim"])), true, "alternate screen");
	assert.equal(appOwnsPageKeys(pane(["0", "1", "1", "1", "0", "0", "0", "bash"])), true, "already in copy mode");
});

// --- scroll-to-bottom key from pi's own keybindings ------------------------

test("pi keybinding ids translate to tmux key names", () => {
	assert.equal(piKeyToTmux("end"), "End");
	assert.equal(piKeyToTmux("ctrl+end"), "C-End");
	assert.equal(piKeyToTmux("ctrl+shift+down"), "C-S-Down");
	assert.equal(piKeyToTmux("alt+g"), "M-g");
	assert.equal(piKeyToTmux("f12"), "F12");
	// a chord pi understands but tmux cannot express must not be sent mangled
	assert.equal(piKeyToTmux("cmd+end"), undefined);
});

test("scrollBottomKey follows the local pi config and falls back to stock End", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-keys-"));
	assert.equal(scrollBottomKey(dir), "End", "no config file");
	writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "tui.altScreen.bottom": ["ctrl+end"] }));
	assert.equal(scrollBottomKey(dir), "C-End", "rebound");
	writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "app.clipboard.pasteImage": [] }));
	assert.equal(scrollBottomKey(dir), "End", "config without this binding");
	writeFileSync(join(dir, "keybindings.json"), "{ not json");
	assert.equal(scrollBottomKey(dir), "End", "broken config");
	writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "tui.altScreen.bottom": ["cmd+end", "ctrl+end"] }));
	assert.equal(scrollBottomKey(dir), "C-End", "untranslatable binding skipped");
	rmSync(dir, { recursive: true, force: true });
});

// --- prompt log ------------------------------------------------------------

test("a prompt survives the agent that never answered it", async () => {
	const { PromptLog } = await import("../dist/server/prompts.js");
	const dir = mkdtempSync(join(tmpdir(), "pi-super-prompts-"));
	const log = new PromptLog(dir);
	const answered = log.record("what is the build status", "chat");
	const lost = log.record("a long batch of feedback", "voice");
	log.answered([answered]);

	// the log is the point: a fresh reader (i.e. the restarted process) sees the same thing
	const pending = new PromptLog(dir).unanswered();
	assert.deepEqual(
		pending.map((p) => [p.id, p.source, p.text]),
		[[lost, "voice", "a long batch of feedback"]],
	);
	assert.ok(readFileSync(join(dir, "prompts.jsonl"), "utf8").includes("a long batch of feedback"));

	// once reported it must not come back on every later restart
	log.answered([lost]);
	assert.deepEqual(new PromptLog(dir).unanswered(), []);
});

test("the prompt log survives a torn line and forgets ancient prompts", async () => {
	const { PromptLog } = await import("../dist/server/prompts.js");
	const dir = mkdtempSync(join(tmpdir(), "pi-super-prompts-"));
	const file = join(dir, "prompts.jsonl");
	const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
	writeFileSync(
		file,
		`${JSON.stringify({ id: "ancient", at: old, source: "chat", text: "last week" })}\n{"id":"torn","te`,
	);
	const log = new PromptLog(dir);
	const live = log.record("still owed", "chat");
	assert.deepEqual(
		log.unanswered().map((p) => p.id),
		[live],
	);
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

// A realtime session cannot be resumed, so a reload leaves the voice with no memory while
// super still has all of it. The instructions are the only place that can be said.
test("a call joining a conversation in progress is told to ask super for the catch-up", () => {
	const metaDir = join(import.meta.dirname, "..", "src", "meta");
	const fresh = voiceInstructions(metaDir, 0);
	assert.equal(fresh, readFileSync(join(metaDir, "voice-prompt.md"), "utf8"), "a first call gets the prompt as written");

	const joined = voiceInstructions(metaDir, 7);
	assert.ok(joined.startsWith(fresh), "the catch-up is appended, never a replacement");
	assert.match(joined, /7 exchanges/);
	assert.match(joined, /catch-up/);
	assert.match(joined, /Never\nask the user to tell you what you missed/);

	// a missing prompt file must still yield usable instructions, not a crash
	assert.match(voiceInstructions(join(tmpdir(), "pi-super-no-such-dir"), 3), /catch-up/);
});

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

test("client_show tool completion requests a validated foreground-client switch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-client-show-"));
	const fakePi = join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		`process.stdin.setEncoding("utf8");
let buf = "";
const say = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	if (!buf.includes("\\n")) return;
	say({ type: "agent_start" });
	say({ type: "tool_execution_start", toolCallId: "show1", toolName: "client_show", args: { window: "@42", view: "reader" } });
	say({ type: "tool_execution_end", toolCallId: "show1", toolName: "client_show", result: { content: [] } });
	say({ type: "agent_settled" });
	buf = "";
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
	});
	const control = new Promise((resolve) => meta.once("clientControl", resolve));
	meta.prompt("show me the new project");
	assert.deepEqual(await control, { action: "showWindow", window: "@42", view: "reader" });
	await meta.stop();
});

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

test("a tool-heavy turn does not push the user's own messages out of the chat", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-meta-"));
	// a pi that answers every prompt with a flood of tool calls, as a real research turn does
	const fakePi = join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		`process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
	buf += c;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		if (JSON.parse(line).type !== "prompt") continue;
		process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
		for (let n = 0; n < 700; n++) {
			process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "t" + n, toolName: "tmux_capture", args: {} }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "t" + n, toolName: "tmux_capture", result: { content: [] } }) + "\\n");
		}
		process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
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
	});
	const settled = new Promise((r) => meta.once("settled", r));
	meta.prompt("here is a batch of feedback I just dictated");
	await settled;
	await meta.stop();

	const user = meta.transcript.filter((i) => i.kind === "user");
	assert.deepEqual(
		user.map((i) => i.text),
		["here is a batch of feedback I just dictated"],
		"the user's message must outlive the tool spam that buried it",
	);
	assert.ok(meta.transcript.length <= 500, `transcript still bounded (${meta.transcript.length})`);
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
		compactionStallMs: 5000,
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

test("a compaction that never finishes is still rescued", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-compact-stuck-"));
	// The summarization call can wedge like any other provider call. Waiting on it forever
	// would mean the one turn nobody can nudge also switches the watchdog off for good.
	const fakePi = join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		`process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
	buf += c;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		if (JSON.parse(line).type !== "prompt") continue;
		process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "compaction_start", reason: "threshold" }) + "\\n");
		// ...and no compaction_end, ever
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
		stallMs: 100,
		compactionStallMs: 400,
		watchdogMs: 50,
	});
	const systems = [];
	meta.on("item", (item) => item.kind === "system" && systems.push(item.text));
	meta.prompt("summarize the day");
	const deadline = Date.now() + 6000;
	while (Date.now() < deadline && !systems.some((t) => /restarting/.test(t))) await new Promise((r) => setTimeout(r, 50));
	await meta.stop();

	assert.ok(systems.some((t) => /compaction has not finished in .*restarting/.test(t)), systems.join(" | "));
});

test("/new on a dead agent starts clean instead of resuming the old context", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-newsession-"));
	const argvLog = join(dir, "argv.log");
	const sessions = join(dir, "sessions");
	mkdirSync(sessions, { recursive: true });
	// a session file exactly as a previous run would have left it
	writeFileSync(
		join(sessions, "old.jsonl"),
		`${JSON.stringify({ type: "session", id: "old" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "the context to forget" } })}\n`,
	);
	const fakePi = join(dir, "fake-pi.mjs");
	writeFileSync(fakePi, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(" "));
setInterval(() => {}, 1000);
`);
	const shim = join(dir, "pi");
	writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${fakePi} "$@"\n`, { mode: 0o755 });
	const { MetaAgent } = await import("../dist/server/meta.js");
	const meta = new MetaAgent({
		metaDir: join(import.meta.dirname, "..", "src", "meta"),
		socketArgs: [],
		piBin: shim,
		sessionDir: sessions,
	});
	assert.equal(meta.hasPreviousSession, true, "the fixture is only meaningful if there is something to resume");
	meta.newSession();
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline && !existsSync(argvLog)) await new Promise((r) => setTimeout(r, 50));
	await meta.stop();

	const argv = readFileSync(argvLog, "utf8");
	assert.ok(!/--session /.test(argv), `"forget the conversation" resumed it anyway: ${argv}`);
	assert.match(argv, /--session-dir/, "the fresh session is still persisted for later resumes");
	assert.equal(meta.transcript.length > 0 && meta.transcript.every((i) => i.kind === "system"), true);
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

// --- peeking at a file the terminal mentioned ------------------------------

test("readPeek resolves against the pane cwd and classifies what it finds", async () => {
	const { readPeek, MAX_TEXT_BYTES } = await import("../dist/server/files.js");
	const dir = mkdtempSync(join(tmpdir(), "pi-super-peek-"));
	writeFileSync(join(dir, "note.txt"), "hello\nworld\n");
	writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
	writeFileSync(join(dir, "core.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]));

	// a bare token, as printed by an agent working in that directory
	const rel = readPeek("note.txt", dir);
	assert.equal(rel.ok, true);
	assert.equal(rel.path, join(dir, "note.txt"));
	assert.equal(rel.body.toString(), "hello\nworld\n");
	assert.equal(rel.type, "application/octet-stream", "never a type a browser renders on its own");
	assert.equal(rel.truncated, false);

	assert.equal(readPeek(join(dir, "shot.png")).kind, "image");
	assert.equal(readPeek("core.bin", dir).error, "binary file", "no point rendering ELF in a <pre>");
	assert.equal(readPeek("nope.txt", dir).status, 404);

	// a directory lists itself, directories first, so the popup can be a file browser
	mkdirSync(join(dir, "sub"), { recursive: true });
	const listing = readPeek(dir);
	assert.equal(listing.kind, "dir");
	const entries = JSON.parse(listing.body.toString()).entries;
	assert.deepEqual(entries.map((e) => e.name), ["sub", "core.bin", "note.txt", "shot.png"]);
	assert.equal(entries[0].dir, true);
	assert.equal(entries.find((e) => e.name === "note.txt").size, 12);

	// a phone must not be handed a whole log file
	writeFileSync(join(dir, "big.log"), "x".repeat(MAX_TEXT_BYTES + 5000));
	const big = readPeek("big.log", dir);
	assert.equal(big.body.length, MAX_TEXT_BYTES);
	assert.equal(big.truncated, true);
	assert.equal(big.bytes, MAX_TEXT_BYTES + 5000);
});

// --- dictation vocabulary ---------------------------------------------------
// The whole value of dictation mode is that the prompt biases the recogniser, so what goes
// into the prompt has to be the jargon actually on screen — not the English around it.

test("buildVocabulary primes on-screen jargon and drops prose", () => {
	const pane = `
		$ npm run build && systemctl --user restart pi-super
		error: the file was not found, and that is all we can say about it
		src/server/dictation.ts:12:5 - error TS2554
	`;
	const vocab = buildVocabulary(pane, ["grand-endeavors", "pi-super docs"]);
	const words = vocab.split(", ");

	for (const core of ["pi-super", "tmux", "systemd", "rebase"]) {
		assert.ok(words.includes(core), `core vocabulary must survive: ${core}`);
	}
	assert.ok(words.includes("grand-endeavors"), "window names are the user's own words");
	assert.ok(words.includes("systemctl"), "commands on screen are exactly what gets misheard");
	assert.ok(!words.includes("the") && !words.includes("that"), "prose is noise here");
	assert.equal(new Set(words.map((w) => w.toLowerCase())).size, words.length, "no duplicates");
	// the hint rides in every session's instructions: it must stay small
	assert.ok(vocab.length <= 500, `vocabulary too long: ${vocab.length}`);
});

test("dictationInstructions carries the prompt plus the vocabulary", () => {
	const metaDir = new URL("../src/meta", import.meta.url).pathname;
	const instructions = dictationInstructions(metaDir, "pi-super, tmux");
	assert.match(instructions, /NEVER speak/, "the prompt file is what makes it a microphone");
	assert.match(instructions, /pi-super, tmux/);

	// a missing prompt file must still produce a usable microphone, not an empty prompt
	const fallback = dictationInstructions("/nonexistent", "");
	assert.match(fallback, /[Nn]ever speak/);
});

test("rotation keeps what is still owed, and a dead log says so", async () => {
	const { PromptLog } = await import("../dist/server/prompts.js");
	const dir = mkdtempSync(join(tmpdir(), "pi-super-prompts-"));
	const log = new PromptLog(dir);
	const owed = log.record("the batch of feedback", "voice");
	// push the log past the 4 MiB rotation threshold with answered traffic
	for (let i = 0; i < 160; i++) log.answered([`filler-${i}-${"x".repeat(30_000)}`]);
	assert.ok(existsSync(join(dir, "prompts.jsonl.1")), "the log rotated");
	assert.deepEqual(
		log.unanswered().map((p) => p.id),
		[owed],
	);
	// a second rotation must not drop it with the byte window it was first written in
	for (let i = 0; i < 160; i++) log.answered([`filler2-${i}-${"x".repeat(30_000)}`]);
	assert.deepEqual(
		new PromptLog(dir).unanswered().map((p) => p.id),
		[owed],
		"a prompt nobody answered survives being rotated out twice",
	);

	assert.equal(log.broken, undefined);
	const dead = new PromptLog(dir);
	rmSync(dir, { recursive: true, force: true });
	writeFileSync(dir, ""); // the state dir is now a file: every write must fail
	dead.record("into the void", "chat");
	assert.ok(dead.broken, "a log that cannot be written must admit it, not pretend");
});
