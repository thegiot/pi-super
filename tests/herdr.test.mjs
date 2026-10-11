import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../dist/server/config.js";
import { HerdrError, LOCAL, agentsFromSnapshot, fleetAgents, herdrRun, savedMachines } from "../dist/server/herdr.js";

// --- agentsFromSnapshot ----------------------------------------------------

const SNAPSHOT = {
	agents: [
		{
			agent: "devin",
			agent_status: "working",
			pane_id: "wZZ:p48",
			tab_id: "wZZ:t3A",
			workspace_id: "wZZ",
			cwd: "/workspace/tools/pi-super",
			terminal_title_stripped: "devin: building things",
			focused: false,
			state_change_seq: 42,
		},
		{
			agent: "pi",
			name: "reviewer",
			agent_status: "blocked",
			pane_id: "wAA:p10",
			tab_id: "wAA:t11",
			workspace_id: "wAA",
			cwd: "/workspace/giot-mono",
			terminal_title_stripped: "pi: giot-mono",
			focused: true,
		},
		{
			agent: "hermes",
			agent_status: "idle",
			pane_id: "wZZ:p46",
			tab_id: "wZZ:t39",
			workspace_id: "wZZ",
			cwd: "/workspace/caelus-pilot",
			terminal_title_stripped: "hermes dashboard",
			focused: false,
		},
		{
			agent: "codex",
			agent_status: "done",
			pane_id: "wAA:p12",
			tab_id: "wAA:t13",
			workspace_id: "wAA",
			cwd: "/workspace/other",
			terminal_title_stripped: "codex",
			focused: false,
		},
		{
			agent: "claude",
			agent_status: "unknown",
			pane_id: "wAA:p14",
			tab_id: "wAA:t13",
			workspace_id: "wAA",
			cwd: "/workspace/other",
			terminal_title_stripped: "claude",
			focused: false,
		},
	],
	workspaces: [
		{ workspace_id: "wZZ", label: "main", number: 1 },
		{ workspace_id: "wAA", label: "review", number: 2 },
	],
	tabs: [
		{ tab_id: "wZZ:t39", label: "dash", number: 1 },
		{ tab_id: "wZZ:t3A", label: "pi-super", number: 2 },
		{ tab_id: "wAA:t11", label: "mono", number: 1 },
		{ tab_id: "wAA:t13", label: "misc", number: 2 },
	],
	panes: [{ pane_id: "wAA:p10", label: "the reviewer" }],
};

test("agentsFromSnapshot joins labels and sorts for scanning", () => {
	const agents = agentsFromSnapshot("local", SNAPSHOT);
	assert.equal(agents.length, 5);
	assert.deepEqual(
		agents.map((a) => a.status),
		["blocked", "working", "done", "idle", "unknown"],
		"blocked first, then working, done, idle, unknown",
	);
	const blocked = agents[0];
	assert.equal(blocked.name, "reviewer");
	assert.equal(blocked.workspace, "review");
	assert.equal(blocked.tab, "mono");
	assert.equal(blocked.paneLabel, "the reviewer");
	assert.equal(blocked.machine, "local");
	const working = agents[1];
	assert.equal(working.name, undefined, "unnamed agents carry no name");
	assert.equal(working.workspace, "main");
	assert.equal(working.tab, "pi-super");
	assert.equal(working.stateChangeSeq, 42);
	assert.equal(working.title, "devin: building things");
	// same-status ties order by workspace then tab: done(wAA) before idle(wZZ)?
	assert.equal(agents[2].status, "done");
	assert.equal(agents[3].status, "idle");
});

// --- fake herdr bin --------------------------------------------------------

function makeFakeHerdr(dir) {
	const argvLog = join(dir, "argv.log");
	const pidFile = join(dir, "child.pid");
	const fake = join(dir, "fake-herdr.mjs");
	writeFileSync(
		fake,
		`import { appendFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
const mi = argv.indexOf("--machine");
const machine = mi >= 0 ? argv[mi + 1] : "local";
const cmd = (mi >= 0 ? argv.slice(mi + 2) : argv).join(" ");
if (cmd === "sleep") {
	writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
	setInterval(() => {}, 1000);
} else if (cmd === "agent get nosuch") {
	process.stderr.write(JSON.stringify({ error: { code: "agent_not_found", message: "agent target nosuch not found" }, id: "cli:agent:get" }) + "\\n");
	process.exit(1);
} else if (cmd === "bogus") {
	process.stderr.write("error: unrecognized subcommand\\n");
	process.exit(2);
} else if (cmd === "machine list --json") {
	process.stdout.write(JSON.stringify([{ id: "1", label: "korea", enabled: true }, { id: "2", label: "off", enabled: false }]));
} else if (cmd === "api snapshot") {
	if (machine === "failm") {
		process.stderr.write(JSON.stringify({ error: { code: "ssh_failed", message: "ssh timed out" } }) + "\\n");
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({ id: "cli:api:snapshot", result: { snapshot: { agents: [], workspaces: [], tabs: [], panes: [] } } }));
} else {
	process.stdout.write("{}\\n");
}
`,
	);
	// a shell shim so the fake takes herdr's real argv (same trick as the fake pi shims)
	const bin = join(dir, "herdr");
	writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${fake} "$@"\n`, { mode: 0o755 });
	return { bin, argvLog, pidFile };
}

test("herdrRun puts --machine first for remote and omits it for local", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-herdr-"));
	const { bin, argvLog } = makeFakeHerdr(dir);
	await herdrRun("korea", ["agent", "list"], { bin });
	await herdrRun(LOCAL, ["agent", "list"], { bin });
	const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(calls[0], ["--machine", "korea", "agent", "list"]);
	assert.deepEqual(calls[1], ["agent", "list"]);
});

test("exit 1 with JSON stderr becomes a HerdrError with the herdr code", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-herdr-"));
	const { bin } = makeFakeHerdr(dir);
	await assert.rejects(herdrRun("korea", ["agent", "get", "nosuch"], { bin }), (err) => {
		assert.ok(err instanceof HerdrError);
		assert.equal(err.code, "agent_not_found");
		assert.equal(err.machine, "korea");
		assert.match(err.message, /not found/);
		return true;
	});
});

test("exit 2 (syntax error) becomes a cli_error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-herdr-"));
	const { bin } = makeFakeHerdr(dir);
	await assert.rejects(herdrRun(LOCAL, ["bogus"], { bin }), (err) => {
		assert.ok(err instanceof HerdrError);
		assert.equal(err.code, "cli_error");
		return true;
	});
});

test("a timeout kills the child and rejects with HerdrError timeout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-herdr-"));
	const { bin, pidFile } = makeFakeHerdr(dir);
	const run = herdrRun(LOCAL, ["sleep"], { bin, timeoutMs: 300 });
	const deadline = Date.now() + 5000;
	while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	await assert.rejects(run, (err) => {
		assert.ok(err instanceof HerdrError);
		assert.equal(err.code, "timeout");
		return true;
	});
	const pid = Number(readFileSync(pidFile, "utf8"));
	// the SIGKILLed child stays a zombie until spawn reaps it; wait that out
	const reapDeadline = Date.now() + 3000;
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	while (alive() && Date.now() < reapDeadline) await new Promise((r) => setTimeout(r, 25));
	assert.ok(!alive(), "the timed-out child must be dead");
});

test("fleetAgents degrades a failing machine instead of rejecting", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-herdr-"));
	const { bin } = makeFakeHerdr(dir);
	const fleet = await fleetAgents([LOCAL, "failm"], { bin });
	assert.equal(fleet.length, 2);
	assert.deepEqual(fleet[0], { machine: LOCAL, ok: true, agents: [] });
	assert.equal(fleet[1].machine, "failm");
	assert.equal(fleet[1].ok, false);
	assert.match(fleet[1].error, /ssh timed out/);
	assert.deepEqual(fleet[1].agents, []);
});

test("savedMachines returns enabled labels only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-herdr-"));
	const { bin } = makeFakeHerdr(dir);
	assert.deepEqual(await savedMachines({ bin }), ["korea"]);
});

// --- config -----------------------------------------------------------------

test("herdr flags parse into config", () => {
	const def = parseArgs([]);
	assert.equal(def.herdrEnabled, true);
	assert.equal(def.herdrMachines, "auto");
	assert.equal(def.herdrBin, undefined);
	const explicit = parseArgs(["--herdr-machines", "a,b", "--herdr-bin", "/opt/herdr"]);
	assert.equal(explicit.herdrMachines, "a,b");
	assert.equal(explicit.herdrBin, "/opt/herdr");
	assert.equal(parseArgs(["--no-herdr"]).herdrEnabled, false);
});

// --- meta agent spawn -------------------------------------------------------

function makeFakePi(dir) {
	const file = join(dir, "spawn.json");
	const fake = join(dir, "fake-pi.mjs");
	writeFileSync(
		fake,
		`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(file)}, JSON.stringify({
	argv: process.argv.slice(2),
	env: {
		PI_SUPER_HERDR_MACHINES: process.env.PI_SUPER_HERDR_MACHINES ?? null,
		PI_SUPER_HERDR_BIN: process.env.PI_SUPER_HERDR_BIN ?? null,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID ?? null,
		HERDR_TAB_ID: process.env.HERDR_TAB_ID ?? null,
		HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID ?? null,
		HERDR_ENV: process.env.HERDR_ENV ?? null,
		HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH ?? null,
	},
}));
setInterval(() => {}, 1000);
`,
	);
	const shim = join(dir, "pi");
	writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${fake} "$@"\n`, { mode: 0o755 });
	return { shim, file };
}

test("meta agent gets the herdr extension and a scrubbed herdr env", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-herdr-meta-"));
	const { shim, file } = makeFakePi(dir);
	const prev = {
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
		HERDR_TAB_ID: process.env.HERDR_TAB_ID,
		HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
		HERDR_ENV: process.env.HERDR_ENV,
	};
	process.env.HERDR_PANE_ID = "wX:p1";
	process.env.HERDR_TAB_ID = "wX:t1";
	process.env.HERDR_WORKSPACE_ID = "wX";
	process.env.HERDR_ENV = "1";
	try {
		const { MetaAgent } = await import("../dist/server/meta.js");
		const meta = new MetaAgent({
			metaDir: join(import.meta.dirname, "..", "src", "meta"),
			socketArgs: [],
			piBin: shim,
			herdrMachines: ["local", "korea"],
			herdrBin: "/opt/herdr",
		});
		meta.start();
		const deadline = Date.now() + 5000;
		while (!existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		await meta.stop();
		const spawned = JSON.parse(readFileSync(file, "utf8"));
		const ext = spawned.argv[spawned.argv.indexOf("-e") + 1];
		assert.match(ext, /super-meta\.ts$/);
		const second = spawned.argv.indexOf("-e", spawned.argv.indexOf("-e") + 1);
		assert.match(spawned.argv[second + 1], /super-herdr\.ts$/, "second -e loads the herdr extension");
		assert.equal(spawned.env.PI_SUPER_HERDR_MACHINES, "local,korea");
		assert.equal(spawned.env.PI_SUPER_HERDR_BIN, "/opt/herdr");
		assert.equal(spawned.env.HERDR_PANE_ID, null, "a herdr-pane identity must never leak to the meta agent");
		assert.equal(spawned.env.HERDR_TAB_ID, null);
		assert.equal(spawned.env.HERDR_WORKSPACE_ID, null);
		assert.equal(spawned.env.HERDR_ENV, null);
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("meta agent without herdrMachines gets no herdr extension", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-herdr-meta-"));
	const { shim, file } = makeFakePi(dir);
	const { MetaAgent } = await import("../dist/server/meta.js");
	const meta = new MetaAgent({
		metaDir: join(import.meta.dirname, "..", "src", "meta"),
		socketArgs: [],
		piBin: shim,
	});
	meta.start();
	const deadline = Date.now() + 5000;
	while (!existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	await meta.stop();
	const spawned = JSON.parse(readFileSync(file, "utf8"));
	assert.ok(!spawned.argv.some((a) => String(a).includes("super-herdr")), "no herdr extension");
	assert.equal(spawned.env.PI_SUPER_HERDR_MACHINES, null);
});
