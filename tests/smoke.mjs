#!/usr/bin/env node
// Manual end-to-end smoke test.
//   node tests/smoke.mjs <baseUrl> <token>
//
// Point it at a pi-super started on a THROWAWAY tmux session, e.g.
//   tmux -L smoke new-session -d -s smoke
//   node dist/server/index.js -L smoke -s smoke --port 8799 --no-meta
// It types into panes and kills windows, so never aim it at your real session.
import { WebSocket } from "ws";

const base = process.argv[2] ?? "http://127.0.0.1:8799";
const token = process.argv[3] ?? "";
const auth = { Authorization: `Bearer ${token}` };
const log = (...a) => console.log("·", ...a);

const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
log("state:", state.base, state.tmux, `${state.windows.length} windows`);

const ws = new WebSocket(`${base.replace("http", "ws")}/ws?cols=90&rows=25&mode=ignore`, { headers: auth });
let out = "";
const seen = [];
ws.on("message", (data, isBinary) => {
	if (isBinary) out += data.toString("utf8");
	else seen.push(JSON.parse(data.toString()));
});
await new Promise((r) => ws.on("open", r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1500);

const hello = seen.find((m) => m.t === "hello");
log("hello:", JSON.stringify(hello));
if (!hello) throw new Error("no hello");
log("first output bytes:", JSON.stringify(out.slice(0, 80)));
if (out.length === 0) throw new Error("no terminal output");

// type a command through the pty
ws.send(Buffer.from("echo hello-from-pi-super\r", "utf8"));
await wait(800);
if (!out.includes("hello-from-pi-super")) throw new Error("pty input did not round-trip");
log("pty input round-trip ok");

// out-of-band: create a window, list windows, select it, kill it
const beforeIds = new Set((seen.filter((m) => m.t === "windows").pop()?.windows ?? []).map((w) => w.id));
ws.send(JSON.stringify({ t: "newWindow", cwd: process.env.HOME, name: "smoke" }));
await wait(1500);
const windows = seen.filter((m) => m.t === "windows").pop();
log("windows:", windows?.windows.map((w) => `${w.index}:${w.name}`).join(" "));
// identify by window id, never by name: names are not unique
const created = windows?.windows.find((w) => !beforeIds.has(w.id));
if (!created) throw new Error("newWindow did not show up");
ws.send(JSON.stringify({ t: "select", window: created.id }));
await wait(600);

// paste + keys into the focused pane
ws.send(JSON.stringify({ t: "paste", text: "echo pasted-text", enter: true }));
await wait(800);
const cap = await (
	await fetch(`${base}/api/capture?target=${encodeURIComponent(created.paneId)}&lines=100`, { headers: auth })
).text();
if (!cap.includes("pasted-text")) throw new Error(`paste did not land:\n${cap}`);
log("paste + capture ok");

// upload
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const up = await (
	await fetch(`${base}/api/upload?name=x.png`, {
		method: "POST",
		headers: { ...auth, "content-type": "image/png" },
		body: png,
	})
).json();
log("upload:", up.path);
if (!up.path.endsWith(".png")) throw new Error("upload ext wrong");

ws.send(JSON.stringify({ t: "killWindow", window: created.id }));
await wait(600);
ws.close();
await wait(500);
log("OK");
process.exit(0);
