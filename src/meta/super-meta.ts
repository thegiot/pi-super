/**
 * pi-super meta agent extension.
 *
 * Loaded *only* into the meta-agent pi session that pi-super spawns
 * (`pi --mode rpc -e .../super-meta.ts`) — never installed globally, so no other
 * pi session pays for it.
 *
 * It gives the meta agent precise, cheap handles on the tmux it lives to manage.
 * Everything here is doable with bash + tmux(1); these tools exist so the model
 * does not have to re-derive quoting/framing every time, and so pi-super can
 * observe intent (notably `speak`) in the RPC event stream.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SOCKET_ARGS = (process.env.PI_SUPER_TMUX_SOCKET ?? "").split(" ").filter(Boolean);
const SELF_SESSION_PREFIX = "pisuper-";

function tmux(args: string[], stdin?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"tmux",
			[...SOCKET_ARGS, ...args],
			{ maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			(err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout)),
		);
		if (stdin !== undefined) child.stdin?.end(stdin);
	});
}

/** tmux escapes control chars in non-tty output, so fields are newline-framed. */
async function query(args: string[], fields: string[]): Promise<string[][]> {
	const out = await tmux([...args, "-F", fields.join("\n")]);
	const lines = out.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const rows: string[][] = [];
	for (let i = 0; i + fields.length <= lines.length; i += fields.length) rows.push(lines.slice(i, i + fields.length));
	return rows;
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function paste(target: string, body: string): Promise<void> {
	const buffer = `pi-super-meta-${Math.random().toString(36).slice(2, 10)}`;
	await tmux(["load-buffer", "-b", buffer, "-"], body);
	try {
		await tmux(["paste-buffer", "-d", "-p", "-b", buffer, "-t", target]);
	} finally {
		await tmux(["delete-buffer", "-b", buffer]).catch(() => {});
	}
}

/**
 * A new default tmux pane has an interactive shell, but keystrokes sent while its startup
 * files are still running can be displayed and never executed. This is the same guard used
 * by pi-side-agents; timing out merely falls back to tmux's queued tty input.
 */
async function waitForShellReady(target: string, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const out = await tmux(["capture-pane", "-p", "-t", target]);
		const lines = out.split(/\r?\n/).filter((line) => line.trim());
		const last = lines.at(-1);
		if (last && /[$#%>❯›➜λ]\s*$/u.test(last)) return;
		await sleep(100);
	}
}

export default function superMeta(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tmux_windows",
		label: "tmux windows",
		description:
			"Inventory of every window in the tmux (all sessions except pi-super's own mirror sessions): window id, session, index, name, running command, cwd, size, activity flag, last activity age in seconds. This is your map of the world; start here.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const rows = await query(
					["list-windows", "-a"],
					[
						"#{session_name}",
						"#{window_id}",
						"#{window_index}",
						"#{window_name}",
						"#{window_active}",
						"#{window_activity_flag}",
						"#{window_width}",
						"#{window_height}",
						"#{pane_id}",
						"#{pane_current_command}",
						"#{pane_current_path}",
						"#{window_activity}",
					],
				);
				const now = Date.now() / 1000;
				const seen = new Set<string>();
				const windows = rows
					.filter((r) => !r[0]!.startsWith(SELF_SESSION_PREFIX))
					// grouped sessions repeat the same windows; report each window once
					.filter((r) => (seen.has(r[1]!) ? false : (seen.add(r[1]!), true)))
					.map((r) => ({
						session: r[0],
						window: r[1],
						index: Number(r[2]),
						name: r[3],
						active: r[4] === "1",
						activity: r[5] === "1",
						size: `${r[6]}x${r[7]}`,
						pane: r[8],
						command: r[9],
						cwd: r[10],
						idleSeconds: Math.max(0, Math.round(now - Number(r[11]))),
					}));
				return json({ ok: true, count: windows.length, windows });
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "tmux_read",
		label: "tmux read",
		description:
			"Read what a window is showing: capture-pane of the window's active pane, joined and trimmed. `lines` is how far back into the scrollback to go (0 = just the visible screen). Use a bigger `lines` when you need the context of a long agent turn.",
		parameters: Type.Object({
			window: Type.String({ description: "window id (@12), pane id (%34) or session:index target" }),
			lines: Type.Optional(Type.Number({ description: "scrollback lines to include (default 200, max 20000)" })),
		}),
		async execute(_id, params) {
			try {
				const lines = Math.min(Math.max(params.lines ?? 200, 0), 20000);
				const args = ["capture-pane", "-p", "-J", "-t", params.window];
				if (lines > 0) args.push("-S", String(-lines));
				const out = (await tmux(args)).replace(/\n+$/, "");
				return text(out || "(empty)");
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "tmux_send",
		label: "tmux send",
		description:
			"Type into a window. Text is delivered as a bracketed paste (safe for multi-line prompts) and submitted with Enter unless submit=false. Prefix the text with '!' to send Ctrl-C first (interrupt a running agent, then optionally instruct it). Use keys[] instead for raw key names (Enter, Escape, C-c, Up, PageUp, ...). Same contract as pi-side-agents' agent-send.",
		parameters: Type.Object({
			window: Type.String({ description: "window id (@12), pane id (%34) or session:index target" }),
			text: Type.Optional(Type.String({ description: "text/prompt to type ('!' prefix = interrupt first)" })),
			keys: Type.Optional(Type.Array(Type.String(), { description: "tmux key names, e.g. ['C-c'] or ['Escape']" })),
			submit: Type.Optional(Type.Boolean({ description: "press Enter after the text (default true)" })),
		}),
		async execute(_id, params) {
			try {
				let body = params.text ?? "";
				if (body.startsWith("!")) {
					await tmux(["send-keys", "-t", params.window, "C-c"]);
					await sleep(300);
					body = body.slice(1);
				}
				if (body) {
					await paste(params.window, body);
					if (params.submit !== false) {
						await sleep(150);
						await tmux(["send-keys", "-t", params.window, "Enter"]);
					}
				}
				if (params.keys?.length) await tmux(["send-keys", "-t", params.window, ...params.keys]);
				return json({ ok: true });
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "tmux_open",
		label: "tmux open window",
		description:
			"Open a new tmux window (in the user's main session) at a given cwd, optionally typing a command such as `pi` into its interactive shell. The shell stays underneath the command, so Ctrl-Z works. Returns the new window id/index. To start work: open with command 'pi', wait a moment for the TUI, then tmux_send the prompt.",
		parameters: Type.Object({
			cwd: Type.String({ description: "absolute working directory for the new window" }),
			name: Type.Optional(Type.String({ description: "window name" })),
			command: Type.Optional(Type.String({ description: "command to run (default: the user's shell)" })),
			session: Type.Optional(Type.String({ description: "target session (default: first non-mirror session)" })),
		}),
		async execute(_id, params) {
			try {
				let session = params.session;
				if (!session) {
					const rows = await query(["list-sessions"], ["#{session_name}", "#{session_group}"]);
					const real = rows.map((r) => r[0]!).filter((n) => !n.startsWith(SELF_SESSION_PREFIX));
					session = real[0];
					if (!session) throw new Error("no tmux session found");
				}
				const idx = await query(["list-windows", "-t", `=${session}`], ["#{window_index}"]);
				const next = idx.reduce((m, r) => Math.max(m, Number(r[0])), -1) + 1;
				const args = ["new-window", "-d", "-P", "-F", "#{window_id} #{window_index}", "-t", `=${session}:${next}`, "-c", params.cwd];
				if (params.name) args.push("-n", params.name);
				// Do not pass the command as tmux's pane command: that has no interactive
				// parent shell to regain control when the user presses Ctrl-Z. Start the normal
				// shell first and type into it, exactly like pi-side-agents does.
				const [window, index] = (await tmux(args)).trim().split(/\s+/);
				if (!window || !/^@\d+$/.test(window) || !index || !/^\d+$/.test(index)) {
					throw new Error(`could not parse new tmux window identity: ${window ?? ""} ${index ?? ""}`);
				}
				if (params.command) {
					await waitForShellReady(window);
					// This target is a shell, not a TUI prompt: literal keys avoid bracketed-paste
					// markers becoming command text in shells that do not support that mode.
					await tmux(["send-keys", "-l", "-t", window, params.command]);
					await tmux(["send-keys", "-t", window, "Enter"]);
				}
				return json({ ok: true, session, window, index: Number(index) });
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "client_show",
		label: "show window on client",
		description:
			"Switch the currently active pi-super browser/app from the meta chat to a tmux window. Use this when the user asks to open, show, or take them to work you started. Defaults to the live raw terminal; reader reflows captured output.",
		parameters: Type.Object({
			window: Type.String({ description: "tmux window id returned by tmux_open, e.g. @12" }),
			view: Type.Optional(
				Type.Union([Type.Literal("raw"), Type.Literal("reader")], {
					description: "view to show (default raw)",
				}),
			),
		}),
		async execute(_id, params) {
			if (!/^@\d+$/.test(params.window)) return fail(new Error("window must be a tmux window id such as @12"));
			// pi-super observes this tool's RPC completion and routes it to the one client
			// most recently in the foreground; the extension itself has no browser socket.
			return json({ ok: true, requested: { window: params.window, view: params.view ?? "raw" } });
		},
	});

	pi.registerTool({
		name: "tmux_wait_idle",
		label: "tmux wait",
		description:
			"Block until a window's screen stops changing (an agent finished its turn / a build ended), then return the final screen. Use this instead of polling tmux_read in a loop when you promised the user you would report back.",
		parameters: Type.Object({
			window: Type.String({ description: "window id (@12) or pane id (%34)" }),
			quietSeconds: Type.Optional(Type.Number({ description: "how long the screen must stay unchanged (default 6)" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "give up after this long (default 300, max 3600)" })),
		}),
		async execute(_id, params, signal) {
			try {
				const quiet = Math.max(1, params.quietSeconds ?? 6) * 1000;
				const timeout = Math.min(Math.max(5, params.timeoutSeconds ?? 300), 3600) * 1000;
				const started = Date.now();
				let last = "";
				let lastChange = Date.now();
				while (Date.now() - started < timeout) {
					if (signal?.aborted) return text("(aborted)");
					const screen = await tmux(["capture-pane", "-p", "-J", "-t", params.window]);
					if (screen !== last) {
						last = screen;
						lastChange = Date.now();
					} else if (Date.now() - lastChange >= quiet) {
						return text(`(idle for ${Math.round(quiet / 1000)}s)\n\n${last.replace(/\n+$/, "")}`);
					}
					await sleep(1000);
				}
				return text(`(still busy after ${Math.round(timeout / 1000)}s)\n\n${last.replace(/\n+$/, "")}`);
			} catch (err) {
				return fail(err);
			}
		},
	});

	pi.registerTool({
		name: "speak",
		label: "speak to user",
		description:
			"Say something to the user right now, out of band — it is spoken aloud in voice mode and shown as a notification in text mode. Use it for: an immediate acknowledgement before a long look-around, a progress note while you keep working, and the final answer. Keep it short and conversational (one or two sentences, no markdown, no paths unless asked) — it is going through a text-to-speech voice.",
		parameters: Type.Object({
			message: Type.String({ description: "what to say, in spoken language" }),
			kind: Type.Optional(
				Type.Union([Type.Literal("ack"), Type.Literal("status"), Type.Literal("final")], {
					description: "ack = 'on it', status = progress, final = the answer (default status)",
				}),
			),
		}),
		async execute(_id, params) {
			// pi-super picks this up from the RPC tool_execution_end event and routes it
			// to the phone (voice session and/or chat view). Nothing to do here.
			return json({ ok: true, delivered: params.kind ?? "status" });
		},
	});
}
