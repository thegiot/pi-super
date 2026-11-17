import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Assistant, buildContext } from "../dist/server/inbox/assistant.js";
import { AssistantEngines, hermesPolicyCommand, parseRuntimeAnswer } from "../dist/server/inbox/assistant-engines.js";
import { discoverAssistantCatalog, runtimePaths } from "../dist/server/inbox/assistant-catalog.js";
import { AssistantSettings } from "../dist/server/inbox/assistant-settings.js";
import { runAssistantProcess } from "../dist/server/inbox/assistant-process.js";
import { parseArgs } from "../dist/server/config.js";
import { createServer } from "../dist/server/server.js";
import { startFakeBeeper } from "./fixtures/fake-beeper.mjs";
import { startFakeLlm, GOOD_ANSWER } from "./fixtures/fake-llm.mjs";

const defaultSelection = { engine: "flash", provider: "responses", model: "glm-5.3-flash" };
const piSelection = { engine: "pi", provider: "test-provider", model: "test-model" };
const hermesSelection = { ...piSelection, engine: "hermes" };
const catalog = { default: defaultSelection, engines: [defaultSelection, piSelection, hermesSelection].map(s => ({ id: s.engine, label: s.engine, available: true, models: [{ provider: s.provider, id: s.model, label: s.model }], default: { provider: s.provider, model: s.model } })) };
const answer = { reply: "synthetic reply", draftText: "synthetic draft", draftLanguage: "it", model: "test-model" };
const context = buildContext({ meta: { title: "synthetic", network: "test", type: "single", participantCount: 1, needsReply: false, reasons: [], incomplete: false }, messages: [] });
const request = { prompt: "Riassumi", history: [], context };
const error = code => err => err.code === code;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function temp(t) {
	const dir = mkdtempSync(join(tmpdir(), "inbox-engines-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function executable(dir, name, script) {
	const file = join(dir, name);
	writeFileSync(file, `#!${process.execPath}\n${script}`, { mode: 0o700 });
	return file;
}

test("Hermes invocation policy rejects tool escapes and reads skills without evaluation", async () => {
	await runAssistantProcess({ command: "python3", argv: ["tests/inbox-hermes-policy.py"], cwd: process.cwd(), timeoutMs: 10_000 });
});

test("settings persist only metadata, reload privately, and invalidate A-B-A", t => {
	const file = join(temp(t), "settings.json");
	const store = new AssistantSettings(file, () => {});
	assert.deepEqual(store.get("c", defaultSelection), defaultSelection);
	store.set("c", piSelection);
	store.set("c", hermesSelection);
	store.set("c", piSelection);
	assert.equal(store.revision("c"), 3);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(new AssistantSettings(file, () => {}).get("c", defaultSelection), piSelection);
	assert.deepEqual(JSON.parse(readFileSync(file)), { version: 1, chats: { c: piSelection } });
});

test("local Pi catalog whitelists identifiers and authenticated providers without spawning Pi", async t => {
	const dir = temp(t);
	writeFileSync(join(dir, "models-store.json"), JSON.stringify({ known: { apiKey: "SECRET", models: [{ id: "m", name: "Model", apiKey: "SECRET", baseUrl: "secret-host" }, { id: "--bad" }] }, unauthenticated: { models: [{ id: "hidden" }] } }));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ known: { key: "SECRET" } }));
	const piBin = executable(dir, "pi", 'throw Error("catalog must never launch Pi")');
	const options = await discoverAssistantCatalog({ model: "flash-model", flashAvailable: true, paths: runtimePaths({ piAgentDir: dir, piBin, hermesBin: "/absent" }) });
	assert.deepEqual(options.engines[1].models, [{ provider: "known", id: "m", label: "Model" }]);
	assert.equal(options.engines[1].available, true);
	assert.equal(options.engines[2].available, false);
	assert.doesNotMatch(JSON.stringify(options), /SECRET|secret-host|unauthenticated/);
});

test("runtime protocol consumes final records, requires Hermes guard, rejects errors and incomplete output", () => {
	const text = JSON.stringify(GOOD_ANSWER);
	const pi = [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }, { type: "agent_settled", aborted: false }].map(JSON.stringify).join("\n");
	assert.equal(parseRuntimeAnswer(pi, "pi").reply, GOOD_ANSWER.reply);
	const hermes = [{ type: "inbox_policy", version: 1 }, { type: "tool_result", output: "secret tool text" }, { type: "result", exit_code: 0, text }].map(JSON.stringify).join("\n");
	assert.equal(parseRuntimeAnswer(hermes, "hermes").reply, GOOD_ANSWER.reply);
	for (const raw of [JSON.stringify({ type: "result", exit_code: 0, text }), hermes.replace('"exit_code":0', '"exit_code":1'), pi.replace('"aborted":false', '"aborted":true')]) {
		assert.throws(() => parseRuntimeAnswer(raw, raw.includes("agent_settled") ? "pi" : "hermes"), error("assistant_failed"));
	}
});

test("child runner drains large final records and caps both private streams", async t => {
	const dir = temp(t);
	const good = await runAssistantProcess({ command: process.execPath, argv: ["-e", 'process.stdout.write("x".repeat(300000))'], cwd: dir });
	assert.equal(good.length, 300000);
	for (const stream of ["stdout", "stderr"]) {
		await assert.rejects(runAssistantProcess({ command: process.execPath, argv: ["-e", `process.${stream}.write("x".repeat(100000));setInterval(()=>{},1000)`], cwd: dir, maxBytes: 1024 }), error("assistant_failed"));
	}
	await assert.rejects(runAssistantProcess({ command: "/missing-inbox-runtime", argv: [], cwd: dir }), error("assistant_unconfigured"));
});

test("child deadline terminates the process group including descendants", async t => {
	const dir = temp(t);
	const pidFile = join(dir, "child-pid");
	const script = `const {spawn}=require("node:child_process");const fs=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`;
	await assert.rejects(runAssistantProcess({ command: process.execPath, argv: ["-e", script], cwd: dir, timeoutMs: 400 }), error("assistant_timeout"));
	const pid = Number(readFileSync(pidFile));
	for (let n = 0; n < 50; n++) {
		try {
			const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
			if (state === "Z") return;
		} catch { return; }
		await sleep(20);
	}
	assert.fail("descendant still executing after deadline");
});

test("installed Hermes command export must have a recognized isolated bootstrap", async t => {
	const dir = temp(t);
	const suffix = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
	const good = executable(dir, "hermes-good", `process.stdout.write(JSON.stringify(["/store/python","-I","-c",${JSON.stringify("import runpy,sys; " + suffix)}]))`);
	const result = await hermesPolicyCommand(good, dir);
	assert.equal(result.command, "/store/python");
	assert.match(result.argv[2], /runpy\.run_path/);
	assert.match(result.argv[3], /contrib\/inbox-hermes\.py$/);
	const bad = executable(dir, "hermes-bad", 'process.stdout.write(JSON.stringify(["sh","-c","something"]))');
	await assert.rejects(hermesPolicyCommand(bad, dir), error("assistant_unconfigured"));
});

test("privacy and selection are rechecked after delayed Hermes startup before model process launch", async t => {
	const dir = temp(t);
	const suffix = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
	const hermesBin = executable(dir, "slow-hermes", `setTimeout(()=>process.stdout.write(JSON.stringify(["/must-never-launch","-I","-c",${JSON.stringify("import runpy,sys; " + suffix)}])),150)`);
	const engines = new AssistantEngines(new Assistant({ url: "http://unused", keyFile: join(dir, "missing"), model: "flash", log: () => {} }), { stateDir: dir, log: () => {}, runtime: { catalog, paths: { hermesBin } } });
	let revoked = false;
	let checks = 0;
	const timer = setTimeout(() => { revoked = true; }, 60);
	const revocation = new Error("revoked while startup was pending");
	await assert.rejects(engines.ask(hermesSelection, request, () => { checks++; if (revoked) throw revocation; }), err => err === revocation);
	clearTimeout(timer);
	assert.equal(checks, 2);
});

test("Pi selected provider/model reaches runtime argv, prompt stays stdin and answer mode strips drafts", async t => {
	const dir = temp(t);
	const argvFile = join(dir, "argv.json");
	const inputFile = join(dir, "input");
	const events = [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(GOOD_ANSWER) }] } }, { type: "agent_settled", aborted: false }];
	const piBin = executable(dir, "pi", `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2)));let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{fs.writeFileSync(${JSON.stringify(inputFile)},input);process.stdout.write(${JSON.stringify(events.map(JSON.stringify).join("\n"))})})`);
	const engines = new AssistantEngines(new Assistant({ url: "http://unused", keyFile: join(dir, "missing"), model: "flash", log: () => {} }), { stateDir: dir, log: () => {}, runtime: { catalog, paths: { piBin } } });
	const out = await engines.ask(piSelection, { ...request, prompt: "$(do-not-run) `also-not-run`" });
	assert.equal(out.engine, "pi");
	assert.equal(out.provider, piSelection.provider);
	assert.equal(out.model, piSelection.model);
	assert.equal(out.draftText, "");
	const argv = JSON.parse(readFileSync(argvFile));
	assert.equal(argv[argv.indexOf("--provider") + 1], piSelection.provider);
	assert.equal(argv[argv.indexOf("--model") + 1], piSelection.model);
	assert.ok(argv.includes("--no-tools") && argv.includes("--no-mcp") && argv.includes("--no-session"));
	assert.doesNotMatch(argv.join(" "), /do-not-run/);
	assert.match(readFileSync(inputFile, "utf8"), /\$\(do-not-run\)/);
});

async function httpFixture(t) {
	const dir = temp(t);
	const beeper = await startFakeBeeper();
	const llm = await startFakeLlm();
	writeFileSync(join(dir, "beeper-token"), beeper.token, { mode: 0o600 });
	writeFileSync(join(dir, "llm-key"), "synthetic-key");
	const calls = [];
	let run = async () => answer;
	const cfg = parseArgs(["--state-dir", dir, "--no-meta", "--no-herdr", "--beeper-url", beeper.url, "--llm-url", llm.url]);
	const server = createServer({ ...cfg, inboxAssistantRuntime: { catalog, run: async (selection, request) => { calls.push({ selection, request }); return run(selection, request); } } }, "synthetic-token");
	await new Promise(resolve => server.http.listen(0, "127.0.0.1", resolve));
	t.after(async () => { await server.close(); await beeper.close(); await llm.close(); });
	server.inbox.start();
	for (let n = 0; n < 100 && server.inbox.state().loading; n++) await sleep(20);
	const base = `http://127.0.0.1:${server.http.address().port}/api/inbox`;
	const call = async (path, method = "GET", body) => {
		const res = await fetch(base + path, { method, headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
		return { status: res.status, body: await res.json() };
	};
	return { dir, calls, llm, server, call, setRun: fn => { run = fn; } };
}

test("HTTP catalogs/settings have no chat access, persist per chat, and selected engines bypass missing Flash key", async t => {
	const f = await httpFixture(t);
	const chat = "/chats/" + encodeURIComponent("!wa-ana:wa.test");
	assert.equal((await f.call("/assistant/options")).status, 200);
	assert.equal(f.llm.requests.length, 0);
	assert.deepEqual((await f.call(chat + "/assistant-settings")).body, defaultSelection);
	assert.equal((await f.call(chat + "/assistant-settings", "PATCH", { ...piSelection, model: "--evil" })).status, 400);
	assert.equal((await f.call(chat + "/assistant-settings", "PATCH", { ...piSelection, secret: "forbidden" })).status, 400);
	assert.equal((await f.call(chat + "/assistant-settings", "PATCH", piSelection)).status, 200);
	rmSync(join(f.dir, "llm-key"));
	const result = await f.call(chat + "/assistant", "POST", { prompt: "Informazione" });
	assert.equal(result.status, 200);
	assert.equal(result.body.engine, "pi");
	assert.equal(result.body.draft, null);
	assert.equal(f.calls.length, 1);
	assert.equal((await f.call(chat + "/assistant", "POST", { prompt: "Scrivi una risposta", intent: "auto" })).body.draft.text, answer.draftText);
	assert.equal(f.calls.at(-1).request.intent, "auto");
	assert.equal((await f.call("/chats/missing/assistant-settings", "PATCH", piSelection)).status, 404);
});

test("HTTP discards pending A-B-A selections and privacy revocations for both optional engines", async t => {
	const f = await httpFixture(t);
	const path = "/chats/" + encodeURIComponent("!wa-ana:wa.test");
	for (const selection of [piSelection, hermesSelection]) {
		await f.call(path + "/assistant-settings", "PATCH", selection);
		let complete;
		f.setRun(() => new Promise(resolve => { complete = resolve; }));
		const pending = f.call(path + "/assistant", "POST", { prompt: "Riassumi" });
		while (!complete) await sleep(5);
		await f.call(path + "/assistant-settings", "PATCH", defaultSelection);
		await f.call(path + "/assistant-settings", "PATCH", selection);
		complete(answer);
		assert.equal((await pending).body.error, "assistant_settings_changed");
		complete = undefined;
		const privatePending = f.call(path + "/assistant", "POST", { prompt: "Riassumi" });
		while (!complete) await sleep(5);
		await f.call(path + "/model-exclusion", "POST", { scope: "chat", on: true });
		await f.call(path + "/model-exclusion", "POST", { scope: "chat", on: false });
		complete(answer);
		assert.equal((await privatePending).body.error, "model_context_changed");
	}
});
