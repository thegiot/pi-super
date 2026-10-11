/**
 * Lane and coordinator plumbing: the parts of pi-manager-collaborator's
 * lane-bootstrap.sh super needs to own — one issue = one worktree = one herdr
 * tab with impl-<N>/rev-<N> panes, a JSON lane record as the only lane handle,
 * and coord-<slug> tabs running the collaborator skill or hermes.
 *
 * The fail-closed rules are ported intact: an existing record aborts create, a
 * reviewer never shares the implementer's model family by default, and IDs come
 * only out of herdr's JSON responses — never constructed.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HerdrError, LOCAL, herdrJson, herdrRun } from "./herdr.js";

// --------------------------------------------------------------------- models

export interface ModelChoice {
	provider: string;
	model: string;
	thinking?: string;
}

/** "provider/model[:thinking]" — providers are slash-free, so the first / splits. */
export function parseModel(spec: string): ModelChoice {
	const slash = spec.indexOf("/");
	if (slash < 0) throw new Error(`model must be provider/model[:thinking], got '${spec}'`);
	const provider = spec.slice(0, slash);
	let rest = spec.slice(slash + 1);
	let thinking: string | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon >= 0) {
		thinking = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
	}
	if (!provider || !rest) throw new Error(`model must be provider/model[:thinking], got '${spec}'`);
	return { provider, model: rest, ...(thinking ? { thinking } : {}) };
}

/**
 * The review-independence axis is the model family, not the provider: glm on two
 * different providers is still the same model reviewing its own kin. First
 * alphabetic token of the bare model id, lowercased.
 */
export function modelFamily(spec: string): string {
	const id = spec.includes("/") ? spec.slice(spec.indexOf("/") + 1) : spec;
	return (/^[a-z]+/i.exec(id)?.[0] ?? id).toLowerCase();
}

export function piModelArgs(c: ModelChoice): string[] {
	const args = ["--model", `${c.provider}/${c.model}`];
	if (c.thinking) args.push("--thinking", c.thinking);
	return args;
}

interface RoutingEntry {
	provider: string;
	model: string;
	thinking?: string;
	available?: boolean;
}

export interface Routing {
	classes: Record<string, RoutingEntry[]>;
	specialists: Record<string, RoutingEntry[]>;
}

export function loadRouting(file?: string): Routing {
	const path = file ?? process.env.GIOT_MODEL_ROUTING_FILE ?? join(homedir(), ".config", "giot", "model-routing.json");
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Routing>;
	return { classes: parsed.classes ?? {}, specialists: parsed.specialists ?? {} };
}

/**
 * First available entry of the named specialist (when the file has one), else of
 * the class — skipping entries whose family is excluded. Nothing qualifying is
 * an error, never a silent fallback onto pi's default model: a lane that opens
 * on the wrong model is a dispatch deviation nobody notices.
 */
export function resolveModel(
	routing: Routing,
	opts: { specialist?: string; cls: string; excludeFamily?: string },
): ModelChoice {
	const from = opts.specialist && routing.specialists[opts.specialist]?.length ? "specialist" : "class";
	const pool = from === "specialist" ? routing.specialists[opts.specialist!]! : (routing.classes[opts.cls] ?? []);
	for (const e of pool) {
		if (e.available !== true) continue;
		if (opts.excludeFamily && modelFamily(e.model) === opts.excludeFamily) continue;
		return { provider: e.provider, model: e.model, ...(e.thinking ? { thinking: e.thinking } : {}) };
	}
	const what = from === "specialist" ? `specialist '${opts.specialist}'` : `class '${opts.cls}'`;
	throw new Error(
		`no available model in ${what}${opts.excludeFamily ? ` (excluding family '${opts.excludeFamily}')` : ""}`,
	);
}

// ------------------------------------------------------------------ machine io

export function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function machineTarget(machine: string, opts: LaneEnv): Promise<string> {
	const list = await herdrJson<Array<{ label?: string; target?: string }>>(LOCAL, ["machine", "list", "--json"], {
		bin: opts.herdrBin,
	});
	const m = (list ?? []).find((x) => x.label === machine);
	if (!m?.target) throw new Error(`herdr machine '${machine}' has no ssh target`);
	return m.target;
}

function sh(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number; stdin?: string }): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = execFile(
			command,
			args,
			{ cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			(err, stdout, stderr) => {
				resolve({
					code: typeof err?.code === "number" ? err.code : err ? -1 : 0,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? err?.message ?? ""),
				});
			},
		);
		if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
	});
}

/**
 * Run a shell command where the lane lives: locally `bash -lc` in cwd, or over
 * ssh on a saved herdr machine. Never rejects on a nonzero exit — the code is
 * the answer.
 */
export async function runIn(
	machine: string,
	cwd: string,
	command: string,
	opts: { timeoutMs?: number; stdin?: string } & LaneEnv = {},
): Promise<RunResult> {
	if (machine === LOCAL) return sh("bash", ["-lc", command], { cwd, timeoutMs: opts.timeoutMs, stdin: opts.stdin });
	const target = await machineTarget(machine, opts);
	const remote = `bash -lc ${sq(`cd ${sq(cwd)} && ${command}`)}`;
	return sh("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "--", remote], {
		timeoutMs: opts.timeoutMs,
		stdin: opts.stdin,
	});
}

// --------------------------------------------------------------------- records

function recordsDir(env: LaneEnv): string {
	return env.recordsDir ?? process.env.PI_LANE_RECORDS_DIR ?? join(homedir(), ".local", "state", "pi-manager-lanes");
}

function recordPath(issue: string, env: LaneEnv): string {
	return join(recordsDir(env), `issue-${issue}.json`);
}

export interface LaneRecord {
	issue: string;
	target: string;
	workspace: string;
	branch: string;
	tab_id: string;
	impl_pane: string;
	rev_pane: string | null;
	impl_agent: string;
	rev_agent: string;
	updated_at: string;
	/** full base ref used for the worktree (target keeps the branch name only) */
	base?: string;
	machine?: string;
	repo?: string;
	impl_kind?: string;
	impl_model?: string;
	rev_kind?: string;
	rev_model?: string;
	created_by?: string;
}

export function readRecord(issue: string, env: LaneEnv = {}): LaneRecord | undefined {
	try {
		return JSON.parse(readFileSync(recordPath(issue, env), "utf8")) as LaneRecord;
	} catch {
		return undefined;
	}
}

/** Atomic tmp+rename; earlier lane steps' fields survive a partial update. */
function writeRecord(issue: string, fields: Partial<LaneRecord>, env: LaneEnv): LaneRecord {
	const dir = recordsDir(env);
	mkdirSync(dir, { recursive: true });
	const file = recordPath(issue, env);
	let prev: Record<string, unknown> = {};
	try {
		prev = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		// first write (or a corrupt record): start fresh, same as the bash
	}
	const merged: Record<string, unknown> = { ...prev };
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined) continue;
		if (v === "" && prev[k] !== undefined && prev[k] !== "") continue;
		merged[k] = v;
	}
	if (!("rev_pane" in merged)) merged.rev_pane = null;
	merged.updated_at = new Date().toISOString();
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
	renameSync(tmp, file);
	return merged as unknown as LaneRecord;
}

/** An open record IS a live lane — closing moves it aside, not deletes. */
function archiveRecord(issue: string, env: LaneEnv): string {
	const file = recordPath(issue, env);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const to = join(recordsDir(env), `issue-${issue}.closed-${ts}.json`);
	renameSync(file, to);
	return to;
}

// ----------------------------------------------------------------------- ops

export interface LaneEnv {
	herdrBin?: string;
	/** pi-super state dir — mandates live under <stateDir>/mandates */
	stateDir?: string;
	recordsDir?: string;
	routingFile?: string;
	/** pi-manager-collaborator skill dir (default <home>/.hermes/skills/pi-manager-collaborator) */
	skillDir?: string;
	/** command runner override — tests inject this instead of faking ssh */
	run?: typeof runIn;
}

export interface LaneOp {
	plan: Record<string, unknown>;
	execute(): Promise<Record<string, unknown>>;
}

export class LaneError extends Error {
	constructor(
		message: string,
		readonly created?: Record<string, unknown>,
	) {
		super(message);
		this.name = "LaneError";
	}
}

async function hj<T>(machine: string, args: string[], env: LaneEnv): Promise<T> {
	return herdrJson<T>(machine, args, { bin: env.herdrBin });
}

/** First pane whose cwd is `cwd`, else a fresh workspace labelled after the dir. */
async function resolveWorkspace(machine: string, cwd: string, workspace: string | undefined, env: LaneEnv): Promise<string> {
	if (workspace) return workspace;
	const res = await hj<{ panes?: Array<{ cwd?: string; workspace_id?: string }> }>(machine, ["pane", "list"], env);
	const hit = (res?.panes ?? []).find((p) => p.cwd === cwd && p.workspace_id);
	if (hit?.workspace_id) return hit.workspace_id;
	const made = await hj<{ workspace?: { workspace_id?: string } }>(
		machine,
		["workspace", "create", "--cwd", cwd, "--label", basename(cwd), "--no-focus"],
		env,
	);
	const id = made?.workspace?.workspace_id;
	if (!id) throw new Error("workspace create returned no id");
	return id;
}

async function agentStatus(machine: string, target: string, env: LaneEnv): Promise<string> {
	try {
		const res = await hj<{ agent?: { agent_status?: unknown } }>(machine, ["agent", "get", target], env);
		return String(res?.agent?.agent_status ?? "unknown");
	} catch (err) {
		if (err instanceof HerdrError && err.code === "agent_not_found") return "gone";
		throw err;
	}
}

async function startBanner(machine: string, name: string, env: LaneEnv): Promise<string> {
	const out = await herdrRun(machine, ["agent", "read", name, "--source", "recent", "--lines", "80"], { bin: env.herdrBin });
	return out;
}

const bannerExcerpt = (banner: string): string => banner.trimEnd().split("\n").slice(-10).join("\n");

/** the model id must appear in the agent's own startup screen — else it is not pinned */
function verifyBanner(banner: string, model: string): boolean {
	return banner.includes(model);
}

function checkIssue(issue: unknown): string {
	const s = String(issue ?? "");
	if (!/^[0-9]+$/.test(s)) throw new LaneError(`issue must be a positive integer, got '${s}'`);
	return s;
}

interface LaneOpenArgs {
	machine?: string;
	issue: string | number;
	repo?: string;
	path?: string;
	base?: string;
	workspace?: string;
	implKind?: string;
	implModel?: string;
	implClass?: string;
	extensions?: boolean;
	prompt?: string;
}

/** $HOME on the target machine — remote paths must be absolute, never `~/...` */
async function remoteHome(machine: string, run: typeof runIn, env: LaneEnv): Promise<string> {
	if (machine === LOCAL) return homedir();
	const r = await run(machine, "/", 'printf %s "$HOME"', env);
	const home = r.stdout.trim();
	if (r.code !== 0 || !home.startsWith("/")) throw new LaneError(`cannot resolve remote home on ${machine}: ${r.stderr || r.stdout}`);
	return home;
}

export function laneOpen(args: LaneOpenArgs, env: LaneEnv = {}): LaneOp {
	const machine = args.machine ?? LOCAL;
	const issue = String(args.issue ?? "");
	const repo = args.repo;
	const dir = args.path;
	const base = args.base ?? "origin/main";
	const implKind = args.implKind ?? "pi";
	const implClass = args.implClass ?? "balanced";
	const branch = `issue-${issue}`;
	const recFile = recordPath(/^[0-9]+$/.test(issue) ? issue : "x", env);
	const blocked = /^[0-9]+$/.test(issue) && existsSync(recFile);
	let model: ModelChoice | undefined;
	let modelError: string | undefined;
	if (implKind === "pi") {
		try {
			model = args.implModel ? parseModel(args.implModel) : resolveModel(loadRouting(env.routingFile), { cls: implClass });
		} catch (err) {
			modelError = String((err as Error)?.message ?? err);
		}
	} else if (args.implModel) {
		try {
			model = parseModel(args.implModel);
		} catch {
			model = undefined;
		}
	}
	const wtDir = repo ? join(dirname(repo), `${basename(repo)}-worktrees`, branch) : undefined;
	// the script check is a local fs read — remote machines decide it at execute time
	const localHasWtScript = machine === LOCAL && repo ? existsSync(join(repo, "scripts", "new-worktree.sh")) : undefined;
	const plan: Record<string, unknown> = {
		op: "lane_open",
		issue,
		machine,
		blockedBy: blocked ? `lane record already exists: ${recFile}` : undefined,
		worktree: dir
			? { mode: "existing", path: dir }
			: repo
				? localHasWtScript === true
					? { mode: "new-worktree.sh", cwd: repo, command: `bash scripts/new-worktree.sh ${branch} ${base}` }
					: localHasWtScript === false
						? { mode: "git", command: `git -C ${repo} worktree add ${wtDir} -b ${branch} ${base}` }
						: {
								mode: "script-or-git",
								detail: `new-worktree.sh if present on ${machine}, else git worktree add ${wtDir}`,
							}
				: { mode: "error", error: "repo or path required" },
		workspace: args.workspace ?? `first pane with cwd ${repo ?? dir ?? "?"} (else create)`,
		tab: `issue-${issue}`,
		impl: {
			name: `impl-${issue}`,
			kind: implKind,
			model: model ? `${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}` : undefined,
			modelError,
			args: implKind === "pi" && model ? [...piModelArgs(model), ...(args.extensions ? [] : ["-ne"])] : [],
		},
		prompt: args.prompt ? "(initial prompt)" : undefined,
	};
	return {
		plan,
		async execute() {
			checkIssue(issue);
			if (blocked) throw new LaneError(`lane record already exists: ${recFile} (lane ${issue} is live)`);
			if (!repo && !dir) throw new LaneError("lane_open needs repo (to create a worktree) or path (an existing dir)");
			if (implKind === "pi" && !model) throw new LaneError(`cannot resolve implementer model: ${modelError ?? "none"}`);

			const run = env.run ?? runIn;
			const created: Record<string, unknown> = {};
			try {
				// ---- workspace dir
				let worktree = dir ?? "";
				let branchName = "";
				if (dir) {
					const r = await run(machine, "/", `cd ${sq(dir)} && pwd -P`, env);
					if (r.code !== 0) throw new LaneError(`path does not exist on ${machine}: ${dir}`);
					worktree = r.stdout.trim();
					const b = await run(machine, worktree, "git branch --show-current", env);
					branchName = b.stdout.trim();
				} else {
					// existence is decided on the machine that will run the command
					const hasWtScript =
						(await run(machine, "/", `test -f ${sq(join(repo!, "scripts", "new-worktree.sh"))}`, env)).code === 0;
					if (hasWtScript) {
						const r = await run(machine, repo!, `bash scripts/new-worktree.sh ${sq(branch)} ${sq(base)}`, {
							...env,
							timeoutMs: 15 * 60_000,
						});
						if (r.code !== 0) throw new LaneError(`new-worktree.sh failed: ${r.stderr || r.stdout}`);
					} else {
						const r = await run(
							machine,
							"/",
							`git -C ${sq(repo!)} worktree add ${sq(wtDir!)} -b ${sq(branch)} ${sq(base)}`,
							{ ...env, timeoutMs: 15 * 60_000 },
						);
						if (r.code !== 0) throw new LaneError(`git worktree add failed: ${r.stderr || r.stdout}`);
					}
					// never trust what the command printed: ask git which path owns the branch
					const r = await run(machine, "/", `git -C ${sq(repo!)} worktree list --porcelain`, env);
					worktree = resolveWorktreePath(r.stdout, `refs/heads/${branch}`) ?? "";
					if (!worktree) throw new LaneError(`cannot resolve worktree for branch ${branch}`);
					branchName = branch;
				}
				created.worktree = worktree;

				// ---- herdr layout
				const ws = await resolveWorkspace(machine, repo ?? worktree, args.workspace, env);
				created.workspaceId = ws;
				const tab = await hj<{ tab?: { tab_id?: string }; root_pane?: { pane_id?: string } }>(
					machine,
					["tab", "create", "--workspace", ws, "--cwd", worktree, "--label", `issue-${issue}`, "--no-focus"],
					env,
				);
				const tabId = tab?.tab?.tab_id;
				const implPane = tab?.root_pane?.pane_id;
				if (!tabId || !implPane) throw new LaneError("tab create returned no ids");
				created.tabId = tabId;
				created.implPane = implPane;
				await hj(machine, ["pane", "rename", implPane, `impl-${issue}`], env);
				const implName = `impl-${issue}`;
				const startArgs = ["agent", "start", implName, "--kind", implKind, "--pane", implPane, "--timeout", "60000"];
				if (implKind === "pi" && model) startArgs.push("--", ...piModelArgs(model), ...(args.extensions ? [] : ["-ne"]));
				await hj(machine, startArgs, env);

				// ---- verify the model in the banner (pi only; a miss is a warning, not a rollback)
				let modelVerified: boolean | undefined;
				let banner: string | undefined;
				if (implKind === "pi" && model) {
					const full = await startBanner(machine, implName, env);
					modelVerified = verifyBanner(full, model.model);
					banner = bannerExcerpt(full);
				}

				const record = writeRecord(
					issue,
					{
						issue,
						// target stays the integration branch for record compat; the
						// full ref (fork remote, sha) lives in `base`
						target: base.replace(/^origin\//, ""),
						base,
						workspace: worktree,
						branch: branchName,
						tab_id: tabId,
						impl_pane: implPane,
						impl_agent: implName,
						rev_agent: `rev-${issue}`,
						machine,
						repo: repo ?? "",
						impl_kind: implKind,
						impl_model: model ? `${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}` : "",
						created_by: "pi-super",
					},
					env,
				);

				if (args.prompt) {
					await hj(
						machine,
						["agent", "prompt", implName, args.prompt, "--wait", "--until", "working", "--timeout", "60000"],
						env,
					);
				}
				return { ok: true, issue, machine, worktree, workspaceId: ws, tabId, implPane, modelVerified, banner, record, created };
			} catch (err) {
				throw enrich(err, created);
			}
		},
	};
}

/** an op that failed mid-flight still reports what it managed to create */
function enrich(err: unknown, created: Record<string, unknown>): LaneError {
	if (err instanceof LaneError) {
		if (err.created === undefined && Object.keys(created).length) return new LaneError(err.message, created);
		return err;
	}
	return new LaneError(String((err as Error)?.message ?? err), created);
}

function resolveWorktreePath(porcelain: string, branchRef: string): string | undefined {
	let wt = "";
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) wt = line.slice(9);
		if (line === `branch ${branchRef}` && wt) return wt;
	}
	return undefined;
}

interface LaneReviewerArgs {
	issue: string | number;
	revKind?: string;
	revModel?: string;
	revClass?: string;
	allowSameFamily?: boolean;
	extensions?: boolean;
	prompt?: string;
}

export function laneReviewer(args: LaneReviewerArgs, env: LaneEnv = {}): LaneOp {
	const issue = String(args.issue ?? "");
	const rec = /^[0-9]+$/.test(issue) ? readRecord(issue, env) : undefined;
	const machine = rec?.machine ?? LOCAL;
	const revKind = args.revKind ?? "pi";
	const revClass = args.revClass ?? "strong";
	let model: ModelChoice | undefined;
	let modelError: string | undefined;
	let sameFamily = false;
	const implFamily = rec?.impl_model ? modelFamily(rec.impl_model) : undefined;
	if (revKind === "pi") {
		try {
			if (args.revModel) {
				model = parseModel(args.revModel);
				sameFamily = implFamily !== undefined && modelFamily(model.model) === implFamily;
				if (sameFamily && !args.allowSameFamily) throw new LaneError(
					`reviewer model ${model.model} is the same family as the implementer (${implFamily}) — pass allowSameFamily to override`,
				);
			} else {
				model = resolveModel(loadRouting(env.routingFile), {
					specialist: "epic-reviewer",
					cls: revClass,
					excludeFamily: implFamily,
				});
			}
		} catch (err) {
			// a refused model must not survive into execute() — parse ok, policy no
			model = undefined;
			modelError = String((err as Error)?.message ?? err);
		}
	}
	const plan: Record<string, unknown> = {
		op: "lane_reviewer",
		issue,
		machine,
		blockedBy: rec ? undefined : `no lane record for issue ${issue}`,
		worktree: rec?.workspace,
		split: `${rec?.impl_pane ?? "?"} right`,
		rev: {
			name: `rev-${issue}`,
			kind: revKind,
			model: model ? `${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}` : undefined,
			sameFamily: sameFamily || undefined,
			modelError,
		},
		prompt: args.prompt ? "(review prompt)" : undefined,
	};
	return {
		plan,
		async execute() {
			checkIssue(issue);
			if (!rec) throw new LaneError(`no lane record for issue ${issue} — open the lane first`);
			if (revKind === "pi" && !model) throw new LaneError(`cannot resolve reviewer model: ${modelError ?? "none"}`);
			const created: Record<string, unknown> = {};
			try {
				const out = await hj<{ pane?: { pane_id?: string } }>(
					machine,
					["pane", "split", rec.impl_pane, "--direction", "right", "--cwd", rec.workspace, "--no-focus"],
					env,
				);
				const revPane = out?.pane?.pane_id;
				if (!revPane) throw new LaneError("pane split returned no pane id");
				created.revPane = revPane;
				const revName = `rev-${issue}`;
				await hj(machine, ["pane", "rename", revPane, revName], env);
				const startArgs = ["agent", "start", revName, "--kind", revKind, "--pane", revPane, "--timeout", "60000"];
				if (revKind === "pi" && model) startArgs.push("--", ...piModelArgs(model), ...(args.extensions ? [] : ["-ne"]));
				await hj(machine, startArgs, env);
				let modelVerified: boolean | undefined;
				let banner: string | undefined;
				if (revKind === "pi" && model) {
					const full = await startBanner(machine, revName, env);
					modelVerified = verifyBanner(full, model.model);
					banner = bannerExcerpt(full);
				}
				const record = writeRecord(
					issue,
					{
						rev_pane: revPane,
						rev_agent: revName,
						rev_kind: revKind,
						rev_model: model ? `${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}` : "",
					},
					env,
				);
				if (args.prompt) {
					await hj(machine, ["agent", "prompt", revName, args.prompt, "--wait", "--until", "working", "--timeout", "60000"], env);
				}
				return {
					ok: true,
					issue,
					machine,
					revPane,
					modelVerified,
					banner,
					record,
					independence: sameFamily ? "context-isolated, not cross-family independent" : "cross-family",
					created,
				};
			} catch (err) {
				throw enrich(err, created);
			}
		},
	};
}

interface LaneCloseArgs {
	issue: string | number;
	force?: boolean;
	removeWorktree?: boolean;
}

export function laneClose(args: LaneCloseArgs, env: LaneEnv = {}): LaneOp {
	const issue = String(args.issue ?? "");
	const rec = /^[0-9]+$/.test(issue) ? readRecord(issue, env) : undefined;
	const machine = rec?.machine ?? LOCAL;
	const plan: Record<string, unknown> = {
		op: "lane_close",
		issue,
		machine,
		blockedBy: rec ? undefined : `no lane record for issue ${issue}`,
		tab: rec?.tab_id,
		removeWorktree: args.removeWorktree ? rec?.workspace : undefined,
		force: args.force === true,
	};
	return {
		plan,
		async execute() {
			checkIssue(issue);
			if (!rec) throw new LaneError(`no lane record for issue ${issue}`);
			const impl = await agentStatus(machine, rec.impl_agent, env);
			const rev = rec.rev_agent ? await agentStatus(machine, rec.rev_agent, env) : "gone";
			const busy = [impl, rev].filter((s) => s === "working" || s === "blocked");
			if (busy.length && !args.force) {
				return { ok: false, error: `lane still busy (impl ${impl}, rev ${rev}) — close with force`, statuses: { impl, rev } };
			}
			try {
				await hj(machine, ["tab", "close", rec.tab_id], env);
			} catch (err) {
				if (!(err instanceof HerdrError)) throw err;
				// "close failed" and "tab gone" are not the same: only a tab that is
				// really absent may cost the record — a live tab stays a live lane
				try {
					await hj(machine, ["tab", "get", rec.tab_id], env);
					return { ok: false, error: `tab close failed and the tab still exists: ${err.message}`, statuses: { impl, rev } };
				} catch (again) {
					if (!(again instanceof HerdrError)) throw again;
				}
			}
			const run = env.run ?? runIn;
			let worktreeRemoved = false;
			let worktreeError: string | undefined;
			if (args.removeWorktree && rec.repo && rec.workspace) {
				const r = await run(machine, "/", `git -C ${sq(rec.repo)} worktree remove ${sq(rec.workspace)}`, env);
				worktreeRemoved = r.code === 0;
				if (!worktreeRemoved) worktreeError = (r.stderr || r.stdout).trim();
			}
			const archived = archiveRecord(issue, env);
			return { ok: true, issue, machine, closedTab: rec.tab_id, worktreeRemoved, worktreeError, archived };
		},
	};
}

export async function laneList(env: LaneEnv = {}): Promise<Record<string, unknown>> {
	const dir = recordsDir(env);
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => /^issue-\d+\.json$/.test(f));
	} catch {
		files = [];
	}
	const lanes = [];
	for (const f of files) {
		const rec = readRecord(f.slice(6, -5), env);
		if (!rec) continue;
		const machine = rec.machine ?? LOCAL;
		lanes.push({
			issue: rec.issue,
			machine,
			workspace: rec.workspace,
			branch: rec.branch,
			impl: { agent: rec.impl_agent, pane: rec.impl_pane, status: await agentStatus(machine, rec.impl_agent, env) },
			rev: rec.rev_agent
				? { agent: rec.rev_agent, pane: rec.rev_pane, status: await agentStatus(machine, rec.rev_agent, env) }
				: undefined,
			updated_at: rec.updated_at,
		});
	}
	return { lanes };
}

interface CoordinatorArgs {
	machine?: string;
	slug: string;
	cwd: string;
	kind: "pi" | "hermes";
	mandate?: string;
	mandateFile?: string;
	model?: string;
	cls?: string;
	hermesArgs?: string[];
	workspace?: string;
}

/** skill dir resolved against the home of the machine the coordinator runs on */
function collaboratorSkillDir(env: LaneEnv, home: string): string {
	return env.skillDir ?? process.env.PI_SUPER_COLLABORATOR_SKILL ?? join(home, ".hermes", "skills", "pi-manager-collaborator");
}

export function coordinatorStart(args: CoordinatorArgs, env: LaneEnv = {}): LaneOp {
	const machine = args.machine ?? LOCAL;
	const slug = String(args.slug ?? "");
	const name = `coord-${slug}`;
	const kind = args.kind;
	const cls = args.cls ?? "strong";
	const hermesArgs = args.hermesArgs ?? ["-p", "orchestrator"];
	// remote home is unknown until execute — show the override or the pattern
	const planSkill =
		env.skillDir ??
		process.env.PI_SUPER_COLLABORATOR_SKILL ??
		(machine === LOCAL
			? join(homedir(), ".hermes", "skills", "pi-manager-collaborator")
			: `$HOME on ${machine} → .hermes/skills/pi-manager-collaborator`);
	let model: ModelChoice | undefined;
	let modelError: string | undefined;
	try {
		model = args.model ? parseModel(args.model) : resolveModel(loadRouting(env.routingFile), { cls });
	} catch (err) {
		modelError = String((err as Error)?.message ?? err);
	}
	const mandateError =
		(args.mandate !== undefined) === (args.mandateFile !== undefined)
			? "exactly one of mandate / mandateFile is required"
			: undefined;
	const plan: Record<string, unknown> = {
		op: "coordinator_start",
		machine,
		slug,
		name,
		kind,
		cwd: args.cwd,
		workspace: args.workspace ?? `first pane with cwd ${args.cwd ?? "?"} (else create)`,
		tab: name,
		model: model ? `${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}` : undefined,
		modelError,
		mandate: args.mandateFile ?? (args.mandate !== undefined ? "(text → <stateDir>/mandates/)" : undefined),
		mandateError,
		skill: kind === "pi" ? planSkill : undefined,
	};
	return {
		plan,
		async execute() {
			if (!/^[a-z0-9-]{1,24}$/.test(slug)) throw new LaneError(`slug must be [a-z0-9-]{1,24}, got '${slug}'`);
			if (mandateError) throw new LaneError(mandateError);
			if (!args.cwd) throw new LaneError("coordinator_start needs cwd");
			if (!model) throw new LaneError(`cannot resolve model: ${modelError ?? "none"}`);
			if ((await agentStatus(machine, name, env)) !== "gone") {
				throw new LaneError(`agent '${name}' already exists on ${machine}`);
			}
			const run = env.run ?? runIn;
			const home = await remoteHome(machine, run, env);
			const skillDir = collaboratorSkillDir(env, home);
			if (kind === "pi") {
				const r = await run(machine, "/", `test -f ${sq(join(skillDir, "SKILL.md"))}`, env);
				if (r.code !== 0) throw new LaneError(`collaborator skill not found on ${machine}: ${skillDir}`);
			}
			const created: Record<string, unknown> = {};
			try {
				let mandatePath = args.mandateFile ?? "";
				if (args.mandate !== undefined) {
					const ts = new Date().toISOString().replace(/[:.]/g, "-");
					const file = `${slug}-${ts}.md`;
					if (machine === LOCAL) {
						const dir = join(env.stateDir ?? process.env.PI_SUPER_STATE_DIR ?? join(homedir(), ".pi", "super"), "mandates");
						mkdirSync(dir, { recursive: true });
						mandatePath = join(dir, file);
						writeFileSync(mandatePath, args.mandate);
					} else {
						// absolute remote paths only — herdr/agent args must never carry `~`
						mandatePath = `${home}/.pi/super/mandates/${file}`;
						const r = await run(
							machine,
							"/",
							`mkdir -p ${sq(`${home}/.pi/super/mandates`)} && cat > ${sq(mandatePath)}`,
							{ ...env, stdin: args.mandate },
						);
						if (r.code !== 0) throw new LaneError(`mandate upload failed: ${r.stderr}`);
					}
				}
				created.mandatePath = mandatePath;

				const ws = await resolveWorkspace(machine, args.cwd, args.workspace, env);
				created.workspaceId = ws;
				const tab = await hj<{ tab?: { tab_id?: string }; root_pane?: { pane_id?: string } }>(
					machine,
					["tab", "create", "--workspace", ws, "--cwd", args.cwd, "--label", name, "--no-focus"],
					env,
				);
				const tabId = tab?.tab?.tab_id;
				const pane = tab?.root_pane?.pane_id;
				if (!tabId || !pane) throw new LaneError("tab create returned no ids");
				created.tabId = tabId;
				created.pane = pane;
				await hj(machine, ["pane", "rename", pane, name], env);

				const startArgs = ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "60000", "--"];
				if (kind === "pi") startArgs.push(...piModelArgs(model), "-ne", "--skill", skillDir);
				else {
					startArgs.push(...hermesArgs);
					if (model) {
						startArgs.push("--provider", model.provider, "-m", model.model);
						if (model.thinking) startArgs.push("--reasoning", model.thinking);
					}
					startArgs.push("chat", "--yolo", "--query-file", mandatePath);
				}
				await hj(machine, startArgs, env);

				let modelVerified: boolean | undefined;
				let banner: string | undefined;
				if (kind === "pi") {
					const full = await startBanner(machine, name, env);
					modelVerified = verifyBanner(full, model.model);
					banner = bannerExcerpt(full);
					await hj(
						machine,
						[
							"agent",
							"prompt",
							name,
							// read-file first: /skill:name only works when pi's frontmatter parser
							// accepts the SKILL.md, and a valid-looking file can still fail to parse
							`Read the coordinator protocol file ${join(skillDir, "SKILL.md")} completely, then work it in Mode C (it is also loadable as /skill:pi-manager-collaborator). Your conductor is super (the pi-super meta agent); report blockers and the three checkpoints to the conductor by writing them in your own pane, where super reads them. Mandate file: ${mandatePath} — read it completely before acting.`,
							"--wait",
							"--until",
							"working",
							"--timeout",
							"60000",
						],
						env,
					);
				}
				return { ok: true, machine, name, tabId, pane, mandatePath, modelVerified, banner, args: startArgs.slice(startArgs.indexOf("--") + 1), created };
			} catch (err) {
				throw enrich(err, created);
			}
		},
	};
}
