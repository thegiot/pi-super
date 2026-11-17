/*
 * "Da rispondere" and "importante" (PRD §10). Pure: no I/O, no clock except `now`, no
 * text rendering. The client turns the codes into Italian.
 *
 * Exclusions are checked in the order of §10.1 and the first one that applies wins, so
 * `excludedBy` explains why a chat that looks like it needs a reply does not show up.
 */

export type Reason =
	| { code: "dm_waiting"; since: string }
	| { code: "mention" }
	| { code: "reply_to_you"; messageID: string }
	| { code: "marked" }
	| { code: "pinned" }
	| { code: "priority" };

export type ExclusionCode =
	| "read_only"
	| "archived"
	| "low_priority"
	| "no_reply_needed"
	| "snoozed"
	| "last_is_mine"
	| "group_without_mention"
	| "muted_without_mention"
	| "outside_window";

export interface Labels {
	needsReply: boolean;
	reasons: Reason[];
	important: Reason[];
	excludedBy?: ExclusionCode;
	incomplete: boolean;
	longPending?: boolean;
}

export interface ClassifyChat {
	id: string;
	type: "single" | "group";
	isReadOnly: boolean;
	isArchived: boolean;
	isLowPriority: boolean;
	isMuted: boolean;
	isPinned: boolean;
	isMarkedUnread: boolean;
	unreadCount: number;
	unreadMentionsCount: number;
	lastActivity?: string;
}

export interface ClassifyMessage {
	id: string;
	timestamp: string;
	senderID: string;
	isSender: boolean;
	/** Beeper message type: TEXT, NOTICE, REACTION, IMAGE... */
	type: string;
	isDeleted: boolean;
	isHidden: boolean;
	mentions: string[] | null;
	linkedMessageID?: string;
}

export interface Corrections {
	noReplyAt?: string;
	snoozeUntil?: string;
	marked: boolean;
	priority: boolean;
}

export interface ClassifyInput {
	chat: ClassifyChat;
	/** the newest message, as listed with the chat; null when the chat has none */
	preview: ClassifyMessage | null;
	/** newest page of history, oldest first; undefined when not fetched */
	history?: ClassifyMessage[];
	corrections: Corrections;
	selfIDs: ReadonlySet<string>;
	now: Date;
	windowDays?: number;
}

export const DEFAULT_WINDOW_DAYS = 14;

/** Reactions and service notices are not conversation: they never count as the last word. */
export function isMeaningful(m: ClassifyMessage): boolean {
	return !m.isDeleted && !m.isHidden && m.type !== "REACTION" && m.type !== "NOTICE";
}

export function classify(input: ClassifyInput): Labels {
	const { chat, corrections: c, now } = input;
	const windowMs = (input.windowDays ?? DEFAULT_WINDOW_DAYS) * 86_400_000;
	const seen = input.history ?? (input.preview ? [input.preview] : undefined);
	const last = seen ? lastMeaningful(seen) : undefined;
	const mineOf = (m: ClassifyMessage) => m.isSender || input.selfIDs.has(m.senderID);

	const lastIdx = seen ? findLastIndex(seen, (m) => mineOf(m)) : -1;
	const afterMine = seen ? seen.slice(lastIdx + 1).filter(isMeaningful) : [];
	const mentionedInHistory = afterMine.some((m) => m.mentions?.some((id) => input.selfIDs.has(id)) === true);
	const mentioned = chat.unreadMentionsCount > 0 || mentionedInHistory;
	const replyTo = seen
		? afterMine.find((m) => {
				if (!m.linkedMessageID) return false;
				const target = seen.find((x) => x.id === m.linkedMessageID);
				return target !== undefined && mineOf(target);
			})
		: undefined;
	const important: Reason[] = [];
	if (chat.isPinned) important.push({ code: "pinned" });
	if (mentioned) important.push({ code: "mention" });
	if (c.priority) important.push({ code: "priority" });
	const marked = c.marked || chat.isMarkedUnread;

	const done = (
		excludedBy: ExclusionCode | undefined,
		reasons: Reason[] = [],
		incomplete = false,
		longPending?: boolean,
	): Labels => ({
		needsReply: excludedBy === undefined && !incomplete && reasons.length > 0,
		reasons: excludedBy === undefined && !incomplete ? reasons : [],
		important,
		excludedBy,
		incomplete,
		...(longPending ? { longPending } : {}),
	});

	if (chat.isReadOnly) return done("read_only");
	if (chat.isArchived) return done("archived");
	if (chat.isLowPriority) return done("low_priority");

	if (c.noReplyAt) {
		const dismissed = Date.parse(c.noReplyAt);
		if (seen) {
			const newerIncoming = seen.some(
				(m) => isMeaningful(m) && !mineOf(m) && Date.parse(m.timestamp) > dismissed,
			);
			if (!newerIncoming) return done("no_reply_needed");
		} else if (chat.lastActivity && Date.parse(chat.lastActivity) <= dismissed) {
			return done("no_reply_needed");
		} else {
			return done(undefined, [], true);
		}
	}

	if (c.snoozeUntil && Date.parse(c.snoozeUntil) > now.getTime()) return done("snoozed");

	if (!chat.lastActivity) return done(undefined, [], true);

	// A group with nothing unread and nothing fetched can only be decided by its preview;
	// that is enough, because it cannot be waiting on us without an unread counter.
	const groupAtRest = chat.type === "group" && chat.unreadCount === 0 && chat.unreadMentionsCount === 0;
	if (!last && !groupAtRest) return done(undefined, [], true);
	if (last && mineOf(last)) return done("last_is_mine");

	const reasons: Reason[] = [];
	if (chat.type === "single") {
		if (last) {
			const since = Date.parse(last.timestamp);
			if (now.getTime() - since > windowMs) return done("outside_window", [], false, true);
			reasons.push({ code: "dm_waiting", since: last.timestamp });
		}
	} else {
		if (chat.isMuted && !mentioned) return done("muted_without_mention");
		// Unread messages we have not read cannot be ruled out as mentions or replies.
		if (!input.history && chat.unreadCount > 0 && !mentioned) return done(undefined, [], true);
		if (mentioned) reasons.push({ code: "mention" });
		if (replyTo) reasons.push({ code: "reply_to_you", messageID: replyTo.id });
		if (reasons.length === 0 && !marked) return done("group_without_mention");
	}
	if (marked) reasons.push({ code: "marked" });
	return done(undefined, reasons);
}

function lastMeaningful(messages: ClassifyMessage[]): ClassifyMessage | undefined {
	return messages.filter(isMeaningful).at(-1);
}

function findLastIndex<T>(items: T[], pred: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
	return -1;
}
