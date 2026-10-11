/**
 * pi-super meta agent extension: lanes and coordinators.
 *
 * Loaded as the third -e next to super-meta/super-herdr, only when herdr is
 * configured. Every mutating tool is two-phase: without `execute` it returns the
 * exact plan (resolved models, commands, paths) and refuses to act; the user
 * approves the plan, and only then does execute:true run it. That is the
 * conductor's "explicit yes" gate in tool form.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	LOCAL,
	coordinatorStart,
	laneClose,
	laneList,
	laneOpen,
	laneReviewer,
	type LaneEnv,
} from "../server/lanes.ts";

const MACHINES = (process.env.PI_SUPER_HERDR_MACHINES ?? "")
	.split(",")
	.map((m) => m.trim())
	.filter(Boolean);

const MAX_TOOL_BYTES = 50_000;

const text = (s: string) => {
	let out = s;
	if (Buffer.byteLength(out, "utf8") > MAX_TOOL_BYTES) {
		out = `[…truncated…]\n${Buffer.from(out, "utf8").subarray(-MAX_TOOL_BYTES).toString("utf8")}`;
	}
	return { content: [{ type: "text" as const, text: out }] };
};
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (err: unknown) =>
	text(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err), created: (err as { created?: unknown }).created }));

const ENV: LaneEnv = {
	stateDir: process.env.PI_SUPER_STATE_DIR,
	herdrBin: process.env.PI_SUPER_HERDR_BIN,
};

function machineParam(m: string | undefined): string {
	const machine = m?.trim() || LOCAL;
	if (!MACHINES.includes(machine)) {
		throw new Error(`machine '${machine}' is not configured — known machines: ${MACHINES.join(", ") || "(none)"}`);
	}
	return machine;
}

const APPROVAL =
	"Not executed. Show this plan to the user and call again with execute:true only after they explicitly approve.";

type Op = { plan: Record<string, unknown>; execute(): Promise<Record<string, unknown>> };

async function runOp(op: Op, execute: boolean | undefined) {
	if (!execute) return json({ plan: op.plan, note: APPROVAL });
	try {
		return json(await op.execute());
	} catch (err) {
		return fail(err);
	}
}

export default function superLanes(pi: ExtensionAPI) {
	pi.registerTool({
		name: "lane_open",
		label: "lane open",
		description:
			"Open an implementer lane for one issue: one worktree, one herdr tab issue-<N> with agent impl-<N> on a pinned model. Returns a plan first; needs execute:true after the user approves.",
		parameters: Type.Object({
			issue: Type.String({ description: "issue number, e.g. '412'" }),
			repo: Type.Optional(Type.String({ description: "git checkout that owns the worktrees (or use path)" })),
			path: Type.Optional(Type.String({ description: "existing workspace dir instead of creating a worktree" })),
			base: Type.Optional(Type.String({ description: "base ref for the worktree (default origin/main)" })),
			workspace: Type.Optional(Type.String({ description: "herdr workspace id (default: pane whose cwd is the repo, else created)" })),
			implKind: Type.Optional(Type.String({ description: "agent kind (default pi)" })),
			implModel: Type.Optional(Type.String({ description: "explicit provider/model[:thinking]; default: resolve from the routing file" })),
			implClass: Type.Optional(Type.String({ description: "routing class when no explicit model (default balanced)" })),
			extensions: Type.Optional(Type.Boolean({ description: "let pi load the user's extensions (default -ne)" })),
			prompt: Type.Optional(Type.String({ description: "initial prompt to the implementer" })),
			machine: Type.Optional(Type.String({ description: "herdr machine label (default local)" })),
			execute: Type.Optional(Type.Boolean({ description: "true only after the user approved the plan" })),
		}),
		async execute(_id, params) {
			try {
				return await runOp(
					laneOpen(
						{
							machine: machineParam(params.machine),
							issue: params.issue,
							repo: params.repo,
							path: params.path,
							base: params.base,
							workspace: params.workspace,
							implKind: params.implKind,
							implModel: params.implModel,
							implClass: params.implClass,
							extensions: params.extensions,
							prompt: params.prompt,
						},
						ENV,
					),
					params.execute,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "lane_reviewer",
		label: "lane reviewer",
		description:
			"Split the implementer pane and start the writable reviewer rev-<N> in the same worktree — always a different model family unless you explicitly allow the same. Plan first, execute:true after approval.",
		parameters: Type.Object({
			issue: Type.String({ description: "issue number of an open lane" }),
			revKind: Type.Optional(Type.String({ description: "agent kind (default pi)" })),
			revModel: Type.Optional(Type.String({ description: "explicit provider/model[:thinking]" })),
			revClass: Type.Optional(Type.String({ description: "routing class (default strong)" })),
			allowSameFamily: Type.Optional(Type.Boolean({ description: "permit same model family as the implementer (context-isolated only)" })),
			extensions: Type.Optional(Type.Boolean()),
			prompt: Type.Optional(Type.String({ description: "initial review prompt" })),
			execute: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			try {
				return await runOp(
					laneReviewer(
						{
							issue: params.issue,
							revKind: params.revKind,
							revModel: params.revModel,
							revClass: params.revClass,
							allowSameFamily: params.allowSameFamily,
							extensions: params.extensions,
							prompt: params.prompt,
						},
						ENV,
					),
					params.execute,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "lane_close",
		label: "lane close",
		description:
			"Close a lane's herdr tab and archive its record. Refuses while an agent is working or blocked unless force. removeWorktree also removes the worktree (unforced git remove — a dirty worktree is reported, not destroyed).",
		parameters: Type.Object({
			issue: Type.String({ description: "issue number" }),
			force: Type.Optional(Type.Boolean({ description: "close even while agents are working/blocked" })),
			removeWorktree: Type.Optional(Type.Boolean({ description: "also remove the lane worktree (default false)" })),
			execute: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			try {
				return await runOp(
					laneClose({ issue: params.issue, force: params.force, removeWorktree: params.removeWorktree }, ENV),
					params.execute,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "lane_list",
		label: "lane list",
		description: "List open lane records with the live status of impl and rev agents (read-only).",
		parameters: Type.Object({}),
		async execute() {
			try {
				return json(await laneList(ENV));
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "coordinator_start",
		label: "coordinator start",
		description:
			"Start a coordinator agent coord-<slug> in its own tab: pi with the pi-manager-collaborator skill, or hermes with a profile, driven by a written mandate. Plan first, execute:true after approval.",
		parameters: Type.Object({
			slug: Type.String({ description: "short name [a-z0-9-]{1,24}, agent becomes coord-<slug>" }),
			cwd: Type.String({ description: "working directory the coordinator runs in" }),
			kind: Type.Union([Type.Literal("pi"), Type.Literal("hermes")], { description: "pi + collaborator skill, or hermes" }),
			mandate: Type.Optional(Type.String({ description: "mandate text (written to a file). Exactly one of mandate/mandateFile" })),
			mandateFile: Type.Optional(Type.String({ description: "existing mandate file path on that machine" })),
			model: Type.Optional(Type.String({ description: "explicit provider/model[:thinking]" })),
			cls: Type.Optional(Type.String({ description: "routing class when no explicit model (default strong)" })),
			workspace: Type.Optional(Type.String({ description: "herdr workspace id" })),
			machine: Type.Optional(Type.String({ description: "herdr machine label (default local)" })),
			execute: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			try {
				return await runOp(
					coordinatorStart(
						{
							machine: machineParam(params.machine),
							slug: params.slug,
							cwd: params.cwd,
							kind: params.kind,
							mandate: params.mandate,
							mandateFile: params.mandateFile,
							model: params.model,
							cls: params.cls,
							workspace: params.workspace,
						},
						ENV,
					),
					params.execute,
				);
			} catch (err) {
				return fail(err);
			}
		},
	});
}
