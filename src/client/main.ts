import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { authState, enrollPasskey, gate, loginWithPasskey, logout } from "./auth.js";
import { createDictation } from "./dictate.js";
import { createMeta } from "./meta.js";
import { initPeek, pathAt } from "./peek.js";
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
	callWarn: $("call-warn"),
	status: $("status"),
	input: $<HTMLTextAreaElement>("input"),
	ribbon: $("ribbon"),
	drawer: $("drawer"),
	windowList: $("window-list"),
	views: $("views"),
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
	sizeMode: (localStorage.getItem("sizeMode") as "ignore" | "claim" | null) ?? "claim",
	fontSize: Number(localStorage.getItem("fontSize") ?? 13),
	zoom: Number(localStorage.getItem("zoom") ?? 1),
	session: "",
	base: "",
	backoff: 500,
	connectedAt: 0,
	/** after (re)connect: re-select the remembered window once the list arrives */
	restorePending: false,
	readerTimer: 0 as number | ReturnType<typeof setInterval>,
	/** cwd of the pane the reader text was captured from, snapshotted with it */
	readerCwd: "",
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
 * ours is stale, reload — but only while the app is backgrounded, so the refresh is
 * never visible: the user just always finds a fresh UI when they come back. Drafts,
 * view and window selection all survive reloads. In dev (vite serves main.ts, no
 * hashed asset) this stays inert.
 */
const myBuild = Array.from(document.scripts)
	.map((s) => s.src.match(/assets\/index-[\w-]+\.js/)?.[0])
	.find(Boolean);
let pendingBuild: string | undefined;
function maybeReload(build: unknown): void {
	if (!myBuild || typeof build !== "string" || !build || build === myBuild) return;
	if (sessionStorage.getItem("reloadedFor") === build) return; // never loop
	pendingBuild = build;
	if (document.hidden) applyPendingReload();
}
function applyPendingReload(): void {
	if (!pendingBuild) return;
	sessionStorage.setItem("reloadedFor", pendingBuild);
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
	// Ask for the remembered window up front: selecting it after the attach means the first
	// paint is whatever window the desktop happens to sit on, which flashes past for a second.
	const want = localStorage.getItem("lastWindow");
	const url =
		`${proto}//${location.host}/ws?cols=${cols}&rows=${rows}&mode=${state.sizeMode}` +
		(want ? `&window=${encodeURIComponent(want)}` : "");
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
				// The phone reloads itself into a new client bundle, but the server it talks to
				// does not restart itself — and an old server ignores new control messages in
				// silence, so the symptom is "the new feature does nothing". Say it instead.
				if (msg.stale) status("server is running older code than this page — restart pi-super", 10000, true);
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
				syncDraft();
				pruneDrafts();
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
	if (document.hidden) {
		applyPendingReload();
		return;
	}
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

/**
 * Optimistic switch: flip the UI immediately, let the server's push confirm.
 *
 * `show` marks the deliberate ones (a tab, a row in the drawer). Picking a window by hand
 * means wanting to look at it, so it also leaves the chat — staying in it made the tap
 * look like it had done nothing at all. Server-driven switches must not do that: they
 * would yank the user out of a conversation they are in the middle of.
 */
function selectWindow(id: string, opts: { show?: boolean } = {}): void {
	send({ t: "select", window: id });
	if (opts.show && state.view === "meta") setView(state.lastTermView);
	if (state.windows.some((w) => w.id === id)) {
		for (const w of state.windows) w.active = w.id === id;
		localStorage.setItem("lastWindow", id);
		renderTabs();
		renderWindowList();
		syncDraft();
		if (state.view === "reader") void refreshReader();
	}
}

/** Neighbouring window, in list order. Clamped: wrapping past the ends feels like a bug. */
function stepWindow(delta: number): void {
	const at = state.windows.findIndex((w) => w.active);
	const next = state.windows[at + delta];
	if (at < 0 || !next) return;
	selectWindow(next.id);
	status(`${delta > 0 ? "▸" : "◂"} ${next.index}:${next.name}`, 1200);
}

function renderTabs(): void {
	el.tabs.replaceChildren(
		...state.windows.map((w) => {
			const b = document.createElement("button");
			b.className = `tab${w.active ? " active" : ""}${w.activity || w.bell ? " activity" : ""}`;
			b.textContent = `${w.index}:${w.name}`;
			b.onclick = () => selectWindow(w.id, { show: true });
			return b;
		}),
	);
	el.tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "center" });
}

/**
 * The pane title, unless it is the shell's default "user@host: /cwd" — that one says
 * nothing the path line below it does not already say, and it is long enough to push the
 * useful part of a real title off the row. Both halves must match: a real title that
 * happens to end in a path keeps its place.
 */
const SHELL_TITLE = /^[^\s:@]+@[^\s:@]+:\s/;
function paneTitle(w: WindowInfo): string {
	const title = w.paneTitle?.trim() ?? "";
	if (!title) return "";
	if (w.paneCwd && SHELL_TITLE.test(title) && title.endsWith(w.paneCwd)) return "";
	return title;
}

/**
 * Drag-to-renumber, on a dedicated grip: the row itself is a tap target (select this
 * window), and a long-press-to-drag would make every mis-timed tap feel broken. Pointer
 * events rather than HTML5 drag-and-drop, which does not exist on touch.
 */
let dragging: string | undefined;
function startRowDrag(ev: PointerEvent, row: HTMLElement, id: string): void {
	ev.preventDefault();
	const list = el.windowList;
	const grip = ev.currentTarget as HTMLElement;
	grip.setPointerCapture(ev.pointerId);
	dragging = id;
	row.classList.add("dragging");
	let origin = ev.clientY;

	const move = (e: PointerEvent) => {
		row.style.transform = `translateY(${e.clientY - origin}px)`;
		const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
		for (const other of [...list.children] as HTMLElement[]) {
			if (other === row) continue;
			const box = other.getBoundingClientRect();
			if (mid < box.top || mid > box.bottom) continue;
			const before = row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING;
			const was = row.getBoundingClientRect().top;
			list.insertBefore(row, before ? other.nextSibling : other);
			// the row just jumped a slot; move the drag origin with it, or the finger and the
			// row drift apart by one row height per swap
			origin += row.getBoundingClientRect().top - was;
			row.style.transform = `translateY(${e.clientY - origin}px)`;
			break;
		}
	};
	const end = () => {
		grip.removeEventListener("pointermove", move);
		grip.removeEventListener("pointerup", end);
		grip.removeEventListener("pointercancel", end);
		row.style.transform = "";
		row.classList.remove("dragging");
		dragging = undefined;
		const prev = row.previousElementSibling as HTMLElement | null;
		const next = row.nextElementSibling as HTMLElement | null;
		// Anchor on a neighbour rather than an index: the list may have changed under us.
		if (prev?.dataset.window) send({ t: "moveWindow", window: id, target: prev.dataset.window, where: "after" });
		else if (next?.dataset.window) send({ t: "moveWindow", window: id, target: next.dataset.window, where: "before" });
		else renderWindowList();
	};
	grip.addEventListener("pointermove", move);
	grip.addEventListener("pointerup", end);
	grip.addEventListener("pointercancel", end);
}

function renderWindowList(): void {
	// a poll landing mid-drag would replace the node under the finger
	if (dragging) return;
	el.windowList.replaceChildren(
		...state.windows.map((w) => {
			const row = document.createElement("div");
			row.className = "wrow";
			row.dataset.window = w.id;
			const grip = document.createElement("div");
			grip.className = "grip";
			grip.textContent = "⠿";
			grip.title = "drag to reorder (renumbers the tmux windows)";
			grip.onpointerdown = (ev) => startRowDrag(ev, row, w.id);
			const meta = document.createElement("div");
			meta.className = "meta";
			const name = document.createElement("div");
			name.className = `name${w.active ? " active" : ""}`;
			name.textContent = `${w.index}: ${w.name} · ${w.paneCmd}`;
			// The pane title is what an agent window actually says about itself ("π - CZ filter
			// done; WSDP pricing next"); the tmux window name is usually just "sh". One line,
			// clipped — wrapping would turn the list into a wall of prose.
			const title = paneTitle(w);
			if (title) {
				const t = document.createElement("span");
				t.className = "title";
				t.textContent = ` ${title}`;
				name.append(t);
			}
			const path = document.createElement("div");
			path.className = "path";
			path.textContent = w.paneCwd;
			meta.append(name, path);
			meta.onclick = () => {
				selectWindow(w.id, { show: true });
				closeDrawer();
			};
			row.append(grip, meta);
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
		state.readerCwd = w.paneCwd; // snapshotted with the text, for resolving paths tapped in it
		if (keepBottom) el.reader.scrollTop = el.reader.scrollHeight;
	} catch (err) {
		status(`capture failed: ${String((err as Error).message)}`, 3000, true);
	} finally {
		readerBusy = false;
	}
}

/**
 * Tapping a path in the capture (or in the chat) opens the file. Relative paths are
 * printed relative to the pane's own cwd, which is the one thing the phone knows and the
 * server would have to guess.
 */
const peek = initPeek({
	// The reader is a capture taken at some past moment; the pane may have been switched
	// or `cd`ed since, and resolving against the pane's *current* cwd would then quietly
	// open the same-named file from the wrong worktree. So the capture carries its own.
	// (The popup always shows the resolved path, which is the check on any guess here.)
	cwd: () => (state.view === "reader" ? state.readerCwd : activeWindow()?.paneCwd ?? ""),
	status,
});
for (const host of [el.reader, el.meta]) {
	host.addEventListener("click", (e) => {
		// a tap that ended a selection or landed on a control was aimed at something else
		if (!(window.getSelection()?.isCollapsed ?? true)) return;
		if ((e.target as HTMLElement).closest("a,button,input,textarea")) return;
		peek.fromPoint(e.clientX, e.clientY);
	});
}

/**
 * The raw view is a grid, not text: there is no DOM node under the finger to hit-test, so
 * the tap is turned into a cell by hand. The screen's on-screen rect already accounts for
 * the ignore-mode scale transform and any font size, so cell size is just that rect over
 * the grid — no need to know either.
 */
el.term.addEventListener("click", (e) => {
	if (term.hasSelection()) return; // a tap that ended a selection meant the selection
	// A mouse-tracking TUI (vim, a pager, tmux copy-mode) has already been sent this tap as
	// a click of its own; opening a popup on top of whatever it just did is not what anyone
	// meant by it. Those apps own the pointer, and the reader view is one button away.
	if (term.modes.mouseTrackingMode !== "none") return;
	const screen = el.term.querySelector<HTMLElement>(".xterm-screen");
	if (!screen) return;
	const r = screen.getBoundingClientRect();
	if (!r.width || !r.height) return;
	const col = Math.floor(((e.clientX - r.left) / r.width) * term.cols);
	const row = Math.floor(((e.clientY - r.top) / r.height) * term.rows);
	if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return;
	const hit = cellText(row, col);
	const target = hit && pathAt(hit.text, hit.index);
	if (target) peek.open(target);
});

/**
 * The whole logical line the given viewport cell sits on, and where in it the cell landed.
 * Logical, because at 80 columns a long path is usually split across two rows — the buffer
 * flags the continuation, and a path broken in half is exactly the one worth opening.
 */
function cellText(row: number, col: number): { text: string; index: number } | undefined {
	const buf = term.buffer.active;
	const y = buf.viewportY + row;
	let start = y;
	while (start > 0 && buf.getLine(start)?.isWrapped) start--;
	let text = "";
	let index = -1;
	for (let k = start; k < buf.length; k++) {
		const line = buf.getLine(k);
		if (!line || (k > start && !line.isWrapped)) break;
		// Columns are not string offsets: a CJK glyph is two columns wide and one character
		// long, so the prefix has to be translated to be measured.
		if (k === y) index = text.length + line.translateToString(false, 0, col).length;
		// untrimmed, and clamped to the grid: the padding is what keeps the arithmetic true
		// across the join, while a line left wider than the grid by a resize has an invisible
		// tail that must not count
		text += line.translateToString(false, 0, term.cols);
	}
	return index < 0 ? undefined : { text, index };
}

function setView(view: "raw" | "reader" | "meta"): void {
	state.view = view;
	if (view !== "meta") state.lastTermView = view;
	el.reader.hidden = view !== "reader";
	el.meta.hidden = view !== "meta";
	el.term.style.visibility = view === "raw" ? "visible" : "hidden";
	el.ribbon.hidden = view === "meta";
	// the tab strip stays up in the chat view, but it is no longer what you are looking at:
	// it drops to the secondary blue and super's button takes the green (see style.css)
	document.body.classList.toggle("meta-view", view === "meta");
	el.abort.hidden = view !== "meta";
	$("btn-insert").hidden = view === "meta"; // "insert without Enter" is a terminal thing
	el.input.placeholder = view === "meta" ? "ask super…" : "prompt…";
	$("btn-view").textContent = view === "reader" ? "▣" : "📖";
	refreshCallButton();
	refreshCallBar();
	clearInterval(state.readerTimer as ReturnType<typeof setInterval>);
	if (view === "reader") {
		void refreshReader();
		state.readerTimer = setInterval(() => void refreshReader(), 2500);
	} else if (view === "raw") {
		refit();
		toBottom(el.term);
	}
	if (view === "meta") el.meta.scrollTop = el.meta.scrollHeight;
	// the chat and the terminal are different conversations; so is every window
	syncDraft();
}

// ------------------------------------------------------------------- drafts

/**
 * A half-typed prompt belongs to the thing it was aimed at: switching windows (or over to
 * the chat) must not carry it along, and must not lose it either. So drafts are keyed by
 * target and swapped in and out of the one textarea as the target changes.
 */
function draftKey(): string | undefined {
	if (state.view === "meta") return "draft:meta";
	const w = activeWindow();
	return w ? `draft:${w.id}` : undefined;
}

/** What the textarea currently holds a draft *for* — undefined before the first window list. */
let draftFor: string | undefined;

function saveDraft(): void {
	if (!draftFor) return;
	if (el.input.value) localStorage.setItem(draftFor, el.input.value);
	else localStorage.removeItem(draftFor);
}

/** Park the current text under its own key and load whatever belongs to the new target. */
function syncDraft(): void {
	const key = draftKey();
	if (!key || key === draftFor) return;
	// dictation is pinned to the draft it started in: letting it run on would splice what is
	// being said into some other window's text and save it there
	dictate.stop();
	// typed before the first window list arrived: that text was meant for this target, so
	// adopt it rather than clobbering it with whatever was stored
	const orphan = draftFor === undefined && el.input.value !== "";
	saveDraft();
	draftFor = key;
	// one-time carry-over from the single shared draft of older builds
	const legacy = localStorage.getItem("draft");
	if (legacy !== null) {
		localStorage.removeItem("draft");
		if (!localStorage.getItem(key)) localStorage.setItem(key, legacy);
	}
	if (orphan) {
		saveDraft();
		return;
	}
	el.input.value = localStorage.getItem(key) ?? "";
	autogrow();
}

/** Windows die; their drafts must not pile up in localStorage forever. */
function pruneDrafts(): void {
	const live = new Set(state.windows.map((w) => `draft:${w.id}`));
	live.add("draft:meta");
	for (const k of Object.keys(localStorage)) {
		if (k.startsWith("draft:") && !live.has(k)) localStorage.removeItem(k);
	}
}

// -------------------------------------------------------------------- input

function sendText(text: string, enter: boolean): void {
	// Sending is the user saying "done". An open microphone would splice the next word into
	// the box we just emptied, refilling it with what was already sent — which reads as the
	// send having silently failed, and leaves stale text behind for every send after it.
	dictate.stop();
	if (!text) return;
	if (state.view === "meta") meta.send(text);
	else send({ t: "paste", text, enter });
	el.input.value = "";
	saveDraft();
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
el.abort.onclick = () => meta.abort();

/** super's one button carries three signals: chat open, call up, super working. */
let metaBusy = false;
/** set by a failed dial, cleared by an explicit hang-up */
let dialFailed = false;
function refreshCallButton(): void {
	const btn = $("btn-call");
	btn.classList.toggle("open", state.view === "meta");
	btn.classList.toggle("armed", voice.state === "live");
	btn.classList.toggle("busy", voice.state === "connecting" || metaBusy);
}

const meta = createMeta(el.meta);
meta.onState = (s) => {
	metaBusy = s.busy;
	refreshCallButton();
};

const voice = createVoice(meta);
meta.onSpeak = ({ message, kind }) => {
	const fate = voice.pushUpdate(message, kind);
	// An update the call could not take is exactly the one worth putting on screen, even
	// in the chat view where it is also a 🔊 line: otherwise super looks like it went quiet.
	if (fate === "queued") status(`🔊 ${message} — will be spoken on your next turn`, 8000);
	else if (state.view !== "meta") status(`🔊 ${message}`, 6000);
};
/**
 * gpt-live (the ChatGPT/Codex realtime model) is the mode this thing is built around;
 * everything else is a downgrade the user should not discover by being confused at it —
 * the API fallback bills per minute, and local speech is half duplex with no barge-in.
 */
function degradedVoiceWarning(): string {
	const cfg = voice.config;
	if (!cfg) return "";
	if (cfg.provider === "local") return "⚠ degraded: browser speech — half duplex, no barge-in";
	if (cfg.provider === "openai")
		return `⚠ degraded: OpenAI Realtime API (${cfg.model}) — not gpt-live, billed per minute`;
	if (cfg.provider === "codex" && !cfg.model.startsWith("gpt-live")) return `⚠ degraded: ${cfg.model} — not gpt-live`;
	return "";
}

/**
 * The bar carries two different things: the call (only while there is one) and /new, which
 * is how you drop a conversation that has wandered off. The second is most wanted exactly
 * when the first is over, so in the chat view the bar stays after the hang-up — with the
 * call controls gone, since there is nothing left to mute.
 */
/**
 * Where the call's audio is going, and where it could go instead. Only the Android wrapper
 * reports this; in a browser it stays empty and the switch never appears.
 */
let callRoute = "speaker";
let callRoutes: string[] = [];
const ROUTE_ICON: Record<string, string> = { speaker: "🔊", bluetooth: "🎧", wired: "🎧", earpiece: "📞" };
/**
 * One button, so it cycles rather than toggles — and it cycles through the routes the
 * phone actually offers. A hardcoded speaker/earpiece switch would strand anyone on a
 * headset: tapping it once would drop bluetooth with no way back, and on a tablet with no
 * earpiece at all it would do nothing.
 */
const ROUTE_ORDER = ["speaker", "bluetooth", "wired", "earpiece"];
function nextRoute(): string | undefined {
	const ring = ROUTE_ORDER.filter((r) => callRoutes.includes(r));
	if (ring.length < 2) return undefined;
	return ring[(ring.indexOf(callRoute) + 1) % ring.length];
}

function refreshCallBar(detail?: string): void {
	const s = voice.state;
	const idle = s === "idle";
	if (idle) callRoutes = [];
	el.call.hidden = idle && state.view !== "meta";
	el.call.classList.toggle("idle", idle);
	// mute/hush need a call that is actually up; hang up doubles as "dismiss this failed
	// dial"; /new is a whole-conversation reset, so it waits until there is no call to
	// half-reset (the speech model keeps its own context, which we cannot clear from here).
	$("btn-mute").hidden = s !== "live";
	$("btn-hush").hidden = s !== "live";
	// The speaker switch is about *this* call's audio, so off a call it says nothing at all
	// — rather than sitting there showing where the last one came out.
	$("btn-speaker").hidden = s !== "live" || callRoutes.length < 2;
	$("btn-hangup").hidden = idle;
	$("btn-new-session").hidden = !idle;
	el.callState.textContent = idle
		? "not on a call"
		: s === "live"
			? "connected — talk to super"
			: detail
				? `${s}: ${detail}`
				: s;
	const warn = idle ? "" : degradedVoiceWarning();
	el.callWarn.textContent = warn;
	el.callWarn.hidden = !warn;
	if (idle) disarmNewSession();
}

voice.onState = (s, detail) => {
	refreshCallBar(detail);
	// A failed dial must not be retried on every visit to the chat; hanging up clears it.
	if (s === "error") dialFailed = true;
	refreshCallButton();
	// a redial re-acquires the mic, so the mute button must not keep claiming otherwise
	if (s !== "live") {
		$("btn-mute").textContent = "🎙";
		$("btn-mute").classList.remove("armed");
	}
	if (s === "error" && detail) status(detail, 8000, true);
};
voice.onTranscript = (role, text) => {
	if (role === "user") status(`🎙 ${text}`, 4000);
};
// non-fatal realtime errors: worth showing, not worth ending the call over
voice.onNotice = (text) => status(text, 6000, true);

// ---------------------------------------------------------------- dictation

const dictate = createDictation();
/** the text around the insertion point, pinned when the mic opens */
let dictBefore = "";
let dictAfter = "";

dictate.onStart = () => {
	const pos = el.input.selectionStart ?? el.input.value.length;
	dictBefore = el.input.value.slice(0, pos);
	dictAfter = el.input.value.slice(pos);
	// dictating after an existing word must not weld the two together
	if (dictBefore && !/\s$/.test(dictBefore)) dictBefore += " ";
};
dictate.onText = (text) => {
	el.input.value = dictBefore + text + dictAfter;
	const caret = dictBefore.length + text.length;
	el.input.setSelectionRange(caret, caret);
	autogrow();
	saveDraft();
};
dictate.onState = (s, detail) => {
	const btn = $("btn-mic");
	btn.classList.toggle("armed", s === "listening");
	btn.classList.toggle("busy", s === "connecting");
	btn.textContent = s === "idle" ? "🎙" : "■";
	if (detail) status(detail, 6000, true);
};
$("btn-mic").onclick = () => {
	// one microphone: a live call already owns it, and silently stealing it would kill the call
	if (voice.state !== "idle" && dictate.state === "idle") {
		status("the call has the mic — hang up first", 3000, true);
		return;
	}
	dictate.toggle(activeWindow()?.paneId);
};
void dictate.available().then((ok) => {
	$("btn-mic").hidden = !ok;
});

// One button for super: it opens the chat and places the call in the same press, because
// on a phone those are never wanted separately — mute and hush handle "not now", and
// leaving the chat view deliberately does *not* hang up (the call bar stays put).
$("btn-call").onclick = () => {
	if (state.view === "meta") {
		setView(state.lastTermView);
		return;
	}
	dictate.stop(); // the call is about to want the microphone
	setView("meta");
	if (!dialFailed && (voice.state === "idle" || voice.state === "error")) void voice.start();
};
$("btn-hangup").onclick = () => {
	dialFailed = false;
	voice.stop({ clearError: true });
};
$("btn-hush").onclick = () => voice.hush();
function showMuted(muted: boolean): void {
	$("btn-mute").textContent = muted ? "🔇" : "🎙";
	$("btn-mute").classList.toggle("armed", muted);
}
$("btn-mute").onclick = () => showMuted(voice.toggleMute());
// the Android wrapper's call can also be muted from a car kit or a watch
voice.onMute = showMuted;

// Where the call comes out. A phone call starts on the earpiece, which is right for a
// phone at your ear and wrong for an assistant across the room, so the app defaults to the
// speaker — but a headset, or an ear, is a good enough reason to move it back.
voice.onRoute = (route, routes) => {
	callRoute = route;
	callRoutes = routes;
	const btn = $("btn-speaker");
	btn.textContent = ROUTE_ICON[route] ?? "📞";
	const next = nextRoute();
	btn.title = next ? `audio: ${route} (tap for ${next})` : `audio: ${route}`;
	btn.classList.toggle("armed", route === "speaker");
	refreshCallBar();
};
$("btn-speaker").onclick = () => {
	const next = nextRoute();
	if (next) voice.setRoute(next);
};

// Throwing away the conversation is not undoable, and this button sits under the thumb
// next to hang-up — so it asks, in place, rather than through a modal nobody reads.
let newSessionTimer: ReturnType<typeof setTimeout> | undefined;
function disarmNewSession(): void {
	clearTimeout(newSessionTimer);
	newSessionTimer = undefined;
	$("btn-new-session").textContent = "/new";
	$("btn-new-session").classList.remove("armed");
}
$("btn-new-session").onclick = () => {
	if (newSessionTimer) {
		disarmNewSession();
		meta.newSession();
		status("started a fresh super session", 4000);
		return;
	}
	$("btn-new-session").textContent = "sure?";
	$("btn-new-session").classList.add("armed");
	newSessionTimer = setTimeout(disarmNewSession, 4000);
};

$("btn-send").onclick = () => sendText(el.input.value, true);
$("btn-insert").onclick = () => sendText(el.input.value, false);
// The draft survives reloads, server restarts and the phone evicting the tab.
el.input.addEventListener("input", () => {
	autogrow();
	saveDraft();
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

// A ribbon key is a modifier for what you are typing, not a change of subject: taking
// focus would drop the on-screen keyboard and the caret with it. mousedown (not
// pointerdown) is where focus moves and it fires after the touch is over, so cancelling it
// keeps the textarea focused without interfering with scrolling the ribbon sideways.
for (const strip of [el.ribbon, $("composer")]) {
	strip.addEventListener("mousedown", (e) => {
		if ((e.target as HTMLElement).closest("button")) e.preventDefault();
	});
}

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

/**
 * Swipes: left/right walks the window list, up/down pages the terminal — the tab strip and
 * the pgup/pgdn keys are both small targets on a phone.
 *
 * Deliberately narrow: one finger, clearly along one axis, and never while the view can
 * still scroll that way itself. An ignore-size terminal is bigger than the screen and
 * panning it is the more specific gesture; the reader and the chat scroll natively. So
 * the gesture only fires where there is nothing else it could have meant.
 */
const SWIPE_MIN_PX = 60;
const SWIPE_MAX_MS = 700;
let swipe: { x: number; y: number; at: number } | undefined;
el.views.addEventListener(
	"touchstart",
	(e: TouchEvent) => {
		const t = e.touches.length === 1 ? e.touches[0] : undefined;
		swipe = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : undefined;
	},
	{ passive: true },
);
el.views.addEventListener(
	"touchend",
	(e: TouchEvent) => {
		const from = swipe;
		swipe = undefined;
		const t = e.changedTouches[0];
		if (!from || !t || state.view === "meta" || Date.now() - from.at > SWIPE_MAX_MS) return;
		const dx = t.clientX - from.x;
		const dy = t.clientY - from.y;
		if (Math.abs(dx) >= Math.abs(dy)) {
			if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 2) return;
			if (el.term.scrollWidth > el.term.clientWidth + 2) return;
			stepWindow(dx < 0 ? 1 : -1);
			return;
		}
		// Vertical: only over the live terminal. The reader is a scrollable capture and the
		// chat is a log — both already do the right thing with a drag.
		if (state.view !== "raw") return;
		if (Math.abs(dy) < SWIPE_MIN_PX || Math.abs(dy) < Math.abs(dx) * 2) return;
		if (el.term.scrollHeight > el.term.clientHeight + 2) return;
		// Dragging the content up reveals what is below it, i.e. pages forward.
		const key = dy < 0 ? "PageDown" : "PageUp";
		send({ t: "keys", keys: [key] });
		status(dy < 0 ? "▾ pgdn" : "▴ pgup", 900);
	},
	{ passive: true },
);

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
	// dictation timings only make sense against the moment each state changed
	const dictation: Array<{ state: string; text: string; at: number }> = [];
	const prevDictState = dictate.onState;
	dictate.onState = (s, detail) => {
		dictation.push({ state: s, text: el.input.value, at: Date.now() });
		prevDictState?.(s, detail);
	};
	const prevDictText = dictate.onText;
	dictate.onText = (text) => {
		dictation.push({ state: "text", text, at: Date.now() });
		prevDictText?.(text);
	};
	(window as unknown as Record<string, unknown>).piSuper = {
		voice,
		dictate,
		dictation,
		meta,
		state,
		// lets a harness open the chat without also placing a call
		setView,
		selectWindow,
		peek,
		term,
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

syncDraft();
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
