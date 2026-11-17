import { spawn } from "node:child_process";
import { AssistantError } from "./assistant.js";

/** No shell, bounded private diagnostics, and a deadline that also reaps descendants. */
export function runAssistantProcess(args: {
	command: string;
	argv: string[];
	input?: string;
	cwd: string;
	timeoutMs?: number;
	maxBytes?: number;
	env?: NodeJS.ProcessEnv;
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(args.command, args.argv, { cwd: args.cwd, env: args.env ?? process.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let failure: AssistantError | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		let drain: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const signal = (value: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value);
				else child.kill(value);
			} catch { /* The process group may already have exited. */ }
		};
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(escalation);
			clearTimeout(drain);
			// A successful launcher can leave a child holding its pipes open.
			signal("SIGKILL");
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			if (failure || code !== 0) reject(failure ?? new AssistantError("assistant_failed"));
			else resolve(Buffer.concat(chunks).toString("utf8"));
		};
		const stop = (error: AssistantError) => {
			if (failure || settled) return;
			failure = error;
			signal("SIGTERM");
			// Hermes uses SIGTERM to interrupt tool processes before it exits.
			escalation = setTimeout(() => { signal("SIGKILL"); finish(null); }, 2500);
		};
		const deadline = setTimeout(() => stop(new AssistantError("assistant_timeout")), args.timeoutMs ?? 120_000);
		const collect = (chunk: Buffer, stdout: boolean) => {
			bytes += chunk.length;
			if (bytes > (args.maxBytes ?? 2 * 1024 * 1024)) stop(new AssistantError("assistant_failed"));
			else if (stdout && !failure) chunks.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
		child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
		child.stdin.on("error", () => stop(new AssistantError("assistant_failed")));
		child.on("error", () => { failure = new AssistantError("assistant_unconfigured"); finish(null); });
		child.on("exit", (code) => {
			signal("SIGKILL");
			// Keep already-written protocol records until close drains the pipes.
			drain = setTimeout(() => finish(code), 1000);
		});
		child.on("close", (code) => finish(code));
		child.stdin.end(args.input ?? "");
	});
}
