import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createMeta } from "./meta.js";
import "./style.css";
import { createVoice } from "./voice.js";

interface WindowInfo {
	id: string;
	index: number;
	name: string;
	active: boolean;
	panes: number;
	activity: boolean;
	bell: boolean;
	width: number;
	height: number;
	paneId: string;
	paneCmd: string;
	panePid: number;
	paneCwd: string;
	paneTitle: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const enc = new TextEncoder();

const el = {
	tabs: $("tabs"),
	term: $("term"),
	reader: $("reader"),
	readerText: $("reader-text"),
	meta: $("meta"),
	abort: $("btn-abort"),
	call: $("call"),
	callState: $("call-state"),
	status: $("status"),
	input: $<HTMLTextAreaElement>("input"),
	ribbon: $("ribbon"),
	drawer: $("drawer"),
	windowList: $("window-list"),
	newCwd: $<HTMLInputElement>("new-cwd"),
	claim: $<HTMLInputElement>("chk-claim"),
	sessionInfo: $("session-info"),
	file: $<HTMLInputElement>("file"),
};

const state = {
	ws: undefined as WebSocket | undefined,
	windows: [] as WindowInfo[],
	view: "raw" as "raw" | "reader" | "meta",
	lastTermView: "raw" as "raw" | "reader",
	sizeMode: (localStorage.getItem("sizeMode") as "ignore" | "claim" | null) ?? "ignore",
	fontSize: Number(localStorage.getItem("fontSize") ?? 13),
	session: "",
	base: "",
	backoff: 500,
	readerTimer: 0 as number | ReturnType<typeof setInterval>,
};

// ------------------------------------------------------------------ terminal

const term = new Terminal({
	fontSize: state.fontSize,
	fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
	scrollback: 5000,
	cursorBlink: true,
	convertEol: false,
	theme: { background: "#000000", foreground: "#d7dae0", cursor: "#7ee787" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(el.term);

term.onData((d) => send(enc.encode(d)));
term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));

function send(data: Uint8Array | object): void {
	const ws = state.ws;
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	if (data instanceof Uint8Array) ws.send(data);
	else ws.send(JSON.stringify(data));
}

/** In ignore-size mode the terminal is as wide as the desktop's — scale it to fit. */
function applyScale(): void {
	const screen = el.term.querySelector<HTMLElement>(".xterm-screen");
	const xterm = el.term.querySelector<HTMLElement>(".xterm");
	if (!screen || !xterm) return;
	xterm.style.transform = "";
	if (state.sizeMode === "claim") return;
	const natural = screen.offsetWidth;
	if (!natural) return;
	const scale = Math.min(1, el.term.clientWidth / natural);
	xterm.style.transform = `scale(${scale})`;
	xterm.style.width = `${100 / scale}%`;
	xterm.style.height = `${100 / scale}%`;
}

function refit(): void {
	if (state.sizeMode !== "claim") {
		applyScale();
		return;
	}
	try {
		fit.fit();
	} catch {
		/* not attached yet */
	}
	send({ t: "resize", cols: term.cols, rows: term.rows });
}

function viewport(): { cols: number; rows: number } {
	const dims = fit.proposeDimensions();
	return { cols: dims?.cols ?? 80, rows: dims?.rows ?? 24 };
}

// ----------------------------------------------------------------- transport

function connect(): void {
	const { cols, rows } = viewport();
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const url = `${proto}//${location.host}/ws?cols=${cols}&rows=${rows}&mode=${state.sizeMode}`;
	const ws = new WebSocket(url);
	ws.binaryType = "arraybuffer";
	state.ws = ws;

	ws.onopen = () => {
		state.backoff = 500;
		status("connected", 1200);
	};
	ws.onmessage = (ev) => {
		if (typeof ev.data !== "string") {
			term.write(new Uint8Array(ev.data as ArrayBuffer));
			return;
		}
		const msg = JSON.parse(ev.data) as Record<string, unknown>;
		switch (msg.t) {
			case "hello":
				state.session = String(msg.session ?? "");
				if (msg.base) state.base = String(msg.base);
				state.sizeMode = msg.mode === "claim" ? "claim" : "ignore";
				el.claim.checked = state.sizeMode === "claim";
				el.sessionInfo.textContent = `${state.base} · via ${state.session}`;
				resizeTerm(Number(msg.cols), Number(msg.rows));
				break;
			case "geometry":
				resizeTerm(Number(msg.cols), Number(msg.rows));
				break;
			case "windows":
				state.windows = msg.windows as WindowInfo[];
				renderTabs();
				renderWindowList();
				if (state.view === "reader") void refreshReader();
				break;
			case "error":
				status(String(msg.error), 4000, true);
				break;
			case "fatal":
				status(String(msg.error), 8000, true);
				break;
		}
	};
	ws.onclose = () => {
		state.ws = undefined;
		status("disconnected — reconnecting…", 0, true);
		setTimeout(connect, state.backoff);
		state.backoff = Math.min(state.backoff * 2, 8000);
	};
	ws.onerror = () => ws.close();
}

function resizeTerm(cols: number, rows: number): void {
	if (!cols || !rows) return;
	if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
	applyScale();
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function status(text: string, ms = 2000, err = false): void {
	el.status.textContent = text;
	el.status.classList.toggle("err", err);
	if (statusTimer) clearTimeout(statusTimer);
	if (ms > 0) statusTimer = setTimeout(() => (el.status.textContent = ""), ms);
}

// --------------------------------------------------------------------- views

function activeWindow(): WindowInfo | undefined {
	return state.windows.find((w) => w.active);
}

function renderTabs(): void {
	el.tabs.replaceChildren(
		...state.windows.map((w) => {
			const b = document.createElement("button");
			b.className = `tab${w.active ? " active" : ""}${w.activity || w.bell ? " activity" : ""}`;
			b.textContent = `${w.index}:${w.name}`;
			b.onclick = () => send({ t: "select", window: w.id });
			return b;
		}),
	);
	el.tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "center" });
}

function renderWindowList(): void {
	el.windowList.replaceChildren(
		...state.windows.map((w) => {
			const row = document.createElement("div");
			row.className = "wrow";
			const meta = document.createElement("div");
			meta.className = "meta";
			const name = document.createElement("div");
			name.className = `name${w.active ? " active" : ""}`;
			name.textContent = `${w.index}: ${w.name} · ${w.paneCmd}`;
			const path = document.createElement("div");
			path.className = "path";
			path.textContent = w.paneCwd;
			meta.append(name, path);
			meta.onclick = () => {
				send({ t: "select", window: w.id });
				closeDrawer();
			};
			const kill = document.createElement("button");
			kill.textContent = "✕";
			kill.onclick = () => {
				if (confirm(`kill window ${w.index}:${w.name}?`)) send({ t: "killWindow", window: w.id });
			};
			row.append(meta, kill);
			return row;
		}),
	);
}

async function refreshReader(): Promise<void> {
	const w = activeWindow();
	if (!w) return;
	const keepBottom = el.reader.scrollTop + el.reader.clientHeight >= el.reader.scrollHeight - 40;
	const res = await fetch(`/api/capture?target=${encodeURIComponent(w.paneId)}&lines=3000`, {
		cache: "no-store",
	});
	if (!res.ok) {
		status(`capture failed: ${res.status}`, 3000, true);
		return;
	}
	el.readerText.textContent = (await res.text()).replace(/\n+$/, "");
	if (keepBottom) el.reader.scrollTop = el.reader.scrollHeight;
}

function setView(view: "raw" | "reader" | "meta"): void {
	state.view = view;
	if (view !== "meta") state.lastTermView = view;
	el.reader.hidden = view !== "reader";
	el.meta.hidden = view !== "meta";
	el.term.style.visibility = view === "raw" ? "visible" : "hidden";
	el.ribbon.hidden = view === "meta";
	el.abort.hidden = view !== "meta";
	el.input.placeholder = view === "meta" ? "ask super…" : "prompt…";
	$("btn-view").textContent = view === "reader" ? "▣" : "📖";
	$("btn-meta").classList.toggle("armed", view === "meta");
	clearInterval(state.readerTimer as ReturnType<typeof setInterval>);
	if (view === "reader") {
		void refreshReader();
		state.readerTimer = setInterval(() => void refreshReader(), 2500);
	} else if (view === "raw") {
		refit();
	}
	if (view === "meta") el.meta.scrollTop = el.meta.scrollHeight;
}

// -------------------------------------------------------------------- input

function sendText(text: string, enter: boolean): void {
	if (!text) return;
	if (state.view === "meta") meta.send(text);
	else send({ t: "paste", text, enter });
	el.input.value = "";
	autogrow();
}

function autogrow(): void {
	el.input.style.height = "auto";
	el.input.style.height = `${Math.min(el.input.scrollHeight, window.innerHeight * 0.35)}px`;
}

async function upload(file: File | Blob, name?: string): Promise<void> {
	status("uploading…", 0);
	const res = await fetch(`/api/upload?name=${encodeURIComponent(name ?? (file as File).name ?? "paste.png")}`, {
		method: "POST",
		headers: { "content-type": file.type || "application/octet-stream" },
		body: file,
	});
	if (!res.ok) {
		status(`upload failed: ${res.status}`, 4000, true);
		return;
	}
	const { path } = (await res.json()) as { path: string };
	const pos = el.input.selectionStart ?? el.input.value.length;
	el.input.value = `${el.input.value.slice(0, pos)}${path} ${el.input.value.slice(pos)}`;
	autogrow();
	status("attached", 1500);
}

function openDrawer(): void {
	el.drawer.hidden = false;
	renderWindowList();
}
function closeDrawer(): void {
	el.drawer.hidden = true;
}

// --------------------------------------------------------------------- wiring

$("btn-menu").onclick = openDrawer;
$("btn-close-drawer").onclick = closeDrawer;
el.drawer.onclick = (e) => {
	if (e.target === el.drawer) closeDrawer();
};
$("btn-view").onclick = () => setView(state.view === "reader" ? "raw" : "reader");
$("btn-meta").onclick = () => setView(state.view === "meta" ? state.lastTermView : "meta");
el.abort.onclick = () => meta.abort();

const meta = createMeta(el.meta);
meta.onState = (s) => $("btn-meta").classList.toggle("busy", s.busy);

const voice = createVoice(meta);
meta.onSpeak = ({ message, kind }) => {
	voice.pushUpdate(message, kind);
	if (state.view !== "meta") status(`🔊 ${message}`, 6000);
};
voice.onState = (s, detail) => {
	el.callState.textContent = s === "live" ? "connected — talk to super" : detail ? `${s}: ${detail}` : s;
	el.call.hidden = s === "idle";
	$("btn-call").classList.toggle("armed", s === "live");
	$("btn-call").classList.toggle("busy", s === "connecting");
	if (s === "error" && detail) status(detail, 8000, true);
};
voice.onTranscript = (role, text) => {
	if (role === "user") status(`🎙 ${text}`, 4000);
};

$("btn-call").onclick = () => {
	if (voice.state === "idle" || voice.state === "error") {
		setView("meta");
		void voice.start();
	} else {
		voice.stop();
	}
};
$("btn-hangup").onclick = () => voice.stop();
$("btn-mute").onclick = () => {
	const muted = voice.toggleMute();
	$("btn-mute").textContent = muted ? "unmute" : "mute";
	$("btn-mute").classList.toggle("armed", muted);
};

$("btn-send").onclick = () => sendText(el.input.value, true);
$("btn-insert").onclick = () => sendText(el.input.value, false);
el.input.addEventListener("input", autogrow);
el.input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		sendText(el.input.value, true);
	}
});

el.ribbon.addEventListener("click", (e) => {
	const key = (e.target as HTMLElement).dataset.key;
	if (key) send({ t: "keys", keys: [key] });
});

$("btn-font-inc").onclick = () => setFont(state.fontSize + 1);
$("btn-font-dec").onclick = () => setFont(state.fontSize - 1);
function setFont(size: number): void {
	state.fontSize = Math.max(6, Math.min(24, size));
	localStorage.setItem("fontSize", String(state.fontSize));
	term.options.fontSize = state.fontSize;
	refit();
}

$("btn-img").onclick = () => el.file.click();
el.file.onchange = () => {
	const f = el.file.files?.[0];
	if (f) void upload(f);
	el.file.value = "";
};
document.addEventListener("paste", (e) => {
	for (const item of e.clipboardData?.items ?? []) {
		if (item.kind === "file") {
			const f = item.getAsFile();
			if (f) {
				e.preventDefault();
				void upload(f);
				return;
			}
		}
	}
});

$("btn-new").onclick = () => {
	send({ t: "newWindow", cwd: el.newCwd.value.trim() || undefined });
	el.newCwd.value = "";
	closeDrawer();
};

el.claim.onchange = () => {
	state.sizeMode = el.claim.checked ? "claim" : "ignore";
	localStorage.setItem("sizeMode", state.sizeMode);
	const { cols, rows } = viewport();
	send({ t: "mode", mode: state.sizeMode, cols, rows });
	setTimeout(refit, 150);
};

const onViewportChange = () => {
	requestAnimationFrame(refit);
};
window.addEventListener("resize", onViewportChange);
window.visualViewport?.addEventListener("resize", onViewportChange);
new ResizeObserver(onViewportChange).observe(el.term);

el.claim.checked = state.sizeMode === "claim";
setView("raw");
connect();
