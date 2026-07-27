import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { authState, enrollPasskey, gate, loginWithPasskey, logout } from "./auth.js";
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
	passkeyInfo: $("passkey-info"),
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
	zoom: Number(localStorage.getItem("zoom") ?? 1),
	session: "",
	base: "",
	backoff: 500,
	connectedAt: 0,
	/** after (re)connect: re-select the remembered window once the list arrives */
	restorePending: false,
	readerTimer: 0 as number | ReturnType<typeof setInterval>,
	reconnectTimer: 0 as number | ReturnType<typeof setTimeout>,
	/** a sticky "disconnected" notice is showing; the next open says "reconnected" */
	wasDown: false,
};

const nearBottom = (e: HTMLElement): boolean => e.scrollTop + e.clientHeight >= e.scrollHeight - 40;
const toBottom = (e: HTMLElement): void => {
	e.scrollTop = e.scrollHeight;
};
/**
 * Self-update: the server tells us which bundle it serves (hello/pong `build`); when
 * ours is stale, reload once — drafts, view and window selection all survive reloads.
 * In dev (vite serves main.ts, no hashed asset) this stays inert.
 */
const myBuild = Array.from(document.scripts)
	.map((s) => s.src.match(/assets\/index-[\w-]+\.js/)?.[0])
	.find(Boolean);
function maybeReload(build: unknown): void {
	if (!myBuild || typeof build !== "string" || !build || build === myBuild) return;
	if (sessionStorage.getItem("reloadedFor") === build) return; // never loop
	sessionStorage.setItem("reloadedFor", build);
	location.reload();
}

/** The scroll container of whatever view is on screen — hidden ones must be left alone. */
const activeScroller = (): HTMLElement =>
	state.view === "reader" ? el.reader : state.view === "meta" ? el.meta : el.term;

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

/**
 * In ignore-size mode the terminal is as wide as the *desktop's* window (213+ columns),
 * so it has to be scaled down. Fitting the full width on a phone lands around 0.27, i.e.
 * a 3px font — useless. So we clamp at a still-legible floor and let the user pan
 * horizontally (and zoom with A+/A-), which beats a wall of grey mush.
 */
const MIN_SCALE = 0.5;

function applyScale(): void {
	const screen = el.term.querySelector<HTMLElement>(".xterm-screen");
	const xterm = el.term.querySelector<HTMLElement>(".xterm");
	if (!screen || !xterm) return;
	if (state.sizeMode === "claim") {
		xterm.style.transform = "";
		xterm.style.margin = "";
		el.term.style.overflow = "hidden";
		return;
	}
	const naturalW = screen.offsetWidth;
	const naturalH = screen.offsetHeight;
	if (!naturalW) return;
	const fit = el.term.clientWidth / naturalW;
	const scale = Math.min(1, Math.max(fit, MIN_SCALE) * state.zoom);
	xterm.style.transformOrigin = "top left";
	xterm.style.transform = `scale(${scale})`;
	// transform doesn't shrink the layout box, so pull it in by hand — otherwise the
	// container scrolls over a big empty area to the right of the scaled terminal.
	xterm.style.marginRight = `${-Math.round(naturalW * (1 - scale))}px`;
	xterm.style.marginBottom = `${-Math.round(naturalH * (1 - scale))}px`;
	el.term.style.overflow = scale < fit - 0.001 || scale > fit + 0.001 ? "auto" : "hidden";
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
	clearTimeout(state.reconnectTimer as ReturnType<typeof setTimeout>);
	if (state.ws) return;
	const { cols, rows } = viewport();
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const url = `${proto}//${location.host}/ws?cols=${cols}&rows=${rows}&mode=${state.sizeMode}`;
	const ws = new WebSocket(url);
	ws.binaryType = "arraybuffer";
	state.ws = ws;
	state.connectedAt = Date.now();

	ws.onopen = () => {
		state.backoff = 500;
		status(state.wasDown ? "reconnected" : "connected", 1200);
		state.wasDown = false;
	};
	ws.onmessage = (ev) => {
		if (typeof ev.data !== "string") {
			term.write(new Uint8Array(ev.data as ArrayBuffer));
			return;
		}
		const msg = JSON.parse(ev.data) as Record<string, unknown>;
		switch (msg.t) {
			case "pong":
				clearTimeout(pongTimer as ReturnType<typeof setTimeout>);
				pongTimer = undefined;
				maybeReload(msg.build);
				break;
			case "hello":
				maybeReload(msg.build);
				state.restorePending = true;
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
			case "windows": {
				state.windows = msg.windows as WindowInfo[];
				// A restarted server rebuilds the mirror session on window 0; put the user
				// back where they were. Otherwise, remember where they are.
				const active = activeWindow();
				if (state.restorePending) {
					state.restorePending = false;
					const want = localStorage.getItem("lastWindow");
					if (want && want !== active?.id && state.windows.some((w) => w.id === want)) {
						selectWindow(want);
					}
				} else if (active) {
					localStorage.setItem("lastWindow", active.id);
				}
				renderTabs();
				renderWindowList();
				if (state.view === "reader") void refreshReader();
				break;
			}
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
		clearTimeout(pongTimer as ReturnType<typeof setTimeout>);
		pongTimer = undefined;
		// The first retry runs silently: sub-second blips (network switch, phone lock)
		// resolve on their own, and a red "disconnected" flash for those only alarms.
		if (state.backoff > 500) {
			state.wasDown = true;
			status("disconnected — reconnecting…", 0, true);
		}
		state.reconnectTimer = setTimeout(connect, state.backoff);
		state.backoff = Math.min(state.backoff * 2, 8000);
	};
	ws.onerror = () => ws.close();
}

/**
 * A phone coming out of suspension often holds a socket that still claims OPEN but is
 * dead. TCP would notice eventually; the user notices immediately. So: probe with an
 * app-level ping and force-close when the pong doesn't come back.
 */
let pongTimer: number | ReturnType<typeof setTimeout> | undefined;
function probe(timeoutMs: number): void {
	const ws = state.ws;
	if (!ws) return;
	if (ws.readyState === WebSocket.CONNECTING) {
		// a connect attempt stuck from before suspension: abort it, onclose retries
		if (Date.now() - state.connectedAt > 10_000) ws.close();
		return;
	}
	if (ws.readyState !== WebSocket.OPEN || pongTimer) return;
	send({ t: "ping" });
	pongTimer = setTimeout(() => {
		pongTimer = undefined;
		ws.close(); // triggers the normal reconnect path
	}, timeoutMs);
}
setInterval(() => probe(8000), 30_000);

// Coming back to the app (unlock, tab switch) must not sit out the backoff timer,
// nor trust a possibly-stale socket.
document.addEventListener("visibilitychange", () => {
	if (document.hidden) return;
	if (!state.ws) {
		state.backoff = 500;
		connect();
	} else {
		probe(5000);
	}
});

let termSized = false;
function resizeTerm(cols: number, rows: number): void {
	if (!cols || !rows) return;
	// The newest output is at the *bottom* of the remote screen; when the scaled canvas
	// overflows the container (phone), land there on first sizing and stay there if the
	// user was already reading the tail — but never yank them out of the scrollback.
	const stick = !termSized || nearBottom(el.term);
	termSized = true;
	if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
	applyScale();
	if (stick) toBottom(el.term);
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

/** Optimistic switch: flip the UI immediately, let the server's push confirm. */
function selectWindow(id: string): void {
	send({ t: "select", window: id });
	if (state.windows.some((w) => w.id === id)) {
		for (const w of state.windows) w.active = w.id === id;
		localStorage.setItem("lastWindow", id);
		renderTabs();
		renderWindowList();
		if (state.view === "reader") void refreshReader();
	}
}

function renderTabs(): void {
	el.tabs.replaceChildren(
		...state.windows.map((w) => {
			const b = document.createElement("button");
			b.className = `tab${w.active ? " active" : ""}${w.activity || w.bell ? " activity" : ""}`;
			b.textContent = `${w.index}:${w.name}`;
			b.onclick = () => selectWindow(w.id);
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
				selectWindow(w.id);
				closeDrawer();
			};
			row.append(meta);
			return row;
		}),
	);
}

let readerBusy = false;
async function refreshReader(): Promise<void> {
	const w = activeWindow();
	if (!w || readerBusy) return; // never let refreshes overlap and land out of order
	readerBusy = true;
	const pane = w.paneId;
	const keepBottom = el.reader.scrollTop + el.reader.clientHeight >= el.reader.scrollHeight - 40;
	try {
		const res = await fetch(`/api/capture?target=${encodeURIComponent(pane)}&lines=3000`, { cache: "no-store" });
		if (!res.ok) {
			status(`capture failed: ${res.status}`, 3000, true);
			return;
		}
		const body = (await res.text()).replace(/\n+$/, "");
		if (state.view !== "reader" || activeWindow()?.paneId !== pane) return; // stale
		el.readerText.textContent = body;
		if (keepBottom) el.reader.scrollTop = el.reader.scrollHeight;
	} catch (err) {
		status(`capture failed: ${String((err as Error).message)}`, 3000, true);
	} finally {
		readerBusy = false;
	}
}

function setView(view: "raw" | "reader" | "meta"): void {
	state.view = view;
	if (view !== "meta") state.lastTermView = view;
	el.reader.hidden = view !== "reader";
	el.meta.hidden = view !== "meta";
	el.term.style.visibility = view === "raw" ? "visible" : "hidden";
	el.ribbon.hidden = view === "meta";
	el.abort.hidden = view !== "meta";
	$("btn-insert").hidden = view === "meta"; // "insert without Enter" is a terminal thing
	el.input.placeholder = view === "meta" ? "ask super…" : "prompt…";
	$("btn-view").textContent = view === "reader" ? "▣" : "📖";
	$("btn-meta").classList.toggle("armed", view === "meta");
	clearInterval(state.readerTimer as ReturnType<typeof setInterval>);
	if (view === "reader") {
		void refreshReader();
		state.readerTimer = setInterval(() => void refreshReader(), 2500);
	} else if (view === "raw") {
		refit();
		toBottom(el.term);
	}
	if (view === "meta") el.meta.scrollTop = el.meta.scrollHeight;
}

// -------------------------------------------------------------------- input

function sendText(text: string, enter: boolean): void {
	if (!text) return;
	if (state.view === "meta") meta.send(text);
	else send({ t: "paste", text, enter });
	el.input.value = "";
	localStorage.removeItem("draft");
	autogrow();
}

function autogrow(): void {
	// Cap against the *visual* viewport: with the on-screen keyboard up, innerHeight
	// still reports the full screen and a long draft would crowd out the terminal.
	const viewH = window.visualViewport?.height ?? window.innerHeight;
	el.input.style.height = "auto";
	el.input.style.height = `${Math.min(el.input.scrollHeight, viewH * 0.3)}px`;
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

$("btn-menu").onclick = () => {
	openDrawer();
	void refreshAuthUi();
};
$("btn-close-drawer").onclick = closeDrawer;
el.drawer.onclick = (e) => {
	if (e.target === el.drawer) closeDrawer();
};
$("btn-view").onclick = () => {
	const next = state.view === "reader" ? "raw" : "reader";
	localStorage.setItem("view", next);
	setView(next);
};
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
// The draft survives reloads, server restarts and the phone evicting the tab.
el.input.addEventListener("input", () => {
	autogrow();
	if (el.input.value) localStorage.setItem("draft", el.input.value);
	else localStorage.removeItem("draft");
});
window.visualViewport?.addEventListener("resize", autogrow);
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

$("btn-font-inc").onclick = () => zoomBy(1.25);
$("btn-font-dec").onclick = () => zoomBy(1 / 1.25);

/**
 * In claim mode we own the geometry, so A+/A- changes the font (and thus how many columns
 * we ask for). In ignore mode the server dictates the grid, so the only thing that can
 * change is how far we zoom into it.
 */
function zoomBy(factor: number): void {
	if (state.sizeMode === "claim") {
		state.fontSize = Math.max(6, Math.min(24, Math.round(state.fontSize * factor)));
		localStorage.setItem("fontSize", String(state.fontSize));
		term.options.fontSize = state.fontSize;
	} else {
		state.zoom = Math.max(0.5, Math.min(6, state.zoom * factor));
		localStorage.setItem("zoom", String(state.zoom));
	}
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
	// Keyboard/URL-bar resizes squeeze the layout; whoever was reading the tail of the
	// visible view must stay pinned to it, or the newest output vanishes under the
	// composer. Hidden views have zero heights — touching them would trash their state.
	const e = activeScroller();
	const stick = nearBottom(e);
	requestAnimationFrame(() => {
		refit();
		if (stick) toBottom(e);
	});
};
window.addEventListener("resize", onViewportChange);
window.visualViewport?.addEventListener("resize", onViewportChange);
new ResizeObserver(onViewportChange).observe(el.term);

// ?debug=1 exposes the innards (same-origin only) so the headless e2e harness — and you,
// from devtools — can drive a call and watch every realtime event go by.
if (new URLSearchParams(location.search).has("debug")) {
	const events: Array<{ dir: string; t: unknown; ev: unknown; at: number }> = [];
	const spoken: string[] = [];
	const transcript: Array<{ role: string; text: string }> = [];
	voice.onEvent = (dir, ev) => {
		events.push({ dir, t: ev.type, ev, at: Date.now() });
		if (events.length > 500) events.shift();
	};
	const prevSpeak = meta.onSpeak;
	meta.onSpeak = (msg) => {
		spoken.push(msg.message);
		prevSpeak?.(msg);
	};
	const prevTranscript = voice.onTranscript;
	voice.onTranscript = (role, text) => {
		transcript.push({ role, text });
		prevTranscript?.(role, text);
	};
	(window as unknown as Record<string, unknown>).piSuper = {
		voice,
		meta,
		state,
		events,
		spoken,
		transcript,
		auth: { enroll: enrollPasskey, login: loginWithPasskey, state: authState, logout },
	};
}

// Passkey gate: nothing connects until the lock screen is satisfied (no-op when no
// passkey is enrolled yet, so first-run enrolment over the token still works).
async function refreshAuthUi(): Promise<void> {
	try {
		const s = await authState();
		el.passkeyInfo.textContent = s.enrolled
			? `passkeys: ${s.credentials.map((c) => c.label).join(", ")}`
			: s.supported
				? "no passkey yet — the token alone lets anyone on your network in"
				: "passkeys need HTTPS (Tailscale serve / a TLS proxy)";
		$("btn-passkey").hidden = !s.canEnroll || !s.supported;
		$("btn-lock").hidden = !s.enrolled;
	} catch {
		el.passkeyInfo.textContent = "passkeys: unavailable";
	}
}

$("btn-passkey").onclick = () => {
	const label = prompt("name this passkey", navigator.userAgent.includes("Android") ? "phone" : "laptop");
	if (label === null) return;
	el.passkeyInfo.textContent = "enrolling…";
	enrollPasskey(label.trim() || "passkey")
		.then((name) => {
			status(`passkey "${name}" enrolled — the token alone no longer opens this`, 6000);
			void refreshAuthUi();
		})
		.catch((e: Error) => {
			// #status sits under the drawer overlay, so a failure must land here too —
			// an instant rejection otherwise looks like the button doing nothing at all
			const detail = `${(e as DOMException).name ?? "Error"}: ${e.message}`;
			el.passkeyInfo.textContent = `enrolment failed — ${detail}`;
			status(`enrolment failed: ${detail}`, 8000, true);
		});
};
$("btn-lock").onclick = () => {
	void logout().then(() => location.reload());
};

el.input.value = localStorage.getItem("draft") ?? "";
if (el.input.value) autogrow();
el.claim.checked = state.sizeMode === "claim";
// On a phone the desktop-width raw terminal is unreadable at a glance, and reader mode is
// the whole point; on a wide screen the real terminal is what you want. Remembered after
// the first manual switch.
const savedView = localStorage.getItem("view") as "raw" | "reader" | null;
setView(savedView ?? (window.innerWidth < 600 ? "reader" : "raw"));
void gate().then(() => {
	connect();
	void refreshAuthUi();
});
