#!/usr/bin/env node
/**
 * Phone-shaped smoke test: drives the UI in headless Chrome with Pixel metrics, touch
 * emulation and a mobile user agent, and writes screenshots to /tmp/pi-super-shots/.
 *
 *   node tests/mobile-shots.mjs [--keep]
 *
 * Chrome is the same engine Android ships, so layout, viewport, touch hit-testing and
 * xterm rendering are faithful. What this can NOT tell us: Gboard/IME behaviour,
 * Bluetooth audio routing, and background lifecycle.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const KEEP = process.argv.includes("--keep");
const CHROME = process.env.CHROME_BIN ?? "google-chrome";
const PORT = 8796;
const CDP_PORT = 9334;
const SOCKET = "mobiletest";
const STATE_DIR = mkdtempSync(join(tmpdir(), "pi-super-mobile-"));
const SHOTS = "/tmp/pi-super-shots";

// Pixel 7-ish: what most of these phones look like to CSS.
const DEVICE = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true };
const UA =
	"Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

const log = (...a) => console.log("·", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const cleanups = [];
const cleanup = async () => {
	for (const fn of cleanups.reverse()) {
		try {
			await fn();
		} catch {
			/* best effort */
		}
	}
};

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
	const shot = async (name) => {
		const { data } = await send("Page.captureScreenshot", { format: "png" });
		const path = join(SHOTS, `${name}.png`);
		writeFileSync(path, Buffer.from(data, "base64"));
		log(`shot: ${path}`);
	};
	return { send, evaluate, shot };
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });

	// a tmux with something worth looking at
	sh("tmux", ["-L", SOCKET, "kill-server"]);
	sh("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "phone", "-x", "213", "-y", "50"]);
	for (const [name, cmd] of [
		["grand-endeavors", "git -C . log --oneline -40 2>/dev/null | cat; ls -la; bash"],
		["notes", "bash"],
		["build", "seq 1 200 | sed 's/^/line /' ; bash"],
		// an agent-style pane title, which is what the window list is meant to surface
		// (a bash prompt would immediately overwrite it with "user@host: cwd")
		["agent", "printf '\\033]2;\u03c0 - reviewing the mobile layout, drawer titles next - pi-super\\033\\\\'; sleep 600"],
	]) {
		sh("tmux", ["-L", SOCKET, "new-window", "-d", "-t", "phone", "-n", name, cmd]);
	}
	cleanups.push(() => sh("tmux", ["-L", SOCKET, "kill-server"]));

	const server = spawn("node", ["dist/server/index.js", "-L", SOCKET, "-s", "phone", "--port", String(PORT)], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, PI_SUPER_STATE_DIR: STATE_DIR },
		stdio: ["ignore", "pipe", "pipe"],
	});
	cleanups.push(() => server.kill());
	await wait(2000);
	const token = readFileSync(join(STATE_DIR, "token"), "utf8").trim();

	const chrome = spawn(
		CHROME,
		[
			"--headless=new",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${join(STATE_DIR, "chrome")}`,
			"--no-first-run",
			"--no-sandbox",
			"--disable-gpu",
			`--window-size=${DEVICE.width},${DEVICE.height}`,
			"about:blank",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	cleanups.push(() => chrome.kill());
	let target;
	for (let i = 0; i < 60 && !target; i++) {
		await wait(250);
		try {
			target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === "page");
		} catch {
			/* not up yet */
		}
	}
	if (!target) throw new Error("chrome did not start");

	const c = await cdp(target.webSocketDebuggerUrl);
	await c.send("Runtime.enable");
	await c.send("Page.enable");
	await c.send("Emulation.setDeviceMetricsOverride", { ...DEVICE, screenWidth: DEVICE.width, screenHeight: DEVICE.height });
	await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	await c.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
	await c.send("Emulation.setUserAgentOverride", { userAgent: UA, platform: "Linux armv8l" });

	await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?token=${token}&debug=1` });
	await wait(4000);
	// the phone default is reader; drive the views explicitly instead of toggling blind
	const setView = async (want) => {
		for (let i = 0; i < 3; i++) {
			const v = await c.evaluate(`window.piSuper && window.piSuper.state.view`);
			if (v === want) return;
			await c.evaluate(`document.getElementById("btn-view").click(); 1`);
			await wait(1200);
		}
	};
	await c.shot("01-default-view");

	// window tabs: switch to the wide git-log window
	const windows = await c.evaluate(`[...document.querySelectorAll("#tabs .tab")].map(b => b.textContent)`);
	log("tabs:", JSON.stringify(windows));
	await c.evaluate(`[...document.querySelectorAll("#tabs .tab")].find(b => /grand/.test(b.textContent)).click(); 1`);
	await wait(2500);
	await setView("raw");
	await wait(1500);
	await c.shot("02-terminal-wide-window");

	await setView("reader");
	await wait(2000);
	await c.shot("03-reader");

	// drawer
	await c.evaluate(`document.getElementById("btn-menu").click(); 1`);
	await wait(800);
	await c.shot("04-drawer");

	// meta chat with the keyboard-ish state: focus the composer and type
	// btn-call opens the chat (and would dial); the shot only needs the view, so no click
	await c.evaluate(`document.getElementById("btn-close-drawer").click(); window.piSuper.setView("meta"); 1`);
	await wait(600);
	await c.evaluate(`
    const i = document.getElementById("input");
    i.value = "what's running in the build window?";
    i.dispatchEvent(new Event("input"));
    i.focus(); 1`);
	await wait(500);
	await c.shot("05-meta-composer");

	// idle chat view: no call, but the bar stays to carry /new
	const idleBar = await c.evaluate(`(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!(e.offsetWidth || e.offsetHeight); };
    return { barVisible: vis("call"), newVisible: vis("btn-new-session"), hangupVisible: vis("btn-hangup") };
  })()`);
	log("idle call bar:", JSON.stringify(idleBar));
	await c.shot("05b-idle-new-button");

	// call bar in its tallest state: it must push the chat log up, never float over its tail
	const callLayout = await c.evaluate(`(() => {
    const call = document.getElementById("call");
    const warn = document.getElementById("call-warn");
    call.hidden = false;
    call.classList.remove("idle");
    for (const id of ["btn-mute", "btn-hush", "btn-hangup"]) document.getElementById(id).hidden = false;
    document.getElementById("call-state").textContent = "connected \u2014 talk to super";
    warn.hidden = false;
    warn.textContent = "\u26a0 degraded: browser speech \u2014 half duplex, no barge-in";
    const meta = document.getElementById("meta").getBoundingClientRect();
    const bar = call.getBoundingClientRect();
    return { metaBottom: Math.round(meta.bottom), callTop: Math.round(bar.top), callH: Math.round(bar.height) };
  })()`);
	await wait(400);
	await c.shot("05c-call-bar");
	log("call layout:", JSON.stringify(callLayout));

	// simulate the soft keyboard eating 45% of the viewport, like Gboard does
	await c.send("Emulation.setDeviceMetricsOverride", {
		...DEVICE,
		height: Math.round(DEVICE.height * 0.55),
		screenWidth: DEVICE.width,
		screenHeight: DEVICE.height,
	});
	await wait(1200);
	await c.shot("06-keyboard-open");
	await c.send("Emulation.setDeviceMetricsOverride", { ...DEVICE, screenWidth: DEVICE.width, screenHeight: DEVICE.height });

	// measurements that matter on a phone
	const metrics = await c.evaluate(`(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }; };
    const term = document.querySelector("#term .xterm");
    const screen = document.querySelector("#term .xterm-screen");
    const smallest = [...document.querySelectorAll("button")].map(b => { const x = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0,8), w: Math.round(x.width), h: Math.round(x.height) }; }).filter(b => b.w > 0).sort((a,b) => (a.w*a.h) - (b.w*b.h)).slice(0, 4);
    return {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      bar: r(document.getElementById("bar")),
      main: r(document.querySelector("main")),
      footer: r(document.querySelector("footer")),
      sizeMode: window.piSuper.state.sizeMode,
      termScale: term ? term.style.transform : "(none)",
      termNaturalWidth: screen ? Math.round(screen.offsetWidth) : 0,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      smallestTouchTargets: smallest,
    };
  })()`);
	const viewChecks = await c.evaluate(`(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!(e.offsetWidth || e.offsetHeight); };
    return { view: window.piSuper.state.view, ribbonVisible: vis("ribbon"), insertVisible: vis("btn-insert"), abortVisible: vis("btn-abort") };
  })()`);
	console.log("\nmeta view:", JSON.stringify(viewChecks));

	console.log("\n=== phone metrics ===");
	console.log(JSON.stringify(metrics, null, 1));

	console.log("\n=== checks ===");
	const checks = [
		["no horizontal page overflow", metrics.horizontalOverflow <= 0],
		// claim mode owns the tmux geometry, so the grid is already phone-sized and must NOT
		// be transformed; only in ignore mode (a desktop-wide grid) do we scale it down.
		[
			"terminal fits the width (scaled in ignore mode, native in claim mode)",
			metrics.sizeMode === "claim"
				? !metrics.termScale.includes("scale") && metrics.termNaturalWidth <= metrics.viewport.w + 1
				: metrics.termScale.includes("scale"),
		],
		["touch targets >= 32px tall", metrics.smallestTouchTargets.every((b) => b.h >= 32)],
		["call bar does not overlay the chat log", callLayout.callH > 0 && callLayout.metaBottom <= callLayout.callTop + 1],
		["/new reachable in the chat view with no call up", idleBar.barVisible && idleBar.newVisible && !idleBar.hangupVisible],
		["footer visible above the fold", metrics.footer.top + metrics.footer.h <= metrics.viewport.h + 1],
		["terminal ribbon hidden in chat view", viewChecks.view !== "meta" || !viewChecks.ribbonVisible],
		["abort button shown in chat view", viewChecks.view !== "meta" || viewChecks.abortVisible],
	];
	let failed = 0;
	for (const [name, ok] of checks) {
		console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
		if (!ok) failed++;
	}
	if (!KEEP) await cleanup();
	else log(`kept: http://127.0.0.1:${PORT}/?token=${token} , cdp ${CDP_PORT}`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
	console.error("mobile-shots failed:", e.message);
	await cleanup();
	process.exit(1);
});
