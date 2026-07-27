#!/usr/bin/env node
/**
 * Passkey flow, end to end, with no phone: Chrome's CDP WebAuthn domain provides a virtual
 * authenticator that performs real ceremonies (real signatures, verified by the server).
 *
 *   node tests/passkey-e2e.mjs
 *
 * It checks the property that actually matters once the box is on a tailnet: after a
 * passkey is enrolled, the bearer token alone no longer opens anything.
 *
 * Note the URL is http://localhost — WebAuthn refuses IP addresses as RP IDs, and only
 * treats localhost as a secure context without TLS.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const CHROME = process.env.CHROME_BIN ?? "google-chrome";
const PORT = 8795;
const CDP_PORT = 9335;
const SOCKET = "passkeytest";
const STATE_DIR = mkdtempSync(join(tmpdir(), "pi-super-passkey-"));
const BASE = `http://localhost:${PORT}`;

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
	const ws = new WebSocket(url, { maxPayload: 32 * 1024 * 1024 });
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

const results = [];
const check = (name, ok, detail = "") => {
	results.push([name, ok, detail]);
	log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
	sh("tmux", ["-L", SOCKET, "kill-server"]);
	sh("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "keys"]);
	cleanups.push(() => sh("tmux", ["-L", SOCKET, "kill-server"]));

	const server = spawn(
		"node",
		["dist/server/index.js", "-L", SOCKET, "-s", "keys", "--port", String(PORT), "--no-meta"],
		{
			cwd: new URL("..", import.meta.url).pathname,
			env: { ...process.env, PI_SUPER_STATE_DIR: STATE_DIR },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	cleanups.push(() => server.kill());
	await wait(2000);
	const token = readFileSync(join(STATE_DIR, "token"), "utf8").trim();
	const auth = { Authorization: `Bearer ${token}` };

	// before enrolment the token is the only credential and it works
	check("token works before enrolment", (await fetch(`${BASE}/api/state`, { headers: auth })).ok);

	const chrome = spawn(
		CHROME,
		[
			"--headless=new",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${join(STATE_DIR, "chrome")}`,
			"--no-first-run",
			"--no-sandbox",
			"--disable-gpu",
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
	await c.send("Network.enable");

	// a virtual passkey: platform authenticator, user verification always "successful"
	await c.send("WebAuthn.enable", { enableUI: false });
	const { authenticatorId } = await c.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			ctap2Version: "ctap2_1",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	log("virtual authenticator:", authenticatorId);

	await c.send("Page.navigate", { url: `${BASE}/?token=${token}&debug=1` });
	await wait(3500);

	const before = await c.evaluate(`window.piSuper.auth.state()`);
	check("starts unenrolled", before.enrolled === false && before.required === false);

	const label = await c.evaluate(`window.piSuper.auth.enroll("test-phone")`);
	check("enrolment ceremony completed", label === "test-phone", `label=${label}`);

	const creds = await c.send("WebAuthn.getCredentials", { authenticatorId });
	check("authenticator holds a credential", creds.credentials.length === 1);

	// the whole point: the token alone must now be refused
	const tokenNow = await fetch(`${BASE}/api/state`, { headers: auth });
	check("token alone refused after enrolment", tokenNow.status === 401, `status=${tokenNow.status}`);

	const wsProbe = await new Promise((resolve) => {
		const probe = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`, { headers: auth });
		probe.on("open", () => {
			probe.close();
			resolve("open");
		});
		probe.on("error", (e) => resolve(String(e.message)));
	});
	check("websocket refused with token alone", wsProbe !== "open", `got ${wsProbe}`);

	// a fresh browser with no cookies must be stopped by the lock screen…
	await c.send("Network.clearBrowserCookies");
	await c.send("Page.navigate", { url: `${BASE}/?debug=1` });
	await wait(3000);
	const locked = await c.evaluate(`!!document.getElementById("lock")`);
	check("lock screen shown without a session", locked === true);
	const connected = await c.evaluate(`document.querySelectorAll("#tabs .tab").length`);
	check("terminal does not connect while locked", connected === 0, `tabs=${connected}`);

	// …and let through by the passkey, via a real tap on the Unlock button
	const box = await c.evaluate(`(() => {
    const b = document.querySelector("#lock button.primary");
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await c.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
	}
	await wait(3000);
	const unlocked = await c.evaluate(`!document.getElementById("lock")`);
	check("passkey unlocked the app", unlocked === true);
	await wait(2500);
	const tabs = await c.evaluate(`document.querySelectorAll("#tabs .tab").length`);
	check("terminal connects after unlock", tabs > 0, `tabs=${tabs}`);

	const after = await c.evaluate(`window.piSuper.auth.state()`);
	check("session reported", after.authenticated === true && after.session?.label === "test-phone");

	// a wrong passkey (different authenticator) must fail
	await c.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
	const other = await c.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	await c.send("Network.clearBrowserCookies");
	await c.send("Page.navigate", { url: `${BASE}/?debug=1` });
	await wait(3000);
	const rejected = await c.evaluate(`window.piSuper.auth.login().then(() => "unexpected-success").catch(e => "rejected")`);
	check("unknown authenticator rejected", rejected === "rejected", rejected);
	await c.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: other.authenticatorId });

	// server-side revocation
	const revoke = spawnSync("node", ["dist/server/index.js", "--logout"], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, PI_SUPER_STATE_DIR: STATE_DIR },
		encoding: "utf8",
	});
	check("--logout revokes sessions", revoke.stdout.includes("revoked"), revoke.stdout.trim());
	const list = spawnSync("node", ["dist/server/index.js", "--list-passkeys"], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, PI_SUPER_STATE_DIR: STATE_DIR },
		encoding: "utf8",
	});
	check("--list-passkeys shows the credential", list.stdout.includes("test-phone"), list.stdout.trim().split("\n")[0]);

	await cleanup();
	const failed = results.filter(([, ok]) => !ok).length;
	console.log(`\n${results.length - failed}/${results.length} checks passed`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
	console.error("passkey-e2e failed:", e.message);
	await cleanup();
	process.exit(1);
});
