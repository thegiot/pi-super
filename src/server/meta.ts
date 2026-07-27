import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface MetaOptions {
	/** directory holding super-meta.ts + meta-prompt.md */
	metaDir: string;
	socketArgs: string[];
	model?: string;
	cwd?: string;
	piBin?: string;
	/** load the user's globally configured extensions/packages too (default: no) */
	inheritExtensions?: boolean;
}

export type ChatItem =
	| { kind: "user"; id: number; text: string }
	| { kind: "assistant"; id: number; text: string; done: boolean }
	| { kind: "tool"; id: number; name: string; args: unknown; result?: string; error?: boolean }
	| { kind: "speak"; id: number; text: string; speech: "ack" | "status" | "final" }
	| { kind: "system"; id: number; text: string };

/**
 * The meta agent: a `pi --mode rpc` child owned by pi-super.
 *
 * RPC (not a tmux window) because the phone chat view and the voice plane both need
 * structured turn/tool events, and because scraping a TUI of the agent that scrapes
 * TUIs is a bad joke. Its *work* is still fully visible in tmux — that is where it acts.
 */
export class MetaAgent extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | undefined;
	private buf = "";
	private seq = 0;
	private nextId = 1;
	private assistant: ChatItem | undefined;
	/** tool_execution_end carries no args, so keep them from the start event */
	private readonly pendingTools = new Map<string, { item: ChatItem; args: unknown }>();
	private patchTimer: ReturnType<typeof setTimeout> | undefined;
	readonly transcript: ChatItem[] = [];
	busy = false;
	/** a prompt was sent but agent_start has not arrived yet */
	private turnPending = false;

	constructor(private readonly opts: MetaOptions) {
		super();
	}

	get running(): boolean {
		return this.proc !== undefined && this.proc.exitCode === null;
	}

	get state(): { running: boolean; busy: boolean; model?: string } {
		return { running: this.running, busy: this.busy, model: this.opts.model };
	}

	start(): void {
		if (this.running) return;
		// pi runs with cwd=$HOME, so these must be absolute.
		const dir = resolve(this.opts.metaDir);
		const ext = join(dir, "super-meta.ts");
		const prompt = join(dir, "meta-prompt.md");
		if (!existsSync(ext)) throw new Error(`meta extension missing: ${ext}`);
		// -ne keeps the meta agent predictable: only our tools, none of the user's
		// globally installed packages (status widgets, side-agents, mood tags, ...).
		const args = ["--mode", "rpc", "-n", "pi-super meta", "-e", ext];
		if (!this.opts.inheritExtensions) args.push("-ne");
		if (existsSync(prompt)) args.push("--append-system-prompt", prompt);
		if (this.opts.model) args.push("--model", this.opts.model);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_SUPER: "1",
			PI_SUPER_TMUX_SOCKET: this.opts.socketArgs.join(" "),
		};
		delete env.TMUX;
		delete env.TMUX_PANE;

		const proc = spawn(this.opts.piBin ?? "pi", args, {
			cwd: this.opts.cwd ?? homedir(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		this.buf = "";
		this.busy = false;

		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => this.emit("log", chunk));
		proc.on("exit", (code, signal) => {
			// only react if this is still *our* child (a restart may have replaced it)
			if (this.proc !== proc) return;
			this.proc = undefined;
			this.resetTurnState();
			this.push({ kind: "system", id: 0, text: `meta agent exited (${code ?? signal})` });
			this.emit("exit", { code, signal });
		});
		proc.on("error", (err) => {
			if (this.proc !== proc) return;
			this.proc = undefined;
			this.resetTurnState();
			this.push({ kind: "system", id: 0, text: `meta agent failed to start: ${err.message}` });
			this.emit("exit", { code: -1 });
		});
		proc.stdin.on("error", (err) => this.emit("log", `meta stdin: ${err.message}\n`));
		this.push({ kind: "system", id: 0, text: "meta agent started" });
	}

	private resetTurnState(): void {
		this.busy = false;
		this.assistant = undefined;
		this.pendingTools.clear();
		this.emit("state", this.state);
	}

	/** SIGTERM, then SIGKILL if it does not go away; resolves once the child is gone. */
	async stop(): Promise<void> {
		const proc = this.proc;
		this.proc = undefined;
		this.resetTurnState();
		if (!proc || proc.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 2000);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			proc.kill("SIGTERM");
		});
	}

	/** RPC framing is strict JSONL: split on \n only. */
	private onStdout(chunk: string): void {
		this.buf += chunk;
		let idx = this.buf.indexOf("\n");
		while (idx >= 0) {
			const line = this.buf.slice(0, idx).replace(/\r$/, "");
			this.buf = this.buf.slice(idx + 1);
			if (line.trim()) {
				try {
					this.onEvent(JSON.parse(line) as Record<string, unknown>);
				} catch {
					this.emit("log", `unparsable rpc line: ${line.slice(0, 200)}`);
				}
			}
			idx = this.buf.indexOf("\n");
		}
	}

	/** Assign an id in place (callers keep the reference and patch it later). */
	private push(item: ChatItem): ChatItem {
		if (!item.id) item.id = ++this.nextId;
		this.transcript.push(item);
		if (this.transcript.length > 500) this.transcript.splice(0, this.transcript.length - 500);
		this.emit("item", item);
		return item;
	}

	/** Streaming text: coalesce patches so a fast stream can't flood slow clients. */
	private patch(item: ChatItem, throttle = false): void {
		if (!throttle) {
			if (this.patchTimer) {
				clearTimeout(this.patchTimer);
				this.patchTimer = undefined;
			}
			this.emit("item", item);
			return;
		}
		if (this.patchTimer) return;
		this.patchTimer = setTimeout(() => {
			this.patchTimer = undefined;
			this.emit("item", item);
		}, 100);
	}

	private onEvent(ev: Record<string, unknown>): void {
		this.emit("event", ev);
		switch (ev.type) {
			case "agent_start":
				this.busy = true;
				this.emit("state", this.state);
				break;
			case "agent_settled":
				this.busy = false;
				this.turnPending = false;
				if (this.assistant && this.assistant.kind === "assistant") {
					this.assistant.done = true;
					this.patch(this.assistant);
				}
				this.assistant = undefined;
				this.emit("state", this.state);
				break;
			case "message_update": {
				const delta = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (delta?.type !== "text_delta" || !delta.delta) break;
				if (!this.assistant || this.assistant.kind !== "assistant" || this.assistant.done) {
					this.assistant = { kind: "assistant", id: ++this.nextId, text: "", done: false };
					this.transcript.push(this.assistant);
				}
				this.assistant.text += delta.delta;
				this.patch(this.assistant, true);
				break;
			}
			case "tool_execution_start": {
				const item: ChatItem = { kind: "tool", id: 0, name: String(ev.toolName), args: ev.args };
				this.push(item);
				this.pendingTools.set(String(ev.toolCallId), { item, args: ev.args });
				break;
			}
			case "tool_execution_end": {
				const name = String(ev.toolName);
				const pending = this.pendingTools.get(String(ev.toolCallId));
				this.pendingTools.delete(String(ev.toolCallId));
				const result = ev.result as { content?: Array<{ type: string; text?: string }> } | undefined;
				const out = (result?.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n");
				const item = pending?.item;
				if (item && item.kind === "tool") {
					item.result = out.length > 400 ? `${out.slice(0, 400)}…` : out;
					item.error = ev.isError === true;
					this.patch(item);
				}
				if (name === "speak" && ev.isError !== true) {
					const args = (pending?.args ?? {}) as { message?: string; kind?: string };
					const speech = (args.kind === "ack" || args.kind === "final" ? args.kind : "status") as
						| "ack"
						| "status"
						| "final";
					if (args.message) {
						this.push({ kind: "speak", id: 0, text: args.message, speech });
						this.emit("speak", { message: args.message, kind: speech });
					}
				}
				break;
			}
		}
	}

	private write(cmd: Record<string, unknown>): void {
		if (!this.proc) throw new Error("meta agent is not running");
		this.proc.stdin.write(`${JSON.stringify({ id: `s${++this.seq}`, ...cmd })}\n`);
	}

	/** Send a user turn. While busy we steer, so voice/chat input is never dropped. */
	prompt(message: string, images?: Array<{ data: string; mimeType: string }>): void {
		if (!this.running) this.start();
		this.push({ kind: "user", id: 0, text: message });
		const cmd: Record<string, unknown> = { type: "prompt", message };
		if (images?.length) cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
		// Always steer: agent_start may not have arrived yet for a turn that is already
		// under way, and a rejected prompt would be silently lost.
		if (this.busy || this.turnPending) cmd.streamingBehavior = "steer";
		this.turnPending = true;
		this.write(cmd);
	}

	abort(): void {
		if (this.running) this.write({ type: "abort" });
	}

	newSession(): void {
		if (!this.running) {
			this.start();
			return;
		}
		this.transcript.length = 0;
		this.resetTurnState();
		this.turnPending = false;
		this.write({ type: "new_session" });
	}
}
