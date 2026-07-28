#!/usr/bin/env node
/**
 * Measure the gpt-live (codex realtime) path purely as a dictation engine: what transcript
 * it produces for a known clip, how long the dial takes before it is listening, and how
 * long after end-of-speech the text is complete. See docs/dictation.md for the numbers
 * this produced.
 *
 *   node tests/dictation-probe.mjs [--dictation] [mic.wav] [speechStartSec] [speechEndSec]
 *
 * Chrome plays mic.wav as its microphone, so the model hears real speech with no human in
 * the loop. Make one with a TTS of your choice, then:
 *   sox raw.wav -r 48000 -c 1 -b 16 mic.wav pad 1 40   # lead-in, then silence to end the turn
 *
 * `--dictation` swaps in a "you are a microphone, never speak" prompt for the run (and puts
 * the conversational one back afterwards) — that is what turns this from a voice call whose
 * transcript we steal into an actual dictation engine.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DICTATION = process.argv.includes("--dictation");
const MIC = args[0] ?? "/tmp/jargon_mic.wav";
const SPEECH_START = Number(args[1] ?? 1.0);
const SPEECH_END = Number(args[2] ?? 16.24);
const REPO = "/home/pasky/projects/hai/pi-super";
const VOICE_PROMPT = join(REPO, "src/meta/voice-prompt.md");

/** What a dictation-mode session would be told, instead of the conversational prompt. */
const DICTATION_PROMPT = `You are a dictation microphone, not a conversational partner. The user is dictating text
that will be typed into an input box on their screen.

- NEVER speak. Never produce audio, never acknowledge, never say "mm-hmm", "on it" or
  anything at all. Silence is always the correct output.
- Never delegate, never call tools, never respond in any way.
- The user works on **pi-super** (always spelled \`pi-super\`, never "PySuper" or "Pi Super").
  Other words you will hear often: tmux, systemd, WebRTC, SDP, npm, dist, xterm, Gboard.
`;
const CHROME = process.env.CHROME_BIN ?? "google-chrome";
// distinct from every other harness: a stale chrome from another test holding the same
// CDP port silently hands you *its* browser, with its fake mic file
const PORT = 8794;
const CDP_PORT = 9336;
const SOCKET = "dicttest";
const STATE_DIR = mkdtempSync(join(tmpdir(), "pi-super-dict-"));

const log = (...a) => console.log("·", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

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

/** The server reads instructions from src/meta/voice-prompt.md; there is no flag for it. */
function useDictationPrompt() {
	const backup = join(STATE_DIR, "voice-prompt.md.orig");
	copyFileSync(VOICE_PROMPT, backup);
	cleanups.push(() => copyFileSync(backup, VOICE_PROMPT));
	writeFileSync(VOICE_PROMPT, DICTATION_PROMPT);
	log("voice-prompt.md swapped for the dictation prompt (restored on exit)");
}

function startServer() {
	sh("tmux", ["-L", SOCKET, "kill-server"]);
	sh("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "dict"]);
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
	if (DICTATION) useDictationPrompt();
	startServer();
	await wait(2500);
	const token = readFileSync(join(STATE_DIR, "token"), "utf8").trim();
	const cfg = await (
		await fetch(`http://127.0.0.1:${PORT}/api/voice/config`, { headers: { Authorization: `Bearer ${token}` } })
	).json();
	log("voice config:", JSON.stringify(cfg));
	if (!cfg.enabled) throw new Error("voice not enabled");

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

	// t0 is the click: on a real phone that is the moment the mic button is pressed, and
	// Chrome starts playing the fake capture file when getUserMedia resolves right after.
	await c.evaluate(`(() => {
		window.__t0 = Date.now();
		const stamp = (s) => { if (!window.__live && s === "live") window.__live = Date.now(); };
		const v = window.piSuper.voice;
		const prev = v.onState;
		v.onState = (s, d) => { stamp(s); prev && prev(s, d); };
		document.getElementById("btn-call").click();
		return "clicked";
	})()`);
	log("clicked call; speech plays " + SPEECH_START + "s–" + SPEECH_END + "s into the mic file");

	const deadline = Date.now() + 75_000;
	let done = false;
	while (Date.now() < deadline && !done) {
		await wait(1500);
		done = await c.evaluate(
			`(window.piSuper.events || []).some(e => e.t === "turn.done" && e.ev.turn && e.ev.turn.role === "user")`,
		);
	}

	const final = await c.evaluate(`(() => {
		const s = window.piSuper;
		const t0 = window.__t0;
		return {
			t0, live: window.__live,
			state: s.voice.state,
			events: (s.events || []).map(e => ({ dt: (e.at - t0) / 1000, dir: e.dir, t: e.t,
				text: (e.ev.item && (e.ev.item.text || (e.ev.item.content||[]).map(x=>x.text).join(" "))) ||
				      (e.ev.turn && e.ev.turn.transcript) || e.ev.transcript || e.ev.delta || "" })),
			transcript: s.transcript || [],
		};
	})()`);

	const rel = (ms) => ((ms - final.t0) / 1000).toFixed(2);
	console.log("\n=== timeline (seconds after the mic button click) ===");
	console.log(`  call live at            +${final.live ? rel(final.live) : "never"}s`);
	console.log(`  speech starts at        +${SPEECH_START.toFixed(2)}s (fake mic file)`);
	console.log(`  speech ends at          +${SPEECH_END.toFixed(2)}s`);
	for (const e of final.events) {
		if (!/transcript|turn\.|delegation|speech/.test(e.t)) continue;
		console.log(`  +${e.dt.toFixed(2)}s  ${e.dir}:${e.t}  ${JSON.stringify(String(e.text).slice(0, 120))}`);
	}

	console.log("\n=== all event types seen ===");
	console.log([...new Set(final.events.map((e) => `${e.dir}:${e.t}`))].join("\n"));
	console.log("\n=== user transcript as delivered to the app ===");
	for (const t of final.transcript) console.log(`${t.role}: ${t.text}`);

	await cleanup();
}

main().catch(async (err) => {
	console.error("probe failed:", err.message);
	await cleanup();
	process.exit(1);
});
