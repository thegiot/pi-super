# pi-super

A phone-shaped remote for **the tmux you already have running** — the one full of `pi`
sessions, side-agents, shells and TUIs — plus (soon) a voice-driven meta agent that can
look into every window and act on your behalf.

* **tmux-native**: attaches to the running tmux server, never replaces it. Your desktop
  client keeps working at the same time, on the same windows.
* **terminal-first**: a real PTY carrying real bytes, so every key, every TUI, copy-mode,
  `vim`, `mutt`, `pi` all behave exactly as they do locally.
* **mobile-first**: window tabs, a reader mode that reflows a 200-column agent session to
  phone width, a key ribbon, a prompt composer (so Gboard dictation just works), and
  image paste that lands as a real file path in the session.

Status: terminal plane and meta agent work; voice mode is wired but its realtime backends
need credentials this box doesn't have yet (details in [DESIGN.md](DESIGN.md)).

## The three views

* **terminal** (📖 toggles raw ↔ reader) — your tmux, tab per window.
* **meta agent** (🜲) — chat with *super*, which inspects and steers every window for you:
  "what's the status of the grand endeavors work?", "tell it to run the tests", "open the
  kitchen radio project and find out why it stopped working". It answers in chat and, via
  its `speak` tool, out loud.
* **voice call** (📞) — the same meta agent, hands free. The speech model only talks and
  delegates; super does the work and reports back mid-call.

## Quick start

```bash
npm install
npm run build
node dist/server/index.js            # prints an URL with the access token
```

Open the printed URL on your phone (same LAN / over an ssh tunnel / behind a TLS proxy).
The `?token=…` is exchanged once for an HttpOnly cookie, so subsequent loads are clean;
"Add to home screen" gives you a standalone app.

```
Options:
  -p, --port <n>          Port (default 8722)
  -H, --host <addr>       Bind address (default 127.0.0.1)
  -s, --session <name>    Base tmux session to mirror (default: first non-pi-super session)
  -S/-L <socket>          tmux socket path / name
      --status-line       Keep tmux's own status line inside the terminal view
      --meta-model <m>    Model for the meta agent (default: your pi default)
      --no-meta           Disable the meta agent
      --meta-inherit-extensions   Load your global pi packages into the meta agent too
      --reset-token       Roll the access token
      --url               Print the access URL and exit
```

### Exposure and passkeys

Terminal access is shell access, so pi-super separates *reachability* from *authorization*.

Reachability: keep the default loopback bind and put a tunnel in front — Tailscale
(`tailscale serve`), `ssh -L`, or a TLS reverse proxy. A VPN makes the box reachable by
every device on your tailnet, which is not the same thing as authorizing them.

Authorization: **enrol a passkey**. Open the app once with the token, menu (≡) → *+
passkey*, and confirm with your phone's fingerprint/screen lock. From then on the bearer
token alone opens nothing — HTTP and WebSocket both demand a passkey session, and a stolen
token or a compromised tailnet device gets 401.

```
--auth auto      token until a passkey is enrolled, then passkey only (default)
--auth token     never require a passkey
--auth passkey   require one even before enrolment (locks you out; for recovery use --auth token)
--allow-token    keep accepting the token alongside passkeys (scripts, CI)
--list-passkeys / --remove-passkey <label> / --logout
```

Passkeys are bound to the hostname you enrol on (WebAuthn RP ID) and need HTTPS or
localhost, so enrol over the name you will actually use — e.g. your MagicDNS
`machine.tailXXXX.ts.net`, not `localhost`. Sessions live in `~/.pi/super/passkeys.json`
and last 30 days; `--logout` revokes them all.

## How it works

Each browser connection creates its own tmux session **grouped** with the base session
(`tmux new-session -d -s pisuper-xxxx -t 0`). Grouped sessions share the window list and
the processes but keep their own *current window*, so the phone can watch window 8 while
the desktop stays on window 3. On disconnect only that grouped session is killed.

By default the phone attaches with `-f ignore-size`, so it observes at the desktop's
geometry and never reflows anybody else's terminal; the UI scales the view to fit. Flip
**claim terminal size** in the drawer when you want to actually work at phone geometry
(that *does* resize the window for every client — that's what claiming means).

Window switching, creation, renaming and killing go out-of-band as plain tmux commands,
not keystroke stuffing. Reader mode is `capture-pane` rendered as selectable DOM text.

## Voice

The voice plane picks a backend automatically:

| provider | needs | how work gets done |
|---|---|---|
| `codex` | your ChatGPT/Codex login (pi's `auth.json`) | WebRTC to `gpt-live`, `delegation.created` → meta agent, progress via `delegation.context.append` |
| `openai` | `OPENAI_API_KEY` | WebRTC to `gpt-realtime-2.1-mini`, `ask_super` function tool |
| `local` | nothing (Chrome) | browser speech recognition → meta agent → `speechSynthesis` |

The credential never reaches the browser: the phone POSTs its SDP offer to pi-super, which
attaches auth plus the server-side instructions and returns only the answer.

Voice runs on your ChatGPT subscription by default (`codex`, gpt-live). `OPENAI_API_KEY`
is only used when no ChatGPT login is present.

### Call handling

The call is meant to behave like a phone call, within what a browser allows:

* **hush** — the `hush` button, or a headset/steering-wheel play-pause press (via Media
  Session), cuts super off mid-sentence. Interruption is always *deliberate*: we never
  cancel a response just because voice activity was detected, because super talking over
  you is frequently the right thing.
* **redial** — a `disconnected` ICE state gets six seconds to heal itself (tunnels, wifi/5G
  handovers), and a genuine failure redials with backoff up to five times instead of
  dropping the call. A real incoming phone call, which takes the microphone away, is
  survivable this way. The meta agent lives on the server, so super's memory spans the
  gap; only the speech model's own short-term context is lost.
* **not yet a real call** — with the screen off, Android suspends the tab and the call
  dies. The screen wake lock we hold is the opposite of what a call wants. Genuine
  screen-off, Bluetooth-routed, ducking-aware audio needs a native foreground service
  (`microphone|phone_call`) or `ConnectionService` — see M4 in `docs/todo.md`.



## Development

The voice call is testable without a human: `npm run test:voice` speaks a synthesized
question into headless Chrome's fake microphone, drives the call over CDP, and checks the
whole loop down to the recorded audio reply (`/tmp/pi-super-voice-out.webm`). It needs
`google-chrome`, `sox`, and piper (`uv tool install piper-tts` plus a voice model in
`/tmp/piper-voices/`).

```bash
npm run build          # tsc (server) + vite (client)
npm run typecheck
node tests/smoke.mjs http://127.0.0.1:8799 "$(cat ~/.pi/super/token)"   # e2e against live tmux
npm run test:voice     # unattended voice call: fake mic + headless Chrome + recorded reply
npm run test:mobile    # Pixel-metrics screenshots + layout checks -> /tmp/pi-super-shots/
npm run test:passkey   # full WebAuthn flow via Chrome's virtual authenticator
```

## Running under systemd (user service)

```sh
cp contrib/pi-super.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-super
journalctl --user -u pi-super -f     # logs
```

The unit starts the server through a login shell so `node` (nvm) and `pi` resolve from
your normal profile. Deploys are `npm run build && systemctl --user restart pi-super`.
