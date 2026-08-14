import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/** Keep the tail after a rotation this far back: enough to still see what was pending. */
const MAX_BYTES = 4 * 1024 * 1024;
/** Nothing older than this is worth replaying — it is history, not a lost request. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PromptRecord {
	id: string;
	at: number;
	source: string;
	text: string;
}

type Line = { id: string; at?: number; source?: string; text?: string; done?: boolean };

/**
 * Every user prompt, on disk, before the meta agent ever sees it.
 *
 * Motivation is a real loss: a turn wedged, the watchdog restarted the agent, and the
 * batch of feedback the user had just dictated was gone — the journal only carried what
 * super *said*, never what it was told. The agent's own session file is no help either,
 * because a prompt that never made it into a completed turn may not be in it.
 *
 * So this is deliberately dumb and independent of the agent: append-only JSONL, fsynced
 * before the prompt is handed on, with a second `done` line once a turn settles. Whatever
 * has no `done` line is what a restart still owes the user.
 */
export class PromptLog {
	readonly file: string;
	private seq = 0;

	constructor(stateDir: string) {
		mkdirSync(stateDir, { recursive: true });
		this.file = join(stateDir, "prompts.jsonl");
	}

	/**
	 * Persist a prompt and return its id. Durability is the whole point, so this fsyncs
	 * and runs *before* the prompt is handed to the agent: a crash between the two costs
	 * a duplicate at worst, the other order costs the prompt itself.
	 */
	record(text: string, source: string, extra?: Record<string, unknown>): string {
		const at = Date.now();
		const id = `${at.toString(36)}-${(++this.seq).toString(36)}`;
		this.append({ id, at, source, text, ...extra });
		return id;
	}

	/** The turn covering these prompts finished; they are no longer owed. */
	answered(ids: string[]): void {
		for (const id of ids) this.append({ id, at: Date.now(), done: true });
	}

	/**
	 * Prompts with no `done` line, oldest first — i.e. what a turn that died mid-flight
	 * swallowed. Ancient ones are dropped: an agent that was killed a week ago is not
	 * going to answer that question now, and a growing pile of them would bury the one
	 * that actually matters.
	 */
	unanswered(now = Date.now()): PromptRecord[] {
		const pending = new Map<string, PromptRecord>();
		for (const line of this.read()) {
			if (line.done) pending.delete(line.id);
			else if (typeof line.text === "string") {
				if (now - (line.at ?? 0) > STALE_MS) continue;
				pending.set(line.id, { id: line.id, at: line.at ?? 0, source: line.source ?? "?", text: line.text });
			}
		}
		return [...pending.values()].sort((a, b) => a.at - b.at);
	}

	private read(): Line[] {
		const out: Line[] = [];
		for (const file of [`${this.file}.1`, this.file]) {
			if (!existsSync(file)) continue;
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line) as Line;
					if (typeof parsed.id === "string") out.push(parsed);
				} catch {
					// a torn line (killed mid-write) must not hide the prompts around it
				}
			}
		}
		return out;
	}

	private append(line: Line & Record<string, unknown>): void {
		try {
			this.rotate();
			// A line torn by a kill mid-write would otherwise swallow the *next* prompt too,
			// by fusing with it into one unparsable line. Cost of the guard: one stat.
			const torn = this.endsMidLine();
			const fd = openSync(this.file, "a");
			try {
				writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(line)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch {
			// The log is a safety net, not a gate: a full or read-only state dir must not
			// stop the user from talking to the agent.
		}
	}

	/** Did the previous write not finish? Reads the last byte, not the file. */
	private endsMidLine(): boolean {
		if (!existsSync(this.file)) return false;
		const size = statSync(this.file).size;
		if (size === 0) return false;
		const fd = openSync(this.file, "r");
		try {
			const buf = Buffer.alloc(1);
			readSync(fd, buf, 0, 1, size - 1);
			return buf[0] !== 0x0a;
		} finally {
			closeSync(fd);
		}
	}

	private rotate(): void {
		try {
			if (!existsSync(this.file) || statSync(this.file).size < MAX_BYTES) return;
			renameSync(this.file, `${this.file}.1`);
		} catch {
			// keep appending to the oversized file rather than lose the write
		}
	}
}
