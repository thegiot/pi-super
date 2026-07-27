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
	send(text: string): void;
	abort(): void;
	newSession(): void;
	onSpeak?: (msg: { message: string; kind: string }) => void;
	onState?: (state: MetaState) => void;
}

export function createMeta(container: HTMLElement): MetaApi {
	const nodes = new Map<number, HTMLElement>();
	let ws: WebSocket | undefined;
	let backoff = 500;

	const api: MetaApi = {
		send(text) {
			if (!text.trim()) return;
			ws?.send(JSON.stringify({ t: "prompt", text }));
		},
		abort() {
			ws?.send(JSON.stringify({ t: "abort" }));
		},
		newSession() {
			ws?.send(JSON.stringify({ t: "newSession" }));
		},
	};

	function atBottom(): boolean {
		return container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
	}

	function render(item: ChatItem): void {
		const stick = atBottom();
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
			}
		};
		ws.onclose = () => {
			ws = undefined;
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 8000);
		};
		ws.onerror = () => ws?.close();
	}

	connect();
	return api;
}
