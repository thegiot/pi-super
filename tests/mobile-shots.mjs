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
	/** A one-finger drag, as CDP touch events (which is what produces real pointer events). */
	const drag = async (from, to, steps = 12) => {
		const point = (x, y) => [{ x: Math.round(x), y: Math.round(y), radiusX: 8, radiusY: 8, force: 1 }];
		await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) });
		for (let i = 1; i <= steps; i++) {
			await send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: point(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps),
			});
			await wait(16);
		}
		await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	};
	return { send, evaluate, shot, drag };
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

	// swipe left/right across the terminal to walk the window list
	const activeName = () =>
		c.evaluate(`(window.piSuper.state.windows.find(w => w.active) || {}).name || "(none)"`);
	const beforeSwipe = await activeName();
	await c.drag({ x: 300, y: 400 }, { x: 90, y: 410 });
	await wait(1200);
	const afterSwipe = await activeName();
	await c.drag({ x: 90, y: 400 }, { x: 300, y: 410 });
	await wait(1200);
	const backSwipe = await activeName();
	log("swipe:", `${beforeSwipe} -> ${afterSwipe} -> ${backSwipe}`);

	// vertical swipes must reach the pty as PageUp/PageDown
	await c.evaluate(`window.__keys = []; (() => {
    const ws = window.piSuper.state.ws;
    const send = ws.send.bind(ws);
    ws.send = (d) => { try { const m = JSON.parse(d); if (m.t === "keys") window.__keys.push(m.keys.join("")); } catch {} return send(d); };
  })(); 1`);
	await c.drag({ x: 200, y: 600 }, { x: 205, y: 300 });
	await wait(500);
	await c.drag({ x: 200, y: 300 }, { x: 205, y: 600 });
	await wait(500);
	const pagedKeys = await c.evaluate(`window.__keys.join(",")`);
	log("vertical swipe keys:", pagedKeys);

	// A ribbon key must reach the pty without taking focus off the composer: on a phone that
	// would drop the on-screen keyboard mid-prompt. Focus normally moves on mousedown, so
	// the harness reproduces that fallback explicitly.
	const ribbon = await c.evaluate(`(() => {
    const i = document.getElementById("input");
    i.focus();
    const btn = document.querySelector('#ribbon [data-key="C-t"]');
    const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(md);
    if (!md.defaultPrevented) btn.focus();
    btn.click();
    return { sent: window.__keys[window.__keys.length - 1], focused: document.activeElement.id };
  })()`);
	log("ribbon key:", JSON.stringify(ribbon));

	// A half-typed prompt belongs to the window it was aimed at, not to whichever window
	// happens to be up when it is finally sent.
	const drafts = await c.evaluate(`(() => {
    const S = window.piSuper, i = document.getElementById("input");
    const a = S.state.windows.find(w => w.active), b = S.state.windows.find(w => !w.active);
    const type = (t) => { i.value = t; i.dispatchEvent(new Event("input")); };
    type("for A");
    S.selectWindow(b.id);
    const onB = i.value;
    type("for B");
    S.selectWindow(a.id);
    const backOnA = i.value;
    S.setView("meta");
    const onMeta = i.value;
    S.setView("raw");
    type("");
    return { onB, backOnA, onMeta };
  })()`);
	log("drafts:", JSON.stringify(drafts));
	await wait(800);

	await setView("reader");
	await wait(2000);
	await c.shot("03-reader");

	// drawer
	await c.evaluate(`document.getElementById("btn-menu").click(); 1`);
	await wait(800);
	await c.shot("04-drawer");

	// drag the last window to the top of the list by its grip, and let tmux renumber
	const gripBox = await c.evaluate(`(() => {
    const rows = [...document.querySelectorAll("#window-list .wrow")];
    const last = rows[rows.length - 1];
    const g = last.querySelector(".grip").getBoundingClientRect();
    const first = rows[0].getBoundingClientRect();
    return { x: g.x + g.width / 2, y: g.y + g.height / 2, topY: first.y + 4, name: last.textContent.slice(0, 24) };
  })()`);
	await c.drag({ x: gripBox.x, y: gripBox.y }, { x: gripBox.x, y: gripBox.topY }, 20);
	await wait(1500);
	const order = await c.evaluate(`window.piSuper.state.windows.map(w => w.index + ":" + w.name).join(" ")`);
	const reorder = { dragged: gripBox.name, order };
	log("drag-reorder:", JSON.stringify(reorder));
	await c.shot("04b-drawer-reordered");

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

	// Green marks what is on screen, and it moves: the tab strip owns it in the terminal,
	// super's button owns it in the chat. Sampled in both views, since the bug this guards
	// against is precisely "the two views look identical".
	const bar = await c.evaluate(`(() => {
    const S = window.piSuper;
    const read = () => ({ tab: getComputedStyle(document.querySelector("#tabs .tab.active")).borderTopColor,
                          call: getComputedStyle(document.getElementById("btn-call")).borderTopColor });
    S.setView("meta"); const meta = read();
    S.setView("raw"); const term = read();
    S.setView("meta");
    return { meta, term };
  })()`);
	console.log("top bar colours:", JSON.stringify(bar));
	const GREEN = "rgb(126, 231, 135)";
	const BLUE = "rgb(79, 127, 208)";

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
		["swipe walks windows and comes back", afterSwipe !== beforeSwipe && backSwipe === beforeSwipe],
		["swipe up/down pages the terminal", pagedKeys === "PageDown,PageUp"],
		["dragging a window to the top renumbers it to 0", reorder.order.startsWith("0:agent")],
		["footer visible above the fold", metrics.footer.top + metrics.footer.h <= metrics.viewport.h + 1],
		["terminal ribbon hidden in chat view", viewChecks.view !== "meta" || !viewChecks.ribbonVisible],
		["abort button shown in chat view", viewChecks.view !== "meta" || viewChecks.abortVisible],
		// green is the active tmux window and nothing else, in every view; super's button
		// answers in blue, so the two signals can never be mistaken for each other
		["terminal view: the window tab is green", bar.term.tab === GREEN],
		["terminal view: super's button is not green", bar.term.call !== GREEN],
		["chat view: super's button is green", bar.meta.call === GREEN],
		["chat view: the window tab drops to blue", bar.meta.tab === BLUE],
		["the two views never look the same", bar.term.tab !== bar.meta.tab && bar.term.call !== bar.meta.call],
		["ribbon key reaches the pty without stealing focus", ribbon.sent === "C-t" && ribbon.focused === "input"],
		["drafts are per window and per view", drafts.onB === "" && drafts.backOnA === "for A" && drafts.onMeta === ""],
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
