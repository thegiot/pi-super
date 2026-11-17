# Inbox PWA bootstrap and explicit assistant intent

## Problem
Chrome Android cannot install the inbox without install metadata; exposing the entire SPA to fix that would widen the authentication boundary. Separately, an assistant used to understand group discussions must not implicitly generate outgoing messages, and long answers must remain readable above question controls.

## Decision
The inbox has stable manifest id, scope and start_url `/inbox/`, standalone display and dedicated 192/512 PNG icons. `serveInboxPwaAsset` admits only exact raw paths for that manifest and those two icons on GET/HEAD before authentication. Pairing and authenticated inbox share the manifest. Encoded aliases, traversal, application bundles, chat APIs and the notification worker do not join this public allowlist. Installation creates no credential: the installed browser must retain or obtain its own authorized cookie. The existing notification-only service worker is unchanged; no offline fetch handler, message cache or browser persistence is added.

`POST /api/inbox/chats/:id/assistant` accepts `intent: "answer" | "draft"`, default `answer`. The selected mode is server-owned instruction context, not inferred from untrusted chat text or prompt keywords. Informational mode retains `reply` but clears model-returned draft fields before returning the response; the client also discards drafts outside explicit draft mode. The panel's free-form question and summary/group-discussion chips use answer mode; “Proponi risposta” and “Riformula” request draft mode. Copying a draft to the composer remains explicit and never sends it. Existing zero-tool, escaped chat_data, context limits and privacy revision checks remain intact. The prompt asks for natural Italian, distinctions between evidence and interpretation, and honesty about truncated history and unseen images; it cannot guarantee factual model output.

## Alternatives
**Public entire inbox shell or offline app cache:** rejected because installability requires only secret-free metadata/icons, not authenticated code/data access or persistent conversation copies.

**Infer drafting from natural-language keywords or trust optional model output:** rejected because questions such as group recaps should not create a draft, and an injected instruction/provider mistake must not change the owner-selected mode. Explicit UI intent is predictable, at the cost of requiring the draft action even if free text says “write a reply.”

## Consequences
Chrome CDP installability checks can validate manifest delivery both with and without cookies, but real Android install UX and cookie sharing remain browser-controlled. Installation is not authentication or offline reading. Informational and draft requests are covered at HTTP and client-store boundaries. Long-response/short-viewport screenshots and bounding-box checks cover the prior flex-shrink overlap; physical Android keyboard behavior still depends on browser viewport reporting.

## Final review and delivery

Existing changes reviewed in place on `inbox-m1`, based on `8e84d1e`. Fresh typecheck including Bun/Svelte check, 254 tests under timeout, build, Svelte autofixer and isolated Chromium inbox harness passed. Final mobile screenshots 28/29/30 and desktop 13/23 inspected; compared assistant with Figma node 11:234. No blocking findings in public asset auth boundary, explicit intent or privacy review. Local KANBAN cards distinguish completed implementation from pending Android device smoke and owner-authorized push/deploy. Commit hooks disabled for this delivery; no live restart, push, real provider call or message send. Physical installation, standalone authentication and Android keyboard remain unverified.
