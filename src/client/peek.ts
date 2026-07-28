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

// ------------------------------------------------------------- highlighting

/**
 * A deliberately small, line-at-a-time tokenizer: strings, comments, numbers, keywords,
 * one shared keyword set across languages. It is not a parser and will get exotic code
 * subtly wrong — but on a phone the job is "tell code apart from prose at a glance",
 * which four colours do, and a real grammar pack would outweigh the whole client bundle.
 */
const KEYWORDS = [
	"as","async","await","break","case","catch","chan","class","const","continue","def","defer","del","delete",
	"do","done","elif","else","elsif","end","enum","esac","except","export","extends","false","fi","final",
	"finally","fn","for","from","func","function","global","go","if","impl","implements","import","in","interface",
	"is","lambda","let","local","loop","match","mod","module","mut","new","nil","None","none","not","null",
	"package","pass","private","protected","pub","public","raise","readonly","return","select","self","static",
	"struct","super","switch","then","this","throw","trait","true","try","type","typeof","undefined","unless",
	"until","use","var","void","where","while","with","yield",
].join("|");

const SLASH = new Set("js mjs cjs jsx ts tsx c h cc cpp cxx hpp go rs java kt kts swift cs php scala dart zig proto glsl css scss less".split(" "));
const HASH = new Set("py pyi sh bash zsh fish rb pl r tf yml yaml toml ini cfg conf mk makefile dockerfile gitignore env service nix".split(" "));

const STRING = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\``;
const NUMBER = String.raw`\b\d[\w.]*\b`;

/** The token rules for a file, or undefined for "this is prose, leave it alone". */
function rulesFor(path: string): RegExp | undefined {
	const name = path.split("/").pop() ?? "";
	const ext = (name.includes(".") ? name.split(".").pop()! : name).toLowerCase();
	// a lone `/*` is its own token: it opens a block comment that runs into the next lines
	if (SLASH.has(ext)) return new RegExp(`(?<c>/\\*[\\s\\S]*?\\*/|/\\*|//.*)|(?<s>${STRING})|(?<n>${NUMBER})|(?<k>\\b(?:${KEYWORDS})\\b)`, "g");
	if (HASH.has(ext)) return new RegExp(`(?<c>#.*)|(?<s>${STRING})|(?<n>${NUMBER})|(?<k>\\b(?:${KEYWORDS})\\b)`, "g");
	if (ext === "json" || ext === "jsonl") return new RegExp(`(?<s>${STRING})|(?<n>${NUMBER})|(?<k>\\b(?:true|false|null)\\b)`, "g");
	return undefined;
}

/** Render one line into `div`, carrying block-comment state to the next one. */
function highlightLine(div: HTMLElement, line: string, re: RegExp | undefined, st: { block: boolean }): void {
	const push = (text: string, cls?: string): void => {
		if (!text) return;
		if (!cls) {
			div.append(text);
			return;
		}
		const span = document.createElement("span");
		span.className = cls;
		span.textContent = text;
		div.append(span);
	};
	if (line === "") {
		div.append("\u200b"); // keep blank lines tall, and numbered
		return;
	}
	let rest = line;
	if (st.block) {
		const end = rest.indexOf("*/");
		if (end < 0) {
			push(rest, "c");
			return;
		}
		push(rest.slice(0, end + 2), "c");
		st.block = false;
		rest = rest.slice(end + 2);
	}
	if (!re) {
		push(rest);
		return;
	}
	let last = 0;
	for (const m of rest.matchAll(re)) {
		push(rest.slice(last, m.index));
		if (m.groups?.c === "/*") {
			st.block = true;
			push(rest.slice(m.index), "c");
			return;
		}
		const g = m.groups ?? {};
		push(m[0], g.c ? "c" : g.s ? "s" : g.n ? "n" : "k");
		last = m.index + m[0].length;
	}
	push(rest.slice(last));
}

// --------------------------------------------------------------- directories

interface DirEntry {
	name: string;
	dir: boolean;
	link: boolean;
	size: number;
}

const note = (text: string): HTMLElement =>
	Object.assign(document.createElement("div"), { className: "peek-note", textContent: text });

const human = (n: number): string => {
	if (n < 1024) return `${n} B`;
	const u = ["K", "M", "G", "T"];
	let i = -1;
	let v = n;
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

/**
 * A tapped directory lists itself, and every row is another tap — which is the only
 * file browser this app is ever going to need: you arrive already next to what you want.
 */
function renderDir(dir: string, entries: DirEntry[], go: (path: string) => void): HTMLElement {
	const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
	const list = document.createElement("div");
	list.className = "peek-dir";
	const row = (name: string, cls: string, size?: string): void => {
		const b = document.createElement("button");
		b.className = `peek-row ${cls}`;
		b.append(Object.assign(document.createElement("span"), { className: "nm", textContent: name }));
		if (size) b.append(Object.assign(document.createElement("span"), { className: "sz", textContent: size }));
		b.onclick = () => go(name === ".." ? base.replace(/\/[^/]*$/, "") || "/" : `${base}/${name}`);
		list.append(b);
	};
	if (base !== "") row("..", "dir");
	for (const e of entries) row(e.name + (e.dir ? "/" : ""), e.dir ? "dir" : e.link ? "link" : "file", e.dir ? undefined : human(e.size));
	if (entries.length === 0) list.append(note("(empty)"));
	return list;
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
		body.replaceChildren(note("…"));
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
		if (res.headers.get("x-peek-kind") === "dir") {
			const listing = (await res.json()) as { entries: DirEntry[] };
			if (mine !== epoch) return;
			body.replaceChildren(renderDir(resolved, listing.entries, (p) => void open({ path: p })));
			if (truncated) body.append(note(`… first ${listing.entries.length} entries only`));
			body.scrollTop = 0;
			return;
		}
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
		const re = rulesFor(resolved);
		const st = { block: false };
		let hit: HTMLElement | undefined;
		for (const [i, l] of text.replace(/\n$/, "").split("\n").entries()) {
			const div = document.createElement("div");
			highlightLine(div, l, re, st);
			if (target.line === i + 1) {
				div.className = "hit";
				hit = div;
			}
			pre.append(div);
		}
		body.replaceChildren(pre);
		if (truncated) body.append(note("… truncated"));
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
