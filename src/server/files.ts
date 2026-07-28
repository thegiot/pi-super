import { closeSync, openSync, readSync, statSync } from "node:fs";
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

export type PeekResult =
	| { ok: true; path: string; type: string; body: Buffer; bytes: number; truncated: boolean }
	| { ok: false; status: number; error: string };

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
	if (st.isDirectory()) return { ok: false, status: 415, error: "directory" };
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
	if (image) return { ok: true, path, type: image, body, bytes, truncated: false };
	// A NUL in the head means this is not something a <pre> should be asked to render.
	if (body.subarray(0, 4096).includes(0)) return { ok: false, status: 415, error: "binary file" };
	return { ok: true, path, type: "text/plain; charset=utf-8", body, bytes, truncated: bytes > read };
}
