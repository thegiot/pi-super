# QR pairing for a new browser

## Use

Open `/pair` on an authenticated pi-super browser (also linked as **QR** in the inbox header), choose **Genera QR**, then scan it on the new device and explicitly choose **Collega questo dispositivo**. The new browser receives the existing HttpOnly login cookie and lands on `/inbox/`; no token editing is needed. The link expires in two minutes, works once, and generating another QR invalidates the previous one. GET previews do not consume it.

Interactive terminal launches print a temporary QR automatically when the current token policy permits it. Use `pi-super --pair-url https://super.example` to advertise your existing reachable HTTPS origin. This flag does not change the listen address, create a tunnel, or configure TLS. Without an advertised origin, only a loopback HTTP origin can be used; a localhost QR works on that computer, not on a phone. The process must remain running. Non-interactive service output does not print a temporary pairing grant.

A new browser opening `/` or `/inbox/` without a cookie sees pairing instructions under token authentication. It cannot generate its own authorization. An authorized browser or the trusted local terminal must provide the QR. Under passkey-required authentication, use the normal passkey login; token/local launch never bypasses it. In `auto`, enrolling the first passkey also invalidates outstanding token-grade pairing tickets at redemption. Explicit `--allow-token` retains its existing meaning.

## Security and limits

- The QR contains a random 32-byte temporary capability in a URL **fragment**, never the persistent token or a passkey session id. Fragments do not reach HTTP request paths. The landing strips it immediately and retains it only in a JavaScript closure, with no local/session storage.
- Redemption requires an explicit same-origin POST. The page and API are `no-store`, with `no-referrer`; the page refuses framing and external resources. Rate limits, bounded bodies, HTTPS except loopback, and current auth policy apply at issue/redemption. Screenshot/scanner compromise can still steal a live QR: treat it as shell access.
- One ticket exists in process memory. Restart, replacement, expiry or successful use makes it unusable. There is no durable ticket registry and no background reissue.
- This is convenient transport for the **existing token-grade cookie**, not a new independently revocable device credential. Existing token rotation and passkey-policy changes revoke its authority; it does not mint `pi_super_sid`. Passkey delegation remains the existing fresh-biometric/PKCE Android handoff, unchanged.
- Correct `?token=` login links now replace stale token cookies and always redirect to a clean URL, including after token rotation.
- Runtime production dependencies audit clean. The existing development Vite/source-map/nanoid advisories remain outside this feature; no unrelated major toolchain update is bundled.

## Verification

Typecheck and Bun check are clean; the full suite has 246 passing tests (17 pairing tests), production build passes, and runtime dependency audit reports zero vulnerabilities. The isolated inbox browser harness passes all existing checks plus zero-cookie pairing. The four new mobile/desktop screenshots were inspected individually: QR readable/contained, explicit confirmation without fragment, and completed inbox with the QR entry point. Review also covered configured advertised HTTPS origins from local browsers and `/pair?token=` cookie pinning.

Unit and real-HTTP tests cover ticket randomness/TTL/replay/replacement, explicit confirmation and fragment scrubbing, zero-cookie login, unauthorized/cross-site issuance and redemption, unapproved origins, passkey lockout, first-enrolment race and stale-cookie repair. The screenshot harness adds mobile QR, desktop QR, zero-cookie confirmation and completed inbox shots using disposable credentials only. Never publish screenshots of a real unexpired pairing QR.

## Deployment record

On 17 November 2026, commit `ba7c0bd` (including M4) was pushed to `origin/inbox-m1` and fast-forwarded on K29, `/workspace/pi-super`, still on `inbox-m1`. Dependencies, typecheck, all 246 tests under timeout and full build passed there before the user service was explicitly restarted at 15:11 CET. The service is active/running. Public HTTPS smoke verified the cookieless pairing page, authenticated issuance, redemption without an existing cookie, replay refusal, paired inbox, notification worker and public VAPID endpoint. Beeper and assistant report `ok` with five accounts; notification state is mode `0600`; production dependency audit is clean. No chat was submitted to the model, no real message was sent and no push subscription was created during verification. OS push delivery still requires the owner's opt-in and device smoke test.
