/** Meta-agent chat view: talks to pi-super's `pi --mode rpc` child over /ws/meta. */

export interface ChatItem {
	kind: "user" | "assistant" | "tool" | "speak" | "system";
	id: number;
	text?: string;
	name?: string;
	args?: unknown;
	result?: string;
	error?: boolean;
	done?: boolean;
	speech?: "ack" | "status" | "final";
}

export interface MetaState {
	running: boolean;
	busy: boolean;
	model?: string;
}

export interface MetaApi {
	/** source is recorded in the server's prompt log, so a lost prompt says where it came from */
	send(text: string, source?: "chat" | "voice"): void;
	abort(): void;
	newSession(): void;
	onSpeak?: (msg: { message: string; kind: string }) => void;
	onState?: (state: MetaState) => void;
	/** Meta agent asked the foreground pi-super client to show a tmux window. */
	onShowWindow?: (request: { window: string; view: "raw" | "reader" }) => void;
}

export function createMeta(container: HTMLElement): MetaApi {
	const nodes = new Map<number, HTMLElement>();
	let ws: WebSocket | undefined;
	let backoff = 500;
	let lastActiveAt = 0;

	// Voice/chat input must survive a reconnect rather than vanish into a closed socket.
	const outbox: string[] = [];
	function post(msg: object): void {
		const data = JSON.stringify(msg);
		if (ws?.readyState === WebSocket.OPEN) ws.send(data);
		else if (outbox.length < 50) outbox.push(data);
	}

	/**
	 * A meta agent is global but its UI commands are not: with a phone and desktop both
	 * connected, only the one the user is touching should move. Presence is deliberately
	 * ephemeral (never queued through reconnect), and throttled so typing is not a stream of
	 * bookkeeping messages.
	 */
	function markActive(force = false): void {
		if (document.hidden || ws?.readyState !== WebSocket.OPEN) return;
		const now = Date.now();
		if (!force && now - lastActiveAt < 1000) return;
		lastActiveAt = now;
		ws.send(JSON.stringify({ t: "active" }));
	}

	const api: MetaApi = {
		send(text, source = "chat") {
			if (!text.trim()) return;
			post({ t: "prompt", text, source });
			// Sending is also a request to *watch*: if the log was scrolled up (or the keyboard
			// resize left it a few pixels off the bottom), the echo of what was just said lands
			// below the fold and the send reads as having gone nowhere.
			container.scrollTop = container.scrollHeight;
		},
		abort() {
			post({ t: "abort" });
		},
		newSession() {
			post({ t: "newSession" });
		},
	};

	function atBottom(): boolean {
		return container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
	}

	function render(item: ChatItem): void {
		// One's own message always pulls the view along, whether or not it was pinned: it is
		// the one item nobody expects to have to go looking for.
		const stick = atBottom() || (item.kind === "user" && !nodes.has(item.id));
		let node = nodes.get(item.id);
		if (!node) {
			node = document.createElement("div");
			nodes.set(item.id, node);
			container.append(node);
		}
		node.className = `chat ${item.kind}${item.speech ? ` ${item.speech}` : ""}`;
		if (item.kind === "tool") {
			const args = item.args ? JSON.stringify(item.args) : "";
			node.textContent = `${item.error ? "✗" : item.result === undefined ? "…" : "✓"} ${item.name} ${
				args.length > 90 ? `${args.slice(0, 90)}…` : args
			}`;
			node.title = item.result ?? "";
			node.onclick = () => {
				if (item.result) node.textContent = `${item.name}\n${item.result}`;
			};
		} else if (item.kind === "speak") {
			node.textContent = `🔊 ${item.text ?? ""}`;
		} else {
			node.textContent = item.text ?? "";
		}
		if (stick) container.scrollTop = container.scrollHeight;
	}

	function connect(): void {
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		ws = new WebSocket(`${proto}//${location.host}/ws/meta`);
		ws.onopen = () => {
			backoff = 500;
			while (outbox.length > 0 && ws?.readyState === WebSocket.OPEN) ws.send(outbox.shift() as string);
			if (document.hidden) ws?.send(JSON.stringify({ t: "inactive" }));
			else markActive(true);
		};
		ws.onmessage = (ev) => {
			const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
			switch (msg.t) {
				case "init":
					nodes.clear();
					container.replaceChildren();
					for (const item of msg.transcript as ChatItem[]) render(item);
					api.onState?.(msg.state as MetaState);
					break;
				case "item":
					render(msg.item as ChatItem);
					break;
				case "state":
					api.onState?.(msg.state as MetaState);
					break;
				case "speak":
					api.onSpeak?.(msg as unknown as { message: string; kind: string });
					break;
				case "clientControl":
					if (msg.action === "showWindow" && typeof msg.window === "string") {
						api.onShowWindow?.({ window: msg.window, view: msg.view === "reader" ? "reader" : "raw" });
					}
					break;
			}
		};
		ws.onclose = () => {
			ws = undefined;
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 8000);
		};
		ws.onerror = () => ws?.close();
	}

	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			// A phone put in a pocket must stop being the target even if no other client has
			// been clicked since. This presence hint is intentionally not queued.
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "inactive" }));
		} else markActive(true);
	});
	window.addEventListener("focus", () => markActive(true));
	window.addEventListener("pointerdown", () => markActive(), { passive: true });
	window.addEventListener("keydown", () => markActive(), { passive: true });

	connect();
	return api;
}
