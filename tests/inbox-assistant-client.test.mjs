import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import compiler from "../inbox/node_modules/svelte/compiler/index.js";
import * as runtime from "../inbox/node_modules/svelte/src/internal/client/index.js";
import ts from "typescript";

function store(api) {
	const source = readFileSync(new URL("../inbox/src/lib/assistant.svelte.ts", import.meta.url), "utf8");
	const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
	const compiled = compiler.compileModule(js, { filename: "assistant.svelte.js", generate: "client" }).js.code
		.replace(/^import .*;$/gm, "")
		.replace("export const assistant = new AssistantStore();", "return new AssistantStore();")
		.replace("export function assistantErrorText", "function assistantErrorText");
	return new Function("$", "api", "ApiError", "inbox", compiled)(runtime, api, class extends Error {}, { chat: { id: "group" } });
}
const answer = { reply: "Hanno discusso dell'incontro.", draft: { text: "NON AUTOMATICA", language: "it" }, context: { messages: 4 } };

test("assistant free questions are informational; drafting and reformulating are explicit", async () => {
	const calls = [];
	const assistant = store({ assistant: async (id, body) => { calls.push({ id, body }); return answer; } });
	await assistant.ask("group", "Di cosa hanno parlato ultimamente?");
	assert.equal(calls[0].body.intent, "answer");
	assert.equal(assistant.thread("group").turns[1].draft, null);
	await assistant.ask("group", "Proponi risposta", "draft");
	assert.equal(calls[1].body.intent, "draft");
	assert.equal(assistant.thread("group").turns[3].draft.text, "NON AUTOMATICA");
	await assistant.reformulate("group");
	assert.equal(calls[2].body.intent, "draft");
	assert.equal(calls[2].body.history.length, 4);
	assert.equal(calls.every(c => c.id === "group"), true);
});

test("privacy clearing still rejects a late informational answer", async () => {
	let resolve;
	const assistant = store({ assistant: () => new Promise(r => { resolve = r; }) });
	const pending = assistant.ask("group", "Riassumi");
	assistant.clear();
	resolve(answer);
	await pending;
	assert.equal(assistant.thread("group").turns.length, 0);
	assert.equal(assistant.open, false);
});
