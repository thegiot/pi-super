import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
	host: string;
	port: number;
	socketArgs: string[];
	baseSession: string | undefined; // undefined => auto-detect at request time
	stateDir: string;
	statusLine: boolean;
	clientDir: string;
	allowedOrigins: string[] | undefined; // undefined => same-host only
}

export interface ParsedArgs extends Config {
	printUrl: boolean;
	help: boolean;
	resetToken: boolean;
}

const HELP = `pi-super — mobile meta-interface to an existing tmux server

Usage: pi-super [options]

Options:
  -p, --port <n>          Port to listen on (default 8722)
  -H, --host <addr>       Bind address (default 127.0.0.1; use 0.0.0.0 at your own risk)
  -s, --session <name>    Base tmux session to mirror (default: first non-pi-super session)
  -S, --socket-path <p>   tmux socket path (tmux -S)
  -L, --socket-name <n>   tmux socket name (tmux -L)
      --state-dir <dir>   State/uploads/token dir (default ~/.pi-super)
      --status-line       Show tmux's own status line inside the terminal view
      --origin <url>      Extra allowed WebSocket Origin (repeatable)
      --reset-token       Generate a fresh access token and exit
      --url               Print the access URL and exit
  -h, --help              Show this help
`;

export function parseArgs(argv: string[]): ParsedArgs {
	const cfg: ParsedArgs = {
		host: process.env.PI_SUPER_HOST ?? "127.0.0.1",
		port: Number(process.env.PI_SUPER_PORT ?? 8722),
		socketArgs: [],
		baseSession: process.env.PI_SUPER_SESSION,
		stateDir: process.env.PI_SUPER_STATE_DIR ?? join(homedir(), ".pi-super"),
		statusLine: false,
		clientDir: "",
		allowedOrigins: undefined,
		printUrl: false,
		help: false,
		resetToken: false,
	};
	const origins: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} requires a value`);
			return v;
		};
		switch (a) {
			case "-p":
			case "--port":
				cfg.port = Number(next());
				break;
			case "-H":
			case "--host":
				cfg.host = next();
				break;
			case "-s":
			case "--session":
				cfg.baseSession = next();
				break;
			case "-S":
			case "--socket-path":
				cfg.socketArgs = ["-S", next()];
				break;
			case "-L":
			case "--socket-name":
				cfg.socketArgs = ["-L", next()];
				break;
			case "--state-dir":
				cfg.stateDir = next();
				break;
			case "--status-line":
				cfg.statusLine = true;
				break;
			case "--origin":
				origins.push(next());
				break;
			case "--reset-token":
				cfg.resetToken = true;
				break;
			case "--url":
				cfg.printUrl = true;
				break;
			case "-h":
			case "--help":
				cfg.help = true;
				break;
			default:
				throw new Error(`unknown option: ${a}`);
		}
	}
	if (origins.length > 0) cfg.allowedOrigins = origins;
	if (!Number.isFinite(cfg.port) || cfg.port <= 0 || cfg.port > 65535) throw new Error("invalid --port");
	return cfg;
}

export function helpText(): string {
	return HELP;
}

/** dist/server/config.js -> dist/client */
export function defaultClientDir(moduleDir: string): string {
	const candidates = [join(moduleDir, "..", "client"), join(moduleDir, "..", "..", "dist", "client")];
	for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
	return candidates[0]!;
}
