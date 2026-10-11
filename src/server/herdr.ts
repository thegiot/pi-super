/**
 * Thin async wrapper around the herdr CLI.
 *
 * herdr is the fleet view: agents (pi, hermes, devin, codex, ...) live in herdr
 * panes, and `herdr --machine <label>` reaches the same API on saved SSH
 * machines. The meta agent talks to it through super-herdr.ts — which is loaded
 * as TypeScript source by pi (jiti), so this file must stay free of imports
 * from other src/server modules and of anything jiti cannot transpile.
 */

import { execFile } from "node:child_process";

export class HerdrError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly machine: string,
	) {
		super(message);
		this.name = "HerdrError";
	}
}

export interface HerdrOptions {
	bin?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** the pseudo-machine label for "the herdr on this host" (no --machine flag) */
export const LOCAL = "local";

export const PANE_ID = /^w[^:\s]+:p[^:\s]+$/;

function herdrBin(opts: HerdrOptions): string {
	return opts.bin ?? process.env.PI_SUPER_HERDR_BIN ?? process.env.HERDR_BIN_PATH ?? "herdr";
}

/**
 * Runs `herdr [--machine m] ...args` and resolves with stdout.
 *
 * herdr's exit-code contract: 1 = a real answer, stderr carrying
 * {"error":{"code","message"}}; 2 = CLI syntax error. Anything else (spawn
 * failure, non-JSON stderr, killed by timeout/abort) is normalized into a
 * HerdrError too so callers only ever see one error type.
 */
export function herdrRun(machine: string, args: string[], opts: HerdrOptions = {}): Promise<string> {
	const argv = machine === LOCAL ? args : ["--machine", machine, ...args];
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (fn: () => void): void => {
			if (done) return;
			done = true;
			cleanup();
			fn();
		};
		const child = execFile(
			herdrBin(opts),
			argv,
			{ maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			(err, stdout, stderr) => {
				if (!err) {
					finish(() => resolve(stdout));
					return;
				}
				if (typeof err.code === "number" && err.code === 1) {
					try {
						const body = JSON.parse(stderr) as { error?: { code?: unknown; message?: unknown } };
						if (typeof body.error?.code === "string") {
							const message = String(body.error.message ?? stderr).trim();
							finish(() => reject(new HerdrError(body.error!.code as string, message, machine)));
							return;
						}
					} catch {
						// exit 1 without the JSON envelope is still a failure, just unclassified
					}
				}
				const msg = String(stderr || err.message).trim();
				finish(() => reject(new HerdrError("cli_error", msg || `herdr exited ${String(err.code ?? err.signal)}`, machine)));
			},
		);
		const timeoutMs = opts.timeoutMs ?? 60_000;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new HerdrError("timeout", `herdr timed out after ${timeoutMs}ms`, machine)));
		}, timeoutMs);
		const onAbort = (): void => {
			child.kill("SIGKILL");
			finish(() => reject(new HerdrError("aborted", "aborted", machine)));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** herdrRun + JSON.parse; control commands wrap the payload as {id, result}. */
export async function herdrJson<T = unknown>(machine: string, args: string[], opts?: HerdrOptions): Promise<T> {
	const parsed = JSON.parse(await herdrRun(machine, args, opts)) as unknown;
	if (parsed && typeof parsed === "object" && "result" in parsed) return (parsed as { result: T }).result;
	return parsed as T;
}

/** enabled machine labels from the local `herdr machine list --json` */
export async function savedMachines(opts?: HerdrOptions): Promise<string[]> {
	const list = await herdrJson<Array<{ label?: unknown; enabled?: unknown }>>(LOCAL, ["machine", "list", "--json"], opts);
	return (list ?? []).filter((m) => m && m.enabled === true && typeof m.label === "string").map((m) => m.label as string);
}

export interface FleetAgent {
	machine: string;
	name?: string;
	kind: string;
	status: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
	workspace?: string;
	tab?: string;
	paneLabel?: string;
	cwd: string;
	title: string;
	focused: boolean;
	stateChangeSeq?: number;
}

// the order a human scans a fleet in: what needs a decision, then what is
// running, then finished work to report, then the idle pool
const STATUS_ORDER: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

/** pure: joins snapshot agents with workspace/tab/pane labels and sorts for scanning */
export function agentsFromSnapshot(machine: string, snapshot: unknown): FleetAgent[] {
	const snap = (snapshot ?? {}) as {
		agents?: Array<Record<string, unknown>>;
		workspaces?: Array<{ workspace_id?: string; label?: string }>;
		tabs?: Array<{ tab_id?: string; label?: string }>;
		panes?: Array<{ pane_id?: string; label?: string }>;
	};
	const labels = new Map<string, string>();
	for (const w of snap.workspaces ?? []) if (w.workspace_id && w.label) labels.set(`ws:${w.workspace_id}`, w.label);
	for (const t of snap.tabs ?? []) if (t.tab_id && t.label) labels.set(`tab:${t.tab_id}`, t.label);
	for (const p of snap.panes ?? []) if (p.pane_id && p.label) labels.set(`pane:${p.pane_id}`, p.label);
	const agents = (snap.agents ?? []).map((a): FleetAgent => {
		const agent: FleetAgent = {
			machine,
			kind: String(a.agent ?? "unknown"),
			status: String(a.agent_status ?? "unknown"),
			paneId: String(a.pane_id ?? ""),
			tabId: String(a.tab_id ?? ""),
			workspaceId: String(a.workspace_id ?? ""),
			cwd: String(a.cwd ?? ""),
			title: String(a.terminal_title_stripped ?? a.terminal_title ?? a.title ?? ""),
			focused: a.focused === true,
		};
		if (typeof a.name === "string" && a.name) agent.name = a.name;
		const workspace = labels.get(`ws:${agent.workspaceId}`);
		if (workspace) agent.workspace = workspace;
		const tab = labels.get(`tab:${agent.tabId}`);
		if (tab) agent.tab = tab;
		const pane = labels.get(`pane:${agent.paneId}`);
		if (pane) agent.paneLabel = pane;
		if (typeof a.state_change_seq === "number") agent.stateChangeSeq = a.state_change_seq;
		return agent;
	});
	agents.sort((x, y) => {
		const byStatus = (STATUS_ORDER[x.status] ?? STATUS_ORDER.unknown!) - (STATUS_ORDER[y.status] ?? STATUS_ORDER.unknown!);
		if (byStatus !== 0) return byStatus;
		return (x.workspace ?? "").localeCompare(y.workspace ?? "") || (x.tab ?? "").localeCompare(y.tab ?? "");
	});
	return agents;
}

export interface MachineAgents {
	machine: string;
	ok: boolean;
	error?: string;
	agents: FleetAgent[];
}

/**
 * `api snapshot` on every machine in parallel with a per-machine timeout
 * (remote machines go over ssh, and an unreachable one must not stall the whole
 * fleet listing). A failing machine degrades to ok:false, never a rejection.
 */
export async function fleetAgents(machines: string[], opts: HerdrOptions = {}): Promise<MachineAgents[]> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	return Promise.all(
		machines.map(async (machine): Promise<MachineAgents> => {
			try {
				const res = await herdrJson<{ snapshot?: unknown }>(machine, ["api", "snapshot"], { ...opts, timeoutMs });
				return { machine, ok: true, agents: agentsFromSnapshot(machine, res?.snapshot) };
			} catch (err) {
				return { machine, ok: false, error: String((err as Error)?.message ?? err), agents: [] };
			}
		}),
	);
}
