/**
 * The Android bridge contract, tested without Android: compile src/client/native-call.ts
 * on its own and drive it against a fake `window.PiNative`, checking the exact messages
 * the Kotlin side switches on (`startCall`/`markActive`/`endCall`/`setMuted`) and the
 * events it sends back.
 *
 * This is where the contract is pinned down. If a message name changes on either side,
 * voice mode silently degrades to media audio on the phone and nothing else notices.
 */
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const OUT = mkdtempSync(join(tmpdir(), "pi-super-native-"));
after(() => rmSync(OUT, { recursive: true, force: true }));

// A config file rather than flags: `types: []` keeps @types/node out (this file is
// browser-only, and node's own .d.ts do not even resolve under these settings).
const project = join(OUT, "tsconfig.json");
writeFileSync(
	project,
	JSON.stringify({
		compilerOptions: {
			outDir: OUT,
			module: "esnext",
			moduleResolution: "bundler",
			target: "es2022",
			lib: ["es2022", "dom"],
			types: [],
			strict: true,
		},
		files: [new URL("../src/client/native-call.ts", import.meta.url).pathname],
	}),
);
const tsc = spawnSync("node_modules/.bin/tsc", ["-p", project], { encoding: "utf8" });
assert.equal(tsc.status, 0, `tsc failed: ${tsc.stdout}${tsc.stderr}`);

/** A window just real enough for the module: a bridge that records, and event listeners. */
function fakeWindow() {
	const sent = [];
	const listeners = new Map();
	return {
		sent,
		PiNative: { postMessage: (m) => sent.push(JSON.parse(m)) },
		addEventListener: (type, fn) => listeners.set(type, fn),
		emit: (detail) => listeners.get("pi-native")?.({ detail }),
	};
}

async function load(win) {
	globalThis.window = win;
	// a fresh module instance per test: it caches window.PiNative at import time
	const url = `${pathToFileURL(join(OUT, "native-call.js")).href}?${Math.random()}`;
	const mod = await import(url);
	return mod.nativeCall;
}

test("without the bridge every call is a no-op", async () => {
	const win = { addEventListener: () => {} };
	const call = await load(win);
	assert.equal(call.available, false);
	await call.begin();
	call.active();
	call.end();
	call.setMuted(true);
	assert.equal(call.mode, undefined);
});

test("a dial waits for the OS, then reports the mode it got", async () => {
	const win = fakeWindow();
	const call = await load(win);
	assert.equal(call.available, true);

	let settled = false;
	const dial = call.begin().then((t) => {
		settled = true;
		return t;
	});
	assert.equal(win.sent.length, 1);
	assert.equal(win.sent[0].type, "startCall");
	const callId = win.sent[0].callId;
	assert.ok(callId, "the call carries an id");

	await Promise.resolve();
	assert.equal(settled, false, "begin() does not resolve before the OS admits the call");

	const notices = [];
	call.onNotice = (t) => notices.push(t);
	win.emit({ type: "callReady", callId, mode: "telecom" });
	assert.equal(await dial, callId, "begin() resolves with the token that scopes the call");
	assert.equal(call.mode, "telecom");
	assert.deepEqual(notices, [], "a plain telecom call is not worth a notice");

	call.active();
	assert.deepEqual(win.sent[1], { type: "markActive", callId });
	call.setMuted(true);
	assert.deepEqual(win.sent[2], { type: "setMuted", callId, muted: true });
	call.end();
	assert.deepEqual(win.sent[3], { type: "endCall", callId });
	assert.equal(call.mode, undefined);
});

test("a wedged OS does not stop the dial", async () => {
	const win = fakeWindow();
	const call = await load(win);
	const started = Date.now();
	await call.begin();
	// The watchdog is 6s and must outlast the native side's own 2.5s telecom timeout, or we
	// would open the microphone while the fallback is still claiming the audio route.
	assert.ok(Date.now() - started >= 5000, "begin() waits for the OS before giving up");
	assert.equal(call.mode, undefined, "no mode: the call is media audio and the page may say so");
});

test("the audio-focus fallback announces itself", async () => {
	const win = fakeWindow();
	const call = await load(win);
	const notices = [];
	call.onNotice = (t) => notices.push(t);
	const dial = call.begin();
	win.emit({ type: "callReady", callId: win.sent[0].callId, mode: "audiofocus", reason: "telecom unavailable" });
	await dial;
	assert.equal(call.mode, "audiofocus");
	assert.deepEqual(notices, ["call: audiofocus (telecom unavailable)"]);
});

test("a reconnect stays inside the same native call", async () => {
	const win = fakeWindow();
	const call = await load(win);
	const dial = call.begin();
	win.emit({ type: "callReady", callId: win.sent[0].callId, mode: "telecom" });
	await dial;
	await call.begin();
	assert.equal(win.sent.filter((m) => m.type === "startCall").length, 1, "no second call is placed");
});

test("a hang-up from the car ends the call here too, and only once", async () => {
	const win = fakeWindow();
	const call = await load(win);
	let hangups = 0;
	call.onDisconnect = () => hangups++;
	const dial = call.begin();
	win.emit({ type: "callReady", callId: win.sent[0].callId, mode: "telecom" });
	await dial;

	win.emit({ type: "disconnect", callId: win.sent[0].callId });
	assert.equal(hangups, 1);
	assert.equal(call.mode, undefined);
	// voice.ts answers a native disconnect by calling stop(), which calls end(): the
	// native side has already torn the call down, so nothing more may be sent to it
	const before = win.sent.length;
	call.end();
	assert.equal(win.sent.length, before, "no endCall after the OS already hung up");
});

test("a hang-up the OS can explain says why", async () => {
	const win = fakeWindow();
	const call = await load(win);
	const notices = [];
	call.onNotice = (t) => notices.push(t);
	call.onDisconnect = () => {};
	const dial = call.begin();
	const callId = win.sent[0].callId;
	win.emit({ type: "callReady", callId, mode: "telecom" });
	await dial;
	// The native side sends a reason when it has one — audio focus refused because an
	// emergency call holds it, say. Without it voice mode would just stop, silently.
	win.emit({ type: "disconnect", callId, reason: "the audio is busy (telecom unavailable)" });
	assert.deepEqual(notices, ["call ended: the audio is busy (telecom unavailable)"]);
});

test("route changes reach the page", async () => {
	const win = fakeWindow();
	const call = await load(win);
	const seen = [];
	call.onRoute = (route, routes, muted) => seen.push([route, routes, muted]);
	const dial = call.begin();
	const callId = win.sent[0].callId;
	win.emit({ type: "callReady", callId, mode: "telecom" });
	await dial;
	win.emit({ type: "audioRoute", callId, route: "bluetooth", routes: ["speaker", "bluetooth"], muted: true });
	assert.deepEqual(seen, [["bluetooth", ["speaker", "bluetooth"], true]]);

	call.setRoute("speaker");
	assert.deepEqual(win.sent.at(-1), { type: "setRoute", callId, route: "speaker" });
});

test("events for a call that has ended are ignored", async () => {
	const win = fakeWindow();
	const call = await load(win);
	let hangups = 0;
	call.onDisconnect = () => hangups++;
	call.onRoute = () => assert.fail("a stale route change must not reach the page");
	const dial = call.begin();
	const first = win.sent[0].callId;
	win.emit({ type: "callReady", callId: first, mode: "telecom" });
	await dial;
	call.end();

	// the second dial is a different call; the first one's leftovers must not touch it
	const second = call.begin();
	win.emit({ type: "disconnect", callId: first });
	win.emit({ type: "audioRoute", callId: first, route: "speaker", routes: ["speaker"], muted: true });
	assert.equal(hangups, 0);
	call.end();
	await second;
});

test("an abandoned dial cannot hang up the call that replaced it", async () => {
	const win = fakeWindow();
	const call = await load(win);
	const stale = call.begin();
	const staleToken = win.sent[0].callId;
	call.end(); // the user hung up while the OS was still thinking
	await stale;

	const fresh = call.begin();
	const freshToken = win.sent.at(-1).callId;
	assert.notEqual(freshToken, staleToken);
	call.end(staleToken); // the stale attempt finally gives up
	assert.equal(win.sent.filter((m) => m.type === "endCall").length, 1, "the live call survives");
	call.end(freshToken);
	await fresh;
});

test("a dial that is never admitted still cancels cleanly", async () => {
	const win = fakeWindow();
	const call = await load(win);
	const dial = call.begin();
	call.end(); // voice.ts does this when the user hangs up mid-connect
	await dial; // must not hang for the full timeout
	assert.deepEqual(win.sent.map((m) => m.type), ["startCall", "endCall"]);
});
