# Token-grade QR pairing, not a passkey bypass

## Problem

A browser without a pi-super cookie previously required manually editing a long token into the URL. Device pairing must remove that friction without silently weakening the existing auto/passkey authentication boundary or leaking a permanent shell credential in QR screenshots and server request paths.

## Decision

`PairingTickets` holds exactly one 32-byte random ticket in memory for two minutes. Issuing replaces it; successful redemption consumes it. `/pair#pair=…` removes the fragment synchronously before rendering and requires an explicit same-origin POST to `/api/auth/pair/redeem`, so camera previews do not consume access. The server sets the existing HttpOnly `pi_super` cookie and the browser navigates to fixed `/inbox/`; no passkey-grade session is created. Both issuance and redemption recheck token policy, including first-passkey enrollment between them. Token credentials/local process ownership cannot override a passkey-required configuration without the preexisting explicit `--allow-token` option.

Authenticated `/pair` users can explicitly generate a QR; unauthenticated users receive secret-free instructions only. The interactive launcher renders a QR with `qrcode`; noninteractive service output does not print temporary grants. `--pair-url` accepts an origin, HTTPS except loopback, without changing bind or creating a tunnel. Request-derived issue origins must exactly match the supplied/reviewed origin. Pairing pages reject framing/external resources and use no-store/no-referrer; tickets never enter persistent storage or application logs. Existing `?token=` transport now always scrubs the URL and refreshes stale cookies.

## Alternatives

**Permanent token in a QR** was rejected: a screenshot would retain the full credential indefinitely. A temporary fragment ticket limits lifetime and avoids query-path disclosure, but a captured live QR can still be raced.

**DSH-style loopback-authorized issuer and independent device registry** were considered. Loopback is not proof of authorization behind this installation's reverse proxy and cannot be a passkey exception. A second persistent credential/WS-revocation system is unnecessary for this request: this feature honestly transports the existing token cookie rather than claiming independently revocable device sessions.

**Automatic GET redemption or reusable QR** was rejected because scanner previews and split browser contexts make consumption ambiguous; explicit confirmation plus single use favors limited exposure over DSH's reusable-link convenience. Passkey-required users keep normal WebAuthn rather than receiving a weaker delegation path.

## Consequences

Pairing becomes a two-click browser flow with bounded in-memory state and unchanged central HTTP/WS auth, token reset and push-owner semantics. It costs reissuing after expiry/restart/camera context loss, requires an existing HTTPS origin for another device, and retains shared-token logout semantics. Tests cover lifecycle, CSRF, first-enrollment and cookie rotation; isolated browser shots exercise a completely empty cookie jar. No Android code or channel changes. Related inbox privacy boundary: [M4 consent](2026-11-17-inbox-m4-consent-boundaries.md).
