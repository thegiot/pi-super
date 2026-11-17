import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CorrectionsStore } from "../dist/server/inbox/corrections.js";

const iso = (ms) => new Date(ms).toISOString();

function scratch() {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-corrections-"));
	return { dir, file: join(dir, "inbox-corrections.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("corrections survive a restart (CA5)", () => {
	const s = scratch();
	try {
		const at = iso(Date.parse("2026-06-01T10:00:00Z"));
		new CorrectionsStore(s.file).update("!chat-a:test.invalid", { noReplyAt: at, marked: true });
		const reopened = new CorrectionsStore(s.file);
		assert.deepEqual(reopened.get("!chat-a:test.invalid"), { noReplyAt: at, marked: true, priority: false });
		assert.deepEqual(reopened.get("!unknown:test.invalid"), { marked: false, priority: false });
	} finally {
		s.cleanup();
	}
});

test("the file is 0600 and holds only chat ids, timestamps and flags", () => {
	const s = scratch();
	try {
		const store = new CorrectionsStore(s.file);
		store.update("!chat-a:test.invalid", { noReplyAt: iso(1), snoozeUntil: iso(2), priority: true });
		assert.equal(statSync(s.file).mode & 0o777, 0o600);
		const parsed = JSON.parse(readFileSync(s.file, "utf8"));
		assert.deepEqual(Object.keys(parsed), ["version", "chats"]);
		assert.deepEqual(Object.keys(parsed.chats["!chat-a:test.invalid"]).sort(), ["noReplyAt", "priority", "snoozeUntil"]);
		assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith(".tmp")), []);
	} finally {
		s.cleanup();
	}
});

test("an explicit undefined clears a field, and a cleared chat leaves the file", () => {
	const s = scratch();
	try {
		const store = new CorrectionsStore(s.file);
		store.update("!chat-a:test.invalid", { snoozeUntil: iso(5) });
		store.update("!chat-a:test.invalid", { snoozeUntil: undefined });
		assert.equal(store.get("!chat-a:test.invalid").snoozeUntil, undefined);
		const parsed = JSON.parse(readFileSync(s.file, "utf8"));
		assert.deepEqual(parsed.chats, {});
	} finally {
		s.cleanup();
	}
});

test("an unreadable file is moved aside, not silently overwritten, and the store starts empty", () => {
	const s = scratch();
	try {
		writeFileSync(s.file, "{not json");
		const logs = [];
		const store = new CorrectionsStore(s.file, (m) => logs.push(m));
		assert.deepEqual(store.get("!chat-a:test.invalid"), { marked: false, priority: false });
		assert.equal(existsSync(s.file), false);
		const aside = readdirSync(s.dir).filter((f) => f.includes(".corrupt-"));
		assert.equal(aside.length, 1);
		assert.equal(readFileSync(join(s.dir, aside[0]), "utf8"), "{not json");
		assert.equal(logs.length, 1);
	} finally {
		s.cleanup();
	}
});
