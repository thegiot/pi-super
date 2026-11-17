import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import compiler from "../inbox/node_modules/svelte/compiler/index.js";
const { compileModule } = compiler;
import * as runtime from "../inbox/node_modules/svelte/src/internal/client/index.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function store(api) {
	const source = readFileSync(new URL("../inbox/src/lib/inbox.svelte.ts", import.meta.url), "utf8");
	// TypeScript is erased by the same compiler used by the project, before rune compilation.
	return import("typescript").then(({ default: ts }) => {
		const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
		const compiled = compileModule(js, { filename: "inbox.svelte.js", generate: "client" }).js.code
			.replace(/^import .*;$/gm, "")
			.replace("export const inbox = new InboxStore();", "return new InboxStore();");
		return new Function("$", "api", "ApiError", "outbox", compiled)(runtime, api, class extends Error {}, {});
	});
}
const oldChat = { id: "c", network: "N", participants: [], modelPrivacy: { chatExcluded: false, networkExcluded: false }, importance: { motivo: "OLD REVOKED" } };
const revoked = { ...oldChat, modelPrivacy: { chatExcluded: true, networkExcluded: false }, importance: undefined };

test("revoked model output cannot be restored by a delayed chat GET or list GET", async () => {
	const detail = deferred(), messages = deferred(), list = deferred();
	const inbox = await store({ chat: () => detail.promise, messages: () => messages.promise, chats: () => list.promise });
	inbox.openChat("c");
	const listing = inbox.refreshList();
	detail.resolve(oldChat);
	await Promise.resolve();
	inbox.chat = oldChat;
	inbox.chats = [oldChat];
	inbox.applyModelPrivacy(revoked, "chat");
	clearTimeout(inbox.listTimer);
	messages.resolve({ messages: [], nextCursor: null });
	list.resolve({ chats: [oldChat] });
	await listing;
	await new Promise(r => setImmediate(r));
	assert.equal(inbox.chat.modelPrivacy.chatExcluded, true);
	assert.equal(inbox.chat.importance, undefined);
	assert.equal(inbox.chats[0].importance, undefined);
	assert.equal(inbox.messagesLoaded, true);
});

test("WS summary revocation supersedes a pending detail read", async () => {
	const detail = deferred(), messages = deferred();
	const inbox = await store({ chat: () => detail.promise, messages: () => messages.promise });
	inbox.openChat("c");
	inbox.chat = oldChat;
	inbox.onMessage(JSON.stringify({ t: "chats", changed: [revoked], removed: [] }));
	clearTimeout(inbox.listTimer);
	detail.resolve(oldChat); messages.resolve({ messages: [], nextCursor: null });
	await new Promise(r => setImmediate(r));
	assert.equal(inbox.chat.modelPrivacy.chatExcluded, true);
	assert.equal(inbox.chat.importance, undefined);
});
