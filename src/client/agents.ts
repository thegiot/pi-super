/**
 * The Agents view: every agent herdr knows about, on this machine and on the
 * saved remote ones, as tappable cards with a detail view (live output tail,
 * a few safe keys, and the composer becomes a direct prompt channel).
 *
 * The module owns everything inside #agents; main.ts owns the chrome around it
 * (header button + badge, the shared composer, view switching).
 */

export interface FleetAgentDto {
	machine: string;
	name?: string;
	kind: string;
	status: string;
	paneId: string;
	workspace?: string;
	tab?: string;
	paneLabel?: string;
	cwd: string;
	title: string;
	focused: boolean;
	since: number;
	sinceApprox?: boolean;
}

interface FleetMachine {
	machine: string;
	ok: boolean;
	error?: string;
	updatedAt: number;
	agents: FleetAgentDto[];
}

interface FleetSnapshot {
	machines: FleetMachine[];
}

export interface FleetTarget {
	machine: string;
	pane: string;
	name: string;
}

export interface AgentsCallbacks {
	/** "ask super" hands the agent's identity to the meta composer */
	onAskSuper: (agent: FleetAgentDto) => void;
	/** detail open/close decides whether the shared composer is a prompt box */
	onDetailChange: (target: FleetTarget | undefined) => void;
	/** the fleet API is absent: hide the button, stop polling */
	onUnavailable: () => void;
	/** blocked-agent count for the header badge */
	onBadge: (count: number) => void;
	status: (msg: string, ms?: number, isErr?: boolean) => void;
}

const SECTIONS: Array<{ status: string; label: string }> = [
	{ status: "blocked", label: "needs you" },
	{ status: "working", label: "working" },
	{ status: "done", label: "done" },
	{ status: "idle", label: "idle" },
	{ status: "unknown", label: "unknown" },
];

const KEYS: Array<{ label: string; key: string }> = [
	{ label: "esc", key: "esc" },
	{ label: "⏎", key: "enter" },
	{ label: "↑", key: "up" },
	{ label: "↓", key: "down" },
	{ label: "^C", key: "ctrl+c" },
];

const DETAIL_KEY = "agentsDetail";

function age(since: number, approx: boolean | undefined): string {
	const s = Math.max(0, Math.round((Date.now() - since) / 1000));
	const t = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
	return approx ? `~${t}` : t;
}

/** $HOME is unknown on the client side; the common /home/<user> form is close enough. */
function shortCwd(cwd: string): string {
	const parts = cwd.replace(/^\/home\/[^/]+/, "~").split("/").filter(Boolean);
	return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/") || cwd;
}

function agentLabel(a: FleetAgentDto): string {
	return a.name ?? (a.tab ?? a.paneLabel ? `${a.kind} ${a.tab ?? a.paneLabel}` : a.kind);
}

export function createAgents(root: HTMLElement, cb: AgentsCallbacks) {
	let snap: FleetSnapshot | undefined;
	let enabled = true;
	let active = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let readTimer: ReturnType<typeof setInterval> | undefined;
	let detail: { machine: string; pane: string } | undefined;
	let detailError = "";
	let out: HTMLElement | undefined;
	/** first fill always lands at the bottom; after that only if the user stayed there */
	let outFresh = true;
	let detailEls: { dot: HTMLElement; name: HTMLElement; meta: HTMLElement } | undefined;

	try {
		const saved = localStorage.getItem(DETAIL_KEY);
		if (saved) detail = JSON.parse(saved) as { machine: string; pane: string };
	} catch {
		detail = undefined;
	}

	function findAgent(machine: string, pane: string): FleetAgentDto | undefined {
		return snap?.machines.find((m) => m.machine === machine)?.agents.find((a) => a.paneId === pane);
	}

	function schedule(): void {
		clearTimeout(timer);
		if (!enabled || document.hidden) return;
		timer = setTimeout(() => void poll(), active ? 3000 : 20_000);
	}

	async function poll(): Promise<void> {
		try {
			const res = await fetch("/api/fleet", { cache: "no-store" });
			if (res.status === 404) {
				enabled = false;
				clearTimeout(timer);
				cb.onUnavailable();
				return;
			}
			if (!res.ok) throw new Error(`fleet: ${res.status}`);
			snap = (await res.json()) as FleetSnapshot;
			render();
			cb.onBadge(countBlocked());
		} catch {
			// keep the last snapshot; the next tick retries
		}
		schedule();
	}

	function countBlocked(): number {
		let n = 0;
		for (const m of snap?.machines ?? []) for (const a of m.agents) if (a.status === "blocked") n++;
		return n;
	}

	function node(tag: string, cls?: string, text?: string): HTMLElement {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function card(a: FleetAgentDto, stale: boolean): HTMLElement {
		const c = node("button", `agent-card st-${a.status}`);
		const head = node("div", "ac-head");
		head.append(node("span", `dot ${a.status}`));
		head.append(node("span", "ac-name", agentLabel(a)));
		head.append(node("span", "ac-age", age(a.since, a.sinceApprox)));
		c.append(head);
		if (a.title) c.append(node("div", "ac-title", a.title));
		const sub = node("div", "ac-sub");
		sub.append(node("span", "", `${a.machine} · ${a.workspace ?? ""} · ${shortCwd(a.cwd)}`));
		if (stale) sub.append(node("span", "ac-stale", "stale"));
		c.append(sub);
		c.onclick = () => openDetail(a);
		return c;
	}

	function openDetail(a: FleetAgentDto): void {
		detail = { machine: a.machine, pane: a.paneId };
		localStorage.setItem(DETAIL_KEY, JSON.stringify(detail));
		detailError = "";
		renderDetail();
		cb.onDetailChange({ machine: a.machine, pane: a.paneId, name: a.name ?? a.kind });
		void refreshDetail();
	}

	function closeDetail(): void {
		detail = undefined;
		localStorage.removeItem(DETAIL_KEY);
		detailError = "";
		detailEls = undefined;
		out = undefined;
		clearInterval(readTimer);
		readTimer = undefined;
		render();
		cb.onDetailChange(undefined);
	}

	async function refreshDetail(): Promise<void> {
		if (!detail || !out) return;
		// the newest output is the tail: land there on open, and stay there across the
		// 3s refresh unless the user has scrolled up into the buffer on purpose
		const stick = outFresh || out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
		try {
			const res = await fetch(
				`/api/fleet/read?machine=${encodeURIComponent(detail.machine)}&target=${encodeURIComponent(detail.pane)}&lines=400`,
				{ cache: "no-store" },
			);
			if (!res.ok) throw new Error(`${res.status}`);
			out.textContent = await res.text();
			if (stick) out.scrollTop = out.scrollHeight;
			outFresh = false;
		} catch (err) {
			out.textContent = `read failed: ${String((err as Error)?.message ?? err)}`;
		}
	}

	async function sendKeys(keys: string[]): Promise<void> {
		if (!detail) return;
		const res = await fetch("/api/fleet/keys", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ machine: detail.machine, target: detail.pane, keys }),
		});
		const body = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string; error?: string };
		if (body.ok === false) {
			detailError = `${body.code ?? "error"}: ${body.error ?? "failed"}`;
			renderDetailError();
		}
		setTimeout(() => void refreshDetail(), 300);
	}

	function render(): void {
		if (!active) return;
		if (detail) {
			if (!detailEls) {
				renderDetail();
				void refreshDetail();
				return;
			}
			// the open detail refreshes its own pane on readTimer; a poll must not rebuild
			// it or the scroll position resets every 3s — only the status bits move
			const a = findAgent(detail.machine, detail.pane);
			if (detailEls) {
				detailEls.dot.className = `dot ${a?.status ?? "unknown"}`;
				detailEls.name.textContent = a ? agentLabel(a) : detail.pane;
				detailEls.meta.textContent = a
					? `${shortCwd(a.cwd)}${a.title ? ` — ${a.title}` : ""}`
					: "(agent no longer in the fleet listing)";
			}
			return;
		}
		root.textContent = "";
		root.classList.remove("ag-detail");
		if (!snap) {
			root.append(node("div", "ag-note", "asking herdr…"));
			return;
		}
		for (const m of snap.machines) {
			if (!m.ok) {
				root.append(node("div", "ag-down", `${m.machine} unreachable — ${m.error ?? "waiting for first poll"}`));
			}
		}
		for (const sec of SECTIONS) {
			const cards: HTMLElement[] = [];
			for (const m of snap.machines) {
				for (const a of m.agents) {
					if (a.status !== sec.status) continue;
					cards.push(card(a, !m.ok));
				}
			}
			if (!cards.length) continue;
			const h = node("div", "ag-sec", `${sec.label} · ${cards.length}`);
			root.append(h);
			for (const c of cards) root.append(c);
		}
		if (!root.childElementCount) root.append(node("div", "ag-note", "no herdr agents anywhere"));
	}

	function renderDetail(): void {
		if (!detail) return;
		root.textContent = "";
		// the pre is the scroller here, so the pane tail can be 400 lines and the key row
		// still sits directly above the composer — a phone must not scroll past output
		// to reach esc/enter
		root.classList.add("ag-detail");
		const a = findAgent(detail.machine, detail.pane);
		const head = node("div", "agd-head");
		const back = node("button", "agd-back", "‹ agents");
		back.onclick = closeDetail;
		head.append(back);
		const dot = node("span", `dot ${a?.status ?? "unknown"}`);
		const name = node("span", "agd-name", a ? agentLabel(a) : detail.pane);
		head.append(dot, name, node("span", "agd-machine", detail.machine));
		root.append(head);
		const meta = node(
			"div",
			"agd-meta",
			a ? `${shortCwd(a.cwd)}${a.title ? ` — ${a.title}` : ""}` : "(agent no longer in the fleet listing)",
		);
		root.append(meta);
		detailEls = { dot, name, meta };
		const err = node("div", "agd-err", detailError);
		err.hidden = !detailError;
		root.append(err);
		out = node("pre", "agd-out", "…");
		outFresh = true;
		root.append(out);
		const row = node("div", "agd-keys");
		for (const k of KEYS) {
			const b = node("button", "", k.label);
			b.onclick = () => void sendKeys([k.key]);
			row.append(b);
		}
		const ask = node("button", "agd-ask", "ask super");
		ask.onclick = () => {
			const agent = findAgent(detail!.machine, detail!.pane);
			if (agent) cb.onAskSuper(agent);
		};
		row.append(ask);
		root.append(row);
		clearInterval(readTimer);
		readTimer = setInterval(() => void refreshDetail(), 3000);
	}

	function renderDetailError(): void {
		const e = root.querySelector(".agd-err");
		if (e) {
			e.textContent = detailError;
			(e as HTMLElement).hidden = !detailError;
		}
	}

	async function sendPrompt(text: string): Promise<void> {
		if (!detail) return;
		const res = await fetch("/api/fleet/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ machine: detail.machine, target: detail.pane, text }),
		});
		const body = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string; error?: string };
		if (!res.ok || body.ok === false) {
			detailError = body.ok === false ? `${body.code}: ${body.error}` : `prompt failed: ${res.status}`;
			renderDetailError();
			cb.status(detailError, 6000, true);
			return;
		}
		detailError = "";
		renderDetailError();
		setTimeout(() => void refreshDetail(), 500);
	}

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && enabled) {
			clearTimeout(timer);
			void poll();
		}
	});

	void poll();

	return {
		setActive(on: boolean): void {
			if (active === on) return;
			active = on;
			if (on) {
				clearTimeout(timer);
				render();
				if (detail) {
					void refreshDetail();
					if (!readTimer) readTimer = setInterval(() => void refreshDetail(), 3000);
				}
				void poll();
			} else {
				clearInterval(readTimer);
				readTimer = undefined;
				schedule();
			}
		},
		enabled: () => enabled,
		blocked: countBlocked,
		detail: (): FleetTarget | undefined => {
			if (!detail) return undefined;
			const a = findAgent(detail.machine, detail.pane);
			return { machine: detail.machine, pane: detail.pane, name: a?.name ?? a?.kind ?? detail.pane };
		},
		sendPrompt,
	};
}
