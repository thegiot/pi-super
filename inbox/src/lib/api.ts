// Shapes served by src/server/inbox (keep in step with service.ts / classify.ts).

export type MessageKind =
	| "text"
	| "image"
	| "video"
	| "audio"
	| "file"
	| "sticker"
	| "location"
	| "notice"
	| "reaction"
	| "unknown";

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
	| "no_messages"
	| "outside_window";

export interface Labels {
	needsReply: boolean;
	reasons: Reason[];
	important: Reason[];
	excludedBy?: ExclusionCode;
	incomplete: boolean;
	longPending?: boolean;
}

export interface Corrections {
	noReplyAt?: string;
	snoozeUntil?: string;
	marked: boolean;
	priority: boolean;
}

export interface ImportanceEvaluation {
	importanza: "alta" | "normale" | "bassa";
	motivo: string;
	fiducia: "alta" | "media" | "bassa";
	highlight: boolean;
	context: { messages: number; from: string | null; to: string | null };
	evaluatedAt: string;
	expiresAt: string;
	model: string;
	cached: boolean;
}

export interface ChatSummary {
	id: string;
	accountID: string;
	network: string;
	title: string;
	type: "single" | "group";
	participantCount: number;
	lastActivity?: string;
	unreadCount: number;
	mentions: number;
	preview: { kind: MessageKind; text?: string; senderName?: string; isSender: boolean; timestamp: string } | null;
	muted: boolean;
	archived: boolean;
	pinned: boolean;
	lowPriority: boolean;
	readOnly: boolean;
	maxTextLength?: number;
	labels: Labels;
	corrections: Corrections;
	accountStatus: string;
	importance?: ImportanceEvaluation;
	modelPrivacy: { chatExcluded: boolean; networkExcluded: boolean };
}

export interface ChatDetail extends ChatSummary {
	participants: { id: string; name: string; isSelf: boolean }[];
}

export interface MessageView {
	id: string;
	sortKey: string;
	timestamp: string;
	senderID: string;
	senderName?: string;
	isSender: boolean;
	kind: MessageKind;
	text?: string;
	edited: boolean;
	deleted: boolean;
	linkedMessageID?: string;
	attachments: {
		index: number;
		kind: MessageKind;
		name?: string;
		mime?: string;
		size?: number;
		width?: number;
		height?: number;
		url: string;
	}[];
	reactions: { key: string; count: number; mine: boolean }[];
}

export type BeeperStatus = "ok" | "slow" | "unreachable" | "unauthorized" | "unconfigured";

export interface Counts {
	reply: number;
	unread: number;
	all: number;
}

export type AssistantIntent = "answer" | "draft" | "auto";
export interface AssistantSettings {
	engine: "flash" | "pi" | "hermes";
	provider: string;
	model: string;
}
export interface AssistantOptions {
	engines: {
		id: AssistantSettings["engine"];
		label: string;
		available: boolean;
		profile?: string;
		models: { provider: string; id: string; label: string }[];
		default: { provider: string; model: string };
	}[];
	default: AssistantSettings;
}

export interface AssistantAnswer {
	engine?: AssistantSettings["engine"];
	provider?: string;
	reply: string;
	draft: { text: string; language: string } | null;
	context: { messages: number; from: string | null; to: string | null };
	model: string;
}

export interface InboxState {
	assistant: { status: "ok" | "unconfigured" };
	beeper: { status: BeeperStatus; lastOkAt?: string; scope?: string[] };
	accounts: { id: string; network: string; status: string }[];
	updatedAt?: string;
	loading: boolean;
	counts: Counts;
}

export type ChatFilter = "reply" | "unread" | "all";

// ---------------------------------------------------------------- outbox (M3)

export type OutboxState =
	| "pending_confirm"
	| "sending"
	| "pending"
	| "uncertain"
	| "sent"
	| "failed"
	| "not_found"
	| "cancelled"
	| "expired";

export interface OutboxRecipient {
	network: string;
	accountID: string;
	accountLabel: string;
	title: string;
	type: "single" | "group";
	participantCount: number;
	peerLabel?: string;
	/** null means "nessun limite dichiarato" */
	maxLength: number | null;
}

/** The public view: state, recipient, hashes — never the text (the composer holds it). */
export interface OutboxIntent {
	id: string;
	key: string;
	chatID: string;
	state: OutboxState;
	finalState?: OutboxState;
	reason?: string;
	sendAttempts: number;
	charCount: number;
	textHash: string;
	createdAt: string;
	sentAt?: string;
	expiresAt?: string;
	resolvedChatID?: string;
	recipient: OutboxRecipient;
	replyTo?: { author?: string; text?: string };
}

export interface OutboxCreated {
	intent: OutboxIntent;
	confirmToken?: string;
	expiresAt?: string;
}

export interface ChatList {
	chats: ChatSummary[];
	counts: Counts;
	updatedAt?: string;
	stale: boolean;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		credentials: "same-origin",
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) {
		let message = `HTTP ${res.status}`;
		try {
			const data = (await res.json()) as { error?: string };
			if (data.error) message = data.error;
		} catch {
			// not JSON: keep the status
		}
		throw new ApiError(res.status, message);
	}
	return res.status === 204 ? undefined as T : (await res.json()) as T;
}

const chatPath = (id: string) => `/api/inbox/chats/${encodeURIComponent(id)}`;

export const api = {
	state: () => call<InboxState>("GET", "/api/inbox/state"),
	refresh: () => call<InboxState>("POST", "/api/inbox/refresh"),
	chats: (q: { filter: ChatFilter; network?: string; q?: string }) => {
		const params = new URLSearchParams({ filter: q.filter });
		if (q.network) params.set("network", q.network);
		if (q.q) params.set("q", q.q);
		return call<ChatList>("GET", `/api/inbox/chats?${params}`);
	},
	chat: (id: string) => call<ChatDetail>("GET", chatPath(id)),
	messages: (id: string, cursor?: string) => {
		const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}&direction=before` : "";
		return call<{ messages: MessageView[]; nextCursor: string | null }>("GET", `${chatPath(id)}/messages${suffix}`);
	},
	setNoReply: (id: string, on: boolean) => call<ChatSummary>(on ? "POST" : "DELETE", `${chatPath(id)}/no-reply`),
	snooze: (id: string, until: string | null) =>
		until === null
			? call<ChatSummary>("DELETE", `${chatPath(id)}/snooze`)
			: call<ChatSummary>("POST", `${chatPath(id)}/snooze`, { until }),
	mark: (id: string, on: boolean) => call<ChatSummary>("POST", `${chatPath(id)}/mark`, { on }),
	priority: (id: string, on: boolean) => call<ChatSummary>("POST", `${chatPath(id)}/priority`, { on }),
	importance: (id: string) =>
		call<{ evaluation: ImportanceEvaluation; chat: ChatSummary }>("POST", `${chatPath(id)}/importance`),
	modelExclusion: (id: string, scope: "chat" | "network", on: boolean) =>
		call<ChatSummary>("POST", `${chatPath(id)}/model-exclusion`, { scope, on }),
	notifications: () => call<{ publicKey: string }>("GET", "/api/inbox/notifications"),
	subscribe: (subscription: PushSubscriptionJSON) =>
		call<unknown>("POST", "/api/inbox/notifications/subscriptions", subscription),
	unsubscribe: (endpoint: string) =>
		call<unknown>("DELETE", "/api/inbox/notifications/subscriptions", { endpoint }),
	assistantOptions: () => call<AssistantOptions>("GET", "/api/inbox/assistant/options"),
	assistantSettings: (id: string) => call<AssistantSettings>("GET", `${chatPath(id)}/assistant-settings`),
	setAssistantSettings: (id: string, settings: AssistantSettings) => call<AssistantSettings>("PATCH", `${chatPath(id)}/assistant-settings`, settings),
	assistant: (id: string, body: { prompt: string; intent?: AssistantIntent; history: { role: "user" | "assistant"; text: string }[] }) =>
		call<AssistantAnswer>("POST", `${chatPath(id)}/assistant`, body),
	createIntent: (body: { key: string; chatID: string; text: string; replyToMessageID?: string }) =>
		call<OutboxCreated>("POST", "/api/inbox/outbox", body),
	intent: (id: string) => call<OutboxIntent>("GET", `/api/inbox/outbox/${encodeURIComponent(id)}`),
	confirm: (id: string, confirmToken: string) =>
		call<OutboxIntent>("POST", `/api/inbox/outbox/${encodeURIComponent(id)}/confirm`, { confirmToken }),
	cancelIntent: (id: string) => call<OutboxIntent>("POST", `/api/inbox/outbox/${encodeURIComponent(id)}/cancel`),
	reissue: (id: string, text: string) => call<OutboxCreated>("POST", `/api/inbox/outbox/${encodeURIComponent(id)}/reissue`, { text }),
	reconcile: (id: string) => call<OutboxIntent>("POST", `/api/inbox/outbox/${encodeURIComponent(id)}/reconcile`),
};
