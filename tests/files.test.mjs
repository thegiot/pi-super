import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_DIR_ENTRIES, readPeek } from "../dist/server/files.js";

// The peek endpoint reads whatever the terminal just mentioned, which is anything at all
// on this machine. These are the cases where "anything at all" bites back.

test("nothing is served as a type the browser would render by itself", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-peek-svg-"));
	writeFileSync(join(dir, "evil.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
	writeFileSync(join(dir, "page.html"), "<h1>hi</h1>");
	// navigating to /api/file?path=evil.svg must not produce a same-origin scripted
	// document, so the wire type is opaque and the popup re-types the blob itself
	for (const name of ["evil.svg", "page.html"]) {
		const r = readPeek(name, dir);
		assert.equal(r.ok, true);
		assert.equal(r.type, "application/octet-stream", `${name} must not be inline-renderable`);
	}
	assert.equal(readPeek("evil.svg", dir).kind, "image", "it is still shown as an image in the popup");
});

test("a short read is reported, not silently passed off as the whole file", () => {
	// procfs seq files hand back one page per read and claim size 0 — the classic way to
	// show half a file and call it complete
	const r = readPeek("/proc/self/mountinfo");
	assert.equal(r.ok, true);
	const real = execFileSync("cat", ["/proc/self/mountinfo"], { encoding: "utf8" });
	assert.equal(r.body.toString(), real, "the whole pseudo-file, across as many reads as it takes");
});

test("a fifo cannot wedge the server, and neither can a symlink loop", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-peek-fifo-"));
	execFileSync("mkfifo", [join(dir, "pipe")]);
	symlinkSync(join(dir, "loop"), join(dir, "loop"));
	// nobody is writing to the fifo: without O_NONBLOCK (and the stat check) this hangs
	// the single event loop this server has, i.e. every client at once
	const r = readPeek("pipe", dir);
	assert.equal(r.ok, false);
	assert.equal(r.status, 415);
	assert.equal(readPeek("loop", dir).ok, false);
});

test("a huge directory is capped instead of materialised", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-peek-big-"));
	mkdirSync(join(dir, "d"));
	for (let i = 0; i < MAX_DIR_ENTRIES + 50; i++) writeFileSync(join(dir, `f${i}`), "x");
	const r = readPeek(dir);
	assert.equal(r.truncated, true);
	assert.equal(JSON.parse(r.body.toString()).entries.length, MAX_DIR_ENTRIES);
});
