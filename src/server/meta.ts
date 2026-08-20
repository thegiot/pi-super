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
	/** stall-watchdog tuning; defaults are the production values (tests drive it fast) */
	stallMs?: number;
	compactionStallMs?: number;
	watchdogMs?: number;
}

/** Prefix for prompts pi-super injects itself, so rehydration can hide them later. */
const INTERNAL_PROMPT = "[pi-super]";

/**
 * How long a turn may produce *no RPC event at all* before we call it wedged.
 *
 * This is silence, not slowness: a thinking model streams deltas, and a long tool
 * (tmux_wait_idle runs for minutes by design) is excluded because its
 * tool_execution_start is still outstanding. What it catches is the real failure seen
 * in the field — the provider stream stops delivering while the socket stays open on
 * keepalives, so pi waits forever and every prompt after it queues behind a turn that
 * will never end. Voice makes this maximally confusing: super says "checking" and then
 * simply never speaks again.
 */
const STALL_MS = 180_000;
/**
 * The same question for compaction, which is silent by construction (one blocking
 * summarization call). It gets a much longer rope than a normal turn — but a rope, not an
 * exemption: the summarization provider can wedge exactly like any other, and an unbounded
 * pass would switch the watchdog off for good on the one agent that cannot be nudged.
 */
const COMPACTION_STALL_MS = 600_000;
/** how often the watchdog looks */
const WATCHDOG_MS = 30_000;
/** never rescue more often than this — a provider outage must not become a restart loop */
const RESCUE_COOLDOWN_MS = 600_000;

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
	/** last RPC event of any kind, for the stall watchdog */
	private lastEventAt = 0;
	private watchdog: ReturnType<typeof setInterval> | undefined;
	private lastRescueAt = 0;
	/** bumped by every stop(); a rescue in flight uses it to notice it was overtaken */
	private stopGen = 0;
	/** the user turn in flight, so a rescue can ask it again instead of losing it */
	private lastPrompt: string | undefined;
	/** when pi started summarizing the conversation, 0 if it is not; see checkStall() */
	private compactingSince = 0;
	/** next start() must not resume: the user asked for a clean slate */
	private freshStart = false;

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

	/**
	 * How much conversation this agent is already carrying. A voice call is a brand-new
	 * realtime session every time it is dialled, so this is what tells it whether it is
	 * joining a conversation in progress (and had better ask super for a recap) or
	 * starting one.
	 */
	get conversationTurns(): number {
		return this.transcript.filter((i) => i.kind === "user" || i.kind === "assistant").length;
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
			const prev = this.freshStart ? undefined : this.latestSessionFile();
			this.freshStart = false;
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
		// A child we have already given up on can still have bytes in flight. Its events
		// describe a session we no longer run, and applying them (a stray compaction_start,
		// say) leaves the *new* child's state machine holding a flag nobody will ever clear.
		proc.stdout.on("data", (chunk: string) => {
			if (this.proc === proc) this.onStdout(chunk);
		});
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
		this.lastEventAt = Date.now();
		if (!this.watchdog) {
			this.watchdog = setInterval(() => void this.checkStall(), this.opts.watchdogMs ?? WATCHDOG_MS);
			this.watchdog.unref?.();
		}
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
		// A dead or restarted child has no turn in flight. Leaving these set made an idle
		// agent look permanently mid-turn, which the stall watchdog would then "rescue"
		// once per cooldown, forever.
		this.turnPending = false;
		this.lastPrompt = undefined;
		this.assistant = undefined;
		this.compactingSince = 0;
		this.pendingTools.clear();
		this.emit("state", this.state);
	}

	/**
	 * A turn that has gone completely silent is not coming back on its own: pi is blocked
	 * on a provider stream that stopped delivering, and everything the user has said since
	 * is queued behind it. Restart the child (it resumes the same session file, so no
	 * memory is lost), re-ask the question, and say so out loud — silence is the one
	 * response voice mode cannot explain.
	 */
	private async checkStall(): Promise<void> {
		if (!this.running) return;
		if (!this.busy && !this.turnPending) return;
		// a tool is legitimately allowed to take a very long time (tmux_wait_idle)
		if (this.pendingTools.size > 0) return;
		// Compaction is a single blocking LLM call that emits nothing between its start and
		// end events, so on a full context it looks exactly like a dead provider stream.
		// Killing pi here would be self-defeating: the resumed child hits the same threshold
		// and compacts again, only now from a cold start. Past COMPACTION_STALL_MS, though,
		// it is not compacting slowly, it is stuck, and a stuck compaction wedges every turn
		// after it just as thoroughly.
		const compacting = this.compactingSince > 0;
		if (compacting && Date.now() - this.compactingSince < (this.opts.compactionStallMs ?? COMPACTION_STALL_MS)) return;
		const silent = Date.now() - this.lastEventAt;
		if (silent < (this.opts.stallMs ?? STALL_MS)) return;
		const mins = Math.round(silent / 60_000);
		if (Date.now() - this.lastRescueAt < RESCUE_COOLDOWN_MS) {
			this.push({ kind: "system", id: 0, text: `meta agent still stalled (${mins}m, rescued recently)` });
			this.lastEventAt = Date.now(); // don't re-report every 30s
			return;
		}
		this.lastRescueAt = Date.now();
		const lost = this.lastPrompt;
		this.push({
			kind: "system",
			id: 0,
			text: compacting
				? `compaction has not finished in ${mins}m — restarting the meta agent`
				: `meta agent silent for ${mins}m mid-turn — restarting it`,
		});
		this.emit("speak", {
			message: lost
				? "That request got stuck, so I restarted myself and I'm picking it up again."
				: "I got stuck and restarted myself. Say that again?",
			kind: "status",
		});
		const gen = this.stopGen;
		await this.stop();
		// Someone stopped us while we were waiting for the old child to die (server shutting
		// down, an explicit stop from the UI, a test tearing down). Restarting now would
		// resurrect an agent that was deliberately put down, and nothing would ever reap it.
		if (this.stopGen !== gen + 1) return;
		// the recovery prompt below *is* the resume nudge for this restart; two prompts into
		// a fresh child would race (the second would need steering that may be rejected)
		this.nudged = true;
		this.start();
		// Not a replay: the killed turn may have already sent a prompt to an agent window or
		// opened one, and those side effects are in the resumed session for the model to see.
		// Asking it to *finish* the request — after checking what it already did — is the only
		// version that cannot double-send.
		if (lost) {
			this.write({
				type: "prompt",
				message: `${INTERNAL_PROMPT} Your last turn hung and I had to restart you mid-request. It was: "${lost}". Check first what that turn already did (its tool calls are above; look at the windows it touched) and do NOT repeat anything that already happened — then finish the job and speak the answer.`,
			});
			this.turnPending = true;
			// keep it as the outstanding request: if the recovery turn hangs too, the next
			// rescue must still know what the user actually asked for
			this.lastPrompt = lost;
			this.lastEventAt = Date.now();
		}
	}

	/** SIGTERM, then SIGKILL if it does not go away; resolves once the child is gone. */
	async stop(): Promise<void> {
		this.stopGen++;
		const proc = this.proc;
		this.proc = undefined;
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = undefined;
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
		this.trim();
		this.emit("item", item);
		return item;
	}

	/**
	 * Keep the transcript bounded by dropping tool chatter first. A plain "keep the last
	 * 500" let a single tool-heavy turn push the user's own messages out of the chat — and
	 * those are the one part of it that exists nowhere else on screen.
	 */
	private trim(): void {
		let excess = this.transcript.length - 500;
		if (excess <= 0) return;
		for (let i = 0; i < this.transcript.length && excess > 0; ) {
			if (this.transcript[i]?.kind === "tool") {
				this.transcript.splice(i, 1);
				excess--;
			} else i++;
		}
		if (excess > 0) this.transcript.splice(0, excess);
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
		this.lastEventAt = Date.now();
		switch (ev.type) {
			// Transient-failure handling used to be invisible: a turn stuck in backoff looked
			// exactly like a turn thinking hard. Surface it — the chat shows it, and the server
			// logs every system item to the journal.
			case "auto_retry_start":
				this.push({
					kind: "system",
					id: 0,
					text: `provider error, retrying (attempt ${String(ev.attempt ?? "?")}): ${String(ev.errorMessage ?? "").slice(0, 200)}`,
				});
				break;
			case "auto_retry_end":
				if (ev.finalError) this.push({ kind: "system", id: 0, text: `retries gave up: ${String(ev.finalError).slice(0, 200)}` });
				break;
			// Compaction can hold a turn for a minute with nothing on the wire. Unannounced,
			// that is indistinguishable from the agent having died — and in voice mode it is
			// pure silence. Say it out loud in the chat, and let the watchdog know.
			case "compaction_start":
				this.compactingSince = Date.now();
				this.push({ kind: "system", id: 0, text: `compacting context (${String(ev.reason ?? "threshold")})…` });
				break;
			case "compaction_end": {
				this.compactingSince = 0;
				const result = ev.result as { tokensBefore?: number; estimatedTokensAfter?: number } | null | undefined;
				const k = (n: unknown) => (typeof n === "number" ? `${Math.round(n / 1000)}k` : "?");
				if (ev.aborted) this.push({ kind: "system", id: 0, text: "compaction aborted" });
				else if (!result)
					this.push({ kind: "system", id: 0, text: `compaction failed: ${String(ev.errorMessage ?? "unknown").slice(0, 200)}` });
				else
					this.push({
						kind: "system",
						id: 0,
						text: `context compacted: ${k(result.tokensBefore)} → ${k(result.estimatedTokensAfter)} tokens`,
					});
				break;
			}
			case "extension_error":
				this.push({ kind: "system", id: 0, text: `extension error: ${String(ev.error ?? "").slice(0, 200)}` });
				break;
			case "agent_start":
				this.busy = true;
				this.emit("state", this.state);
				break;
			case "agent_settled":
				this.busy = false;
				this.turnPending = false;
				this.lastPrompt = undefined;
				// whatever the user asked has now been answered; the prompt log can let it go
				this.emit("settled");
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
				if (name === "client_show" && ev.isError !== true) {
					const args = (pending?.args ?? {}) as { window?: string; view?: string };
					// A browser only accepts real tmux window ids. Silently dropping malformed model
					// output is safer than turning it into tmux's broad target syntax.
					if (args.window && /^@\d+$/.test(args.window)) {
						this.emit("clientControl", {
							action: "showWindow",
							window: args.window,
							view: args.view === "reader" ? "reader" : "raw",
						});
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
		this.lastPrompt = message;
		this.lastEventAt = Date.now();
		this.write(cmd);
	}

	/** Put a note in the chat (and thus the journal) without prompting the agent. */
	note(text: string): void {
		this.push({ kind: "system", id: 0, text });
	}

	abort(): void {
		if (this.running) this.write({ type: "abort" });
	}

	/**
	 * Forget the conversation. On a dead child this cannot just start(): that resumes the
	 * newest session file, i.e. hands back the very context the user asked to be rid of.
	 */
	newSession(): void {
		this.transcript.length = 0;
		this.resetTurnState();
		if (!this.running) {
			this.freshStart = true;
			this.start();
			return;
		}
		this.write({ type: "new_session" });
	}
}
