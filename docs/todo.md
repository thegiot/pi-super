# pi-super — open items

Carried over from the first code review; the P0/P1 items it found are fixed, these are
the ones deliberately left for later.

## Correctness / robustness

- **Meta transcript ordering**: assistant text from several turns is appended to one item
  until `agent_settled`, so a long turn's final text can render above the tool rows that
  produced it. Should close the assistant item on `turn_end` / when a tool starts.
- **Server-side transcript eviction** (>500 items) is not reflected in the client DOM;
  reconnect fixes it, long-lived tabs grow.
- **`-ne` only disables extension discovery**, not global skills/prompt templates/context
  files — the meta agent is less isolated than the README implies.
- **`speak.kind`** uses `Type.Union(Type.Literal(...))`, which pi documents as unfriendly
  to Google models; use a string enum if the meta agent is ever run on Gemini.
- **Socket args** are passed to the meta extension space-joined, so a tmux socket path
  containing spaces breaks.
- **Claim mode is remembered in localStorage**: a reconnect silently resizes shared windows
  again. Probably should require a fresh decision per session.
- `killWindow` refuses only when it is the *last* window; it still kills a window that the
  desktop client may be sitting in. A "detach from my mirror only" alternative would be
  nicer but tmux has no per-group window hiding.

## Voice

- Only one `delegationId` is tracked, and `speak()` events are global, so two overlapping
  voice requests share one channel — real async multiplexing needs correlation ids
  (meta-side job registry) before the "ask about B while A builds" story is honest.
- No timeout/rate limit on `/api/voice/offer` provider calls.
- `commentary` vs `speakable` channel choice is a guess: `speak(kind:"status")` goes to
  `commentary`, everything else to `speakable`. Only `speakable` has been observed live.
- The 500-byte chunking of `delegation.context.append` has never been exercised (real
  updates have been one chunk).

## Hardening

- Passkey enrolment is authorized by the bearer token, so the token is still a full
  bootstrap credential until you roll it (`--reset-token`) after enrolling.
- No per-passkey scopes (every passkey is equal), and no WebAuthn user handle/account
  concept — this is a single-user tool.

- Upload quota/TTL/count limits and a MIME allowlist (currently only size + sniffed ext).
- WS message rate limiting per connection; `/api/capture` line caps are generous.
- 413 for oversize uploads currently races socket destruction.

## Nice to have

- `tmux -CC … -f ignore-size,no-output` observer instead of the 1 s window poll.
- Push notifications (tmux bell / meta `speak` while the tab is closed).
- Native Android wrapper (M4) for real call-mode audio with the screen off.
