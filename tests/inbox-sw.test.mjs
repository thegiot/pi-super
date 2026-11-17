import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function worker(windows = []) {
	const listeners = {}, shown = [], opened = [];
	const self = {
		location: { origin: "https://inbox.test" },
		addEventListener: (name, fn) => { listeners[name] = fn; },
		registration: { showNotification: async (...args) => { shown.push(args); } },
		clients: { matchAll: async () => windows, openWindow: async url => { opened.push(url); } },
	};
	runInNewContext(readFileSync(new URL("../inbox/static/inbox-sw.js", import.meta.url), "utf8"), { self, URL });
	return { listeners, shown, opened };
}
async function click(w, url) {
	let pending, closed = false;
	w.listeners.notificationclick({ notification: { data: { url }, close: () => { closed = true; } }, waitUntil: p => { pending = p; } });
	await pending;
	assert.equal(closed, true);
}

test("inbox SW handles notifications only, validates push shape and never stores/caches", async () => {
	const w = worker();
	assert.deepEqual(Object.keys(w.listeners).sort(), ["notificationclick", "push"]);
	for (const payload of [null, {}, { title: "x" }, { title: "x", body: 1, tag: "t", url: "/inbox/" }]) {
		w.listeners.push({ data: { json: () => payload }, waitUntil: () => assert.fail("invalid payload") });
	}
	w.listeners.push({ data: { json: () => { throw new Error(); } } });
	let pending;
	w.listeners.push({ data: { json: () => ({ title: "Chat", body: "Una chat importante attende risposta", tag: "t", url: "https://evil.test/inbox/" }) }, waitUntil: p => { pending = p; } });
	await pending;
	assert.equal(w.shown.length, 1);
	assert.equal(w.shown[0][1].data.url, "/inbox/");
});

test("notification clicks cannot escape the same-origin inbox or focus other app pages", async () => {
	for (const url of ["https://evil.test/inbox/", "//evil.test/inbox/", "/inbox/../../logout", "/inbox/\\evil", "/inbox/\nfoo", "/logout", null]) {
		const w = worker([{ url: "https://inbox.test/", focus: () => assert.fail("terminal focused") }]);
		await click(w, url);
		assert.deepEqual(w.opened, ["/inbox/"]);
	}
});

test("notification click navigates and focuses an inbox tab, falls back when it closes", async () => {
	const calls = [];
	const w = worker([{ url: "https://inbox.test/inbox/", navigate: async url => { calls.push(url); return { focus: async () => calls.push("focus") }; } }]);
	await click(w, "/inbox/chat/c");
	assert.deepEqual(calls, ["/inbox/chat/c", "focus"]);
	assert.deepEqual(w.opened, []);
	const closing = worker([{ url: "https://inbox.test/inbox/", navigate: async () => { throw new Error("closing"); } }]);
	await click(closing, "/inbox/chat/c");
	assert.deepEqual(closing.opened, ["/inbox/chat/c"]);
});
