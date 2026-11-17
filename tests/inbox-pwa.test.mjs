import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { parseArgs } from "../dist/server/config.js";
import { createServer } from "../dist/server/server.js";

const TOKEN = randomBytes(24).toString("base64url");
const STATIC = new URL("../inbox/static/", import.meta.url);
const MANIFEST = "/inbox/manifest.webmanifest";
const ICONS = ["/inbox/icons/inbox-192.png", "/inbox/icons/inbox-512.png"];
const root = mkdtempSync(join(tmpdir(), "pi-super-pwa-"));
let server, strict, port, strictPort;

function raw(port, path, { method = "GET", headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers, timeout: 5000 }, res => {
			const chunks = [];
			res.on("data", chunk => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
		req.on("error", reject);
		req.end();
	});
}

async function boot(name, mode) {
	const stateDir = join(root, name);
	mkdirSync(stateDir);
	const cfg = parseArgs(["--state-dir", stateDir, "--no-meta", "--no-herdr", "--no-inbox", "--auth", mode]);
	const instance = createServer({ ...cfg, inboxDir: join(root, "inbox"), clientDir: join(root, "client"), metaDir: stateDir }, TOKEN);
	await new Promise(resolve => instance.http.listen(0, "127.0.0.1", resolve));
	return [instance, instance.http.address().port];
}

before(async () => {
	// Use the real build when present, but keep HTTP security coverage runnable with
	// `npm test` (which builds the server only) on a fresh checkout too.
	const build = new URL("../dist/inbox/", import.meta.url);
	cpSync(existsSync(new URL("index.html", build)) ? build : STATIC, join(root, "inbox"), { recursive: true });
	cpSync(STATIC, join(root, "inbox"), { recursive: true });
	if (!existsSync(join(root, "inbox/index.html"))) {
		const app = readFileSync(new URL("../inbox/src/app.html", import.meta.url), "utf8");
		writeFileSync(join(root, "inbox/index.html"), app.replaceAll(/%sveltekit\.[^%]+%/g, ""));
	}
	mkdirSync(join(root, "client"));
	writeFileSync(join(root, "client/index.html"), "<!doctype html><title>Unlock</title>");
	writeFileSync(join(root, "inbox/private.js"), "private bundle marker");
	[server, port] = await boot("token", "token");
	[strict, strictPort] = await boot("passkey", "passkey");
}, { timeout: 10000 });

after(async () => {
	await server?.close();
	await strict?.close();
	// root is a verified mkdtemp directory owned solely by this test.
	assert.ok(root.startsWith(join(tmpdir(), "pi-super-pwa-")));
	rmSync(root, { recursive: true, force: true });
});

test("public manifest has stable inbox identity/scope and credential-free PNG icons", { timeout: 10000 }, async () => {
	for (const p of [port, strictPort]) {
		const response = await raw(p, MANIFEST);
		assert.equal(response.status, 200);
		assert.equal(response.headers["content-type"], "application/manifest+json; charset=utf-8");
		assert.equal(response.headers["x-content-type-options"], "nosniff");
		assert.equal(response.headers["set-cookie"], undefined);
		assert.equal(response.body.includes(TOKEN), false);
		const manifest = JSON.parse(response.body);
		assert.equal(manifest.id, "/inbox/");
		assert.equal(manifest.scope, "/inbox/");
		assert.equal(manifest.start_url, "/inbox/");
		assert.equal(manifest.display, "standalone");
		assert.ok(manifest.name && manifest.short_name);
		assert.deepEqual(manifest.icons.map(icon => icon.src), ICONS);
		assert.doesNotMatch(response.body.toString().replaceAll(/#[0-9a-f]{6}/gi, ""), /token|ticket|secret|authorization|cookie|\?|#/i);
		for (const [i, icon] of manifest.icons.entries()) {
			assert.equal(icon.type, "image/png");
			const image = await raw(p, icon.src);
			assert.equal(image.status, 200);
			assert.equal(image.headers["content-type"], "image/png");
			assert.equal(image.headers["set-cookie"], undefined);
			assert.deepEqual(image.body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			const size = [192, 512][i];
			assert.equal(image.body.readUInt32BE(16), size);
			assert.equal(image.body.readUInt32BE(20), size);
			assert.equal(icon.sizes, `${size}x${size}`);
			assert.match(icon.purpose, /maskable/);
		}
		for (const path of [MANIFEST, ...ICONS]) {
			const head = await raw(p, path, { method: "HEAD" });
			assert.equal(head.status, 200);
			assert.equal(head.body.length, 0);
		}
	}
});

test("only exact public asset paths/methods bypass auth; inbox APIs, worker and app remain locked", { timeout: 10000 }, async () => {
	const locked = [
		"/api/inbox/state", "/api/inbox/chats", "/api/inbox/chats/x/messages", "/api/inbox/attachments/x/y/0",
		"/inbox/index.html", "/inbox/private.js", "/inbox/inbox-sw.js", "/inbox/_app/test.js", "/inbox/chat/private",
		"/inbox/icons/private.png", `${MANIFEST}/suffix`, "/inbox/manifest.webmanifest.bak", "/inbox/icons/inbox-192.png/x",
		"/inbox/%6danifest.webmanifest", "/inbox/icons/%69nbox-192.png", "/inbox/icons/../manifest.webmanifest",
		"/inbox/icons/%2e%2e/manifest.webmanifest", "/inbox//manifest.webmanifest", "/inbox/manifest.webmanifest%00",
		"/inbox/%2e%2e%2fclient%2findex.html",
	];
	for (const p of [port, strictPort]) {
		for (const path of locked) {
			const response = await raw(p, path);
			assert.ok([401, 302].includes(response.status), `${p} ${path}: ${response.status}`);
			assert.equal(response.body.includes("private bundle marker"), false);
		}
		for (const path of [MANIFEST, ...ICONS]) {
			for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
				const response = await raw(p, path, { method });
				assert.ok([401, 302].includes(response.status), `${method} ${path}`);
			}
		}
	}
	const landing = await raw(port, "/inbox/");
	assert.equal(landing.status, 302);
	assert.equal(landing.headers.location, "/pair");
	const privateApp = await raw(port, "/inbox/", { headers: { authorization: `Bearer ${TOKEN}` } });
	assert.equal(privateApp.status, 200);
	assert.match(privateApp.body.toString(), /rel="manifest" href="\/inbox\/manifest.webmanifest"/);
	assert.equal(privateApp.headers["cache-control"], "no-store");
});

test("unauthenticated pairing advertises the same manifest with a narrow manifest CSP", { timeout: 5000 }, async () => {
	const pairing = await raw(port, "/pair");
	assert.equal(pairing.status, 200);
	assert.match(pairing.body.toString(), /rel="manifest" href="\/inbox\/manifest.webmanifest"/);
	assert.match(pairing.headers["content-security-policy"], /manifest-src 'self'/);
	assert.match(pairing.headers["content-security-policy"], /img-src 'self' data:/);
	assert.match(pairing.headers["content-security-policy"], /default-src 'none'/);
	assert.equal(pairing.headers["cache-control"], "no-store");
	assert.equal(pairing.body.includes(TOKEN), false);
});

const CHROME = process.env.CHROME_BIN ?? ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"].find(existsSync);

async function devtools(url) {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
	let id = 0;
	const pending = new Map();
	const events = new Map();
	ws.on("message", data => {
		const result = JSON.parse(String(data));
		if (result.method) events.get(result.method)?.(result.params);
		const entry = pending.get(result.id);
		if (!entry) return;
		pending.delete(result.id);
		clearTimeout(entry.timer);
		result.error ? entry.reject(new Error(JSON.stringify(result.error))) : entry.resolve(result.result);
	});
	return {
		close: () => ws.close(),
		waitFor(method) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { events.delete(method); reject(new Error(`CDP event timeout: ${method}`)); }, 5000);
				events.set(method, result => { clearTimeout(timer); events.delete(method); resolve(result); });
			});
		},
		send(method, params = {}) {
			return new Promise((resolve, reject) => {
				const n = ++id;
				const timer = setTimeout(() => { pending.delete(n); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
				pending.set(n, { resolve, reject, timer });
				ws.send(JSON.stringify({ id: n, method, params }));
			});
		},
	};
}

test("Chromium reports actual installability for authenticated inbox and unauthenticated pairing", { timeout: 30000, skip: !CHROME && "Chromium not installed; set CHROME_BIN" }, async t => {
	const profile = join(root, "chromium");
	const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
	let client;
	try {
		const endpoint = await new Promise((resolve, reject) => {
			let output = "";
			const timer = setTimeout(() => reject(new Error(`Chromium startup timeout: ${output}`)), 8000);
			chrome.once("error", error => { clearTimeout(timer); reject(error); });
			chrome.stderr.on("data", data => {
				output += data;
				const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
				if (match) { clearTimeout(timer); resolve(new URL(match[1])); }
			});
		});
		const target = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5000) }).then(r => r.json());
		client = await devtools(target.webSocketDebuggerUrl);
		await client.send("Page.enable");
		await client.send("Network.enable");
		for (const path of ["/inbox/", "/pair"]) {
			await client.send("Network.clearBrowserCookies");
			const loaded = client.waitFor("Page.loadEventFired");
			if (path === "/inbox/") {
				// Use the production login redirect/cookie, not an injected bypass.
				await client.send("Page.navigate", { url: `http://127.0.0.1:${port}/inbox/?token=${TOKEN}` });
			} else await client.send("Page.navigate", { url: `http://127.0.0.1:${port}/pair` });
			await loaded;
			const manifest = await client.send("Page.getAppManifest");
			assert.equal(manifest.url, `http://127.0.0.1:${port}${MANIFEST}`);
			assert.deepEqual(manifest.errors, []);
			const result = await client.send("Page.getInstallabilityErrors");
			t.diagnostic(`${path}: ${JSON.stringify(result.installabilityErrors)}`);
			assert.deepEqual(result.installabilityErrors, [], `${path} must be installable`);
			if (path === "/pair") {
				const locked = await client.send("Runtime.evaluate", { expression: "fetch('/api/inbox/chats').then(r => r.status)", awaitPromise: true, returnByValue: true });
				assert.equal(locked.result.value, 401, "installability never unlocks chats");
			}
		}
	} finally {
		client?.close();
		const exited = new Promise(resolve => chrome.once("exit", resolve));
		chrome.kill("SIGKILL");
		await exited;
	}
});
