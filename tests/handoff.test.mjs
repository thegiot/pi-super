/**
 * The passkey handoff: a session earned in a browser, moved into the Android app.
 *
 * This is the one credential path that is not a WebAuthn ceremony, so it carries its own
 * weight: the code travels over a custom scheme any app on the phone may claim, and the
 * only thing standing between an interceptor and a root shell is PKCE plus single use.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PasskeyStore } from "../dist/server/webauthn.js";

const dirs = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A store with one enrolled passkey and one live browser session, without going through a
 * real ceremony. `age` backdates the session: the server only exports a session the user
 * has just verified, so most tests want a fresh one.
 */
function storeWithCredential({ id = "cred-1", age = 0 } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-handoff-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "passkeys.json"),
		JSON.stringify({
			credentials: [{ id, publicKey: "AA", counter: 0, label: "phone", createdAt: new Date().toISOString() }],
			sessions: [
				{ id: "browser-sid", credentialId: id, label: "phone", createdAt: Date.now() - age, expiresAt: Date.now() + 60_000 },
			],
		}),
	);
	return new PasskeyStore(dir);
}

const session = (age = 0) => ({
	id: "browser-sid",
	credentialId: "cred-1",
	label: "phone",
	createdAt: Date.now() - age,
	expiresAt: Date.now() + 60_000,
});

function pkce() {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

test("a code plus its verifier becomes a session cookie", () => {
	const store = storeWithCredential();
	const { verifier, challenge } = pkce();
	const code = store.mintHandoff(session(), challenge);
	assert.ok(code);
	const result = store.redeemHandoff(code, verifier, true);
	assert.equal(result?.label, "phone");
	assert.match(result.cookie, /^pi_super_sid=[\w-]+; HttpOnly; Secure; SameSite=Lax/);
	// the app's session is its own, so logging one out does not log the other out
	const sid = result.cookie.split("=")[1].split(";")[0];
	assert.notEqual(sid, "browser-sid");
	assert.equal(store.sessionAlive(sid), true);
	store.revokeSession(sid);
	assert.equal(store.sessionAlive(sid), false);
	assert.equal(store.sessionAlive("browser-sid"), true);
});

test("a session the user did not just verify cannot be exported", () => {
	// Otherwise any app that claims the pi-super: scheme could open the login page in a
	// browser that logged in this morning and be handed a shell, silently.
	const store = storeWithCredential({ age: 10 * 60_000 });
	assert.equal(store.mintHandoff(session(10 * 60_000), pkce().challenge), undefined);
});

test("logging the browser out kills a code that was already in flight", () => {
	const store = storeWithCredential();
	const { verifier, challenge } = pkce();
	const code = store.mintHandoff(session(), challenge);
	store.revokeAllSessions();
	assert.equal(store.redeemHandoff(code, verifier, true), undefined);
});

test("one live code per challenge, however often the page is reloaded", () => {
	const store = storeWithCredential();
	const { verifier, challenge } = pkce();
	const first = store.mintHandoff(session(), challenge);
	const second = store.mintHandoff(session(), challenge);
	assert.notEqual(first, second);
	// the sibling must not survive its replacement, or the app redeems one and an
	// interceptor still has the other
	assert.equal(store.redeemHandoff(first, verifier, true), undefined);
	assert.ok(store.redeemHandoff(second, verifier, true));
});

test("the code alone is worthless", () => {
	const store = storeWithCredential();
	const { challenge } = pkce();
	const code = store.mintHandoff(session(), challenge);
	assert.equal(store.redeemHandoff(code, randomBytes(32).toString("base64url"), true), undefined);
	assert.equal(store.redeemHandoff(code, "", true), undefined);
});

test("a code is single use, even when the verifier was wrong the first time", () => {
	const store = storeWithCredential();
	const { verifier, challenge } = pkce();
	const code = store.mintHandoff(session(), challenge);
	// an interceptor guessing: this must burn the code rather than leave it for a retry
	assert.equal(store.redeemHandoff(code, "not-it", true), undefined);
	assert.equal(store.redeemHandoff(code, verifier, true), undefined);
});

test("the code alone is worthless, even before it is burned", () => {
	const store = storeWithCredential();
	const { verifier, challenge } = pkce();
	const code = store.mintHandoff(session(), challenge);
	assert.equal(store.redeemHandoff(code, "", true), undefined);
	// and burning it is what that attempt cost
	assert.equal(store.redeemHandoff(code, verifier, true), undefined);
});

test("a passkey revoked mid-handoff takes the code with it", () => {
	const store = storeWithCredential();
	const { verifier, challenge } = pkce();
	const code = store.mintHandoff(session(), challenge);
	store.removeCredential("cred-1");
	assert.equal(store.redeemHandoff(code, verifier, true), undefined);
});

test("a made-up code is refused", () => {
	const store = storeWithCredential();
	assert.equal(store.redeemHandoff(randomBytes(32).toString("base64url"), "whatever", true), undefined);
	assert.equal(store.redeemHandoff("", "", true), undefined);
});

test("the challenge has to look like one", () => {
	const store = storeWithCredential();
	assert.equal(store.mintHandoff(session(), "short"), undefined);
	assert.equal(store.mintHandoff(session(), `${"x".repeat(200)}`), undefined);
	assert.equal(store.mintHandoff(session(), "not base64url!!"), undefined);
});
