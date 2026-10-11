import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	LaneError,
	coordinatorStart,
	laneClose,
	laneList,
	laneOpen,
	laneReviewer,
	modelFamily,
	parseModel,
	piModelArgs,
	readRecord,
	resolveModel,
	runIn,
	sq,
} from "../dist/server/lanes.js";

const FIXTURE = new URL("./fixtures/fake-herdr.mjs", import.meta.url).pathname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- model helpers ---------------------------------------------------------

test("modelFamily reads the first alphabetic token of the bare id", () => {
	assert.equal(modelFamily("gpt-6.1-sol"), "gpt");
	assert.equal(modelFamily("openai-codex/gpt-6.1-sol"), "gpt");
	assert.equal(modelFamily("zai-coding-cn/glm-5.3-flash"), "glm");
	assert.equal(modelFamily("antigravity/gemini-3-8-flash"), "gemini");
	assert.equal(modelFamily("xiaomi-token-plan-cn/mimo-v2.6-flash"), "mimo");
	assert.equal(modelFamily("kimi-k3"), "kimi");
	assert.equal(modelFamily("deepseek-v4"), "deepseek");
	assert.equal(modelFamily("anthropic/claude-x"), "claude");
	assert.equal(modelFamily("zai-coding-cn/glm-5.3-flash:low"), "glm");
});

test("parseModel and piModelArgs", () => {
	assert.deepEqual(parseModel("zai-coding-cn/glm-5.3-flash:low"), {
		provider: "zai-coding-cn",
		model: "glm-5.3-flash",
		thinking: "low",
	});
	assert.deepEqual(parseModel("openai-codex/gpt-6.1-sol"), { provider: "openai-codex", model: "gpt-6.1-sol" });
	assert.throws(() => parseModel("glm-5.3"), /provider\/model/);
	assert.deepEqual(piModelArgs(parseModel("zai-coding-cn/glm-5.3-flash:low")), [
		"--model",
		"zai-coding-cn/glm-5.3-flash",
		"--thinking",
		"low",
	]);
	assert.deepEqual(piModelArgs(parseModel("p/m")), ["--model", "p/m"]);
});

test("resolveModel: specialist wins, class falls back, family excluded, closed on empty", () => {
	const routing = {
		classes: {
			strong: [
				{ provider: "zai-coding-cn", model: "glm-5.3", thinking: "high", available: true },
				{ provider: "openai-codex", model: "gpt-6.1-sol", thinking: "high", available: true },
			],
			balanced: [{ provider: "antigravity", model: "gemini-3-8-flash", available: true }],
		},
		specialists: {
			"epic-reviewer": [
				{ provider: "zai-coding-cn", model: "glm-5.3", available: false },
				{ provider: "deepseek", model: "deepseek-flash", available: true },
			],
			"all-unavailable": [{ provider: "x", model: "m", available: false }],
		},
	};
	assert.deepEqual(resolveModel(routing, { specialist: "epic-reviewer", cls: "strong" }), {
		provider: "deepseek",
		model: "deepseek-flash",
	});
	// absent specialist -> class
	assert.equal(resolveModel(routing, { cls: "balanced" }).model, "gemini-3-8-flash");
	// excludeFamily skips glm inside the class
	assert.equal(resolveModel(routing, { cls: "strong", excludeFamily: "glm" }).model, "gpt-6.1-sol");
	// specialist present but nothing available -> closed, no silent fallback
	assert.throws(() => resolveModel(routing, { specialist: "all-unavailable", cls: "balanced" }), /no available model/);
	// everything excluded -> throws
	assert.throws(() => resolveModel(routing, { cls: "balanced", excludeFamily: "gemini" }), /no available model/);
});

// --- shell quoting ----------------------------------------------------------

test("sq survives quotes, spaces, $ and backticks through bash", async () => {
	for (const s of ["plain", "two words", "it's $HOME `whoami`", 'a"b\'c', "trailing\\"]) {
		const r = await runIn("local", "/", `printf %s ${sq(s)}`);
		assert.equal(r.code, 0);
		assert.equal(r.stdout, s);
	}
});

// --- lanes against the fake herdr + a real temp repo ------------------------

function gitSetup(dir) {
	const repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
	spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
	return repo;
}

function envFor(dir, overrides = {}) {
	const recordsDir = join(dir, "records");
	const stateDir = join(dir, "state");
	const argvLog = join(dir, "herdr-argv.log");
	const routingFile = join(dir, "routing.json");
	writeFileSync(
		routingFile,
		JSON.stringify({
			classes: {
				balanced: [{ provider: "zai-coding-cn", model: "glm-5.3-flash", thinking: "low", available: true }],
				strong: [
					{ provider: "openai-codex", model: "gpt-6.1-sol", thinking: "high", available: true },
					{ provider: "zai-coding-cn", model: "glm-5.3", thinking: "high", available: true },
				],
			},
			specialists: {},
		}),
	);
	const env = {
		herdrBin: FIXTURE,
		recordsDir,
		stateDir,
		routingFile,
		...overrides,
	};
	return { env, recordsDir, stateDir, argvLog };
}

function herdrEnv(dir) {
	// the fixture's own state/argv plumbing via process env
	return { FAKE_HERDR_ARGV_LOG: join(dir, "herdr-argv.log"), FAKE_HERDR_STATE: join(dir, "herdr-state.json") };
}

const argvLines = (file) =>
	(existsSync(file) ? readFileSync(file, "utf8") : "")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l).join(" "));

// lanes need the fake's env vars set globally for the duration of these tests
function withHerdrEnv(dir, fn) {
	const he = herdrEnv(dir);
	const prev = {};
	for (const [k, v] of Object.entries(he)) {
		prev[k] = process.env[k];
		process.env[k] = v;
	}
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			for (const [k, v] of Object.entries(prev)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		});
}

test("laneOpen creates the worktree, tab, agent and a compatible record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-"));
	const repo = gitSetup(dir);
	const { env, recordsDir, argvLog } = envFor(dir);
	await withHerdrEnv(dir, async () => {
		// plan mode: nothing runs
		const planOnly = laneOpen({ issue: "77", repo, base: "HEAD", implModel: "zai-coding-cn/glm-5.3-flash:low" }, env);
		assert.equal(planOnly.plan.blockedBy, undefined);
		assert.equal(planOnly.plan.impl.model, "zai-coding-cn/glm-5.3-flash:low");
		assert.equal(existsSync(argvLog), false, "plan mode ran no herdr command");
		assert.equal(readdirSync(dir).filter((f) => f.includes("worktrees")).length, 0, "plan mode ran no git command");

		const res = await laneOpen({ issue: "77", repo, base: "HEAD", implModel: "zai-coding-cn/glm-5.3-flash:low" }, env).execute();
		assert.equal(res.ok, true);
		assert.equal(res.modelVerified, true, "banner carries the model id");
		const wt = join(dir, "repo-worktrees", "issue-77");
		assert.equal(res.worktree, wt, "worktree resolved from git, not the command output");
		assert.ok(existsSync(wt));
		const rec = JSON.parse(readFileSync(join(recordsDir, "issue-77.json"), "utf8"));
		assert.equal(rec.issue, "77");
		assert.equal(rec.target, "HEAD");
		assert.equal(rec.base, "HEAD");
		assert.equal(rec.workspace, wt);
		assert.equal(rec.branch, "issue-77");
		assert.equal(rec.tab_id, res.tabId);
		assert.equal(rec.impl_pane, res.implPane);
		assert.equal(rec.rev_pane, null);
		assert.equal(rec.impl_agent, "impl-77");
		assert.equal(rec.rev_agent, "rev-77");
		assert.equal(rec.machine, "local");
		assert.equal(rec.impl_kind, "pi");
		assert.equal(rec.impl_model, "zai-coding-cn/glm-5.3-flash:low");
		assert.equal(rec.created_by, "pi-super");
		const calls = argvLines(argvLog);
		assert.ok(calls.some((c) => c.startsWith("tab create --workspace wNEW")));
		assert.ok(calls.some((c) => c === "agent start impl-77 --kind pi --pane wFK:p41 --timeout 60000 -- --model zai-coding-cn/glm-5.3-flash --thinking low -ne"));

		// a second create on a live lane fails closed and touches nothing
		const again = laneOpen({ issue: "77", repo, base: "HEAD" }, env);
		assert.match(String(again.plan.blockedBy), /already exists/);
		const before = argvLines(argvLog).length;
		await assert.rejects(again.execute(), LaneError);
		assert.equal(argvLines(argvLog).length, before, "fail-closed called no herdr");
	});
});

test("laneReviewer picks a cross-family model, refuses explicit same-family, discloses override", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-"));
	const repo = gitSetup(dir);
	const { env, recordsDir, argvLog } = envFor(dir);
	await withHerdrEnv(dir, async () => {
		await laneOpen({ issue: "78", repo, base: "HEAD", implModel: "zai-coding-cn/glm-5.3-flash:low" }, env).execute();
		const res = await laneReviewer({ issue: "78" }, env).execute();
		assert.equal(res.ok, true);
		assert.equal(res.modelVerified, true);
		assert.equal(res.independence, "cross-family");
		// no epic-reviewer specialist in the test routing -> class strong -> first available = gpt
		assert.match(String(res.record.rev_model), /gpt-6\.1-sol/);
		const calls = argvLines(argvLog);
		assert.ok(calls.some((c) => c.startsWith("pane split ")));
		assert.ok(calls.some((c) => c.includes("agent start rev-78 --kind pi") && c.includes("--model openai-codex/gpt-6.1-sol")));

		// explicit same-family is refused
		const same = laneReviewer({ issue: "78", revModel: "zai-coding-cn/glm-5.3:high" }, env);
		assert.match(String(same.plan.rev.modelError), /same family/);
		await assert.rejects(same.execute(), /same family/);

		// allowSameFamily runs but says what it is
		await laneOpen({ issue: "79", repo, base: "HEAD", implModel: "zai-coding-cn/glm-5.3-flash:low" }, env).execute();
		const override = await laneReviewer({ issue: "79", revModel: "zai-coding-cn/glm-5.3:high", allowSameFamily: true }, env).execute();
		assert.equal(override.ok, true);
		assert.equal(override.independence, "context-isolated, not cross-family independent");
	});
});

test("laneClose refuses while busy, force closes, removeWorktree removes a clean tree", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-"));
	const repo = gitSetup(dir);
	const { env, recordsDir } = envFor(dir);
	await withHerdrEnv(dir, async () => {
		const open = await laneOpen(
			{ issue: "80", repo, base: "HEAD", implModel: "zai-coding-cn/glm-5.3-flash:low", prompt: "go" },
			env,
		).execute();
		// the fake flips the agent to working on prompt
		const refused = await laneClose({ issue: "80" }, env).execute();
		assert.equal(refused.ok, false);
		assert.match(refused.error, /busy/);
		const forced = await laneClose({ issue: "80", force: true, removeWorktree: true }, env).execute();
		assert.equal(forced.ok, true);
		assert.equal(forced.worktreeRemoved, true);
		assert.equal(existsSync(open.worktree), false);
		const files = readdirSync(recordsDir);
		assert.ok(files.some((f) => /^issue-80\.closed-.+\.json$/.test(f)), "record archived");
		assert.equal(files.filter((f) => f === "issue-80.json").length, 0, "open record gone");
	});
});

test("laneList joins records with live statuses", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-"));
	const repo = gitSetup(dir);
	const { env } = envFor(dir);
	await withHerdrEnv(dir, async () => {
		await laneOpen({ issue: "81", repo, base: "HEAD", implModel: "zai-coding-cn/glm-5.3-flash:low" }, env).execute();
		const res = await laneList(env);
		assert.equal(res.lanes.length, 1);
		assert.equal(res.lanes[0].issue, "81");
		assert.equal(res.lanes[0].impl.status, "idle");
		assert.equal(res.lanes[0].rev.status, "gone");
	});
});

test("coordinatorStart writes the mandate, builds the pi and hermes argv", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-"));
	const { env, stateDir, argvLog } = envFor(dir);
	const skillDir = join(dir, "skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "# fake skill\n");
	env.skillDir = skillDir;
	await withHerdrEnv(dir, async () => {
		const res = await coordinatorStart(
			{ slug: "t1", cwd: dir, kind: "pi", mandate: "do the e2e thing" },
			env,
		).execute();
		assert.equal(res.ok, true);
		assert.match(res.mandatePath, /mandates\/t1-.+\.md$/);
		assert.equal(readFileSync(res.mandatePath, "utf8"), "do the e2e thing");
		assert.equal(res.modelVerified, true);
		assert.deepEqual(res.args.slice(-2), ["--skill", skillDir]);
		const calls = argvLines(argvLog);
		assert.ok(calls.some((c) => c.includes(`agent start coord-t1 --kind pi`) && c.includes("--model openai-codex/gpt-6.1-sol")));
		assert.ok(
			calls.some(
				(c) => c.startsWith("agent prompt coord-t1 Read the coordinator protocol file") && c.includes(skillDir) && c.includes(res.mandatePath),
			),
		);

		// hermes: exact argv shape, no follow-up prompt
		const before = calls.length;
		const h = await coordinatorStart(
			{ slug: "t2", cwd: dir, kind: "hermes", mandate: "be brief", model: "zai-coding-cn/glm-5.3-flash:low" },
			env,
		).execute();
		assert.equal(h.ok, true);
		assert.deepEqual(h.args, [
			"-p",
			"orchestrator",
			"--provider",
			"zai-coding-cn",
			"-m",
			"glm-5.3-flash",
			"--reasoning",
			"low",
			"chat",
			"--yolo",
			"--query-file",
			h.mandatePath,
		]);
		assert.equal(argvLines(argvLog).length, before + 4, "workspace create + tab + rename + start only, no prompt");

		// name collision fails closed
		await assert.rejects(coordinatorStart({ slug: "t1", cwd: dir, kind: "pi", mandate: "x" }, env).execute(), /already exists/);
		// missing skill fails closed
		await assert.rejects(
			coordinatorStart({ slug: "t3", cwd: dir, kind: "pi", mandate: "x" }, { ...env, skillDir: join(dir, "nope") }).execute(),
			/skill not found/,
		);
		// exactly one mandate form
		await assert.rejects(
			coordinatorStart({ slug: "t4", cwd: dir, kind: "pi", mandate: "a", mandateFile: "/x" }, env).execute(),
			/exactly one/,
		);
	});
});

test("remote laneOpen decides the worktree script on the target machine", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-"));
	const { env, argvLog } = envFor(dir);
	const runCalls = [];
	env.run = async (machine, cwd, command, opts = {}) => {
		runCalls.push({ machine, cwd, command, stdin: opts.stdin });
		if (command === 'printf %s "$HOME"') return { code: 0, stdout: "/home/remoteuser", stderr: "" };
		if (command.includes("new-worktree.sh")) {
			return command.startsWith("test -f") ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: "ok", stderr: "" };
		}
		if (command.includes("worktree list --porcelain")) {
			return { code: 0, stdout: "worktree /remote/repo-worktrees/issue-95\nbranch refs/heads/issue-95\n", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	await withHerdrEnv(dir, async () => {
		const plan = laneOpen({ machine: "korea", issue: "95", repo: "/remote/repo", implModel: "zai-coding-cn/glm-5.3-flash:low" }, env).plan;
		assert.equal(plan.worktree.mode, "script-or-git");
		assert.equal(existsSync(argvLog), false, "remote plan ran no herdr command");
		assert.equal(runCalls.length, 0, "remote plan ran no remote command");

		const res = await laneOpen({ machine: "korea", issue: "95", repo: "/remote/repo", implModel: "zai-coding-cn/glm-5.3-flash:low" }, env).execute();
		assert.equal(res.ok, true);
		assert.equal(res.worktree, "/remote/repo-worktrees/issue-95");
		// the test -f ran on the remote, then the script itself (not the git fallback)
		assert.ok(runCalls.some((c) => c.command === "test -f '/remote/repo/scripts/new-worktree.sh'"), "test -f ran via runner");
		assert.ok(runCalls.some((c) => c.command === "bash scripts/new-worktree.sh 'issue-95' 'origin/main'" && c.cwd === "/remote/repo"), "script ran in repo");
		const calls = argvLines(argvLog);
		assert.ok(calls.some((c) => c.startsWith("--machine korea tab create")), "herdr went through --machine korea");
	});
});

test("remote coordinatorStart resolves $HOME remotely and never passes ~ paths", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-"));
	const { env, argvLog } = envFor(dir);
	const runCalls = [];
	env.run = async (machine, cwd, command, opts = {}) => {
		runCalls.push({ machine, cwd, command, stdin: opts.stdin });
		if (command === 'printf %s "$HOME"') return { code: 0, stdout: "/home/remoteuser", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	await withHerdrEnv(dir, async () => {
		const res = await coordinatorStart(
			{ machine: "korea", slug: "rmt", cwd: "/remote/repo", kind: "pi", mandate: "remote mandate body" },
			env,
		).execute();
		assert.equal(res.ok, true);
		assert.match(res.mandatePath, /^\/home\/remoteuser\/\.pi\/super\/mandates\/rmt-.+\.md$/);
		const startCall = argvLines(argvLog).find((c) => c.includes("agent start coord-rmt"));
		assert.ok(startCall.includes("--skill /home/remoteuser/.hermes/skills/pi-manager-collaborator"), `skill path absolute: ${startCall}`);
		assert.ok(!startCall.split(" ").some((a) => a.startsWith("~")), "no ~ in start argv");
		const promptCall = argvLines(argvLog).find((c) => c.startsWith("--machine korea agent prompt coord-rmt"));
		assert.ok(promptCall.includes("/home/remoteuser/"), "prompt uses the absolute mandate path");
		assert.ok(!promptCall.includes("~"), "no ~ in the prompt");
		const mkdir = runCalls.find((c) => c.command.includes("cat >"));
		assert.equal(mkdir.stdin, "remote mandate body", "mandate uploaded via stdin");
	});
});

test("laneClose keeps the record when tab close fails and the tab still exists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-"));
	const repo = gitSetup(dir);
	const { env, recordsDir } = envFor(dir);
	await withHerdrEnv(dir, async () => {
		await laneOpen({ issue: "96", repo, base: "HEAD", implModel: "zai-coding-cn/glm-5.3-flash:low" }, env).execute();
		process.env.FAKE_TAB_CLOSE_FAIL = "1";
		const res = await laneClose({ issue: "96" }, env).execute();
		assert.equal(res.ok, false);
		assert.match(res.error, /still exists/);
		assert.ok(existsSync(join(recordsDir, "issue-96.json")), "record kept — the lane is still live");
		delete process.env.FAKE_TAB_CLOSE_FAIL;
		const closed = await laneClose({ issue: "96" }, env).execute();
		assert.equal(closed.ok, true);
	});
});

// --- meta agent spawn -------------------------------------------------------

test("meta agent also loads super-lanes.ts and gets PI_SUPER_STATE_DIR", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-lanes-meta-"));
	const file = join(dir, "spawn.json");
	const fake = join(dir, "fake-pi.mjs");
	writeFileSync(
		fake,
		`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(file)}, JSON.stringify({ argv: process.argv.slice(2), env: { PI_SUPER_STATE_DIR: process.env.PI_SUPER_STATE_DIR ?? null } }));
setInterval(() => {}, 1000);
`,
	);
	const shim = join(dir, "pi");
	writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${fake} "$@"\n`, { mode: 0o755 });
	const { MetaAgent } = await import("../dist/server/meta.js");
	const meta = new MetaAgent({
		metaDir: join(import.meta.dirname, "..", "src", "meta"),
		socketArgs: [],
		piBin: shim,
		herdrMachines: ["local"],
		stateDir: "/tmp/pi-super-dev-state",
	});
	meta.start();
	const deadline = Date.now() + 5000;
	while (!existsSync(file) && Date.now() < deadline) await wait(25);
	await meta.stop();
	const spawned = JSON.parse(readFileSync(file, "utf8"));
	assert.ok(spawned.argv.some((a, i) => a === "-e" && /super-lanes\.ts$/.test(spawned.argv[i + 1] ?? "")), "third -e is super-lanes.ts");
	assert.equal(spawned.env.PI_SUPER_STATE_DIR, "/tmp/pi-super-dev-state");
});
