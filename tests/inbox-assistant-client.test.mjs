import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import compiler from "../inbox/node_modules/svelte/compiler/index.js";
import * as runtime from "../inbox/node_modules/svelte/src/internal/client/index.js";
import ts from "typescript";

function compile(path, runes = false) {
	const source = readFileSync(new URL(`../inbox/src/lib/${path}`, import.meta.url), "utf8");
	const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	return (runes ? compiler.compileModule(js, { filename: path.replace(/\.ts$/, ".js"), generate: "client" }).js.code : js)
		.replace(/^import .*;$/gm, "").replace(/\bexport /g, "");
}
function fixture(handler) {
	const calls = [];
	const fetch = async (path, init) => {
		const call = { path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
		calls.push(call);
		const data = await handler(call);
		return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
	};
	const { api, ApiError } = new Function("fetch", `${compile("api.ts")}\nreturn { api, ApiError };`)(fetch);
	const { composer, sendsOnEnter } = new Function("$", "kindLabel", `${compile("composer.svelte.ts", true)}\nreturn { composer, sendsOnEnter };`)(runtime, () => "message");
	const inbox = { chat: { id: "group" }, modelPrivacyBusy: false };
	const assistant = new Function("$", "api", "ApiError", "inbox", "composer", `${compile("assistant.svelte.ts", true)}\nreturn assistant;`)(runtime, api, ApiError, inbox, composer);
	const outbox = new Function("$", "api", "ApiError", "composer", `${compile("outbox.svelte.ts", true)}\nreturn outbox;`)(runtime, api, ApiError, composer);
	return { assistant, composer, outbox, inbox, calls, sendsOnEnter };
}
const selection = { engine: "flash", provider: "deepseek", model: "flash" };
const options = { default: selection, engines: [{ id: "flash", label: "Flash", available: true, models: [{ provider: "deepseek", id: "flash", label: "Flash" }], default: { provider: "deepseek", model: "flash" } }] };
const answer = { reply: "Hanno discusso dell'incontro.", draft: { text: "Ci vediamo domani.", language: "it" }, context: { messages: 4 } };
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

test("free questions use auto, informational chips discard drafts, structured owner drafts enter the composer", async () => {
	const env = fixture(() => answer);
	await env.assistant.ask("group", "Di cosa hanno parlato?", "answer");
	assert.equal(env.calls[0].body.intent, "answer");
	assert.equal(env.assistant.thread("group").turns[1].draft, null);
	assert.equal(env.composer.draft("group").text, "");
	env.assistant.open = true;
	await env.assistant.ask("group", "Scrivi un messaggio per dire che ci vediamo domani");
	assert.equal(env.calls[1].body.intent, "auto");
	assert.equal(env.composer.draft("group").text, answer.draft.text);
	assert.equal(env.composer.focusRequest.chatID, "group");
	assert.equal(env.assistant.open, false);
	assert.equal(env.calls[1].body.history.length, 2);
});

test("existing composer text requires replace or append and preserves the quote", async () => {
	const env = fixture(() => answer);
	env.composer.setText("group", "Mio testo");
	env.composer.setReply("group", { id: "quoted", snippet: "Prima" });
	env.assistant.open = true;
	await env.assistant.ask("group", "Proponi risposta", "draft");
	assert.equal(env.composer.draft("group").text, "Mio testo");
	assert.equal(env.assistant.thread("group").pendingDraft, answer.draft.text);
	assert.equal(env.assistant.open, true);
	env.assistant.applyDraft("group", "append");
	assert.equal(env.composer.draft("group").text, `Mio testo\n${answer.draft.text}`);
	assert.equal(env.composer.draft("group").replyTo.id, "quoted");
	assert.equal(env.assistant.thread("group").pendingDraft, null);
	await env.assistant.reformulate("group");
	assert.equal(env.calls[1].body.intent, "draft");
	env.assistant.applyDraft("group", "replace");
	assert.equal(env.composer.draft("group").text, answer.draft.text);
});

test("privacy revocation, closing, and leaving a chat invalidate late drafts", async () => {
	for (const invalidate of [
		(env) => env.assistant.clear(),
		(env) => env.assistant.close(),
		(env) => { env.assistant.deactivate("group"); env.inbox.chat = { id: "other" }; },
	]) {
		const response = deferred();
		const env = fixture(() => response.promise);
		const pending = env.assistant.ask("group", "Scrivi un messaggio");
		invalidate(env);
		response.resolve(answer);
		await pending;
		assert.equal(env.assistant.thread("group").turns.some((turn) => turn.role === "assistant"), false);
		assert.equal(env.composer.draft("group").text, "");
		assert.equal(env.composer.draft("other").text, "");
	}
});

test("editing then emptying the composer while asking prevents automatic insertion", async () => {
	const response = deferred();
	const env = fixture(() => response.promise);
	const pending = env.assistant.ask("group", "Scrivi un messaggio");
	env.composer.setText("group", "Sto scrivendo");
	env.composer.setText("group", "");
	response.resolve(answer);
	await pending;
	assert.equal(env.composer.draft("group").text, "");
	assert.equal(env.assistant.thread("group").turns[1].draft.text, answer.draft.text);
});

test("settings use content-free catalog endpoints and selection changes invalidate prior output", async () => {
	const response = deferred();
	const env = fixture((call) => {
		if (call.path.endsWith("/assistant/options")) return options;
		if (call.path.endsWith("/assistant-settings")) return call.body ?? selection;
		return response.promise;
	});
	await env.assistant.loadSettings("group");
	assert.equal(env.assistant.identity("group"), "Flash · deepseek · flash");
	assert.equal(env.calls.slice(0, 2).every((call) => call.method === "GET" && call.body === undefined), true);
	const pending = env.assistant.ask("group", "Scrivi un messaggio");
	const next = { engine: "hermes", provider: "openrouter", model: "example/model" };
	await env.assistant.select("group", next);
	response.resolve(answer);
	await pending;
	assert.deepEqual(JSON.parse(JSON.stringify(env.assistant.settings.group)), next);
	assert.equal(env.assistant.thread("group").turns.length, 0);
	assert.equal(env.composer.draft("group").text, "");
	assert.deepEqual(env.calls.at(-1).body, next);
	await env.assistant.ask("group", "Proponi risposta", "draft");
	env.composer.setText("group", "Mio testo");
	env.assistant.useDraft("group", "Vecchia proposta");
	assert.equal(env.assistant.thread("group").pendingDraft, "Vecchia proposta");
	await env.assistant.select("group", selection);
	assert.equal(env.assistant.thread("group").pendingDraft, null);
});

test("old answer metadata falls back to the selected identity", async () => {
	const env = fixture((call) => call.path.endsWith("/assistant/options") ? options : call.path.endsWith("/assistant-settings") ? selection : { ...answer, draft: null });
	await env.assistant.loadSettings("group");
	await env.assistant.ask("group", "Riassumi", "answer");
	assert.equal(env.assistant.thread("group").turns[1].identity, "flash · deepseek · flash");
});

function intent(state = "pending_confirm") {
	return { id: "intent-1", key: "key", chatID: "group", state, recipient: { title: "Gruppo", maxLength: null }, sendAttempts: state === "pending_confirm" ? 0 : 1 };
}
test("direct send registers exact text and quote, confirms once, and clears the captured revision", async () => {
	const create = deferred();
	const env = fixture((call) => call.path.endsWith("/confirm") ? intent("pending") : create.promise);
	env.composer.setText("group", "  testo esatto\nseconda riga  ");
	env.composer.setReply("group", { id: "quoted", snippet: "Prima" });
	const pending = env.outbox.sendDirect("group", env.composer.draft("group").text, "quoted");
	assert.equal(await env.outbox.sendDirect("group", "doppio invio"), false);
	assert.equal(env.outbox.review, null);
	create.resolve({ intent: intent(), confirmToken: "token" });
	assert.equal(await pending, true);
	assert.equal(env.calls.length, 2);
	assert.equal(env.calls[0].body.text, "  testo esatto\nseconda riga  ");
	assert.equal(env.calls[0].body.replyToMessageID, "quoted");
	assert.equal(env.calls[1].body.confirmToken, "token");
	assert.equal(env.composer.draft("group").text, "");
	assert.equal(env.outbox.review.outcome, true);
	assert.equal(env.outbox.pendingFor("group")[0].text, "  testo esatto\nseconda riga  ");
});

test("a late send confirmation keeps text edited after submission and other chat drafts", async () => {
	const confirmation = deferred();
	const env = fixture((call) => call.path.endsWith("/confirm") ? confirmation.promise : { intent: intent(), confirmToken: "token" });
	env.composer.setText("group", "Originale");
	const pending = env.outbox.sendDirect("group", "Originale");
	env.composer.setText("group", "Nuovo testo");
	env.composer.setText("other", "Altra chat");
	confirmation.resolve(intent("pending"));
	assert.equal(await pending, true);
	assert.equal(env.composer.draft("group").text, "Nuovo testo");
	assert.equal(env.composer.draft("other").text, "Altra chat");
});

test("uncertain sends retain recovery controls and a duplicate create never blindly reconfirms", async () => {
	let created = false;
	const env = fixture((call) => {
		if (call.path.endsWith("/confirm")) return intent("uncertain");
		if (call.path.endsWith("/reconcile")) return intent("not_found");
		if (call.path.endsWith("/reissue")) return { intent: intent(), confirmToken: "retry-token" };
		if (created) return { intent: intent("uncertain") };
		created = true;
		return { intent: intent(), confirmToken: "token" };
	});
	env.composer.setText("group", "Messaggio");
	await env.outbox.sendDirect("group", "Messaggio");
	assert.equal(env.outbox.review.intent.state, "uncertain");
	assert.equal(await env.outbox.sendDirect("group", "Messaggio"), false);
	assert.equal(env.calls.filter((call) => call.path.endsWith("/confirm")).length, 1);
	assert.equal(env.calls[0].body.key, env.calls[2].body.key);
	await env.outbox.reconcile();
	assert.equal(env.outbox.review.intent.state, "not_found");
	await env.outbox.reissue();
	assert.equal(env.outbox.review.outcome, false);
	assert.equal(env.outbox.review.confirmToken, "retry-token");
	assert.equal(env.calls.filter((call) => call.path.endsWith("/confirm")).length, 1);
});

test("Enter sends while Shift+Enter, repeat and IME events do not", () => {
	const env = fixture(() => ({}));
	const enter = { key: "Enter", shiftKey: false, repeat: false, isComposing: false, keyCode: 13 };
	assert.equal(env.sendsOnEnter(enter), true);
	for (const changed of [{ shiftKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { key: "x" }]) {
		assert.equal(env.sendsOnEnter({ ...enter, ...changed }), false);
	}
});

test("two deliberate identical sent messages get new keys, including delivery completed over the socket", async () => {
	for (const confirmedState of ["sent", "pending"]) {
		let number = 0;
		let last;
		const env = fixture((call) => {
			if (call.path.endsWith("/confirm")) return { ...last, state: confirmedState };
			last = { ...intent(), id: `intent-${++number}`, key: call.body.key };
			return { intent: last, confirmToken: "token" };
		});
		env.composer.setText("group", "Grazie!");
		await env.outbox.sendDirect("group", "Grazie!");
		if (confirmedState === "pending") env.outbox.apply({ ...last, state: "sent" });
		env.composer.setText("group", "Grazie!");
		await env.outbox.sendDirect("group", "Grazie!");
		const creates = env.calls.filter((call) => call.path === "/api/inbox/outbox");
		assert.equal(creates.length, 2);
		assert.notEqual(creates[0].body.key, creates[1].body.key);
		assert.equal(env.calls.filter((call) => call.path.endsWith("/confirm")).length, 2);
	}
});

test("selected Pi and Hermes remain available without a Flash API key", async () => {
	for (const engine of ["pi", "hermes"]) {
		const chosen = { engine, provider: "local", model: "configured-model" };
		const env = fixture((call) => call.path.endsWith("/assistant/options") ? { default: selection, engines: [{ id: engine, label: engine, available: true, models: [], default: { provider: "local", model: chosen.model } }] } : chosen);
		env.inbox.state = { assistant: { status: "unconfigured" } };
		await env.assistant.loadSettings("group");
		assert.equal(env.assistant.available("group"), true);
	}
});

test("pending and sending messages keep their key and are never blindly confirmed again", async () => {
	for (const state of ["pending", "sending"]) {
		let created = false;
		const env = fixture((call) => {
			if (call.path.endsWith("/confirm")) return intent(state);
			if (created) return { intent: intent(state) };
			created = true;
			return { intent: intent(), confirmToken: "token" };
		});
		await env.outbox.sendDirect("group", "Messaggio");
		await env.outbox.sendDirect("group", "Messaggio");
		assert.equal(env.calls[0].body.key, env.calls[2].body.key);
		assert.equal(env.calls.filter((call) => call.path.endsWith("/confirm")).length, 1);
	}
});


test("socket sent followed by a lost confirmation keeps the untouched submission key", async () => {
	const confirmation = deferred();
	const registered = new Map();
	let first;
	const env = fixture((call) => {
		if (call.path.endsWith("/confirm")) {
			if (call.path.includes("intent-1/")) return confirmation.promise;
			return { ...intent("sent"), id: "intent-2" };
		}
		let existing = registered.get(call.body.key);
		if (!existing) {
			existing = { ...intent(), id: `intent-${registered.size + 1}`, key: call.body.key };
			registered.set(call.body.key, existing);
			first ??= existing;
		}
		return { intent: existing, ...(existing.state === "pending_confirm" ? { confirmToken: "token" } : {}) };
	});
	env.composer.setText("group", "Messaggio originale");
	const pending = env.outbox.sendDirect("group", "Messaggio originale");
	await new Promise((resolve) => setImmediate(resolve));
	first.state = "sent";
	env.outbox.apply(first);
	confirmation.reject(new TypeError("connection lost"));
	assert.equal(await pending, false);
	assert.equal(env.composer.draft("group").text, "Messaggio originale");
	await env.outbox.sendDirect("group", "Messaggio originale");
	const creates = env.calls.filter((call) => call.path === "/api/inbox/outbox");
	assert.equal(creates.length, 2);
	assert.equal(creates[0].body.key, creates[1].body.key);
	assert.equal(env.calls.filter((call) => call.path.endsWith("/confirm")).length, 1);
	assert.equal(env.composer.draft("group").text, "");
});

test("a stale HTTP pending response cannot replace socket-confirmed sent delivery", async () => {
	const confirmation = deferred();
	let created;
	const env = fixture((call) => {
		if (call.path.endsWith("/confirm")) return confirmation.promise;
		created = { ...intent(), key: call.body.key };
		return { intent: created, confirmToken: "token" };
	});
	env.composer.setText("group", "Messaggio originale");
	const pending = env.outbox.sendDirect("group", "Messaggio originale");
	await new Promise((resolve) => setImmediate(resolve));
	env.outbox.apply({ ...created, state: "sent" });
	confirmation.resolve({ ...created, state: "pending" });
	assert.equal(await pending, true);
	assert.equal(env.outbox.intents[created.id].state, "sent");
	assert.equal(env.outbox.review.intent.state, "sent");
	assert.equal(env.composer.draft("group").text, "");
});
