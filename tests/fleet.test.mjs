import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetMonitor, validateFleetRequest } from "../dist/server/fleet.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const agent = (machine, paneId, kind, status, extra = {}) => ({
	machine,
	kind,
	status,
	paneId,
	tabId: `${paneId.split(":")[0]}:t1`,
	workspaceId: paneId.split(":")[0],
	cwd: `/work/${kind}`,
	title: `${kind} on ${paneId}`,
	focused: false,
	...extra,
});

const fleet = (machine, agents) => [{ machine, ok: true, agents }];

const logFile = (dir) => join(dir, "fleet-transitions.jsonl");
const logged = (dir) =>
	(existsSync(logFile(dir)) ? readFileSync(logFile(dir), "utf8") : "")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

test("appearance, status change and disappearance are journalled and emitted", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-fleet-"));
	let t = 1000;
	let data = fleet("local", [agent("local", "wZZ:p1", "pi", "idle")]);
	const mon = new FleetMonitor({
		machines: ["local"],
		stateDir: dir,
		now: () => t,
		localPollMs: 10,
		fetch: async () => data,
	});
	const transitions = [];
	mon.on("transition", (tr) => transitions.push(tr));
	mon.start();
	await wait(50);
	assert.equal(transitions.length, 1);
	assert.equal(transitions[0].from, null);
	assert.equal(transitions[0].to, "idle");
	assert.equal(transitions[0].ts, 1000);
	let snap = mon.snapshot();
	assert.equal(snap.machines[0].agents[0].since, 1000);
	assert.equal(snap.machines[0].agents[0].sinceApprox, true, "first-ever sighting is approximate");

	// a status change moves `since`; polls without a change must not
	t = 2000;
	data = fleet("local", [agent("local", "wZZ:p1", "pi", "working")]);
	await wait(50);
	assert.equal(transitions.length, 2);
	assert.equal(transitions[1].from, "idle");
	assert.equal(transitions[1].to, "working");
	snap = mon.snapshot();
	assert.equal(snap.machines[0].agents[0].since, 2000);
	assert.equal(snap.machines[0].agents[0].sinceApprox, undefined);
	t = 3000;
	await wait(50);
	assert.equal(transitions.length, 2, "no change, no transition");
	assert.equal(mon.snapshot().machines[0].agents[0].since, 2000, "since holds across unchanged polls");

	t = 4000;
	data = fleet("local", []);
	await wait(50);
	assert.equal(transitions.length, 3);
	assert.equal(transitions[2].from, "working");
	assert.equal(transitions[2].to, "gone");
	assert.equal(mon.snapshot().machines[0].agents.length, 0);
	mon.stop();

	const file = logged(dir);
	assert.equal(file.length, 3, "every transition hit the journal");
	assert.deepEqual(
		file.map((f) => [f.from, f.to]),
		[
			[null, "idle"],
			["idle", "working"],
			["working", "gone"],
		],
	);
});

test("an unreachable machine keeps its agents and logs no 'gone'", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-fleet-"));
	let ok = true;
	const data = fleet("local", [agent("local", "wZZ:p1", "pi", "working")]);
	const mon = new FleetMonitor({
		machines: ["local"],
		stateDir: dir,
		localPollMs: 10,
		fetch: async () => (ok ? data : [{ machine: "local", ok: false, error: "ssh timed out", agents: [] }]),
	});
	const transitions = [];
	mon.on("transition", (tr) => transitions.push(tr));
	mon.start();
	await wait(40);
	ok = false;
	await wait(50);
	const m = mon.snapshot().machines[0];
	assert.equal(m.ok, false);
	assert.equal(m.error, "ssh timed out");
	assert.equal(m.agents.length, 1, "stale agents stay listed");
	assert.equal(transitions.length, 1, "only the first appearance — no 'gone' for a dead machine");
	mon.stop();
});

test("since is restored from the journal across a restart", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-fleet-"));
	const data = fleet("local", [agent("local", "wZZ:p1", "pi", "working")]);
	let t = 5000;
	const first = new FleetMonitor({ machines: ["local"], stateDir: dir, now: () => t, localPollMs: 10, fetch: async () => data });
	first.start();
	await wait(40);
	first.stop();
	assert.equal(logged(dir).at(-1).to, "working");

	t = 9000;
	const second = new FleetMonitor({ machines: ["local"], stateDir: dir, now: () => t, localPollMs: 10, fetch: async () => data });
	second.start();
	await wait(40);
	second.stop();
	const a = second.snapshot().machines[0].agents[0];
	assert.equal(a.since, 5000, "the journal's ts survives the restart");
	assert.equal(a.sinceApprox, undefined);
});

test("the journal rotates past rotateBytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-fleet-"));
	let n = 0;
	const statuses = ["idle", "working", "done"];
	const mon = new FleetMonitor({
		machines: ["local"],
		stateDir: dir,
		localPollMs: 10,
		rotateBytes: 300,
		fetch: async () => fleet("local", [agent("local", "wZZ:p1", "pi", statuses[n % 3], { title: `x`.repeat(80) })]),
	});
	// every other poll flips the status => a transition each time
	mon.on("transition", () => n++);
	mon.start();
	await wait(120);
	mon.stop();
	assert.ok(n > 3, `enough transitions happened (${n})`);
	assert.ok(existsSync(`${logFile(dir)}.1`), "rotated file exists");
	assert.ok(statSync(`${logFile(dir)}.1`).size >= 300, "the rotated file holds the spilled lines");
	assert.ok(logged(dir).length < n, "earlier transitions moved into .1");
});

test("a slow machine's loop never overlaps itself", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-fleet-"));
	let inflight = 0;
	let maxInflight = 0;
	let calls = 0;
	const mon = new FleetMonitor({
		machines: ["korea"],
		stateDir: dir,
		remotePollMs: 10,
		fetch: async () => {
			calls++;
			inflight++;
			maxInflight = Math.max(maxInflight, inflight);
			await wait(80); // a slow ssh, much longer than the poll interval
			inflight--;
			return fleet("korea", []);
		},
	});
	mon.start();
	await wait(350);
	mon.stop();
	assert.ok(calls >= 2, `several polls ran (${calls})`);
	assert.equal(maxInflight, 1, "one in flight per machine, always");
});

test("validateFleetRequest gates machine, target, keys and text", () => {
	const machines = ["local", "korea"];
	assert.equal(validateFleetRequest(machines, "prompt", { machine: "mars", target: "wZZ:p1", text: "hi" }).ok, false);
	assert.equal(
		validateFleetRequest(machines, "prompt", { machine: "local", target: "rev-412", text: "hi" }).ok,
		false,
		"agent names are not accepted — pane ids only",
	);
	assert.equal(validateFleetRequest(machines, "keys", { machine: "local", target: "wZZ:p1", keys: ["F12"] }).ok, false);
	assert.equal(
		validateFleetRequest(machines, "prompt", { machine: "local", target: "wZZ:p1", text: "x".repeat(70 * 1024) }).ok,
		false,
		"oversize text",
	);
	const good = validateFleetRequest(machines, "prompt", { machine: "korea", target: "wZZ:p1", text: "hi" });
	assert.deepEqual(good, { ok: true, machine: "korea", target: "wZZ:p1", text: "hi" });
	const keys = validateFleetRequest(machines, "keys", { machine: "local", target: "wZZ:p1", keys: ["esc", "enter"] });
	assert.equal(keys.ok, true);
	const read = validateFleetRequest(machines, "read", { machine: "local", target: "wZZ:p1", lines: "999999" });
	assert.equal(read.ok && read.lines, 5000);
	assert.equal(
		validateFleetRequest(machines, "read", { machine: "local", target: "wZZ:p1" }).lines,
		400,
	);
});
