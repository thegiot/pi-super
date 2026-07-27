import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthed, originAllowed, parseCookies, requestToken, tokenEquals } from "../dist/server/auth.js";
import { parseArgs } from "../dist/server/config.js";
import { Tmux } from "../dist/server/tmux.js";
import { storeUpload } from "../dist/server/uploads.js";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- tmux output framing ---------------------------------------------------
// tmux >= 3.4 escapes control characters in non-tty output, so fields are framed
// by newlines and parsed positionally.

function parseRows(out, fields) {
	// mirror of the private Tmux.rows() framing rule
	const lines = out.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const records = [];
	for (let i = 0; i + fields <= lines.length; i += fields) records.push(lines.slice(i, i + fields));
	return records;
}

test("newline framing keeps empty trailing fields", () => {
	assert.deepEqual(parseRows("$0\n0\n\n$1\nwork\ngrp\n", 3), [
		["$0", "0", ""],
		["$1", "work", "grp"],
	]);
	assert.deepEqual(parseRows("", 3), []);
	assert.deepEqual(parseRows("a\nb\n", 2), [["a", "b"]]);
	assert.equal(typeof new Tmux([]).listSessions, "function");
});

// --- auth ------------------------------------------------------------------

test("parseCookies survives malformed percent-encoding", () => {
	// this runs before authentication: a throw here would be a free remote DoS
	assert.deepEqual(parseCookies("pi_super=%"), { pi_super: "%" });
	assert.deepEqual(parseCookies("a=1; b=%20x"), { a: "1", b: " x" });
	assert.deepEqual(parseCookies(undefined), {});
});

test("explicit credentials beat a stale cookie", () => {
	const url = new URL("http://h/?token=fresh");
	const req = { headers: { cookie: "pi_super=stale" } };
	assert.equal(requestToken(req, url), "fresh");
	assert.equal(requestToken({ headers: { authorization: "Bearer bear" } }, new URL("http://h/")), "bear");
	assert.equal(requestToken(req, new URL("http://h/")), "stale");
	assert.equal(isAuthed(req, url, "fresh"), true);
	assert.equal(isAuthed(req, new URL("http://h/"), "fresh"), false);
});

test("tokenEquals is length-safe", () => {
	assert.equal(tokenEquals("abc", "abc"), true);
	assert.equal(tokenEquals("abc", "abcd"), false);
	assert.equal(tokenEquals("", ""), true);
});

test("origin must match host, and scheme must not downgrade", () => {
	const plain = { headers: { host: "box:8722" }, socket: {} };
	assert.equal(originAllowed({ ...plain, headers: { ...plain.headers, origin: "http://box:8722" } }, undefined), true);
	assert.equal(originAllowed({ ...plain, headers: { ...plain.headers, origin: "http://evil:8722" } }, undefined), false);
	assert.equal(originAllowed(plain, undefined), true); // no Origin: native client
	const tls = { headers: { host: "box", origin: "http://box" }, socket: { encrypted: true } };
	assert.equal(originAllowed(tls, undefined), false);
	assert.equal(originAllowed({ ...tls, headers: { ...tls.headers, origin: "https://box" } }, undefined), true);
});

// --- uploads ---------------------------------------------------------------

test("uploads are sniffed, renamed and mode 0600", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-test-"));
	const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const path = storeUpload(dir, png, "../../etc/passwd", "text/plain");
	assert.ok(path.startsWith(join(dir, "uploads")), `${path} escaped the upload dir`);
	assert.ok(path.endsWith(".png"), "magic bytes win over a lying content-type");
	assert.ok(!path.includes("passwd"), "client-supplied name must not reach the filesystem");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(readFileSync(path).length, png.length);
});

// --- config ----------------------------------------------------------------

test("parseArgs maps flags and rejects nonsense", () => {
	const cfg = parseArgs(["-p", "9000", "-s", "work", "-L", "sock", "--status-line", "--no-meta"]);
	assert.equal(cfg.port, 9000);
	assert.equal(cfg.baseSession, "work");
	assert.deepEqual(cfg.socketArgs, ["-L", "sock"]);
	assert.equal(cfg.statusLine, true);
	assert.equal(cfg.metaEnabled, false);
	assert.equal(cfg.metaInheritExtensions, false);
	assert.throws(() => parseArgs(["--port", "0"]), /invalid --port/);
	assert.throws(() => parseArgs(["--nope"]), /unknown option/);
	assert.throws(() => parseArgs(["--port"]), /requires a value/);
});
