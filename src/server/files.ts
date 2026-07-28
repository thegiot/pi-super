import { closeSync, constants, fstatSync, opendirSync, openSync, readSync, statSync } from "node:fs";
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

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".svg"]);

/**
 * Never a content type a browser will render *itself*.
 *
 * The popup fetches bytes and builds its own blob, so it does not need one — while a
 * navigation to this endpoint would: `/api/file?path=evil.svg` served as `image/svg+xml`
 * is a same-origin scripted document (SameSite=Lax still sends the cookie on a top-level
 * link), and that script can read every other file through this very endpoint. A cloned
 * repo full of SVGs is a completely ordinary thing to have on this machine.
 */
const OPAQUE = "application/octet-stream";

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
	const dirents = [];
	let truncated = false;
	try {
		// streamed, not readdirSync: a directory with a million entries must not be
		// materialised in full just to show the first screenful of it on a phone
		const handle = opendirSync(path);
		try {
			for (;;) {
				const d = handle.readSync();
				if (!d) break;
				if (dirents.length >= MAX_DIR_ENTRIES) {
					truncated = true;
					break;
				}
				dirents.push(d);
			}
		} finally {
			handle.closeSync();
		}
	} catch (err) {
		return { ok: false, status: 403, error: String((err as NodeJS.ErrnoException).code ?? "unreadable") };
	}
	const entries: DirEntry[] = dirents.map((d) => {
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
	return { ok: true, kind: "dir", path, type: OPAQUE, body, bytes: entries.length, truncated };
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

	const image = IMAGE_EXT.has(extname(path).toLowerCase());
	if (image && st.size > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: `too big: ${st.size} bytes` };

	// O_NONBLOCK: a fifo that nobody writes to would otherwise hang `open` itself, and this
	// server is one event loop — that stalls the terminal, the chat and every other client.
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (err) {
		return { ok: false, status: 403, error: String((err as NodeJS.ErrnoException).code ?? "unreadable") };
	}
	let read = 0;
	let size = 0;
	const cap = image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
	let buf = Buffer.alloc(0);
	try {
		// re-check on the descriptor we actually hold: between the stat above and this open,
		// the name could have been swapped for a fifo or a device
		const fst = fstatSync(fd);
		if (!fst.isFile()) return { ok: false, status: 415, error: "not a regular file" };
		size = fst.size;
		// /proc and friends report size 0 and hand back one page per read, so read until the
		// cap or EOF rather than trusting either number
		const want = size > 0 ? Math.min(size, cap) : cap;
		buf = Buffer.alloc(want);
		while (read < want) {
			const n = readSync(fd, buf, read, want - read, read);
			if (n <= 0) break;
			read += n;
		}
	} catch (err) {
		return { ok: false, status: 403, error: String((err as NodeJS.ErrnoException).code ?? "unreadable") };
	} finally {
		closeSync(fd);
	}
	const body = buf.subarray(0, read);
	const bytes = size > 0 ? size : read;
	if (image) return { ok: true, kind: "image", path, type: OPAQUE, body, bytes, truncated: bytes > read };
	// A NUL in the head means this is not something a <pre> should be asked to render.
	if (body.subarray(0, 4096).includes(0)) return { ok: false, status: 415, error: "binary file" };
	return { ok: true, kind: "text", path, type: OPAQUE, body, bytes, truncated: bytes > read };
}
