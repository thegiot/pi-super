import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
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
	/** where the meta agent's pi sessions live; enables resume across pi-super restarts */
	sessionDir?: string;
}

/** Prefix for prompts pi-super injects itself, so rehydration can hide them later. */
const INTERNAL_PROMPT = "[pi-super]";

const RESUME_NUDGE = `${INTERNAL_PROMPT} The pi-super server restarted and resumed your session. If you had unfinished business — a report you promised, an agent window you were waiting on — check those windows now, re-establish the waits (tmux_wait_idle) and speak a short status update. If everything was already wrapped up, just reply briefly without speaking.`;

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
	/** the resume nudge is sent at most once per pi-super process */
	private nudged = false;

	constructor(private readonly opts: MetaOptions) {
		super();
	}

	get running(): boolean {
		return this.proc !== undefined && this.proc.exitCode === null;
	}

	get state(): { running: boolean; busy: boolean; model?: string } {
		return { running: this.running, busy: this.busy, model: this.opts.model };
	}

	/**
	 * Latest *valid* stored session, resolved by us and passed to pi as an explicit
	 * `--session <file>` — guessing what `pi -c` would pick invites the two to diverge
	 * (e.g. over an empty or truncated file that pi would skip).
	 */
	private latestSessionFile(): string | undefined {
		try {
			const dir = this.opts.sessionDir;
			if (!dir || !existsSync(dir)) return undefined;
			let best: { file: string; mtime: number } | undefined;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".jsonl")) continue;
				const file = join(dir, f);
				try {
					const mtime = statSync(file).mtimeMs;
					if (best && mtime <= best.mtime) continue;
					const header = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
					if ((JSON.parse(header) as { type?: string }).type !== "session") continue;
					best = { file, mtime };
				} catch {
					// unreadable/corrupt candidate: skip it rather than resume garbage
				}
			}
			return best?.file;
		} catch {
			return undefined;
		}
	}

	get hasPreviousSession(): boolean {
		return this.latestSessionFile() !== undefined;
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
		// Persist sessions in our own dir so a pi-super restart resumes the conversation
		// (and its promised follow-ups) instead of starting from amnesia.
		let resuming = false;
		if (this.opts.sessionDir) {
			mkdirSync(this.opts.sessionDir, { recursive: true });
			args.push("--session-dir", this.opts.sessionDir);
			const prev = this.latestSessionFile();
			if (prev) {
				args.push("--session", prev);
				resuming = true;
				if (this.transcript.length === 0) this.rehydrate(prev);
			}
		}

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
		this.push({ kind: "system", id: 0, text: resuming ? "meta agent resumed previous session" : "meta agent started" });
		if (resuming && !this.nudged) {
			this.nudged = true;
			this.turnPending = true;
			this.write({ type: "prompt", message: RESUME_NUDGE });
		}
	}

	/** Best-effort: rebuild the chat view from the session file we are about to resume. */
	private rehydrate(file: string): void {
		try {
			const items: ChatItem[] = [];
			for (const line of readFileSync(file, "utf8").split("\n")) {
				try {
					if (!line.trim()) continue;
					const ev = JSON.parse(line) as {
						type?: string;
						message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
					};
					if (ev.type !== "message") continue;
					const role = ev.message?.role;
					if (role !== "user" && role !== "assistant") continue;
					// message content is either a plain string or a parts array
					const content = ev.message?.content ?? [];
					const text = (
						typeof content === "string"
							? content
							: content
									.filter((c) => c.type === "text" && typeof c.text === "string")
									.map((c) => c.text)
									.join("\n")
					).trim();
					if (!text || text.startsWith(INTERNAL_PROMPT)) continue;
					if (role === "user") items.push({ kind: "user", id: ++this.nextId, text });
					else items.push({ kind: "assistant", id: ++this.nextId, text, done: true });
				} catch {
					// one malformed line must not cost the whole transcript
				}
			}
			this.transcript.push(...items.slice(-100));
		} catch {
			// rehydration is cosmetic; the resumed pi session holds the real context
		}
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
