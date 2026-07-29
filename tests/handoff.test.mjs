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

/** A store with one enrolled passkey, without going through a real ceremony. */
function storeWithCredential(id = "cred-1") {
	const dir = mkdtempSync(join(tmpdir(), "pi-super-handoff-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "passkeys.json"),
		JSON.stringify({
			credentials: [{ id, publicKey: "AA", counter: 0, label: "phone", createdAt: new Date().toISOString() }],
			sessions: [],
		}),
	);
	return new PasskeyStore(dir);
}

const session = (credentialId = "cred-1") => ({
	id: "sid",
	credentialId,
	label: "phone",
	createdAt: Date.now(),
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
	// the app's session is its own, so logging it out does not log the browser out
	const sid = result.cookie.split("=")[1].split(";")[0];
	assert.equal(store.sessionAlive(sid), true);
	assert.equal(store.sessionAlive("sid"), false);
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
