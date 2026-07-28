#!/usr/bin/env node
/**
 * End-to-end test of composer dictation, with no human and no microphone.
 *
 *   node tests/dictation-probe.mjs [mic.wav] [speechStartSec] [speechEndSec]
 *
 * Chrome plays mic.wav as its microphone (--use-file-for-fake-audio-capture), so the model
 * hears real speech; we tap the mic button through CDP and read what lands in the textarea.
 * Make a mic file with the TTS of your choice, then:
 *
 *   sox raw.wav -r 48000 -c 1 -b 16 mic.wav pad 1 40   # lead-in, then silence
 *
 * Besides passing or failing, it prints the timings that justify this design over a
 * record-then-upload one: how long until the mic is open, when the first word appears, and
 * how long after you stop talking the text is complete. See docs/dictation.md.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const MIC = args[0] ?? "/tmp/jargon_mic.wav";
const SPEECH_START = Number(args[1] ?? 1.0);
const SPEECH_END = Number(args[2] ?? 16.24);
/** what the clip says, for a rough accuracy check */
const EXPECTED = process.env.DICTATION_EXPECT ?? "pi-super";
const REPO = new URL("..", import.meta.url).pathname;
const CHROME = process.env.CHROME_BIN ?? "google-chrome";
// distinct from every other harness: a stale chrome from another test holding the same CDP
// port silently hands you *its* browser, with its own fake mic file
const PORT = 8794;
const CDP_PORT = 9336;
const SOCKET = "dicttest";
const STATE_DIR = mkdtempSync(join(tmpdir(), "pi-super-dict-"));

const log = (...a) => console.log("·", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", ...opts });

const cleanups = [];
async function cleanup() {
	for (const fn of cleanups.reverse()) {
		try {
			await fn();
		} catch {
			/* best effort */
		}
	}
}
process.on("SIGINT", () => cleanup().then(() => process.exit(130)));

function startServer() {
	sh("tmux", ["-L", SOCKET, "kill-server"]);
	// the window name and whatever the pane shows are what prime the session's vocabulary,
	// so give it something jargon-shaped to find
	sh("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "dict", "-n", "pi-super"]);
	sh("tmux", ["-L", SOCKET, "send-keys", "-t", "dict", "echo tmux systemd rebase WebRTC dist", "Enter"]);
	cleanups.push(() => sh("tmux", ["-L", SOCKET, "kill-server"]));
	const proc = spawn("node", ["dist/server/index.js", "-L", SOCKET, "-s", "dict", "--port", String(PORT)], {
		cwd: REPO,
		env: { ...process.env, PI_SUPER_STATE_DIR: STATE_DIR },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	proc.stdout.on("data", (d) => (out += d));
	proc.stderr.on("data", (d) => (out += d));
	cleanups.push(() => proc.kill());
	return { log: () => out };
}

async function cdp(url) {
	const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
	await new Promise((res, rej) => {
		ws.once("open", res);
		ws.once("error", rej);
	});
	let id = 0;
	const pending = new Map();
	ws.on("message", (data) => {
		const msg = JSON.parse(String(data));
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const n = ++id;
			pending.set(n, { resolve, reject });
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? "error"}`);
		return r.result.value;
	};
	return { send, evaluate };
}

async function startChrome() {
	const proc = spawn(
		CHROME,
		[
			"--headless=new",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${join(STATE_DIR, "chrome")}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"--no-sandbox",
			"--autoplay-policy=no-user-gesture-required",
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			`--use-file-for-fake-audio-capture=${MIC}`,
			"about:blank",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let err = "";
	proc.stderr.on("data", (d) => (err += d));
	cleanups.push(() => proc.kill());
	for (let i = 0; i < 60; i++) {
		await wait(250);
		try {
			const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
			log(`chrome: ${v.Browser}`);
			return;
		} catch {
			/* not up yet */
		}
	}
	throw new Error(`chrome did not expose CDP:\n${err}`);
}

async function main() {
	startServer();
	await wait(2500);
	const token = readFileSync(join(STATE_DIR, "token"), "utf8").trim();
	const cfg = await (
		await fetch(`http://127.0.0.1:${PORT}/api/voice/config`, { headers: { Authorization: `Bearer ${token}` } })
	).json();
	log("voice config:", JSON.stringify(cfg));
	if (!cfg.enabled) throw new Error("no realtime backend configured — dictation cannot run");

	await startChrome();
	const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
	const c = await cdp(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
	await c.send("Runtime.enable");
	await c.send("Browser.grantPermissions", { permissions: ["audioCapture"] });
	await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?token=${token}&debug=1` });

	// the app boots asynchronously; ?debug=1 publishes window.piSuper only once it has
	let booted = false;
	for (let i = 0; i < 40 && !booted; i++) {
		await wait(500);
		booted = await c.evaluate(`!!window.piSuper`);
	}
	if (!booted) throw new Error("page never published window.piSuper (wrong chrome on the CDP port?)");
	// availability is resolved asynchronously too, and it decides whether the button is there
	await wait(1000);
	const micShown = await c.evaluate(`!document.getElementById("btn-mic").hidden`);

	// t0 is the tap: Chrome starts playing the fake capture file when getUserMedia resolves
	await c.evaluate(`(() => {
		window.__t0 = Date.now();
		document.getElementById("btn-mic").click();
		return "tapped";
	})()`);
	log(`tapped the mic; speech plays ${SPEECH_START}s–${SPEECH_END}s into ${MIC}`);

	// let it hear the whole clip, plus a moment for the tail of the transcript
	await wait((SPEECH_END + 3) * 1000);
	await c.evaluate(`document.getElementById("btn-mic").click(); "stopped"`);
	await wait(500);

	const final = await c.evaluate(`(() => {
		const s = window.piSuper;
		return {
			t0: window.__t0,
			state: s.dictate.state,
			input: document.getElementById("input").value,
			micClass: document.getElementById("btn-mic").className,
			log: (s.dictation || []).map(e => ({ dt: (e.at - window.__t0) / 1000, state: e.state, text: e.text })),
		};
	})()`);

	const at = (pred) => final.log.find(pred);
	const listening = at((e) => e.state === "listening");
	const firstText = at((e) => e.state === "text" && e.text.trim());
	const lastText = [...final.log].reverse().find((e) => e.state === "text");

	console.log("\n=== timeline (seconds after the mic tap) ===");
	console.log(`  mic open (listening)   +${listening ? listening.dt.toFixed(2) : "never"}s`);
	console.log(`  speech starts          +${SPEECH_START.toFixed(2)}s`);
	console.log(`  first word on screen   +${firstText ? firstText.dt.toFixed(2) : "never"}s`);
	console.log(`  speech ends            +${SPEECH_END.toFixed(2)}s`);
	console.log(`  last word on screen    +${lastText ? lastText.dt.toFixed(2) : "never"}s`);
	if (lastText) console.log(`  → complete ${(lastText.dt - SPEECH_END).toFixed(2)}s after the speaker stopped`);

	console.log("\n=== textarea ===");
	console.log(final.input);

	// Sending with the mic still open used to leave the composer fighting the transcript:
	// the box emptied, the next fragment refilled it with what had just been sent, and every
	// send after that looked like it did nothing.
	await c.evaluate(`document.getElementById("btn-mic").click(); "tapped"`);
	await wait(2500);
	const listeningAgain = await c.evaluate(`window.piSuper.dictate.state === "listening"`);
	const sent = await c.evaluate(`(() => {
		document.getElementById("btn-send").click();
		return { state: window.piSuper.dictate.state, input: document.getElementById("input").value };
	})()`);
	await wait(2000); // long enough for a late fragment to arrive, if the mic were still open
	const settled = await c.evaluate(`({
		state: window.piSuper.dictate.state,
		input: document.getElementById("input").value,
		armed: document.getElementById("btn-mic").className.includes("armed"),
	})`);

	const checks = [
		["mic button offered", micShown],
		["mic opened", !!listening],
		["mic opened within 2s", !!listening && listening.dt < 2],
		["text streamed while still speaking", !!firstText && firstText.dt < SPEECH_END],
		["text landed in the composer", final.input.trim().length > 20],
		[`primed jargon transcribed ("${EXPECTED}")`, final.input.includes(EXPECTED)],
		["not auto-sent", final.input.trim().length > 0],
		["mic released on the second tap", final.state === "idle" && !final.micClass.includes("armed")],
		["mic reopened for the send test", listeningAgain],
		["send closes an open mic", sent.state === "idle" && !settled.armed],
		["send empties the composer", sent.input === ""],
		["nothing refills the composer after a send", settled.input === ""],
	];
	console.log("\n=== result ===");
	let failed = 0;
	for (const [name, ok] of checks) {
		console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
		if (!ok) failed++;
	}
	await cleanup();
	process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
	console.error("dictation-probe failed:", err.message);
	await cleanup();
	process.exit(1);
});
