/**
 * pi-super meta agent extension: the herdr fleet.
 *
 * Loaded *only* into the meta-agent pi session pi-super spawns (as a second `-e`
 * next to super-meta.ts), and only when pi-super resolved at least one herdr
 * machine. Most coding agents on this rig do not live in bare tmux windows —
 * they run under herdr, which already knows their kind, their status, and how
 * to reach agents on other machines over ssh. These tools expose that map; the
 * tmux tools stay for whatever herdr does not manage.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HerdrError, LOCAL, PANE_ID, fleetAgents, herdrJson, herdrRun } from "../server/herdr.ts";

const MACHINES = (process.env.PI_SUPER_HERDR_MACHINES ?? "")
	.split(",")
	.map((m) => m.trim())
	.filter(Boolean);

// pi's extension guidance: keep tool output out of "blow up the context" territory.
const MAX_TOOL_BYTES = 50_000;
const MAX_TOOL_LINES = 2000;

function clamp(s: string): string {
	let out = s;
	const lines = out.split("\n");
	if (lines.length > MAX_TOOL_LINES) {
		out = `[…${lines.length - MAX_TOOL_LINES} earlier lines omitted…]\n${lines.slice(-MAX_TOOL_LINES).join("\n")}`;
	}
	if (Buffer.byteLength(out, "utf8") > MAX_TOOL_BYTES) {
		out = `[…truncated…]\n${Buffer.from(out, "utf8").subarray(-MAX_TOOL_BYTES).toString("utf8")}`;
	}
	return out;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: clamp(s) }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (err: unknown) => text(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }));

/** herdr answers carry a machine-readable code (agent_blocked, timeout, ...) — keep it. */
const failHerdr = (err: unknown) =>
	err instanceof HerdrError
		? text(JSON.stringify({ ok: false, code: err.code, machine: err.machine, error: err.message }))
		: fail(err);

/** a machine the server did not configure must be unreachable even if herdr knows it */
function machineParam(m: string | undefined): string {
	const machine = m?.trim() || LOCAL;
	if (!MACHINES.includes(machine)) {
		throw new Error(`machine '${machine}' is not configured — known machines: ${MACHINES.join(", ") || "(none)"}`);
	}
	return machine;
}

async function agentStatus(machine: string, target: string): Promise<string> {
	const res = await herdrJson<{ agent?: { agent_status?: unknown } }>(machine, ["agent", "get", target]);
	return String(res?.agent?.agent_status ?? "unknown");
}

async function agentTail(machine: string, target: string, lines: number): Promise<string> {
	const out = await herdrRun(machine, ["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)]);
	return out.replace(/\n+$/, "");
}

const machineField = {
	machine: Type.Optional(Type.String({ description: "herdr machine label (default: local)" })),
};

export default function superHerdr(pi: ExtensionAPI) {
	pi.registerTool({
		name: "herdr_agents",
		label: "herdr agents",
		description:
			"The map of every coding agent herdr knows about (pi, hermes, codex, devin, claude, ...), across machines: omit `machine` to query all configured machines at once. Each agent has kind, status, pane id, workspace/tab labels, cwd and title. States: working = a turn is in progress, blocked = an approval/question dialog waits for input, done = finished and not yet looked at, idle = ready, unknown = present but unclassified (not proof of completion).",
		parameters: Type.Object({
			machine: Type.Optional(Type.String({ description: "herdr machine label (default: all configured machines)" })),
		}),
		async execute(_id, params) {
			try {
				const machines = params.machine ? [machineParam(params.machine)] : MACHINES;
				const fleet = await fleetAgents(machines);
				return json({
					machines: fleet.map((m) => ({
						machine: m.machine,
						ok: m.ok,
						...(m.error ? { error: m.error } : {}),
						agents: m.agents.map((a) => ({
							name: a.name,
							kind: a.kind,
							status: a.status,
							pane: a.paneId,
							workspace: a.workspace,
							tab: a.tab,
							paneLabel: a.paneLabel,
							cwd: a.cwd,
							title: a.title,
						})),
					})),
				});
			} catch (err) {
				return failHerdr(err);
			}
		},
	});

	pi.registerTool({
		name: "herdr_read",
		label: "herdr read",
		description:
			"Read what an agent's pane is showing: recent unwrapped output of any agent (by name or pane id wZZ:pNN) or any pane herdr manages. Use it to check what an agent answered, what dialog blocks it, or what a non-agent pane is doing.",
		parameters: Type.Object({
			target: Type.String({ description: "agent name or pane id (wZZ:pNN)" }),
			lines: Type.Optional(Type.Number({ description: "lines of recent output (default 200, max 5000)" })),
			...machineField,
		}),
		async execute(_id, params) {
			try {
				const machine = machineParam(params.machine);
				const lines = Math.min(Math.max(1, params.lines ?? 200), 5000);
				const cmd = PANE_ID.test(params.target) ? "pane" : "agent";
				const out = await herdrRun(machine, [cmd, "read", params.target, "--source", "recent-unwrapped", "--lines", String(lines)]);
				return text(out.replace(/\n+$/, "") || "(empty)");
			} catch (err) {
				return failHerdr(err);
			}
		},
	});

	pi.registerTool({
		name: "herdr_prompt",
		label: "herdr prompt",
		description:
			"Submit a prompt to an agent (by name or pane id). wait=working (default) returns as soon as the turn starts — the right way to dispatch. wait=settled blocks until the agent is idle/done/blocked again and returns the final status plus the last lines of output. wait=none returns after submission. Errors carry a herdr code: agent_blocked means a dialog is open and nothing was sent — inspect with herdr_read; timeout or agent_prompt_stalled do NOT prove the prompt was not delivered — always herdr_read before ever resending (a resend is a double submission).",
		parameters: Type.Object({
			target: Type.String({ description: "agent name or pane id (wZZ:pNN)" }),
			text: Type.String({ description: "prompt text to submit" }),
			wait: Type.Optional(
				Type.Union([Type.Literal("none"), Type.Literal("working"), Type.Literal("settled")], {
					description: "none = submit only, working = until the turn starts (default), settled = until idle/done/blocked",
				}),
			),
			timeoutSeconds: Type.Optional(Type.Number({ description: "give up waiting after this long (working: default 60; settled: default 600, max 3600)" })),
			...machineField,
		}),
		async execute(_id, params) {
			try {
				const machine = machineParam(params.machine);
				const wait = params.wait ?? "working";
				const args = ["agent", "prompt", params.target, params.text];
				let ms = 0;
				if (wait !== "none") {
					ms = Math.min(Math.max(1, params.timeoutSeconds ?? (wait === "settled" ? 600 : 60)), 3600) * 1000;
					args.push("--wait", "--timeout", String(ms));
					if (wait === "working") args.push("--until", "working");
				}
				const out = await herdrRun(machine, args, { timeoutMs: ms ? ms + 30_000 : 30_000 });
				if (wait !== "settled") return text(out.trim() || "(submitted)");
				const status = await agentStatus(machine, params.target);
				const tail = await agentTail(machine, params.target, 80);
				return text(`status: ${status}\n\n${tail}`);
			} catch (err) {
				return failHerdr(err);
			}
		},
	});

	pi.registerTool({
		name: "herdr_wait",
		label: "herdr wait",
		description:
			"Block until an agent reaches one of the requested states (default: idle, done or blocked — i.e. its turn settled), then return the final status and the last lines of its output. Use this instead of polling herdr_read when you promised the user you would report back.",
		parameters: Type.Object({
			target: Type.String({ description: "agent name or pane id (wZZ:pNN)" }),
			until: Type.Optional(
				Type.Array(Type.Union([Type.Literal("idle"), Type.Literal("working"), Type.Literal("blocked"), Type.Literal("done")]), {
					description: "states to wait for (default: settled = idle/done/blocked)",
				}),
			),
			timeoutSeconds: Type.Optional(Type.Number({ description: "give up after this long (default 300, max 3600)" })),
			...machineField,
		}),
		async execute(_id, params, signal) {
			try {
				const machine = machineParam(params.machine);
				const ms = Math.min(Math.max(1, params.timeoutSeconds ?? 300), 3600) * 1000;
				const args = ["agent", "wait", params.target, "--timeout", String(ms)];
				for (const s of params.until ?? []) args.push("--until", s);
				try {
					await herdrRun(machine, args, { timeoutMs: ms + 30_000, signal });
				} catch (err) {
					if (err instanceof HerdrError && err.code === "timeout") {
						const status = await agentStatus(machine, params.target);
						const tail = await agentTail(machine, params.target, 60);
						return text(`(still ${status} after ${Math.round(ms / 1000)}s)\n\n${tail}`);
					}
					throw err;
				}
				const status = await agentStatus(machine, params.target);
				const tail = await agentTail(machine, params.target, 60);
				return text(`status: ${status}\n\n${tail}`);
			} catch (err) {
				return failHerdr(err);
			}
		},
	});

	pi.registerTool({
		name: "herdr_keys",
		label: "herdr keys",
		description:
			"Send logical key presses to an agent (by name or pane id): esc, enter, ctrl+c, up, down, tab, ... Use esc to interrupt a pi turn, enter to confirm a dialog, arrows to move in a menu.",
		parameters: Type.Object({
			target: Type.String({ description: "agent name or pane id (wZZ:pNN)" }),
			keys: Type.Array(Type.String(), { description: "logical keys, e.g. ['esc'] or ['ctrl+c']" }),
			...machineField,
		}),
		async execute(_id, params) {
			try {
				const machine = machineParam(params.machine);
				await herdrRun(machine, ["agent", "send-keys", params.target, ...params.keys]);
				return json({ ok: true });
			} catch (err) {
				return failHerdr(err);
			}
		},
	});
}
