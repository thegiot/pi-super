import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../dist/server/inbox/classify.js";

// Synthetic world only: fake ids, fixed clock.
const NOW = new Date("2026-06-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const SELF = new Set(["@me:test.invalid"]);

const chat = (over = {}) => ({
	id: "!chat:test.invalid",
	type: "single",
	isReadOnly: false,
	isArchived: false,
	isLowPriority: false,
	isMuted: false,
	isPinned: false,
	isMarkedUnread: false,
	unreadCount: 1,
	unreadMentionsCount: 0,
	lastActivity: ago(HOUR),
	...over,
});

const msg = (over = {}) => ({
	id: "m-other",
	timestamp: ago(HOUR),
	senderID: "@other:test.invalid",
	isSender: false,
	type: "TEXT",
	isDeleted: false,
	isHidden: false,
	mentions: null,
	...over,
});

const mine = (over = {}) => msg({ id: "m-mine", senderID: "@me:test.invalid", isSender: true, ...over });

/** Defaults to a DM whose newest message is from the other side, one hour ago. */
function run({ chat: c = {}, preview, history, corrections = {}, windowDays, now = NOW } = {}) {
	const p = preview === undefined ? (history?.at(-1) ?? msg()) : preview;
	return classify({
		chat: chat(c),
		preview: p,
		...(history ? { history } : {}),
		corrections: { marked: false, priority: false, ...corrections },
		selfIDs: SELF,
		now,
		...(windowDays ? { windowDays } : {}),
	});
}

test("a DM waiting on us is needsReply with the time it has been waiting", () => {
	const m = msg({ timestamp: ago(2 * HOUR) });
	const out = run({ preview: m });
	assert.equal(out.needsReply, true);
	assert.deepEqual(out.reasons, [{ code: "dm_waiting", since: m.timestamp }]);
	assert.equal(out.excludedBy, undefined);
	assert.equal(out.incomplete, false);
});

test("exclusion last_is_mine when the user spoke last", () => {
	const out = run({ preview: mine() });
	assert.equal(out.needsReply, false);
	assert.equal(out.excludedBy, "last_is_mine");
});

test("last_is_mine also recognises the user by self id when isSender is absent", () => {
	const out = run({ preview: msg({ senderID: "@me:test.invalid", isSender: false }) });
	assert.equal(out.excludedBy, "last_is_mine");
});

test("a DM older than the attention window is outside it and marked long pending", () => {
	const out = run({ preview: msg({ timestamp: ago(30 * DAY) }) });
	assert.equal(out.needsReply, false);
	assert.equal(out.excludedBy, "outside_window");
	assert.equal(out.longPending, true);
	assert.deepEqual(out.reasons, []);
});

test("the attention window is configurable", () => {
	const m = msg({ timestamp: ago(2 * DAY) });
	assert.equal(run({ preview: m, windowDays: 1 }).excludedBy, "outside_window");
	assert.equal(run({ preview: m, windowDays: 3 }).needsReply, true);
});

test("a read-only channel never enters the list, however much is unread", () => {
	const out = run({ chat: { isReadOnly: true, unreadCount: 40 } });
	assert.equal(out.excludedBy, "read_only");
	assert.equal(out.needsReply, false);
});

test("archived and low-priority chats are excluded before any reason is looked at", () => {
	assert.equal(run({ chat: { isArchived: true } }).excludedBy, "archived");
	assert.equal(run({ chat: { isLowPriority: true } }).excludedBy, "low_priority");
});

test("exclusion order: read_only beats archived beats last_is_mine", () => {
	assert.equal(run({ chat: { isReadOnly: true, isArchived: true }, preview: mine() }).excludedBy, "read_only");
	assert.equal(run({ chat: { isArchived: true }, preview: mine() }).excludedBy, "archived");
});

test("a group without a mention or a reply never enters the list", () => {
	const out = run({ chat: { type: "group", unreadCount: 20 }, history: [msg()] });
	assert.equal(out.needsReply, false);
	assert.equal(out.excludedBy, "group_without_mention");
});

test("a muted group is only in the list through a mention", () => {
	const quiet = run({ chat: { type: "group", isMuted: true, unreadCount: 5 }, preview: msg() });
	assert.equal(quiet.excludedBy, "muted_without_mention");
	const mentioned = run({ chat: { type: "group", isMuted: true, unreadCount: 5, unreadMentionsCount: 1 }, preview: msg() });
	assert.equal(mentioned.needsReply, true);
	assert.deepEqual(mentioned.reasons, [{ code: "mention" }]);
});

test("unreadMentionsCount in a group is a mention", () => {
	const out = run({ chat: { type: "group", unreadCount: 2, unreadMentionsCount: 1 }, preview: msg() });
	assert.equal(out.needsReply, true);
	assert.deepEqual(out.reasons, [{ code: "mention" }]);
});

test("a message naming the user after their last word is a mention, one before it is not", () => {
	const after = [
		mine({ id: "m-1", timestamp: ago(3 * HOUR) }),
		msg({ id: "m-2", timestamp: ago(HOUR), mentions: ["@me:test.invalid"] }),
	];
	const out = run({ chat: { type: "group", unreadCount: 1 }, history: after });
	assert.deepEqual(out.reasons, [{ code: "mention" }]);

	const before = [
		msg({ id: "m-1", timestamp: ago(3 * HOUR), mentions: ["@me:test.invalid"] }),
		mine({ id: "m-2", timestamp: ago(2 * HOUR) }),
		msg({ id: "m-3", timestamp: ago(HOUR) }),
	];
	const quiet = run({ chat: { type: "group", unreadCount: 1 }, history: before });
	assert.equal(quiet.excludedBy, "group_without_mention");
});

test("a reply that quotes one of the user's messages is reply_to_you", () => {
	const history = [
		mine({ id: "m-mine", timestamp: ago(5 * HOUR) }),
		msg({ id: "m-s1", timestamp: ago(3 * HOUR), senderID: "@s1:test.invalid" }),
		msg({ id: "m-s2", timestamp: ago(HOUR), senderID: "@s2:test.invalid", linkedMessageID: "m-mine" }),
	];
	const out = run({ chat: { type: "group", unreadCount: 2 }, history });
	assert.equal(out.needsReply, true);
	assert.deepEqual(out.reasons, [{ code: "reply_to_you", messageID: "m-s2" }]);
});

test("a reply quoting someone else's message does not count", () => {
	const history = [
		msg({ id: "m-other", timestamp: ago(5 * HOUR), senderID: "@s1:test.invalid" }),
		msg({ id: "m-s2", timestamp: ago(HOUR), senderID: "@s2:test.invalid", linkedMessageID: "m-other" }),
	];
	assert.equal(run({ chat: { type: "group", unreadCount: 2 }, history }).excludedBy, "group_without_mention");
});

test("reactions and notices do not count as the last word", () => {
	const reactionAfter = [
		msg({ id: "m-1", timestamp: ago(2 * HOUR) }),
		msg({ id: "m-2", timestamp: ago(20 * 60_000), type: "REACTION" }),
	];
	const out = run({ history: reactionAfter });
	assert.equal(out.needsReply, true);
	assert.deepEqual(out.reasons, [{ code: "dm_waiting", since: ago(2 * HOUR) }]);

	const noticeAfterMine = [mine({ id: "m-1", timestamp: ago(3 * HOUR) }), msg({ id: "m-2", timestamp: ago(HOUR), type: "NOTICE" })];
	assert.equal(run({ history: noticeAfterMine }).excludedBy, "last_is_mine");
});

test("deleted and hidden messages do not count as the last word", () => {
	const deleted = [mine({ id: "m-1", timestamp: ago(3 * HOUR) }), msg({ id: "m-2", timestamp: ago(HOUR), isDeleted: true })];
	assert.equal(run({ history: deleted }).excludedBy, "last_is_mine");
	const hidden = [mine({ id: "m-1", timestamp: ago(3 * HOUR) }), msg({ id: "m-2", timestamp: ago(HOUR), isHidden: true })];
	assert.equal(run({ history: hidden }).excludedBy, "last_is_mine");
});

test("the user's own correction marks a chat, and it shows as a reason", () => {
	const out = run({ corrections: { marked: true } });
	assert.equal(out.needsReply, true);
	assert.deepEqual(out.reasons.map((r) => r.code), ["dm_waiting", "marked"]);
});

test("isMarkedUnread in Beeper is marked too", () => {
	const out = run({ chat: { isMarkedUnread: true, unreadCount: 0 }, preview: msg({ timestamp: ago(8 * HOUR) }) });
	assert.deepEqual(out.reasons.map((r) => r.code), ["dm_waiting", "marked"]);
});

test("a hand-marked group with no mention is in the list: the user's word prevails", () => {
	const out = run({ chat: { type: "group", unreadCount: 3 }, history: [msg()], corrections: { marked: true } });
	assert.equal(out.needsReply, true);
	assert.deepEqual(out.reasons, [{ code: "marked" }]);
});

test("no_reply_needed holds until something new arrives from the other side", () => {
	const dismissed = ago(30 * 60_000);
	const older = msg({ timestamp: ago(HOUR) });
	const quiet = run({ preview: older, corrections: { noReplyAt: dismissed } });
	assert.equal(quiet.excludedBy, "no_reply_needed");

	const newer = msg({ id: "m-new", timestamp: ago(10 * 60_000) });
	const back = run({ preview: newer, corrections: { noReplyAt: dismissed } });
	assert.equal(back.needsReply, true);
});

test("no_reply_needed without history: decided by lastActivity alone, otherwise incomplete", () => {
	const dismissed = ago(30 * 60_000);
	const quiet = run({ chat: { lastActivity: ago(HOUR) }, preview: null, corrections: { noReplyAt: dismissed } });
	assert.equal(quiet.excludedBy, "no_reply_needed");
	const unknown = run({ chat: { lastActivity: ago(5 * 60_000) }, preview: null, corrections: { noReplyAt: dismissed } });
	assert.equal(unknown.incomplete, true);
	assert.equal(unknown.needsReply, false);
});

test("a snooze holds the chat until it expires", () => {
	assert.equal(run({ corrections: { snoozeUntil: ago(-HOUR) } }).excludedBy, "snoozed");
	assert.equal(run({ corrections: { snoozeUntil: ago(HOUR) } }).needsReply, true);
});

test("priority and pinned are important, with their reasons, whatever the reply state", () => {
	const out = run({ chat: { isPinned: true, isArchived: true }, corrections: { priority: true } });
	assert.equal(out.needsReply, false);
	assert.deepEqual(out.important, [{ code: "pinned" }, { code: "priority" }]);

	const group = run({ chat: { type: "group", unreadCount: 1, unreadMentionsCount: 1 }, preview: msg() });
	assert.deepEqual(group.important, [{ code: "mention" }]);
});

test("missing lastActivity is incomplete, not a guess", () => {
	const out = run({ chat: { lastActivity: undefined } });
	assert.equal(out.incomplete, true);
	assert.equal(out.needsReply, false);
	assert.deepEqual(out.reasons, []);
});

test("a DM whose last message is a reaction, with no history fetched, is incomplete", () => {
	const out = run({ preview: msg({ type: "REACTION" }) });
	assert.equal(out.incomplete, true);
	assert.equal(out.needsReply, false);
});

test("a group with unread messages and no history fetched is incomplete", () => {
	const out = run({ chat: { type: "group", unreadCount: 4 }, preview: msg() });
	assert.equal(out.incomplete, true);
});

test("a group with nothing unread is decided by its preview: no history needed", () => {
	const out = run({ chat: { type: "group", unreadCount: 0 }, preview: msg({ type: "REACTION" }) });
	assert.equal(out.incomplete, false);
	assert.equal(out.excludedBy, "group_without_mention");
});

test("no messages at all is incomplete", () => {
	const out = run({ preview: null });
	assert.equal(out.incomplete, true);
});
