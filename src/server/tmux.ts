import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

// tmux >= 3.4 escapes control characters (\037 etc.) in non-tty output, so a control
// separator is unusable. Newline works instead: tmux sanitises control chars *inside*
// field values too, so a value can never contain a raw newline and break the framing.
const FS = "\n";

export interface TmuxSession {
	id: string;
	name: string;
	windows: number;
	attached: number;
	group: string;
	created: number;
}

export interface TmuxWindow {
	id: string; // @12
	index: number;
	name: string;
	active: boolean;
	panes: number;
	activity: boolean;
	bell: boolean;
	width: number;
	height: number;
	paneId: string; // %34
	paneCmd: string;
	panePid: number;
	paneCwd: string;
	paneTitle: string;
}

export class TmuxError extends Error {}

/** Thin, injection-safe wrapper around the tmux CLI of an *already running* server. */
export class Tmux {
	/** e.g. ["-S", "/tmp/tmux-1000/default"] or ["-L", "mysock"] or [] for default */
	constructor(private readonly socketArgs: string[] = []) {}

	run(args: string[], stdin?: string | Buffer): Promise<string> {
		const argv = [...this.socketArgs, ...args];
		return new Promise((resolve, reject) => {
			const child = execFile(
				"tmux",
				argv,
				// bounded: a wedged tmux server must not pile up children or buffers
				{ maxBuffer: 16 * 1024 * 1024, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" },
				(err, stdout, stderr) => {
					if (err) {
						reject(new TmuxError(`tmux ${argv.join(" ")}: ${String(stderr || err.message).trim()}`));
						return;
					}
					resolve(stdout);
				},
			);
			if (stdin !== undefined) {
				child.stdin?.end(stdin);
			}
		});
	}

	/** Same as run() but resolves to null instead of throwing (for best-effort calls). */
	async tryRun(args: string[], stdin?: string | Buffer): Promise<string | null> {
		try {
			return await this.run(args, stdin);
		} catch {
			return null;
		}
	}

	/** Split newline-per-field output into records of `fields` fields. */
	private static rows(out: string, fields: number): string[][] {
		const lines = out.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		const records: string[][] = [];
		for (let i = 0; i + fields <= lines.length; i += fields) {
			records.push(lines.slice(i, i + fields) as string[]);
		}
		return records;
	}

	async listSessions(): Promise<TmuxSession[]> {
		const f = [
			"#{session_id}",
			"#{session_name}",
			"#{session_windows}",
			"#{session_attached}",
			"#{session_group}",
			"#{session_created}",
		].join(FS);
		const out = await this.tryRun(["list-sessions", "-F", f]);
		if (out === null) return [];
		return Tmux.rows(out, 6).map((r) => ({
			id: r[0]!,
			name: r[1]!,
			windows: Number(r[2]),
			attached: Number(r[3]),
			group: r[4]!,
			created: Number(r[5]),
		}));
	}

	async hasSession(name: string): Promise<boolean> {
		return (await this.tryRun(["has-session", "-t", `=${name}`])) !== null;
	}

	async listWindows(session: string): Promise<TmuxWindow[]> {
		const f = [
			"#{window_id}",
			"#{window_index}",
			"#{window_name}",
			"#{window_active}",
			"#{window_panes}",
			"#{window_activity_flag}",
			"#{window_bell_flag}",
			"#{window_width}",
			"#{window_height}",
			"#{pane_id}",
			"#{pane_current_command}",
			"#{pane_pid}",
			"#{pane_current_path}",
			"#{pane_title}",
		].join(FS);
		const out = await this.run(["list-windows", "-t", `=${session}`, "-F", f]);
		return Tmux.rows(out, 14).map((r) => ({
			id: r[0]!,
			index: Number(r[1]),
			name: r[2]!,
			active: r[3] === "1",
			panes: Number(r[4]),
			activity: r[5] === "1",
			bell: r[6] === "1",
			width: Number(r[7]),
			height: Number(r[8]),
			paneId: r[9]!,
			paneCmd: r[10]!,
			panePid: Number(r[11]),
			paneCwd: r[12]!,
			paneTitle: r[13]!,
		}));
	}

	/** Window that our session currently has selected, plus its geometry. */
	async currentWindow(session: string): Promise<TmuxWindow | undefined> {
		const windows = await this.listWindows(session);
		return windows.find((w) => w.active);
	}

	async capture(target: string, opts: { lines?: number; escapes?: boolean; join?: boolean } = {}): Promise<string> {
		const args = ["capture-pane", "-p", "-t", target];
		if (opts.join !== false) args.push("-J");
		if (opts.escapes) args.push("-e");
		if (opts.lines && opts.lines > 0) args.push("-S", String(-opts.lines));
		return this.run(args);
	}

	/** Paste arbitrary text into a pane using a tmux buffer (safe for any bytes). */
	async pasteText(target: string, text: string, opts: { bracketed?: boolean } = {}): Promise<void> {
		// per-operation buffer name: two clients pasting at once must not interleave
		const buffer = `pi-super-${randomBytes(6).toString("hex")}`;
		await this.run(["load-buffer", "-b", buffer, "-"], text);
		const args = ["paste-buffer", "-d", "-b", buffer, "-t", target];
		if (opts.bracketed !== false) args.push("-p");
		try {
			await this.run(args);
		} finally {
			await this.tryRun(["delete-buffer", "-b", buffer]);
		}
	}

	/** Send tmux key names (Enter, C-c, Up, Escape, ...). */
	async sendKeys(target: string, keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		await this.run(["send-keys", "-t", target, ...keys]);
	}

	async newSessionGrouped(name: string, base: string): Promise<void> {
		await this.run(["new-session", "-d", "-s", name, "-t", `=${base}`]);
	}

	async killSession(name: string): Promise<void> {
		await this.tryRun(["kill-session", "-t", `=${name}`]);
	}

	/** Session-scoped option. The trailing colon matters: `-t =name` is not a valid target here. */
	async setOption(session: string, option: string, value: string): Promise<string | null> {
		return this.tryRun(["set-option", "-t", `=${session}:`, option, value]);
	}

	async selectWindow(session: string, windowId: string): Promise<void> {
		await this.run(["select-window", "-t", `${session}:${windowId}`]);
	}

	async newWindow(
		session: string,
		opts: { cwd?: string; name?: string; command?: string; index?: number } = {},
	): Promise<string> {
		const args = ["new-window", "-P", "-F", "#{window_id}", "-t", `=${session}:${opts.index ?? ""}`];
		if (opts.cwd) args.push("-c", opts.cwd);
		if (opts.name) args.push("-n", opts.name);
		if (opts.command) args.push(opts.command);
		return (await this.run(args)).trim();
	}

	async killWindow(target: string): Promise<void> {
		await this.run(["kill-window", "-t", target]);
	}

	async renameWindow(target: string, name: string): Promise<void> {
		await this.run(["rename-window", "-t", target, name]);
	}

	async version(): Promise<string> {
		return (await this.run(["-V"])).trim();
	}
}
