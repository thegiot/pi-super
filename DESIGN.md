# pi-super — design

A mobile-first meta-interface to **an existing tmux server** full of `pi` sessions,
side-agents, shells and TUIs — plus a **meta agent** that can be talked to by text or
voice and that manages that tmux on your behalf.

Named after hbomberguy's *super*: one remote that drives everything.

## Non-negotiables (from the brief)

1. **tmux-based** — attaches to the tmux server that is already running, never replaces it.
   Everything stays attachable/usable from the desktop at the same time.
2. **Terminal-first** — the transport is a real PTY carrying real terminal bytes, so
   arbitrary keys, TUI redraws, copy-mode, `vim`, `mutt`, `droid`, whatever, all just work.
   No "structured RPC only" cage.
3. **Voice mode** — a hands-free call-like mode on Android driving a meta agent that
   inspects/steers all tmux windows, model-agnostic (voice model is a thin front end).
4. **Image paste** from the phone into a session.

## Shape

```
                    ┌───────────────────────── Android (PWA, later TWA/Capacitor) ────────┐
                    │  Terminal view      Meta chat view       Voice call view            │
                    │  xterm.js + ribbon  DOM chat             WebRTC ↔ realtime model     │
                    └───────┬───────────────────┬────────────────────┬───────────────────-┘
                            │ WSS (bytes)       │ WSS (json)         │ SDP offer/answer proxy
                    ┌───────┴───────────────────┴────────────────────┴───────────────────┐
                    │                      pi-super server (node)                        │
                    │  auth · uploads · tmux control · pty broker · meta RPC · voice mint │
                    └───────┬───────────────────┬────────────────────────────────────────┘
                            │                   │
             ┌──────────────┴──────────┐   ┌────┴───────────────────────────┐
             │ existing tmux server    │   │ meta agent: `pi --mode rpc`    │
             │  session 0 (+ group)    │   │  -e super-meta.ts (tmux tools) │
             │   0 mutt  1 ssh  2 vi   │◄──┤  drives windows via tmux(1)    │
             │   8 grand-endeavors pi  │   └────────────────────────────────┘
             │   10 pi-super pi ...    │
             └─────────────────────────┘
```

### 1. Terminal plane (M1)

* **Per-client grouped session.** For each connected browser we create
  `tmux new-session -d -s super-<clientId> -t <base>` and attach a PTY to *that*.
  Grouped sessions share the window set and processes but keep their **own current
  window** — so the phone can look at window 8 while the desktop sits on window 3.
  (The user's setup already lives in a group `0, 0-2 … 0-9`; we're just one more member.)
  On disconnect we kill only our own grouped session. Never `attach -d`.
* **Size policy.** tmux computes window size from all attached clients
  (`window-size latest` here) — a phone attaching naively would shrink the desktop's
  windows. Default is therefore `attach-session -f ignore-size`: we observe at the
  desktop's geometry. A per-connection **"claim size"** toggle (re-attaches without the
  flag) is offered for when you actually want to work at phone geometry. We never touch
  global tmux options.
* **Two view modes**, toggleable per window:
  * **raw** — xterm.js over the PTY, exact bytes, all keys, mouse/copy-mode.
  * **reader** — `capture-pane -p -J -S -N` rendered as selectable DOM text that wraps
    to phone width. This is what makes a 213-col agent session readable on a phone,
    and it gets native touch scrolling/selection/find for free.
* **Out-of-band control.** Window list/switch/create/rename/kill are plain `tmux`
  commands against our grouped session (`list-windows`, `select-window`, `new-window -c
  <cwd>`), not keystroke stuffing. Optional later: a `tmux -CC … -f ignore-size,no-output`
  observer for push-based window-list updates instead of polling.
* **Input.** A composer `<textarea>` (native Android keyboard ⇒ Gboard dictation works
  out of the box, no STT of our own needed for text mode) sends bracketed-paste text
  + optional Enter; a key ribbon covers Esc/Tab/Ctrl/arrows/PgUp/PgDn/Ctrl-C; raw xterm
  focus is available for exact TUI typing.
* **Peek at files.** A tap on a path resolves the token under the finger against the
  pane's cwd and pops the file up: images as images, text syntax-highlighted in a `<pre>`,
  `file:42` scrolled to that line, and a directory as a listing whose every row is another
  tap (`..` included) — the only file browser this needs, since you arrive next to what
  you were after. Works in all three views, by two different hit tests —
  the reader and the chat are DOM text (`caretRangeFromPoint`), while the raw grid has no
  node under the finger, so the tap is divided into a cell and read back out of the xterm
  buffer (following `isWrapped`, because at phone width a long path spans two rows).
  There is no sandbox root — everyone who gets this far already has a shell — only size
  caps, so a phone is never handed a core dump.
* **Images.** Clipboard/file-picker upload → `~/.pi/super/uploads/<rand>.<ext>` (0600) →
  the absolute path is pasted into the focused pane, which is exactly what pi/claude
  TUIs want.

### 2. Meta agent plane (M2)

The meta agent is **`pi --mode rpc`**, spawned and owned by the pi-super server, with a
tiny extension loaded via `-e` (so nothing is installed into every pi session anywhere) and
a light system prompt. It is *not* a special tmux window: RPC gives us structured
message/tool events, which is what both the mobile chat view and the voice plane need.
Its own work is still visible in tmux, because everything it does it does *to* tmux.

Tools beyond pi's builtins (bash already covers most of tmux):

* `tmux_windows` — inventory (session, window, pane, cwd, command, activity, size).
* `tmux_read` — `capture-pane` of a window (with `-S` scrollback depth).
* `tmux_send` — send a prompt/keys to a window (`!` interrupt prefix, `/` slash cmds —
  same contract as pi-side-agents' `agent-send`, which the model already knows).
* `tmux_open` — new window in a given cwd, optionally starting `pi` with a prompt.
* `speak` — push a short spoken/notified update to the phone *asynchronously*
  (the ack/status/final contract borrowed from `pi-realtime`; keeps voice grounded
  while long work runs).

System prompt: "you live to manage this tmux"; plus knowledge of where sessions live
(`~/.pi/agent/sessions/<mangled-path>/`) so "the kitchen radio thing we did" is a `grep`
away. Deliberately thin — the models already know tmux.

### 3. Voice plane (M3)

* Browser **WebRTC** to a realtime speech model. The phone POSTs its SDP offer to
  `POST /api/voice/offer`; pi-super attaches the credential and the server-side
  instructions and returns only the answer, so no secret ever reaches the browser.
* **Eco/delegation pattern** (as in `pi-realtime`, and morally what pi-codex-conversion's
  Codex `delegation.created` does, minus the private `quicksilver` protocol): the realtime
  model does turn-taking, barge-in and short chat, and has exactly one substantive tool —
  `ask_super(request)` (or, on the Codex path, the `delegation.created` event) — which
  enqueues a turn on the meta agent and returns immediately.
  Progress/results come back **asynchronously** as `conversation.item.create` +
  `response.create` injected from `speak()` events. So it is model-agnostic: swap Claude,
  GPT, Gemini, whatever behind the meta agent; only the ~200 lines of realtime wiring are
  OpenAI-specific, behind a `VoiceProvider` interface (Gemini Live is the second candidate).
* Async multiplexing (ask about repo A while B builds) falls out of this: the meta agent
  can spawn/steer many tmux windows and `speak()` when something lands. Long jobs are
  *never* an open realtime tool call — the 60-min session cap and mobile lifecycle make
  that a trap.
* **Android reality check:** an installed PWA gets real WebRTC audio + Bluetooth routing,
  but screen-off/background microphone is *not* a contract (Chrome page lifecycle can
  freeze it). M3 ships PWA + Screen Wake Lock + Media Session ("keep the screen on");
  a proper call experience (foreground service / Core-Telecom, works with screen off, car
  audio, headset buttons) needs the M4 thin native wrapper that owns the audio session,
  reusing the same web UI.

### 3b. Authentication (passkeys)

A tailnet gives *reachability*; it does not give *authorization*. Any device on the
tailnet — or anyone who ever saw the bearer token in a URL — would otherwise have a root
shell. So pi-super supports WebAuthn:

* Enrolment is authorized by the bearer token (or an existing session), so first run works
  with the URL you already have.
* Once any passkey exists, `--auth auto` flips the policy: only a passkey session opens the
  app; the token is refused on both HTTP and the WebSocket. `--allow-token` opts out.
* Verified server-side with `@simplewebauthn/server`; credentials, counters and sessions
  live in `~/.pi/super/passkeys.json` (0600). Sessions are opaque 256-bit ids in an
  HttpOnly/Secure/SameSite=Lax cookie, 30 days, revocable with `--logout`.
* The app bundle (no secrets in it) is served unauthenticated once passkeys are required —
  a login page has to be reachable by someone who cannot log in yet.
* RP ID comes from the request host, so a passkey enrolled on the MagicDNS name is only
  usable there. Counter regression is treated as a cloned authenticator.

Tested by `tests/passkey-e2e.mjs` with Chrome's CDP virtual authenticator: real ceremonies,
real signatures, and the load-bearing assertion that the token stops working afterwards.

### 4. Security

Terminal access == shell access. Defaults: bind `127.0.0.1`, mandatory 256-bit bearer
token (`~/.pi/super/token`), token→`HttpOnly; SameSite=Lax` cookie on first load,
WebSocket `Origin` check, upload size/MIME caps, uploads 0600 in a 0700 dir, no root.
Exposure is the operator's choice: ssh -R tunnel, Tailscale serve, or a TLS reverse proxy.
No "convenience" unauthenticated mode once bound off-loopback.

## Milestones

| # | Scope | State |
|---|-------|-------|
| M1 | server + terminal plane + mobile web UI (windows, raw/reader, ribbon, image paste, auth) | **done** |
| M2 | meta agent (pi RPC child + tmux tools + speak + chat view) | **done** |
| M3 | voice mode (WebRTC realtime + delegation; Web Speech fallback) | **done** (gpt-live call negotiates, 201) |
| M4 | native Android wrapper for true call-mode audio; push notifications | |

### M3 backend notes (2026-07)

* **codex** (default): `chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`,
  `gpt-live-1-boulder-alpha`, `delegation: {type: "client"}` — the pi-codex-conversion contract,
  driven by the ChatGPT OAuth pi already stores. Negotiates fine (201).
  **Gotcha that cost a day:** a V2 voice name (`marin`) in a V3 session is rejected as
  `403 Voice session access denied`, which reads exactly like an account entitlement
  failure and is not one. gpt-live voices: cove (default), juniper, maple, spruce, ember,
  vale, breeze, arbor, sol. The query params are mandatory whenever `openai-alpha` is sent.
  Data channel is `oai-events`. Verified vocabulary (captured live by `tests/voice-e2e.mjs`):

  | event | direction | payload |
  |---|---|---|
  | `session.started` | in | `session.{id,model,expires_at,instructions}` |
  | `input_transcript.added` | in | `item.text` — fragment of what the user said |
  | `turn.created` / `turn.delta` / `turn.done` | in | `turn.{id,role,transcript}` — the assembled user turn |
  | `output_transcript.added` | in | `item.text` — fragment of what the model is saying |
  | `delegation.created` | in | `item.{id,content[].text}` — hand-off to us |
  | `delegation.context.append` | out | `{delegation_item_id, channel: speakable\|commentary, content}` |
  | `delegation.context.appended` | in | ack with timing |

  Transcript fragments are tiny (~200 ms), so the user side is taken from `turn.done` and
  the assistant side is accumulated and flushed after a pause.
* **openai** (fallback, needs `OPENAI_API_KEY`): standard Realtime API, `ask_super` function tool.
* **local** fallback: browser `SpeechRecognition` + `speechSynthesis`. Half duplex, no
  credentials, Chrome only.

### Testing voice without a human

`tests/voice-e2e.mjs` runs the entire call unattended: piper TTS renders a question to a
WAV, headless Chrome plays it as its microphone (`--use-file-for-fake-audio-capture`),
CDP clicks the call button, and the page taps the returned WebRTC track with an
`AnalyserNode` (proof audio flowed) plus a `MediaRecorder` (so the reply can be listened
to afterwards). It asserts the full chain: call live → model heard speech → delegated →
meta agent ran tmux tools → `speak()` → `delegation.context.append` → model spoke.


## Prior art actually consulted

`gmux.app` (mobile xterm layer, clipboard→file pipeline, auth posture), `tmux-mobile`
(grouped-session-per-client), `tmux-web`/`webtmux` (control-mode observer, out-of-band
window ops), `mobux` / `agent-tmux-web` (mobile tmux UX, reader mode, image upload),
`ttyd` (PTY/WS core), `pi-realtime` (eco voice mode, ack/status/final tools),
`pi-codex-conversion` (WebRTC realtime + delegation + progress streaming, Codex-specific),
`happy`/`CCGram` (session focus, tmux as generic agent API), `pi-side-agents` (this repo's
sibling: tmux window lifecycle, send-key contract).
