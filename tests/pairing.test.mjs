import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { PairingTickets, pairingPage } from "../dist/server/pairing.js";

const TTL = 120_000;

test("pairing tickets use 32 random bytes and redeem only once", () => {
	const tickets = new PairingTickets(() => 1000);
	const issued = tickets.issue();
	assert.equal(issued.expiresAt, 1000 + TTL);
	assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(Buffer.from(issued.ticket, "base64url").length, 32);
	assert.equal(tickets.redeem("wrong"), false);
	assert.equal(tickets.redeem("x".repeat(43)), false);
	assert.equal(tickets.redeem("é".repeat(43)), false, "multibyte input must not reach unequal buffer comparison");
	assert.equal(tickets.redeem(null), false);
	assert.equal(tickets.redeem("x".repeat(1_000_000)), false);
	assert.equal(tickets.redeem(issued.ticket), true, "wrong guesses do not consume the valid ticket");
	assert.equal(tickets.redeem(issued.ticket), false);
});

test("pairing tickets expire exactly at two minutes", () => {
	let now = 500;
	const tickets = new PairingTickets(() => now);
	const first = tickets.issue();
	now = first.expiresAt - 1;
	assert.equal(tickets.redeem(first.ticket), true);
	const second = tickets.issue();
	now = second.expiresAt;
	assert.equal(tickets.redeem(second.ticket), false);
	now -= 1;
	assert.equal(tickets.redeem(second.ticket), false, "an expired slot is removed, not revived by clock rollback");
	const third = tickets.issue();
	now = third.expiresAt + 1;
	assert.equal(tickets.redeem(third.ticket), false);
});

test("issuing replaces prior tickets and keeps only one bounded slot", () => {
	const tickets = new PairingTickets(() => 42);
	assert.equal(tickets.redeem("no ticket issued"), false);
	const prior = [];
	for (let i = 0; i < 2048; i++) prior.push(tickets.issue().ticket);
	assert.equal(new Set(prior).size, prior.length);
	const current = prior.pop();
	for (const ticket of prior) assert.equal(tickets.redeem(ticket), false);
	assert.equal(tickets.redeem(current), true);
	assert.equal(tickets.redeem(current), false);
	assert.deepEqual(Object.keys(tickets), [], "no public growing collection or credential state");
});

test("issued ticket objects cannot mutate the internal ticket or expiry", () => {
	let now = 100;
	const tickets = new PairingTickets(() => now);
	const issued = tickets.issue();
	const original = issued.ticket;
	issued.ticket = "attacker";
	issued.expiresAt = Infinity;
	assert.equal(tickets.redeem(original), true);
	const expiring = tickets.issue();
	const expiryTicket = expiring.ticket;
	expiring.expiresAt = Infinity;
	now += TTL;
	assert.equal(tickets.redeem(expiryTicket), false);
	const realTime = new PairingTickets().issue();
	assert.ok(realTime.expiresAt >= Date.now() + TTL - 1000);
});

function browser(authed, { hash = "", responses = [], now = 1000 } = {}) {
	const elements = new Map();
	const events = [];
	const fetches = [];
	const timers = new Map();
	let ready;
	let time = now;
	let timerId = 0;
	for (const id of ["action", "status", "help", "result", "qr", "pair-link", "countdown"]) {
		elements.set(id, {
			hidden: ["help", "result"].includes(id),
			disabled: false,
			textContent: "",
			removeAttribute(name) { delete this[name]; },
			addEventListener(name, handler) { this[name] = handler; },
		});
	}
	const location = { hash, origin: "https://pi.example", replace(path) { events.push(["navigate", path]); } };
	const html = pairingPage(authed);
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script);
	runInNewContext(script, {
		location,
		history: { replaceState(state, title, path) { events.push(["scrub", path]); location.hash = ""; } },
		document: {
			addEventListener(event, handler) { assert.equal(event, "DOMContentLoaded"); ready = handler; },
			getElementById(id) { return elements.get(id); },
		},
		URL,
		URLSearchParams,
		Date: { now: () => time },
		encodeURIComponent,
		setInterval(handler) { const id = ++timerId; timers.set(id, handler); return id; },
		clearInterval(id) { timers.delete(id); },
		async fetch(path, options) {
			fetches.push({ path, ...options, body: JSON.parse(options.body) });
			const response = responses.shift();
			if (response instanceof Error) throw response;
			assert.ok(response, "unexpected fetch");
			return response;
		},
	});
	assert.deepEqual(events, [["scrub", "/pair"]], "fragment is scrubbed even before DOMContentLoaded");
	assert.equal(fetches.length, 0);
	ready();
	return {
		elements, events, fetches, timers,
		click: () => elements.get("action").click(),
		advance(ms) { time += ms; for (const handler of timers.values()) handler(); },
	};
}

test("pairing pages are self-contained, Italian and free of credential interpolation or unsafe sinks", () => {
	for (const authed of [false, true]) {
		const html = pairingPage(authed);
		assert.match(html, /<html lang="it">/);
		assert.match(html, /name="viewport"/);
		assert.match(html, /color-scheme: dark/);
		assert.match(html, /pi-super --pair-url https:\/\/&lt;host&gt;/);
		assert.doesNotMatch(html, /<(?:script|iframe)\b[^>]*(?:src|href)=/i);
		assert.deepEqual([...html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)].map(m => m[1]), ["/inbox/manifest.webmanifest"]);
		assert.doesNotMatch(html, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|console\.|prefetch|prerender)\b/);
		assert.doesNotMatch(html, /\?token=|Bearer |pi_super|<input\b|<form\b/);
		assert.equal((html.match(/fetch\(/g) || []).length, 2);
		assert.equal((html.match(/method: "POST"/g) || []).length, 2);
		assert.equal((html.match(/credentials: "same-origin"/g) || []).length, 2);
	}
});

test("unauthenticated pairing requires explicit confirmation and keeps fragment out of the DOM", async () => {
	const ticket = "<img src=x onerror=evil()>";
	const page = browser(false, { hash: "#pair=" + encodeURIComponent(ticket), responses: [{ ok: true }] });
	assert.equal(page.fetches.length, 0);
	for (const element of page.elements.values()) assert.equal(element.textContent.includes(ticket), false);
	await page.click();
	assert.equal(page.fetches.length, 1);
	assert.equal(page.fetches[0].path, "/api/auth/pair/redeem");
	assert.equal(page.fetches[0].method, "POST");
	assert.equal(page.fetches[0].credentials, "same-origin");
	assert.equal(page.fetches[0].headers["Content-Type"], "application/json");
	assert.equal(page.fetches[0].body.ticket, ticket);
	assert.deepEqual(page.events.at(-1), ["navigate", "/inbox/"]);
	assert.equal(page.elements.get("action").disabled, true);
	await page.click();
	assert.equal(page.fetches.length, 1, "no in-memory replay even if handler is called again");
});

test("missing fragment only offers local-launch instructions and never redeems", async () => {
	for (const hash of ["", "#pair=", "#other=value"]) {
		const page = browser(false, { hash });
		assert.equal(page.elements.get("action").hidden, true);
		assert.equal(page.elements.get("help").hidden, false);
		await page.click();
		assert.equal(page.fetches.length, 0);
	}
});

test("failed redemption does not navigate or retain a replayable ticket", async () => {
	for (const response of [{ ok: false, status: 410 }, { ok: false, status: 403 }, new Error("offline")]) {
		const page = browser(false, { hash: "#pair=secret", responses: [response] });
		await page.click();
		assert.deepEqual(page.events, [["scrub", "/pair"]]);
		assert.equal(page.elements.get("help").hidden, false);
		assert.equal(page.elements.get("action").disabled, true);
		if (response.status === 403) assert.match(page.elements.get("status").textContent, /passkey/);
		await page.click();
		assert.equal(page.fetches.length, 1);
	}
});

test("authenticated page issues only on click, renders SVG as an image and hides expired output", async () => {
	const url = "https://pi.example/pair#pair=temporary";
	const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script></svg>';
	const page = browser(true, {
		hash: "#pair=ignored",
		responses: [{ ok: true, json: async () => ({ url, svg, expiresAt: 3000 }) }],
	});
	assert.equal(page.fetches.length, 0);
	await page.click();
	assert.equal(page.fetches.length, 1);
	assert.equal(page.fetches[0].path, "/api/auth/pair/issue");
	assert.equal(page.fetches[0].method, "POST");
	assert.equal(page.fetches[0].credentials, "same-origin");
	assert.equal(page.fetches[0].body.origin, "https://pi.example");
	assert.equal(page.elements.get("qr").src, "data:image/svg+xml," + encodeURIComponent(svg));
	assert.equal(page.elements.get("pair-link").href, url);
	assert.equal(page.elements.get("pair-link").textContent, url);
	assert.equal(page.elements.get("result").hidden, false);
	assert.match(page.elements.get("countdown").textContent, /2 s/);
	page.advance(1000);
	assert.match(page.elements.get("countdown").textContent, /1 s/);
	page.advance(1000);
	assert.equal(page.elements.get("result").hidden, true);
	assert.equal(page.elements.get("qr").src, undefined);
	assert.equal(page.elements.get("pair-link").href, undefined);
	assert.equal(page.elements.get("pair-link").textContent, "");
	assert.equal(page.timers.size, 0);
});

test("new issue attempts clear old QR, while 403 explains passkey policy without a bypass", async () => {
	const page = browser(true, { responses: [
		{ ok: true, json: async () => ({ url: "https://pi.example/pair#pair=old", svg: "<svg/>", expiresAt: 9000 }) },
		{ ok: false, status: 403 },
	] });
	await page.click();
	assert.equal(page.timers.size, 1);
	await page.click();
	assert.equal(page.elements.get("result").hidden, true);
	assert.equal(page.elements.get("qr").src, undefined);
	assert.equal(page.timers.size, 0);
	assert.match(page.elements.get("status").textContent, /passkey/);
	assert.equal(page.elements.get("help").hidden, false);
	assert.equal(page.elements.get("action").disabled, false);
	assert.equal(page.fetches.length, 2, "403 does not trigger authentication or another endpoint");
});

test("issue rejects unsafe links, malformed responses and already expired output", async () => {
	for (const data of [
		{ url: "javascript:alert(1)", svg: "<svg/>", expiresAt: 9000 },
		{ url: "https://other.example/pair#pair=x", svg: "<svg/>", expiresAt: 9000 },
		{ url: "https://pi.example/pair?token=secret#pair=x", svg: "<svg/>", expiresAt: 9000 },
		{ url: "https://pi.example/other#pair=x", svg: "<svg/>", expiresAt: 9000 },
		{ url: "https://pi.example/pair#pair=x", svg: 12, expiresAt: 9000 },
		{ url: "https://pi.example/pair#pair=x", svg: "<svg/>", expiresAt: "9000" },
		{ url: "https://pi.example/pair#pair=x", svg: "<svg/>", expiresAt: 1000 },
	]) {
		const page = browser(true, { responses: [{ ok: true, json: async () => data }] });
		await page.click();
		assert.equal(page.elements.get("result").hidden, true);
		assert.equal(page.elements.get("qr").src, undefined);
		assert.equal(page.elements.get("pair-link").href, undefined);
		assert.equal(page.timers.size, 0);
	}
});
