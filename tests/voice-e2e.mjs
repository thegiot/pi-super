#!/usr/bin/env node
/**
 * End-to-end test of the voice call, with no human and no microphone.
 *
 *   node tests/voice-e2e.mjs [--keep] ["spoken question"]
 *
 * How it works:
 *  - piper TTS renders the question to a WAV; Chrome plays that file as its microphone
 *    (--use-file-for-fake-audio-capture), so the realtime model hears real speech.
 *  - headless Chrome is driven over CDP (no puppeteer dependency): it loads the app with
 *    ?debug=1, clicks the call button, and we read window.piSuper for every realtime
 *    event, transcript line and speak() that goes by.
 *  - the model's voice comes back as a WebRTC track, which we tap in-page with
 *    MediaRecorder + an AnalyserNode: the recording is written to /tmp so it can be
 *    listened to, and the peak energy proves audio actually flowed.
 *
 * Requires: piper + a voice model (see PIPER_MODEL), google-chrome, a tmux binary.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const KEEP = process.argv.includes("--keep");
const QUESTION =
	process.argv.find((a) => !a.startsWith("-") && a.includes(" ")) ??
	"Hello super. How many tmux windows are open right now? Answer in one short sentence.";
const PIPER = process.env.PIPER_BIN ?? `${process.env.HOME}/.local/bin/piper`;
const PIPER_MODEL = process.env.PIPER_MODEL ?? "/tmp/piper-voices/en_US-lessac-medium.onnx";
const CHROME = process.env.CHROME_BIN ?? "google-chrome";
const PORT = 8797;
const CDP_PORT = 9333;
const SOCKET = "voicetest";
const STATE_DIR = mkdtempSync(join(tmpdir(), "pi-super-voice-"));

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

// ---------------------------------------------------------------- 1. the voice

function renderQuestion() {
	if (!existsSync(PIPER) || !existsSync(PIPER_MODEL)) {
		throw new Error(`piper or its model is missing (${PIPER}, ${PIPER_MODEL})`);
	}
	const raw = join(STATE_DIR, "raw.wav");
	const mic = join(STATE_DIR, "mic.wav");
	const r = sh(PIPER, ["-m", PIPER_MODEL, "-f", raw], { input: QUESTION });
	if (!existsSync(raw)) throw new Error(`piper failed: ${r.stderr}`);
	// Chrome loops the fake mic file forever: pad with silence so the model hears the
	// question once, then quiet, instead of a stuttering echo chamber. 48k mono 16-bit.
	const pad = sh("sox", [raw, "-r", "48000", "-c", "1", "-b", "16", mic, "pad", "1", "40"]);
	if (!existsSync(mic)) throw new Error(`sox failed: ${pad.stderr}`);
	log(`mic wav: ${mic} ("${QUESTION.slice(0, 60)}…")`);
	return mic;
}

// ------------------------------------------------------------- 2. tmux + server

function startServer() {
	sh("tmux", ["-L", SOCKET, "kill-server"]);
	sh("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "voice"]);
	sh("tmux", ["-L", SOCKET, "new-window", "-d", "-t", "voice", "-n", "notes"]);
	cleanups.push(() => sh("tmux", ["-L", SOCKET, "kill-server"]));

	const args = ["dist/server/index.js", "-L", SOCKET, "-s", "voice", "--port", String(PORT)];
	if (process.env.META_MODEL) args.push("--meta-model", process.env.META_MODEL);
	const proc = spawn("node", args, {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, PI_SUPER_STATE_DIR: STATE_DIR },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	proc.stdout.on("data", (d) => (out += d));
	proc.stderr.on("data", (d) => (out += d));
	cleanups.push(() => proc.kill());
	return { proc, log: () => out };
}

// ------------------------------------------------------------------ 3. chrome

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
	const evaluate = async (expression, awaitPromise = true) => {
		const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
		if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? "error"}`);
		return r.result.value;
	};
	return { send, evaluate, close: () => ws.close() };
}

async function startChrome(micWav) {
	const profile = join(STATE_DIR, "chrome");
	const proc = spawn(
		CHROME,
		[
			"--headless=new",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"--no-sandbox",
			"--autoplay-policy=no-user-gesture-required",
			"--use-fake-ui-for-media-stream", // auto-accept the mic permission prompt
			"--use-fake-device-for-media-stream",
			`--use-file-for-fake-audio-capture=${micWav}`,
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
			const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
			log(`chrome: ${list.Browser}`);
			return { proc, err: () => err };
		} catch {
			/* not up yet */
		}
	}
	throw new Error(`chrome did not expose CDP:\n${err}`);
}

// -------------------------------------------------------------- 4. the probe

/** Injected into the page: taps the remote track once the call is live. */
const PROBE = `
(() => {
  const s = window.piSuper;
  if (!s) return "no piSuper (is ?debug=1 set?)";
  if (window.__probe) return "already";
  window.__probe = { peak: 0, samples: 0, chunks: [], recorderState: "none" };
  const attach = () => {
    const el = s.voice.remoteAudio;
    const stream = el && el.srcObject;
    if (!stream || !stream.getAudioTracks().length) return false;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      window.__probe.peak = Math.max(window.__probe.peak, peak);
      window.__probe.samples++;
    }, 100);
    try {
      const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      rec.ondataavailable = async (e) => {
        if (!e.data.size) return;
        const b64 = await new Promise((res) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(",")[1]);
          fr.readAsDataURL(e.data);
        });
        window.__probe.chunks.push(b64);
      };
      rec.start(2000);
      window.__probe.recorderState = "recording";
    } catch (e) { window.__probe.recorderState = "failed: " + e.message; }
    return true;
  };
  const timer = setInterval(() => { if (attach()) clearInterval(timer); }, 250);
  return "installed";
})()`;

// ---------------------------------------------------------------------- run

async function main() {
	const micWav = renderQuestion();
	const server = startServer();
	await wait(2000);
	const token = readFileSync(join(STATE_DIR, "token"), "utf8").trim();
	const voiceCfg = await (
		await fetch(`http://127.0.0.1:${PORT}/api/voice/config`, { headers: { Authorization: `Bearer ${token}` } })
	).json();
	log("voice config:", JSON.stringify(voiceCfg));
	if (!voiceCfg.enabled) throw new Error("voice is not enabled on the server");

	await startChrome(micWav);
	const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
	const page = targets.find((t) => t.type === "page");
	const c = await cdp(page.webSocketDebuggerUrl);
	await c.send("Runtime.enable");
	await c.send("Log.enable");
	await c.send("Page.enable");
	await c.send("Browser.grantPermissions", { permissions: ["audioCapture"] });

	await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?token=${token}&debug=1` });
	await wait(3000);
	log("probe:", await c.evaluate(PROBE));

	log("clicking call…");
	await c.evaluate(`document.getElementById("btn-call").click(); "clicked"`);

	// watch the call for a while, reporting as things happen
	const deadline = Date.now() + 90_000;
	let lastSummary = "";
	let sawDelegation = false;
	let sawSpeak = false;
	while (Date.now() < deadline) {
		await wait(2000);
		const snap = await c.evaluate(`(() => {
      const s = window.piSuper || {};
      return {
        state: s.voice && s.voice.state,
        events: (s.events || []).map(e => e.dir + ":" + e.t),
        transcript: s.transcript || [],
        spoken: s.spoken || [],
        peak: window.__probe ? window.__probe.peak : 0,
        rec: window.__probe ? window.__probe.recorderState : "-",
        chunks: window.__probe ? window.__probe.chunks.length : 0,
        chat: [...document.querySelectorAll("#meta .chat")].slice(-6).map(n => n.className + " | " + n.textContent.slice(0, 90)),
      };
    })()`);
		const summary = JSON.stringify({
			state: snap.state,
			peak: Number(snap.peak).toFixed(3),
			ev: snap.events.length,
			chunks: snap.chunks,
		});
		if (summary !== lastSummary) {
			lastSummary = summary;
			log(summary);
		}
		if (!sawDelegation && snap.events.some((e) => e.includes("delegation.created"))) {
			sawDelegation = true;
			log("→ model delegated to super:", JSON.stringify(snap.transcript.filter((t) => t.role === "user")));
		}
		if (!sawSpeak && snap.spoken.length > 0) {
			sawSpeak = true;
			log("→ super spoke back:", JSON.stringify(snap.spoken));
		}
		if (sawDelegation && sawSpeak && snap.events.some((e) => e.includes("out:delegation.context.append"))) {
			await wait(12_000); // let it finish speaking the answer
			break;
		}
	}

	const final = await c.evaluate(`(() => {
    const s = window.piSuper || {};
    return {
      state: s.voice && s.voice.state,
      events: (s.events || []).map(e => e.dir + ":" + e.t),
      transcript: s.transcript || [],
      spoken: s.spoken || [],
      samples: Object.values((s.events || []).reduce((acc, e) => {
        const k = e.dir + ":" + e.t;
        if (!acc[k]) acc[k] = k + "  " + JSON.stringify(e.ev).slice(0, 260);
        return acc;
      }, {})),
      peak: window.__probe ? window.__probe.peak : 0,
      chunks: window.__probe ? window.__probe.chunks : [],
      chat: [...document.querySelectorAll("#meta .chat")].map(n => n.className + " | " + n.textContent.slice(0, 120)),
    };
  })()`);

	// save what the model actually said, so a human can listen to it
	let audioPath = "";
	if (final.chunks.length > 0) {
		audioPath = "/tmp/pi-super-voice-out.webm";
		writeFileSync(audioPath, Buffer.concat(final.chunks.map((b) => Buffer.from(b, "base64"))));
		const info = sh("ffprobe", ["-hide_banner", "-i", audioPath], { stdio: "pipe" });
		log(`recorded reply: ${audioPath} (${(readFileSync(audioPath).length / 1024).toFixed(1)} KiB)`);
		const dur = /Duration: ([0-9:.]+)/.exec(info.stderr ?? "");
		if (dur) log(`  duration ${dur[1]}`);
	}

	console.log("\n=== realtime event vocabulary (one sample each) ===");
	console.log((final.samples ?? []).join("\n") || "(none)");
	console.log("\n=== transcript ===");
	for (const t of final.transcript) console.log(`${t.role}: ${t.text}`);
	console.log("\n=== super spoke ===");
	for (const s of final.spoken) console.log(`speak: ${s}`);
	console.log("\n=== meta chat ===");
	for (const line of final.chat) console.log(line);

	const checks = [
		["call went live", final.state === "live"],
		["realtime events received", final.events.some((e) => e.startsWith("in:"))],
		["model heard speech and delegated", final.events.some((e) => e.includes("delegation.created"))],
		["meta agent spoke back", final.spoken.length > 0],
		["update pushed into the call", final.events.some((e) => e.includes("out:delegation.context.append"))],
		["assistant audio flowed", Number(final.peak) > 0.01],
		["reply recorded", audioPath !== ""],
	];
	console.log("\n=== result ===");
	let failed = 0;
	for (const [name, ok] of checks) {
		console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
		if (!ok) failed++;
	}
	console.log(`peak output amplitude: ${Number(final.peak).toFixed(3)}`);
	if (!KEEP) await cleanup();
	else log(`kept: server on :${PORT}, chrome on :${CDP_PORT}, state ${STATE_DIR}`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
	console.error("voice-e2e failed:", err.message);
	await cleanup();
	process.exit(1);
});
