#!/usr/bin/env node
/**
 * Fake `herdr` for the mobile-shots harness: two machines (local + the saved
 * "korea"), five agents in mixed states, canned pane output. Mutating commands
 * log their argv to FAKE_HERDR_ARGV_LOG so the test can prove they arrived.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mi = argv.indexOf("--machine");
const machine = mi >= 0 ? argv[mi + 1] : "local";
const args = mi >= 0 ? argv.slice(mi + 2) : argv;
const cmd = args.join(" ");

const logArgv = () => {
	if (process.env.FAKE_HERDR_ARGV_LOG) appendFileSync(process.env.FAKE_HERDR_ARGV_LOG, JSON.stringify(argv) + "\n");
};

const agent = (kind, status, pane_id, extra = {}) => ({
	agent: kind,
	agent_status: status,
	pane_id,
	tab_id: "wZZ:t39",
	workspace_id: "wZZ",
	cwd: "/home/user/workspace/giot-factory",
	terminal_title_stripped: `${kind} on ${pane_id}`,
	focused: false,
	...extra,
});

const LOCAL_AGENTS = [
	agent("pi", "blocked", "wZZ:p41", {
		name: "rev-412",
		terminal_title_stripped: "pi: reviewing issue 412 — fix the retry loop",
	}),
	agent("pi", "working", "wZZ:p42", { name: "impl-412", terminal_title_stripped: "pi: implementing issue 412" }),
	agent("hermes", "done", "wZZ:p43", {
		name: "dashboard",
		terminal_title_stripped:
			"hermes dashboard finished: rebuilt the agent overview with a very long title that must ellipsize on a phone",
	}),
	agent("devin", "idle", "wZZ:p44", { name: "sidekick", terminal_title_stripped: "devin: waiting" }),
];
const KOREA_AGENTS = [agent("codex", "working", "wKR:p7", { terminal_title_stripped: "codex: fleet work" })];

const SNAPSHOT = {
	agents: machine === "korea" ? KOREA_AGENTS : LOCAL_AGENTS,
	workspaces: [{ workspace_id: "wZZ", label: "giot-factory", number: 1 }],
	tabs: [{ tab_id: "wZZ:t39", label: "issue-412", number: 1 }],
	panes: LOCAL_AGENTS.map((a) => ({ pane_id: a.pane_id, label: a.name })),
	layouts: [],
};

const PANE_TEXT = Array.from({ length: 40 }, (_, i) =>
	i === 39 ? "❯ waiting for your review decision" : `line ${i + 1}: building workspace giot-factory, check ${i + 1} passed`,
).join("\n");

if (cmd === "status" || cmd === "--version") {
	process.stdout.write("server:\n  status: running\n  version: 0.9.3\n");
} else if (cmd === "machine list --json") {
	process.stdout.write(
		JSON.stringify([{ id: "kr", label: "korea", target: "user@korea", session: "default", enabled: true, selected: false }]),
	);
} else if (cmd === "api snapshot") {
	process.stdout.write(JSON.stringify({ id: "cli:api:snapshot", result: { snapshot: SNAPSHOT } }));
} else if (args[0] === "pane" && args[1] === "read") {
	process.stdout.write(`${PANE_TEXT}\n`);
} else if (args[0] === "agent" && args[1] === "read") {
	process.stdout.write(`${PANE_TEXT}\n`);
} else if (args[0] === "agent" && args[1] === "prompt") {
	logArgv();
	process.stdout.write(JSON.stringify({ id: "cli:agent:prompt", result: { status: "working" } }));
} else if (args[0] === "agent" && args[1] === "send-keys") {
	logArgv();
	process.stdout.write(JSON.stringify({ id: "cli:agent:send-keys", result: { sent: true } }));
} else if (args[0] === "agent" && args[1] === "get") {
	process.stdout.write(JSON.stringify({ id: "cli:agent:get", result: { agent: LOCAL_AGENTS.find((a) => a.pane_id === args[2]) ?? null, type: "agent_info" } }));
} else {
	process.stderr.write(JSON.stringify({ error: { code: "unknown_command", message: `fake-herdr: ${cmd}` } }) + "\n");
	process.exit(1);
}
