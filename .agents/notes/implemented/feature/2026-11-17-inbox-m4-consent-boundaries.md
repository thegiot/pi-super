# Inbox M4: consent boundaries for model importance and Web Push

## Problem

Level-2 importance would disclose unopened conversations beyond D7's request-only consent, while background notifications add a durable external delivery capability. Revocation must also prevent pending responses and stale browser reads from restoring derived private content. The existing Android wrapper has a voice-call service, not an inbox push receiver.

## Decision

The owner approves D13–D15 in the PRD: importance is exclusively on-demand for the requested open chat, SPA Web Push is the sole notification channel, and chat titles may appear in push payloads/lockscreens. `ImportanceBridge` has no scheduler, tools, disk state or implicit refresh caller. It validates bounded JSON, escapes `<` through the assistant context builder, uses `store:false`, and maintains a 120-entry, five-minute RAM cache with two in-flight calls and six provider starts per minute. Level 2 changes only reply-list order/evidence, never `labels.needsReply`; low confidence has no ranking/evidence effect.

`CorrectionsStore` retains v1 compatibility with per-chat `modelExcluded` and optional `modelExcludedNetworks`. Exclusions cover both model entry points. Service revisions invalidate cached or pending results on privacy changes and message events, invalidate history immediately before batched event reconciliation, and compare revisions around asynchronous reads/provider calls. Client summary/list sequence guards prevent delayed GETs from undoing a newer privacy response/WS event. Revocation does not claim to retract content already sent to the model.

`InboxNotifications` receives only chat ids, sanitized titles, significant inbound versions and eligibility booleans. VAPID/subscriptions/auth owner identifiers are the only new durable data, atomically written mode 0600 under the state directory. Delivery checks current owner validity, accepts a closed provider HTTPS allowlist, pins public DNS, and follows no redirects or proxy. The first snapshot is silent; RAM dedup and bounded at-most-once delivery attempts prefer missed notifications over retries. Neither message text nor importance reasons enter push payloads or persistent state. The notification-only worker has no fetch/cache/storage path; clicks stay inside same-origin `/inbox/`. Browser permission and registration require a user gesture; disable attempts browser and server revocation independently.

## Alternatives

**Automatic importance batches** were rejected by the owner: unopened-chat disclosure is not approved. Rate limits bound explicit requests instead; a future background mode requires new consent and a separate budget design.

**Android wrapper or dual-channel notifications** were rejected in favor of Web Push SPA. The voice-call foreground service does not provide independent inbox delivery and must not be repurposed to imply app-closed reliability.

**Persistent evaluation/dedup history** was rejected because reasons derive from messages and notification history would add durable chat activity. Cache loss and silent startup baseline are intentional costs. Self-hosted/unrestricted push endpoints were rejected because authenticated input still must not become an SSRF capability.

**Automatic outbox reconciliation/retry for WeChat** was deferred: observed delivery without timely SUCCESS does not establish which pending identifier/event proves success. A text match can still be pending; M4 does not weaken M3's uncertain state or resend safety.

## Consequences

The feature buys explicit data-disclosure boundaries, cross-tab revocation safety, bounded external calls and reviewable persistence. It costs non-durable importance/dedup, possible notification loss, restricted push-provider compatibility, and reliance on browser/OS background behavior. Unit/integration tests cover hostile inputs, isolation, async revocation, transport encryption/SSRF, lifecycle and SW navigation; mobile/1440/1024 screenshots cover UI, including a sheet fallback below 1280. Real-device Web Push and real Beeper pending-id observations remain post-review smoke work. No push, K29 access or live restart occurs in this milestone; commit hooks are disabled only for the delivery commit.
