import { randomBytes } from "node:crypto";
import pty from "node-pty";
import { Tmux } from "./tmux.js";

export type SizeMode = "ignore" | "claim";

export interface TermOptions {
	/** base tmux session we mirror (its windows are shared with us) */
	base: string;
	/** show tmux's own status line inside the terminal view */
	statusLine: boolean;
	socketArgs: string[];
	onData: (chunk: Buffer) => void;
	onGeometry: (cols: number, rows: number) => void;
	onExit: (info: { exitCode: number; signal?: number }) => void;
}

export const SESSION_PREFIX = "pisuper-";

/**
 * One browser connection == one tmux session *grouped with* the base session.
 *
 * Grouped sessions share the window list and the processes, but have their own
 * "current window", so the phone can browse independently of the desktop client.
 * We only ever kill our own session; the base session is never touched.
 */
export class TermConnection {
	readonly sessionName: string;
	private proc: pty.IPty | undefined;
	private cols = 80;
	private rows = 24;
	private sizeMode: SizeMode = "ignore";
	private disposed = false;

	constructor(
		private readonly tmux: Tmux,
		private readonly opts: TermOptions,
	) {
		this.sessionName = `${SESSION_PREFIX}${randomBytes(4).toString("hex")}`;
	}

	get mode(): SizeMode {
		return this.sizeMode;
	}

	get geometry(): { cols: number; rows: number } {
		return { cols: this.cols, rows: this.rows };
	}

	async start(cols: number, rows: number, sizeMode: SizeMode): Promise<void> {
		this.cols = Math.max(20, cols);
		this.rows = Math.max(5, rows);
		this.sizeMode = sizeMode;
		await this.tmux.newSessionGrouped(this.sessionName, this.opts.base);
		// Session-scoped options: they only affect clients attached to *our* session.
		if (!this.opts.statusLine) await this.tmux.setOption(this.sessionName, "status", "off");
		await this.tmux.setOption(this.sessionName, "detach-on-destroy", "on");
		await this.spawn();
	}

	/** (Re)spawn the tmux client process; used on start and on size-mode change. */
	private async spawn(): Promise<void> {
		if (this.sizeMode === "ignore") {
			const geom = await this.windowGeometry();
			if (geom) {
				this.cols = geom.cols;
				this.rows = geom.rows + (this.opts.statusLine ? 1 : 0);
			}
		}
		const args = [...this.opts.socketArgs, "-u", "attach-session", "-t", `=${this.sessionName}`];
		if (this.sizeMode === "ignore") args.push("-f", "ignore-size");

		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined && k !== "TMUX" && k !== "TMUX_PANE") env[k] = v;
		}
		env.TERM = "xterm-256color";

		const proc = pty.spawn("tmux", args, {
			name: "xterm-256color",
			cols: this.cols,
			rows: this.rows,
			cwd: process.env.HOME ?? "/",
			env,
		});
		this.proc = proc;
		proc.onData((d) => {
			if (!this.disposed) this.opts.onData(Buffer.from(d, "utf8"));
		});
		proc.onExit((e) => {
			if (this.proc === proc && !this.disposed) this.opts.onExit({ exitCode: e.exitCode, signal: e.signal });
		});
		this.opts.onGeometry(this.cols, this.rows);
	}

	/**
	 * Size of the window our session currently shows (as decided by the other clients).
	 * `display-message -p` yields empty width/height for a session with no client attached,
	 * so we read it off list-windows instead.
	 */
	private async windowGeometry(): Promise<{ cols: number; rows: number } | undefined> {
		try {
			const win = await this.tmux.currentWindow(this.sessionName);
			if (!win || !win.width || !win.height) return undefined;
			return { cols: win.width, rows: win.height };
		} catch {
			return undefined;
		}
	}

	write(data: string | Buffer): void {
		this.proc?.write(typeof data === "string" ? data : data.toString("utf8"));
	}

	/** Browser viewport changed. Only honoured in "claim" mode. */
	resize(cols: number, rows: number): void {
		if (this.sizeMode !== "claim" || !this.proc) return;
		this.cols = Math.max(20, cols);
		this.rows = Math.max(5, rows);
		try {
			this.proc.resize(this.cols, this.rows);
		} catch {
			/* pty may have died */
		}
		this.opts.onGeometry(this.cols, this.rows);
	}

	async setSizeMode(mode: SizeMode, cols: number, rows: number): Promise<void> {
		if (mode === this.sizeMode) return;
		this.sizeMode = mode;
		if (mode === "claim") {
			this.cols = Math.max(20, cols);
			this.rows = Math.max(5, rows);
		}
		const old = this.proc;
		this.proc = undefined;
		old?.kill();
		await this.spawn();
	}

	/** In ignore-size mode the window may be resized by other clients; follow it. */
	async syncGeometry(): Promise<void> {
		if (this.sizeMode !== "ignore" || !this.proc) return;
		const geom = await this.windowGeometry();
		if (!geom) return;
		const rows = geom.rows + (this.opts.statusLine ? 1 : 0);
		if (geom.cols === this.cols && rows === this.rows) return;
		this.cols = geom.cols;
		this.rows = rows;
		try {
			this.proc.resize(this.cols, this.rows);
		} catch {
			/* ignore */
		}
		this.opts.onGeometry(this.cols, this.rows);
		// Force a full redraw so the client sees the new geometry filled in.
		await this.tmux.tryRun(["refresh-client", "-t", `=${this.sessionName}`]);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const proc = this.proc;
		this.proc = undefined;
		proc?.kill();
		await this.tmux.killSession(this.sessionName);
	}
}

/** Kill leftover pi-super sessions with no client attached (from crashes/reloads). */
export async function sweepStaleSessions(tmux: Tmux, keep: Set<string>): Promise<number> {
	const sessions = await tmux.listSessions();
	let killed = 0;
	for (const s of sessions) {
		if (!s.name.startsWith(SESSION_PREFIX)) continue;
		if (keep.has(s.name)) continue;
		if (s.attached > 0) continue;
		await tmux.killSession(s.name);
		killed++;
	}
	return killed;
}
