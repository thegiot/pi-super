/**
 * Tap a path, see the file.
 *
 * Agents print paths constantly ("wrote /tmp/plot.png", "src/server/term.ts:88") and on a
 * phone there is no second window to open them in. So a tap on a captured pane resolves
 * the token under the finger against the pane's cwd and pops the file up — images as
 * images, anything text-ish as text.
 *
 * Two hit tests, because there are two kinds of view: the reader capture and the chat are
 * real DOM text (`caretRangeFromPoint`, below), while the raw terminal is a grid with no
 * node under the finger and is mapped cell-wise by its own handler in main.ts.
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
 * which four colours do.
 *
 * Not for weight: Prism would cost ~20 KB gzipped against a bundle already at ~90 KB, so
 * if this ever looks wrong often enough to annoy, swap it out and delete all of this. It
 * is hand-rolled because at *this* quality bar 90 lines beat a dependency, and for no
 * stronger reason than that.
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
// `2003.crt` in a config file is not a number: digits may take a fraction, an exponent and
// a unit, but they do not get to swallow a file extension (measured, on /etc: 216 of these)
const NUMBER = String.raw`\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z%]{0,3}\b`;

/**
 * Markdown gets rules of its own rather than the code ones, which are actively wrong on
 * prose: every apostrophe would open a string and every `# heading` become a comment.
 * It is also the format most worth reading on a phone — half of what agents leave behind
 * is a README or a note.
 */
const MD = new Set(["md", "markdown", "mdx", "mkd"]);
const MD_INLINE =
	/(?<s>`[^`]+`)|(?<l>\[[^\]]*\]\([^)\s]*\))|(?<b>\*\*[^*]+\*\*|__[^_]+__)|(?<e>\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

type Rules = { md: true; re?: undefined } | { md?: undefined; re: RegExp };

/** The token rules for a file, or undefined for "this is prose, leave it alone". */
function rulesFor(path: string): Rules | undefined {
	const name = path.split("/").pop() ?? "";
	const ext = (name.includes(".") ? name.split(".").pop()! : name).toLowerCase();
	const code = (src: string): Rules => ({ re: new RegExp(src, "g") });
	if (MD.has(ext)) return { md: true };
	// a lone `/*` is its own token: it opens a block comment that runs into the next lines
	if (SLASH.has(ext)) return code(`(?<c>/\\*[\\s\\S]*?\\*/|/\\*|//.*)|(?<s>${STRING})|(?<n>${NUMBER})|(?<k>\\b(?:${KEYWORDS})\\b)`);
	if (HASH.has(ext)) return code(`(?<c>#.*)|(?<s>${STRING})|(?<n>${NUMBER})|(?<k>\\b(?:${KEYWORDS})\\b)`);
	if (ext === "json" || ext === "jsonl") return code(`(?<s>${STRING})|(?<n>${NUMBER})|(?<k>\\b(?:true|false|null)\\b)`);
	return undefined;
}

type Push = (text: string, cls?: string) => void;
/** `block`: inside a C comment. `fence`: inside a markdown fence, with its own rules. */
interface HlState {
	block: boolean;
	fence?: Rules | null;
}

/** Render one line into `div`, carrying comment/fence state to the next one. */
function highlightLine(div: HTMLElement, line: string, rules: Rules | undefined, st: HlState): void {
	const push: Push = (text, cls) => {
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
	if (rules?.md) markdownLine(push, line, st);
	else codeLine(push, line, rules?.re, st);
}

function codeLine(push: Push, line: string, re: RegExp | undefined, st: HlState): void {
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
		// An apostrophe glued to a word is prose, not a quote: in "it doesn't validate; that's
		// the job" the naive rule paints from the first apostrophe to the second, which is the
		// single most visible thing this tokenizer used to get wrong (docstrings, comments,
		// every README-ish line inside code). A string prefix (f'', r'', b'') is one letter
		// with a non-letter before it, so it still opens a string.
		const before = rest.slice(Math.max(0, m.index - 2), m.index);
		if (g.s?.startsWith("'") && /[A-Za-z][A-Za-z]$/.test(before)) {
			push(m[0]);
			last = m.index + m[0].length;
			continue;
		}
		push(m[0], g.c ? "c" : g.s ? "s" : g.n ? "n" : "k");
		last = m.index + m[0].length;
	}
	push(rest.slice(last));
}

function markdownLine(push: Push, line: string, st: HlState): void {
	// A fence flips state, and carries the language of what is inside it: a ```ts block in
	// a README is code, and gets coloured as the code it is.
	const fence = line.match(/^\s{0,3}(?:```|~~~)\s*([\w+#.-]*)/);
	if (fence) {
		push(line, "c");
		st.fence = st.fence === undefined ? (rulesFor(`x.${fence[1] || "txt"}`) ?? null) : undefined;
		return;
	}
	if (st.fence !== undefined) {
		codeLine(push, line, st.fence?.re, st);
		return;
	}
	if (/^\s{0,3}#{1,6}\s/.test(line)) {
		push(line, "h");
		return;
	}
	// a quote and a rule are both "not the text itself", and dim says that in one colour
	if (/^\s{0,3}>/.test(line) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
		push(line, "c");
		return;
	}
	let rest = line;
	const bullet = rest.match(/^(\s*)([-*+]|\d+[.)])(\s+)/);
	if (bullet) {
		push(bullet[1]!);
		push(bullet[2]!, "k");
		push(bullet[3]!);
		rest = rest.slice(bullet[0].length);
	}
	let last = 0;
	for (const m of rest.matchAll(MD_INLINE)) {
		push(rest.slice(last, m.index));
		const g = m.groups ?? {};
		push(m[0], g.s ? "s" : g.l ? "l" : g.b ? "b" : "e");
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

/**
 * The server hands everything over as `application/octet-stream`, so that a *navigation*
 * to the endpoint can never render: `/api/file?path=evil.svg` as `image/svg+xml` would be
 * a same-origin scripted document able to read every other file through the same endpoint.
 * The type an image needs is put back on here, on a blob, where SVG scripts do not run.
 */
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	ico: "image/x-icon",
	svg: "image/svg+xml",
};

/** Enough of a big file to be useful; it is a <div> per line, so this is a DOM budget. */
const MAX_RENDER_LINES = 4000;

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
	const closeBtn = document.getElementById("peek-close") as HTMLElement;
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
		// The raw view leaves xterm's textarea focused, and xterm eats Escape (it is a key the
		// pty wants). Taking focus is what makes this a modal rather than a picture of one.
		closeBtn.focus({ preventScroll: true });
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
		const kind = res.headers.get("x-peek-kind") ?? "text";
		const truncated = res.headers.get("x-peek-truncated") === "1";
		setTitle(resolved + (target.line ? `:${target.line}` : ""));
		if (kind === "dir") {
			const listing = (await res.json()) as { entries: DirEntry[] };
			if (mine !== epoch) return;
			body.replaceChildren(renderDir(resolved, listing.entries, (p) => void open({ path: p })));
			if (truncated) body.append(note(`… first ${listing.entries.length} entries only`));
			body.scrollTop = 0;
			return;
		}
		if (kind === "image") {
			const bytes = await res.arrayBuffer();
			if (mine !== epoch) return;
			const ext = (resolved.split(".").pop() ?? "").toLowerCase();
			objectUrl = URL.createObjectURL(new Blob([bytes], { type: IMAGE_MIME[ext] ?? "image/png" }));
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
		const rules = rulesFor(resolved);
		const st: HlState = { block: false };
		let hit: HTMLElement | undefined;
		const all = text.replace(/\n$/, "").split("\n");
		// 256 KB of newlines is a quarter of a million nodes: enough to wedge the phone
		const lines = all.length > MAX_RENDER_LINES ? all.slice(0, MAX_RENDER_LINES) : all;
		for (const [i, l] of lines.entries()) {
			const div = document.createElement("div");
			highlightLine(div, l, rules, st);
			if (target.line === i + 1) {
				div.className = "hit";
				hit = div;
			}
			pre.append(div);
		}
		body.replaceChildren(pre);
		if (lines.length < all.length) body.append(note(`… first ${MAX_RENDER_LINES} lines only`));
		else if (truncated) body.append(note("… truncated"));
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
	closeBtn.onclick = close;
	// capture phase: xterm would otherwise swallow Escape on its way down to its textarea
	document.addEventListener(
		"keydown",
		(e) => {
			if (e.key === "Escape" && !root.hidden) {
				close();
				e.preventDefault();
				e.stopPropagation();
			}
		},
		true,
	);

	return {
		fromPoint,
		open: (t) => void open(t),
		close,
		get openPath() {
			return shown;
		},
	};
}
