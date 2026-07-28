import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";

/**
 * Reading a file the terminal just mentioned.
 *
 * There is deliberately no sandbox root: everyone who gets this far already owns a shell
 * in the tmux (`cat` reaches every one of these bytes anyway), so a jail here would only
 * be theatre that breaks the useful cases (/etc, /var/log, another user's worktree).
 * What is enforced is size — a phone must not be handed a 2 GB core dump.
 */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_DIR_ENTRIES = 2000;

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	// SVG renders in an <img>, where scripts inside it do not run
	".svg": "image/svg+xml",
};

export type PeekKind = "dir" | "image" | "text";

export type PeekResult =
	| { ok: true; kind: PeekKind; path: string; type: string; body: Buffer; bytes: number; truncated: boolean }
	| { ok: false; status: number; error: string };

export interface DirEntry {
	name: string;
	/** directories first in the listing, and only they are worth a trailing slash */
	dir: boolean;
	link: boolean;
	size: number;
}

function listDir(path: string): PeekResult {
	let dirents;
	try {
		dirents = readdirSync(path, { withFileTypes: true });
	} catch (err) {
		return { ok: false, status: 403, error: String((err as NodeJS.ErrnoException).code ?? "unreadable") };
	}
	const truncated = dirents.length > MAX_DIR_ENTRIES;
	const entries: DirEntry[] = dirents.slice(0, MAX_DIR_ENTRIES).map((d) => {
		// a symlink's own stat says nothing useful; what matters is where it lands
		let st;
		try {
			st = statSync(resolve(path, d.name));
		} catch {
			/* dangling link, or not ours to stat */
		}
		return {
			name: d.name,
			dir: st ? st.isDirectory() : d.isDirectory(),
			link: d.isSymbolicLink(),
			size: st?.isFile() ? st.size : 0,
		};
	});
	entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
	const body = Buffer.from(JSON.stringify({ path, entries }), "utf8");
	return { ok: true, kind: "dir", path, type: "application/json; charset=utf-8", body, bytes: dirents.length, truncated };
}

/** Resolve what the terminal printed: `~/x`, `./x`, `x` (against the pane's cwd), `/x`. */
export function resolvePeekPath(raw: string, cwd?: string): string {
	let p = raw.trim();
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	if (isAbsolute(p)) return resolve(p);
	return resolve(cwd && isAbsolute(cwd) ? cwd : homedir(), p);
}

export function readPeek(raw: string, cwd?: string): PeekResult {
	const path = resolvePeekPath(raw, cwd);
	let st;
	try {
		st = statSync(path);
	} catch {
		return { ok: false, status: 404, error: "no such file" };
	}
	if (st.isDirectory()) return listDir(path);
	if (!st.isFile()) return { ok: false, status: 415, error: "not a regular file" };

	const image = IMAGE_MIME[extname(path).toLowerCase()];
	if (image && st.size > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: `too big: ${st.size} bytes` };

	// /proc and friends report size 0 yet read fine, so never trust size as the read length
	const cap = image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
	const want = st.size > 0 ? Math.min(st.size, cap) : cap;
	const buf = Buffer.alloc(want);
	let read = 0;
	const fd = openSync(path, "r");
	try {
		read = readSync(fd, buf, 0, want, 0);
	} finally {
		closeSync(fd);
	}
	const body = buf.subarray(0, read);
	const bytes = st.size > 0 ? st.size : read;
	if (image) return { ok: true, kind: "image", path, type: image, body, bytes, truncated: false };
	// A NUL in the head means this is not something a <pre> should be asked to render.
	if (body.subarray(0, 4096).includes(0)) return { ok: false, status: 415, error: "binary file" };
	return { ok: true, kind: "text", path, type: "text/plain; charset=utf-8", body, bytes, truncated: bytes > read };
}
