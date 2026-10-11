#!/usr/bin/env node
/**
 * Fake `herdr` for tests: two machines (local + the saved "korea"), agents in
 * mixed states, canned pane output, and just enough state to answer lane
 * plumbing (tab/pane ids, agent get/read, prompt, send-keys, tab/workspace
 * create+close). Mutating commands log their argv to FAKE_HERDR_ARGV_LOG; a
 * JSON state file at FAKE_HERDR_STATE persists agents/tabs across invocations.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mi = argv.indexOf("--machine");
const machine = mi >= 0 ? argv[mi + 1] : "local";
const args = mi >= 0 ? argv.slice(mi + 2) : argv;
const cmd = args.join(" ");

const logArgv = () => {
	if (process.env.FAKE_HERDR_ARGV_LOG) appendFileSync(process.env.FAKE_HERDR_ARGV_LOG, JSON.stringify(argv) + "\n");
};
const stateFile = process.env.FAKE_HERDR_STATE;
const load = () => (stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { agents: {}, tabs: {}, seq: 40 });
const save = (st) => stateFile && writeFileSync(stateFile, JSON.stringify(st));
const out = (v) => process.stdout.write(JSON.stringify({ id: "cli", result: v }) + "\n");
const fail1 = (code, message) => {
	process.stderr.write(JSON.stringify({ error: { code, message }, id: "cli" }) + "\n");
	process.exit(1);
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

const st = load();

/** the model a prior `agent start` pinned on this agent, for the banner */
const modelOf = (name) => st.agents[name]?.model;
const nameOf = (target) => st.agents[target]?.name ?? target;

if (cmd === "status" || cmd === "--version") {
	process.stdout.write("server:\n  status: running\n  version: 0.9.3\n");
} else if (cmd === "machine list --json") {
	process.stdout.write(
		JSON.stringify([{ id: "kr", label: "korea", target: "user@korea", session: "default", enabled: true, selected: false }]),
	);
} else if (cmd === "api snapshot") {
	process.stdout.write(JSON.stringify({ id: "cli:api:snapshot", result: { snapshot: SNAPSHOT } }));
} else if (args[0] === "pane" && args[1] === "list") {
	out({ panes: st.extraPanes ?? [] });
} else if (args[0] === "pane" && args[1] === "read") {
	process.stdout.write(`${PANE_TEXT}\n`);
} else if (args[0] === "pane" && args[1] === "split") {
	logArgv();
	const pane = `wFK:p${st.seq++}`;
	save(st);
	out({ pane: { pane_id: pane } });
} else if (args[0] === "pane" && args[1] === "rename") {
	logArgv();
	out({ renamed: true });
} else if (args[0] === "workspace" && args[1] === "create") {
	logArgv();
	out({ workspace: { workspace_id: "wNEW" } });
} else if (args[0] === "workspace" && args[1] === "close") {
	logArgv();
	out({ closed: args[2] });
} else if (args[0] === "workspace" && args[1] === "list") {
	out({ workspaces: [{ workspace_id: "wZZ", label: "main" }] });
} else if (args[0] === "tab" && args[1] === "create") {
	logArgv();
	const tabId = `wFK:t${st.seq++}`;
	const pane = `wFK:p${st.seq++}`;
	st.tabs[tabId] = { panes: [pane] };
	save(st);
	out({ tab: { tab_id: tabId }, root_pane: { pane_id: pane } });
} else if (args[0] === "tab" && args[1] === "get") {
	const t = st.tabs[args[2]];
	if (!t) fail1("tab_not_found", `tab ${args[2]} not found`);
	out({ tab: { tab_id: args[2], pane_count: t.panes.length, workspace_id: "wFK" }, type: "tab_info" });
} else if (args[0] === "tab" && args[1] === "close") {
	if (process.env.FAKE_TAB_CLOSE_FAIL === "1") {
		logArgv();
		fail1("io_error", "simulated tab close failure");
	}
	logArgv();
	for (const pane of st.tabs[args[2]]?.panes ?? []) {
		for (const [n, a] of Object.entries(st.agents)) if (a.pane === pane) delete st.agents[n];
	}
	delete st.tabs[args[2]];
	save(st);
	out({ closed: args[2] });
} else if (args[0] === "agent" && args[1] === "start") {
	logArgv();
	const name = args[2];
	const kind = args[args.indexOf("--kind") + 1];
	const pane = args[args.indexOf("--pane") + 1];
	const mi2 = argv.indexOf("--");
	const agentArgs = mi2 >= 0 ? argv.slice(mi2 + 1) : [];
	const model = agentArgs.includes("--model") ? agentArgs[agentArgs.indexOf("--model") + 1] : undefined;
	st.agents[name] = { name, kind, pane, status: "idle", model, agentArgs };
	save(st);
	out({ agent: { name, kind, pane_id: pane } });
} else if (args[0] === "agent" && args[1] === "read") {
	const model = modelOf(args[2]);
	const banner = model ? `pi — model ${model}\nthinking: ${argv.includes("--thinking") ? argv[argv.indexOf("--thinking") + 1] : "high"}\n` : "";
	process.stdout.write(`${banner}${PANE_TEXT}\n`);
} else if (args[0] === "agent" && args[1] === "get") {
	const a = st.agents[nameOf(args[2])];
	if (!a) fail1("agent_not_found", `agent target ${args[2]} not found`);
	out({ agent: { agent: a.kind, name: a.name, agent_status: a.status, pane_id: a.pane }, type: "agent_info" });
} else if (args[0] === "agent" && args[1] === "prompt") {
	logArgv();
	const a = st.agents[nameOf(args[2])];
	if (a) a.status = "working";
	save(st);
	out({ status: "working" });
} else if (args[0] === "agent" && args[1] === "send-keys") {
	logArgv();
	out({ sent: true });
} else {
	fail1("unknown_command", `fake-herdr: ${cmd}`);
}
