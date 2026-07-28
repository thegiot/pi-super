# pi-super

<p align="center">
  <a href="https://www.youtube.com/watch?v=DZaAFADoF1M">
    <img src="docs/ironman.jpg" width="720" alt="Iron Man at his terminal rig — click to watch">
  </a><br>
  <em>Did you know Iron Man's Jarvis is just a GPT-Live hooked to a tmux with a bunch
  of Pi sessions? (Robots and holograms not included in this package.)</em><br>
</p>

---

pi-super takes the tmux session already running on your dev box — the one full
of `pi` agents, shells and editors — and puts the whole thing on your phone,
while on the tmux side you do not need to change anything at all. Your desktop
keeps showing exactly what it always showed; your phone just gets a seat at the
table too.

And because you're not always in a typing mood on your phone, there's *super*, the meta
agent — an agent whose job is your other agents, that you talk with using your
voice just like you'd talk with the ChatGPT app. It can peek into every window
and act for you while you are driving, cooking or hiking. It isn't just
a speech-to-text-to-speech but a voice-controlled full-duplex agent — it
inspects Pi sessions (and anything else, really), it steers, it reports and
summarizes back.

* **Nothing changes.** pi-super attaches to your running tmux server, never replaces it.
  Your desktop client keeps working at the same time, on the same windows.
* **A real terminal, not an approximation.** A real PTY carrying real bytes: every key,
  every TUI, copy-mode, `vim`, `mutt`, `pi` all behave exactly as they do at your desk.
* **Built for mobile.** Window tabs, a reader mode that reflows a 200-column agent
  session to phone width, a key ribbon, a prompt composer (dictation just works), image paste,
  and a tap on any path in the output to open that file — screenshots and plots included.

---

<p>
  <img src="docs/screenshots/terminal.jpg" width="32%" alt="Terminal view: a live pi session, key ribbon and prompt composer">
  <img src="docs/screenshots/windows.jpg" width="32%" alt="Window list: pane titles say what each agent is doing">
  <img src="docs/screenshots/super-call.jpg" width="32%" alt="On a call with super: transcript plus mute, hush, hang up">
</p>

*Your tmux, live — the window list where pane titles say what each agent is up to — and
mid-call with super.*

---

Where things stand: terminal, chat and voice all work today — voice runs on
your Codex login (gpt-live) and can fall back to the browser's own speech
engine (but you'd be missing a lot).

The voice experience is full-duplex and async-first, already feeling just like
the new GPT-Live-based ChatGPT voice. However, phone-integration-wise it is not
yet compatible with hands-free devices or with the screen locked — a standalone
mobile app will be required to actually emulate a call.

## Driving, or delegating

Two ways to work:

* **Drive it yourself — the terminal** (📖 toggles raw ↔ reader). Your tmux, one tab per
  window, real keys into a real PTY. (Oh, and PgUp/PgDn in Pi actually scroll!) Swipe
  left/right to walk the windows and up/down to page through the terminal; drag windows by
  the ⠿ grip in the list to reorder — that renumbers them in tmux, for every client. In
  reader mode (and in the chat), tapping a file path an agent printed opens the file right
  there: `plot.png` as an image, `src/server/term.ts:88` as text scrolled to line 88.
* **Hand it to super — the meta agent** (📞). Opens the chat and places the call in one press.
  Ask for anything on the machine: "what's the status of the muaddib work?", "tell
  it to run the tests", "open the kitchen radio project and find out why it stopped
  working". Super reads panes, sends prompts, opens windows and waits on builds, then
  answers in the chat and out loud.

📞 again returns to the terminal and keeps the call up; hang up (📴) from the call bar. 🎙 *mute*
and 🤫 *hush* (or the headset button) shut super up without ending anything. The bar stays in
the chat after the call ends to carry **/new**, which forgets the conversation and starts a
fresh super session (tap twice — it asks first).

YMMV, but pi-super is best combined with [**pi-side-agents**](https://github.com/pasky/pi-side-agents) that allow seamless
parallel work on multiple prompts in the same project using tmux windows (and
worktrees, handled transparently behind the scenes).

## Quick start

(Honestly, just point your `pi` at this repo and ask it to walk you through a secure setup.)

...anyway:

```bash
npm install -g pi-super              # needs a C++ toolchain for node-pty's native build
pi-super                             # prints an URL with the access token
```

From source instead: `git clone https://github.com/pasky/pi-super`, `npm install`,
`npm run build`, `node dist/server/index.js`.

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
token or a compromised tailnet device gets 401. It cannot enrol its way back in either:
once a passkey exists, adding another one takes an unlocked session (`--allow-token` opts
out of both rules). Revocation reaches running servers, including the shell sockets they
already handed out — `--remove-passkey` / `--logout` take effect within seconds.

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

By default the phone **claims** the terminal size: it works at its own geometry, which
resizes the window for every client, desktop included — that's what claiming means, and
it's what you want when the phone is where the work is happening. Uncheck **claim
terminal size** in the drawer to attach with `-f ignore-size` instead: the phone then
observes at the desktop's geometry and never reflows anybody else's terminal, and the
UI scales the view to fit.

Window switching, creation, renaming and killing go out-of-band as plain tmux commands,
not keystroke stuffing. Reader mode is `capture-pane` rendered as selectable DOM text.

## Voice

Voice picks a backend automatically:

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
* **stall rescue** — if the agent's turn goes completely silent for three minutes (a
  provider stream that stops delivering while the socket stays open — it happens), the
  server restarts it, tells you out loud, and asks it to pick the request back up after
  checking what it already did. Voice cannot afford a failure mode whose only symptom is
  silence after "checking".
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
