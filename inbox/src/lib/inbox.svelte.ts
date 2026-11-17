import { api, ApiError, type ChatDetail, type ChatFilter, type ChatSummary, type InboxState, type MessageView, type OutboxIntent } from "./api";
import { outbox } from "./outbox.svelte";

/*
 * The one client-side model: the server's list and open chat, kept current by /ws/inbox.
 * Every write here is a correction endpoint on the server; nothing is sent to Beeper.
 */

const PING_MS = 25_000;
const MAX_RETRY_MS = 30_000;
const LIST_DEBOUNCE_MS = 300;

function byTime(a: MessageView, b: MessageView): number {
	return Date.parse(a.timestamp) - Date.parse(b.timestamp) || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
}

function describe(err: unknown): string {
	if (err instanceof ApiError) return err.message;
	return "Errore di rete";
}

class InboxStore {
	state = $state<InboxState | null>(null);
	socket = $state<"connecting" | "open" | "lost">("connecting");
	now = $state(Date.now());

	filter = $state<ChatFilter>("reply");
	network = $state("");
	query = $state("");
	chats = $state<ChatSummary[]>([]);
	listLoaded = $state(false);
	listError = $state<string | null>(null);
	listUpdatedAt = $state<string | undefined>(undefined);
	wide = $state(false);

	chat = $state<ChatDetail | null>(null);
	chatError = $state<string | null>(null);
	messages = $state<MessageView[]>([]);
	nextCursor = $state<string | null>(null);
	messagesLoaded = $state(false);
	loadingOlder = $state(false);
	actionError = $state<string | null>(null);
	modelPrivacyBusy = $state(false);

	openId: string | undefined;
	private started = false;
	private ws: WebSocket | undefined;
	private retryMs = 1000;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private listTimer: ReturnType<typeof setTimeout> | undefined;
	private listSeq = 0;
	private summarySeq = 0;

	get unreachable(): boolean {
		return this.state?.beeper.status === "unreachable";
	}

	get degraded(): boolean {
		const s = this.state?.beeper.status;
		return s === "unreachable" || s === "unauthorized" || s === "unconfigured";
	}

	start(): void {
		if (this.started || typeof window === "undefined") return;
		this.started = true;
		const media = window.matchMedia("(min-width: 800px)");
		this.wide = media.matches;
		media.addEventListener("change", (e) => (this.wide = e.matches));
		setInterval(() => (this.now = Date.now()), 30_000);
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible" && this.socket !== "open") this.connect(true);
		});
		void this.refreshState();
		void this.refreshList();
		this.connect(true);
	}

	async refreshState(): Promise<void> {
		try {
			this.state = await api.state();
		} catch {
			// the socket and the next poll will show it; the banner is driven by the socket
		}
	}

	/** Manual retry: asks the server to re-read Beeper now, then refetches what is on screen. */
	async retry(): Promise<void> {
		try {
			this.state = await api.refresh();
		} catch (err) {
			this.actionError = describe(err);
		}
		void this.refreshList();
		if (this.openId) void this.loadChat(this.openId);
	}

	setFilter(filter: ChatFilter): void {
		this.filter = filter;
		void this.refreshList();
	}

	setNetwork(network: string): void {
		this.network = network;
		void this.refreshList();
	}

	setQuery(query: string): void {
		this.query = query;
		this.scheduleList();
	}

	scheduleList(): void {
		this.listSeq++;
		clearTimeout(this.listTimer);
		this.listTimer = setTimeout(() => void this.refreshList(), LIST_DEBOUNCE_MS);
	}

	async refreshList(): Promise<void> {
		const seq = ++this.listSeq;
		try {
			const r = await api.chats({ filter: this.filter, network: this.network, q: this.query.trim() });
			if (seq !== this.listSeq) return;
			this.chats = r.chats;
			this.listUpdatedAt = r.updatedAt;
			this.listError = null;
		} catch (err) {
			if (seq !== this.listSeq) return;
			this.listError = describe(err);
		} finally {
			if (seq === this.listSeq) this.listLoaded = true;
		}
	}

	openChat(id: string): void {
		if (this.openId === id) return;
		this.openId = id;
		this.chat = null;
		this.chatError = null;
		this.messages = [];
		this.nextCursor = null;
		this.messagesLoaded = false;
		this.actionError = null;
		void this.loadChat(id);
	}

	closeChat(): void {
		this.openId = undefined;
		this.chat = null;
		this.messages = [];
	}

	private async loadChat(id: string): Promise<void> {
		const seq = this.summarySeq;
		try {
			const [chat, page] = await Promise.all([api.chat(id), api.messages(id)]);
			if (this.openId !== id) return;
			if (seq === this.summarySeq) this.chat = chat;
			else if (!this.chat) { void this.loadChat(id); return; }
			this.chatError = null;
			this.messages = page.messages.slice().sort(byTime);
			this.nextCursor = page.nextCursor;
		} catch (err) {
			if (this.openId !== id) return;
			this.chatError = err instanceof ApiError && err.status === 404 ? "Questa chat non è più disponibile." : describe(err);
		} finally {
			if (this.openId === id) this.messagesLoaded = true;
		}
	}

	async loadOlder(): Promise<void> {
		const id = this.openId;
		if (!id || !this.nextCursor || this.loadingOlder) return;
		this.loadingOlder = true;
		try {
			const page = await api.messages(id, this.nextCursor);
			if (this.openId !== id) return;
			this.mergeMessages(page.messages);
			this.nextCursor = page.nextCursor;
		} catch (err) {
			this.actionError = describe(err);
		} finally {
			this.loadingOlder = false;
		}
	}

	private mergeMessages(incoming: MessageView[]): void {
		const byId = new Map(this.messages.map((m) => [m.id, m]));
		for (const m of incoming) byId.set(m.id, m);
		this.messages = [...byId.values()].sort(byTime);
	}

	/** Runs a correction; the returned summary replaces the open chat's and the list is re-read. */
	async correct(run: () => Promise<ChatSummary>): Promise<void> {
		this.actionError = null;
		try {
			const summary = await run();
			this.applySummary(summary);
			this.scheduleList();
		} catch (err) {
			this.actionError = describe(err);
		}
	}

	applySummary(summary: ChatSummary): void {
		this.summarySeq++;
		this.listSeq++;
		if (this.chat && this.chat.id === summary.id) this.chat = { ...summary, participants: this.chat.participants };
		// Replace in place; ordering and filtering are always decided by the next server list.
		this.chats = this.chats.map((chat) => chat.id === summary.id ? summary : chat);
	}

	applyModelPrivacy(summary: ChatSummary, scope: "chat" | "network"): void {
		this.applySummary(summary);
		if (scope === "network") {
			const update = (chat: ChatSummary): ChatSummary => chat.network === summary.network
				? { ...chat, importance: undefined, modelPrivacy: { ...chat.modelPrivacy, networkExcluded: summary.modelPrivacy.networkExcluded } }
				: chat;
			this.chats = this.chats.map(update);
			if (this.chat?.network === summary.network) this.chat = { ...this.chat, ...update(this.chat) };
		}
		this.scheduleList();
	}

	private connect(resetBackoff: boolean): void {
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
		clearTimeout(this.retryTimer);
		if (resetBackoff) this.retryMs = 1000;
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${proto}//${location.host}/ws/inbox`);
		this.ws = ws;
		ws.onopen = () => {
			this.socket = "open";
			this.retryMs = 1000;
			clearInterval(this.pingTimer);
			this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "ping" })), PING_MS);
			// events are not replayed after a reconnect: reread everything on screen
			void this.refreshState();
			void this.refreshList();
			if (this.openId) void this.loadChat(this.openId);
		};
		ws.onmessage = (e: MessageEvent<string>) => this.onMessage(e.data);
		ws.onclose = () => {
			this.socket = "lost";
			clearInterval(this.pingTimer);
			this.ws = undefined;
			this.retryTimer = setTimeout(() => this.connect(false), this.retryMs);
			this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
		};
	}

	private onMessage(raw: string): void {
		let msg: { t: string } & Record<string, unknown>;
		try {
			msg = JSON.parse(raw) as typeof msg;
		} catch {
			return;
		}
		switch (msg.t) {
			case "state":
				this.state = msg.state as InboxState;
				return;
			case "chats": {
				const changed = (msg.changed as ChatSummary[]) ?? [];
				const removed = (msg.removed as string[]) ?? [];
				if (this.openId && removed.includes(this.openId)) this.chatError = "Questa chat non è più disponibile.";
				if (this.chat) {
					const mine = changed.find((c) => c.id === this.chat?.id);
					if (mine) this.applySummary(mine);
				}
				if (changed.length > 0 || removed.length > 0) this.scheduleList();
				return;
			}
			case "messages": {
				if (msg.chatID === this.openId) this.mergeMessages(msg.messages as MessageView[]);
				return;
			}
			case "outbox": {
				outbox.apply(msg.intent as OutboxIntent);
				// a sent message can lift the chat out of "Da rispondere": keep the list fresh
				this.scheduleList();
				return;
			}
		}
	}
}

export const inbox = new InboxStore();
