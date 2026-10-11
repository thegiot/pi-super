/**
 * The fleet monitor: a slow background poller that keeps a cached picture of
 * every herdr agent on every configured machine, so the phone's Agents page and
 * (later) super's wake-on-transition never wait on ssh.
 *
 * Status changes are also journalled to fleet-transitions.jsonl — that log is
 * both the audit trail ("when did rev-412 get blocked?") and how `since`
 * survives a pi-super restart.
 */

import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { type FleetAgent, LOCAL, type MachineAgents, PANE_ID, fleetAgents } from "./herdr.js";

export interface FleetTransition {
	ts: number;
	machine: string;
	pane: string;
	name?: string;
	kind: string;
	from: string | null;
	to: string;
	title: string;
	cwd: string;
}

export interface FleetAgentView extends FleetAgent {
	since: number;
	sinceApprox?: boolean;
}

export interface FleetMachineView {
	machine: string;
	ok: boolean;
	error?: string;
	updatedAt: number;
	agents: FleetAgentView[];
}

export interface FleetMonitorOptions {
	machines: string[];
	stateDir: string;
	herdrBin?: string;
	/** test seam: replaces the herdr call */
	fetch?: (machines: string[]) => Promise<MachineAgents[]>;
	/** test seam: fake clock for ts/since/updatedAt */
	now?: () => number;
	localPollMs?: number;
	remotePollMs?: number;
	/** fleet-transitions.jsonl rotates to .1 past this size */
	rotateBytes?: number;
}

interface MachineState {
	ok: boolean;
	error?: string;
	updatedAt: number;
	agents: FleetAgent[];
}

interface Seen {
	status: string;
	since: number;
	sinceApprox: boolean;
}

const keyOf = (machine: string, paneId: string): string => `${machine}|${paneId}`;

export class FleetMonitor extends EventEmitter {
	readonly machines: readonly string[];
	private readonly fetch: (machines: string[]) => Promise<MachineAgents[]>;
	private readonly now: () => number;
	private readonly localPollMs: number;
	private readonly remotePollMs: number;
	private readonly rotateBytes: number;
	private readonly file: string;
	private readonly state = new Map<string, MachineState>();
	private readonly seen = new Map<string, Seen>();
	/** last transition per agent key, recovered from the log at construction */
	private readonly restored = new Map<string, { to: string; ts: number }>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private stopped = true;

	constructor(private readonly opts: FleetMonitorOptions) {
		super();
		this.machines = opts.machines;
		this.fetch = opts.fetch ?? ((ms) => fleetAgents(ms, { bin: opts.herdrBin }));
		this.now = opts.now ?? (() => Date.now());
		this.localPollMs = opts.localPollMs ?? 3000;
		this.remotePollMs = opts.remotePollMs ?? 15_000;
		this.rotateBytes = opts.rotateBytes ?? 5 * 1024 * 1024;
		mkdirSync(opts.stateDir, { recursive: true });
		this.file = join(opts.stateDir, "fleet-transitions.jsonl");
		for (const machine of this.machines) {
			this.state.set(machine, { ok: false, updatedAt: 0, agents: [] });
		}
		this.restoreLog();
	}

	/**
	 * The newest recorded `to` per agent key is what a restarted monitor can carry
	 * over: an agent first observed in the same status the log last recorded was
	 * (as far as we know) already in it — so `since` is the log's ts, not now.
	 */
	private restoreLog(): void {
		try {
			if (!existsSync(this.file)) return;
			const lines = readFileSync(this.file, "utf8").split("\n").slice(-2000);
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const t = JSON.parse(line) as FleetTransition;
					this.restored.set(keyOf(t.machine, t.pane), { to: t.to, ts: t.ts });
				} catch {
					// one corrupt line must not blind the whole log
				}
			}
		} catch {
			// an unreadable log degrades to sinceApprox timestamps, never a failed boot
		}
	}

	private record(t: FleetTransition): void {
		try {
			if (existsSync(this.file) && statSync(this.file).size > this.rotateBytes) {
				renameSync(this.file, `${this.file}.1`);
			}
			appendFileSync(this.file, `${JSON.stringify(t)}\n`);
		} catch {
			// the journal is an audit trail, not a lock on the monitor itself
		}
		this.emit("transition", t);
	}

	private transition(machine: string, agent: FleetAgent, from: string | null, to: string): void {
		const t: FleetTransition = {
			ts: this.now(),
			machine,
			pane: agent.paneId,
			kind: agent.kind,
			from,
			to,
			title: agent.title,
			cwd: agent.cwd,
		};
		if (agent.name) t.name = agent.name;
		this.record(t);
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		for (const machine of this.machines) {
			void this.poll(machine, machine === LOCAL ? this.localPollMs : this.remotePollMs);
		}
	}

	stop(): void {
		this.stopped = true;
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
	}

	/** One machine, one chain: the next poll is scheduled only after this one ends. */
	private async poll(machine: string, intervalMs: number): Promise<void> {
		try {
			const res = await this.fetch([machine]);
			if (this.stopped) return;
			const m = res.find((x) => x.machine === machine) ?? res[0];
			if (m) this.apply(machine, m);
		} catch (err) {
			if (!this.stopped) this.markDown(machine, err);
		} finally {
			if (!this.stopped) this.timers.set(machine, setTimeout(() => void this.poll(machine, intervalMs), intervalMs));
		}
	}

	/** An unreachable machine keeps its last known agents — "stale" beats "gone". */
	private markDown(machine: string, err: unknown): void {
		const st = this.state.get(machine);
		if (!st) return;
		st.ok = false;
		st.error = String((err as Error)?.message ?? err);
		st.updatedAt = this.now();
	}

	private apply(machine: string, m: MachineAgents): void {
		const st = this.state.get(machine);
		if (!st) return;
		st.updatedAt = this.now();
		if (!m.ok) {
			st.ok = false;
			st.error = m.error;
			return;
		}
		st.ok = true;
		delete st.error;
		const prevPanes = new Set(st.agents.map((a) => a.paneId));
		for (const agent of m.agents) {
			const key = keyOf(machine, agent.paneId);
			const seen = this.seen.get(key);
			if (!seen) {
				const rec = this.restored.get(key);
				this.seen.set(key, {
					status: agent.status,
					since: rec && rec.to === agent.status ? rec.ts : this.now(),
					sinceApprox: !(rec && rec.to === agent.status),
				});
				this.transition(machine, agent, null, agent.status);
			} else if (seen.status !== agent.status) {
				const from = seen.status;
				seen.status = agent.status;
				seen.since = this.now();
				seen.sinceApprox = false;
				this.transition(machine, agent, from, agent.status);
			}
			prevPanes.delete(agent.paneId);
		}
		for (const paneId of prevPanes) {
			const gone = st.agents.find((a) => a.paneId === paneId);
			if (gone) this.transition(machine, gone, gone.status, "gone");
			this.seen.delete(keyOf(machine, paneId));
		}
		st.agents = m.agents;
	}

	snapshot(): { machines: FleetMachineView[] } {
		return {
			machines: this.machines.map((machine) => {
				const st = this.state.get(machine)!;
				return {
					machine,
					ok: st.ok,
					...(st.error ? { error: st.error } : {}),
					updatedAt: st.updatedAt,
					agents: st.agents.map((a) => {
						const seen = this.seen.get(keyOf(machine, a.paneId));
						return {
							...a,
							since: seen?.since ?? this.now(),
							...(seen?.sinceApprox ? { sinceApprox: true } : {}),
						};
					}),
				};
			}),
		};
	}
}

export const FLEET_KEYS = ["esc", "enter", "tab", "up", "down", "left", "right", "ctrl+c", "y", "n"] as const;
export const FLEET_MAX_TEXT = 64 * 1024;

export type FleetRequest =
	| { ok: true; machine: string; target: string; text?: string; keys?: string[]; lines?: number }
	| { ok: false; status: number; error: string };

/**
 * The /api/fleet/* argument check, kept pure so it is unit-testable and the
 * routes stay a three-liner each. UI targets are always pane ids — herdr's
 * looser agent-name targets are deliberately not accepted here.
 */
export function validateFleetRequest(
	machines: readonly string[],
	kind: "read" | "prompt" | "keys",
	fields: { machine?: unknown; target?: unknown; text?: unknown; keys?: unknown; lines?: unknown },
): FleetRequest {
	const machine = typeof fields.machine === "string" ? fields.machine.trim() : "";
	if (!machines.includes(machine)) return { ok: false, status: 400, error: `unknown machine: ${machine || "(missing)"}` };
	const target = typeof fields.target === "string" ? fields.target.trim() : "";
	if (!PANE_ID.test(target)) return { ok: false, status: 400, error: "target must be a pane id (wNN:pNN)" };
	const out: { ok: true; machine: string; target: string; text?: string; keys?: string[]; lines?: number } = {
		ok: true,
		machine,
		target,
	};
	if (kind === "read") {
		const n = Number(fields.lines ?? 400);
		out.lines = Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), 5000) : 400;
	}
	if (kind === "prompt") {
		if (typeof fields.text !== "string" || !fields.text.trim()) {
			return { ok: false, status: 400, error: "text required" };
		}
		if (fields.text.length > FLEET_MAX_TEXT) return { ok: false, status: 400, error: "text too large" };
		out.text = fields.text;
	}
	if (kind === "keys") {
		const keys = fields.keys;
		if (!Array.isArray(keys) || keys.length === 0 || keys.some((k) => typeof k !== "string" || !(FLEET_KEYS as readonly string[]).includes(k))) {
			return { ok: false, status: 400, error: `keys must be from: ${FLEET_KEYS.join(" ")}` };
		}
		out.keys = keys as string[];
	}
	return out;
}
