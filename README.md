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

### Exposure

Terminal access is shell access. Default bind is loopback. To reach it from a phone, pick
one: `ssh -R`/`-L` tunnel, Tailscale, or a reverse proxy that terminates TLS. Off-loopback
binds still require the token, but the token travels in plaintext over HTTP — use TLS.

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

Right now `codex` returns 403 `Voice session access denied` for this account (feature flag
not rolled out) and there is no `OPENAI_API_KEY`, so it falls back to `local`. Nothing to
change when either becomes available.

## Development

```bash
npm run build          # tsc (server) + vite (client)
npm run typecheck
node tests/smoke.mjs http://127.0.0.1:8799 "$(cat ~/.pi-super/token)"   # e2e against live tmux
```
