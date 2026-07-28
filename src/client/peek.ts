/**
 * Tap a path, see the file.
 *
 * Agents print paths constantly ("wrote /tmp/plot.png", "src/server/term.ts:88") and on a
 * phone there is no second window to open them in. So a tap on a captured pane resolves
 * the token under the finger against the pane's cwd and pops the file up — images as
 * images, anything text-ish as text.
 *
 * The hit test is caret-based (`caretRangeFromPoint`), which is why this only serves the
 * views that are real DOM text: the reader capture and the chat. The raw xterm canvas
 * would need its own link provider; not yet.
 */

export interface PeekTarget {
	/** the token as printed — resolved against the pane cwd by the server */
	path: string;
	line?: number;
}

/** Characters that cannot be inside a path as a terminal prints it. */
const STOP = /[\s'"`,;|<>()[\]{}]/;

/**
 * Is this token worth a round trip? The bar: it must name a file rather than merely be a
 * word — it has a slash, a `~`/`./` prefix, or a plausible extension. Everything else
 * (prose, flags, numbers) is left alone so that tapping around stays inert.
 */
export function parsePath(token: string): PeekTarget | undefined {
	let s = token.trim().replace(/^[@=+]+/, "").replace(/[.,:;!?]+$/, "");
	let line: number | undefined;
	const withLine = s.match(/^(.+?):(\d+)(?::\d+)?$/);
	if (withLine) {
		s = withLine[1]!;
		line = Number(withLine[2]);
	}
	if (s.length < 2 || s.length > 400) return undefined;
	if (/^\w+:\/\//.test(s)) return undefined; // a URL is the browser's job, not ours
	const named = s.includes("/") || /^~/.test(s) || /\.[A-Za-z][\w+-]{0,8}$/.test(s);
	if (!named) return undefined;
	return { path: s, line };
}

/** The path token straddling `index` in `text`, if that is what it is. */
export function pathAt(text: string, index: number): PeekTarget | undefined {
	if (index < 0 || index > text.length) return undefined;
	let a = index;
	let b = index;
	while (a > 0 && !STOP.test(text[a - 1]!)) a--;
	while (b < text.length && !STOP.test(text[b]!)) b++;
	return a === b ? undefined : parsePath(text.slice(a, b));
}

interface PeekOptions {
	/** cwd of the pane on screen — relative paths are printed relative to it */
	cwd: () => string;
	status: (msg: string, ms?: number, err?: boolean) => void;
}

export interface Peek {
	/** Hit-test a tap; true if it landed on something that looked like a path. */
	fromPoint(x: number, y: number): boolean;
	open(target: PeekTarget): void;
	close(): void;
	readonly openPath: string | undefined;
}

function caretText(x: number, y: number): { text: string; offset: number } | undefined {
	const doc = document as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	};
	if (doc.caretRangeFromPoint) {
		const r = doc.caretRangeFromPoint(x, y);
		if (r?.startContainer.nodeType === Node.TEXT_NODE)
			return { text: (r.startContainer as Text).data, offset: r.startOffset };
		return undefined;
	}
	const p = doc.caretPositionFromPoint?.(x, y);
	if (p?.offsetNode.nodeType === Node.TEXT_NODE) return { text: (p.offsetNode as Text).data, offset: p.offset };
	return undefined;
}

export function initPeek(opts: PeekOptions): Peek {
	const root = document.getElementById("peek") as HTMLElement;
	const title = document.getElementById("peek-path") as HTMLElement;
	const body = document.getElementById("peek-body") as HTMLElement;
	// The title is `direction: rtl` so a long path keeps its *end* on screen. That flips a
	// leading "/" to the far side unless the whole path is isolated as one LTR run.
	const setTitle = (s: string): void => {
		title.textContent = `\u2066${s}\u2069`;
	};
	let objectUrl: string | undefined;
	let shown: string | undefined;
	let epoch = 0;

	function close(): void {
		epoch++;
		shown = undefined;
		root.hidden = true;
		body.replaceChildren();
		if (objectUrl) URL.revokeObjectURL(objectUrl);
		objectUrl = undefined;
	}

	async function open(target: PeekTarget): Promise<void> {
		const mine = ++epoch;
		shown = target.path;
		root.hidden = false;
		setTitle(target.path);
		body.replaceChildren(Object.assign(document.createElement("div"), { className: "peek-note", textContent: "…" }));
		const q = new URLSearchParams({ path: target.path, cwd: opts.cwd() });
		let res: Response;
		try {
			res = await fetch(`/api/file?${q}`, { cache: "no-store" });
		} catch (err) {
			if (mine === epoch) close();
			opts.status(`peek failed: ${String((err as Error).message)}`, 2500, true);
			return;
		}
		if (mine !== epoch) return; // closed or superseded while in flight
		if (!res.ok) {
			// A miss is the common case (prose that looked like a path), so it must be quiet:
			// no popup left over, just the same toast every other failure uses.
			const why = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
			close();
			opts.status(`${target.path}: ${String(why.error)}`, 2500, true);
			return;
		}
		const resolved = decodeURIComponent(res.headers.get("x-peek-path") ?? target.path);
		const type = res.headers.get("content-type") ?? "";
		const truncated = res.headers.get("x-peek-truncated") === "1";
		setTitle(resolved + (target.line ? `:${target.line}` : ""));
		if (type.startsWith("image/")) {
			const blob = await res.blob();
			if (mine !== epoch) return;
			objectUrl = URL.createObjectURL(blob);
			const img = document.createElement("img");
			img.src = objectUrl;
			img.alt = resolved;
			// tap toggles fit-to-width vs. actual pixels; a screenshot is unreadable fitted
			img.onclick = () => img.classList.toggle("zoom");
			body.replaceChildren(img);
			return;
		}
		const text = await res.text();
		if (mine !== epoch) return;
		const pre = document.createElement("pre");
		pre.className = "peek-code";
		let hit: HTMLElement | undefined;
		for (const [i, l] of text.replace(/\n$/, "").split("\n").entries()) {
			const div = document.createElement("div");
			div.textContent = l === "" ? "\u200b" : l; // keep blank lines tall and numbered
			if (target.line === i + 1) {
				div.className = "hit";
				hit = div;
			}
			pre.append(div);
		}
		body.replaceChildren(pre);
		if (truncated)
			body.append(
				Object.assign(document.createElement("div"), {
					className: "peek-note",
					textContent: "… truncated",
				}),
			);
		hit?.scrollIntoView({ block: "center" });
	}

	function fromPoint(x: number, y: number): boolean {
		const at = caretText(x, y);
		const target = at && pathAt(at.text, at.offset);
		if (!target) return false;
		void open(target);
		return true;
	}

	root.addEventListener("click", (e) => {
		if (e.target === root) close(); // backdrop
	});
	(document.getElementById("peek-close") as HTMLElement).onclick = close;
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !root.hidden) {
			close();
			e.stopPropagation();
		}
	});

	return {
		fromPoint,
		open: (t) => void open(t),
		close,
		get openPath() {
			return shown;
		},
	};
}
