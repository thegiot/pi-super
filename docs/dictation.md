# Dictating prompts into the composer

Gboard's voice typing is what the phone offers today, and it is mediocre on exactly the
words we type most: `tmux`, `pi-super`, `npm run build`, flag names, file paths. This note
records what the alternatives actually are, with numbers measured against the live APIs on
2026-07-28, and recommends one.

Everything below is about the **composer** (`#input`), not about voice calls. Dictation
drops text into the textarea and the user still edits and sends it; the call in
`src/client/voice.ts` is a separate, conversational thing.

**This shipped**: the mic button in the composer runs the gpt-live path described below.
Jump to [As built](#as-built) for what the code does.

The measurements come from `tests/dictation-probe.mjs` (gpt-live, real headless Chrome with
a fake microphone) and from curl against OpenRouter. Both used the same 15.2s clip of
synthesised speech:

> *"In pi-super, rebase the tmux ribbon commit onto main, run npm run build, then restart
> the systemd user unit. Also grep the dist directory for stale WebRTC SDP handling."*

## What credentials this box actually has

`~/.pi/agent/auth.json` holds an `openai-codex` OAuth (the ChatGPT subscription), an
`anthropic` OAuth, and an `openrouter` API key. There is **no `OPENAI_API_KEY`**, and the
subscription does not substitute for one:

| attempt | result |
| --- | --- |
| Codex OAuth → `POST api.openai.com/v1/audio/transcriptions` | `401 Missing scopes: api.model.audio.request` |
| Codex OAuth → `POST chatgpt.com/backend-api/transcribe` (ChatGPT's own dictation) | `403`, Cloudflare interstitial |

The token is *recognised* at `api.openai.com` — it is simply not entitled to the Audio API.
So the subscription buys realtime *conversation*, and no file transcription at all.
Anthropic has no STT.

## Option 1: gpt-live as a silent dictation session — free, streaming, and it works

We already hold a realtime session open during calls, and it already hands us the user's
words: `voice.ts` reads them out of `turn.done`. Point that at the composer instead of at
the meta agent and dictation costs nothing, because it rides the ChatGPT subscription.

The naive version is bad, and measurably so. With the normal conversational
`voice-prompt.md` the model behaves like a partner: it heard the clip as *"In **PySuper**,
…"*, and its polite *"Mm-hmm"* **split the dictation into two turns** mid-sentence.

Replacing the instructions with a dictation prompt — *"You are a dictation microphone.
NEVER speak. … The user works on **pi-super** (always spelled `pi-super`, never 'PySuper'
or 'Pi Super'). Other words you will hear often: tmux, systemd, WebRTC, SDP, npm, dist"* —
fixes both. Four runs:

| | measured |
| --- | --- |
| mic button tap → session live | **0.73–0.83s** |
| first word appears | ~1.6s after you start speaking, then streams at speaking pace |
| full text available | **~0.8s** after you stop (last delta / `delegation.created` at +17.07s for speech ending at +16.24s) |
| `pi-super` transcribed correctly | **4 / 4** |
| model interjected and split the turn | 1 / 4 |
| cost | **$0** (subscription) |

That last line about the transcript quality is the surprise: **instructions bias the
transcript**. The deltas arrive as `" pi"`, `"-super"` — the vocabulary hint is reaching the
recogniser, not just the persona. That is the one thing Gboard structurally cannot do, and
we get it for free by writing a prompt.

Things a dictation client has to handle, all of them client-side:

- **Interjections still happen** (1 in 4). The fix is not to fight it: accumulate
  `input_transcript.added` deltas across *all* user turns until the user taps stop, instead
  of treating the first `turn.done` as the end. Then a split turn is invisible.
- The model still fires `delegation.created` despite being told not to. Dictation mode
  simply does not wire that to `meta.send()`.
- It still generates a spoken reply (~4s after the turn ends: *"Give me a minute to find
  that"*). Never attach the remote audio element and hang up when the user taps stop, and
  nobody hears it.
- `turn.done` lags the actual text by ~4s — it is bookkeeping. Use the deltas.

The real caveat is the endpoint: `chatgpt.com/backend-api/codex/realtime/calls` is
undocumented, entitlement-gated and reverse-engineered — no docs, no SLA, and OpenAI can
change it tomorrow. But `voice.ts` already depends on it entirely, so dictation adds no new
exposure: if it breaks, calls break with it, and the fallback below is there.

### The documented version of the same thing, if an API key ever appears

OpenAI's public Realtime API has a proper
[transcription-only session](https://developers.openai.com/api/docs/guides/realtime-transcription):
`type: "transcription"`, no assistant, no audio out, `conversation.item.input_audio_transcription.delta`
as text arrives, WebRTC supported — so our `POST /api/voice/offer` SDP-proxy pattern carries
over unchanged, and none of the interjection/delegation weirdness above exists.

```jsonc
{ "type": "session.update", "session": {
    "type": "transcription",
    "audio": { "input": {
      "format": { "type": "audio/pcm", "rate": 24000 },
      "transcription": { "model": "gpt-realtime-whisper", "language": "en", "delay": "low" },
      "turn_detection": null          // commit manually for push-to-talk
    } } } }
```

Cost is **$0.034/min** (~$0.0085 per 15s prompt), ~6× the file-based models — the price of
live text. Blocked today for want of a key; it is the clean upgrade path, not a different
design.

## Option 2: OpenRouter `/audio/transcriptions` — one HTTP request, best-in-class accuracy

OpenRouter's transcription endpoint takes the same Bearer key as chat, and we have that key.
Tested end to end on the same clip, encoded as Opus-in-WebM — *exactly* what `MediaRecorder`
produces on Android Chrome, so no client-side transcoding:

| model | latency | cost/clip | errors |
| --- | --- | --- | --- |
| `openai/gpt-4o-transcribe` | 1.3s | $0.0008 | **none — including `pi-super`** |
| `openai/gpt-4o-mini-transcribe` | 1.0s | $0.0004 | `piSuper` |
| `openai/whisper-large-v3` (Groq) | 0.9s | $0.0004 | `PI Super` |
| `qwen/qwen3-asr-flash` | 1.5s | $0.0005 | `Pi Super`, `TMUX` |
| `mistralai/voxtral-mini-transcribe` | 0.7s | $0.0008 | `PySuper`, `TMUX` |
| `deepgram/nova-3` | 0.9s | $0.0011 | `PY super`, `TMUX` |
| `openai/whisper-1` | 1.0s | $0.0016 | `PySuper`, `tmux-ribbon-commit` |

Contract (`POST https://openrouter.ai/api/v1/audio/transcriptions`, JSON): `model`,
`input_audio: { data: <raw base64, not a data: URI>, format: "webm"|"m4a"|"wav"|… }`,
optional `language`. Response `{ text, usage: { seconds, cost } }`. Limits: 60s upstream
timeout, 25 MB, no streaming, no audio URLs.

Vocabulary biasing works here too, but only through the provider passthrough — top-level
`prompt` is silently ignored, `provider.options.openai.prompt` (and `.groq.prompt`) is not:

```
whisper-1, no prompt : "In PySuper, rebase the tmux-ribbon-commit onto main, …"
whisper-1, + prompt  : "In pi-super, rebase the tmux-ribbon commit onto main, …"
```

## Option 3: the browser's own Web Speech API

Already in the tree — `voice.ts`'s `local` provider uses `webkitSpeechRecognition` when the
server has no realtime credential. But on Android it delegates to the same Google speech
service Gboard uses, so it cannot fix the complaint; `continuous` has been unreliable there
for a decade (we already restart it in `onend`); and there is no way to bias vocabulary.
Keep it strictly as the no-credential fallback.

## As built

The gpt-live path is what shipped. OpenRouter stays written down as the fallback to reach
for if the ChatGPT entitlement ever goes away; nothing in the client assumes it exists.

- **`src/client/dictate.ts`** — the transport. Mic → `RTCPeerConnection` →
  `POST /api/voice/offer?mode=dictation&target=<pane>`, no remote audio element attached,
  and only `input_transcript.added` (plus the standard-API `…input_audio_transcription.delta`)
  accumulated into text. `turn.delta` carries the same user fragments *and* the model's own
  speech, so it is deliberately not read. Two-minute cap; the mic tracks are stopped on the
  way out so the phone's recording indicator goes away.
- **`#btn-mic` in the composer**, tap to start and tap to stop — not press-and-hold, which
  fights the browser's own touch handling and does not suit prompts that run long. Hidden
  entirely unless `GET /api/voice/config` reports a `codex` or `openai` backend, since the
  `local` provider is the same engine the phone keyboard already uses.
- **Text streams into the textarea at the cursor** as you speak, keeping a draft as it goes,
  and is **never auto-sent**: the point is that the user proofreads the jargon. The call
  button stops dictation first, because there is only one microphone.
- **`src/server/dictation.ts` + `src/meta/dictation-prompt.md`** — the instructions, primed
  per session with `buildVocabulary()`: window names (weighted heavily — they are the user's
  own words for their own work) plus the last 80 lines of the target pane, minus prose,
  capped at 500 characters. Every failure in there degrades to the bare core vocabulary,
  because a session that mishears `pi-super` still beats no session.

`node tests/dictation-probe.mjs` runs the whole thing headless against a real gpt-live
session and checks the timings above still hold. The last run:

```
  mic open (listening)   +1.11s
  first word on screen   +3.42s   (speech starts at +1.00s)
  last word on screen    +17.20s  — complete 0.96s after the speaker stopped
  textarea: "In pi-super, rebase the tmux ribbon commit onto main. Run npm run build, …"
```

**Privacy**: dictation audio goes exactly where call audio already goes, and only while the
button is red. Nothing new leaves the machine.

## If the ChatGPT entitlement ever goes away

Build the OpenRouter path behind the same button: `MediaRecorder` with the first supported
of `audio/webm;codecs=opus` → `audio/mp4` (iOS Safari; send that as format `m4a`), POST the
blob to a new `POST /api/stt` (`originAllowed` + `readBody` with a ~10 MB cap, like
`/api/upload`), key from `OPENROUTER_API_KEY` or `openrouter.key` in pi's `auth.json`
(mirror `readCodexAuth()`), model from `PI_SUPER_STT_MODEL` defaulting to
`openai/gpt-4o-transcribe`, and the same `buildVocabulary()` output into
`provider.options.{openai,groq}.prompt`. The composer half of the work is already done and
unchanged. Note that this one *does* send audio somewhere new — OpenRouter load-balances
across providers — so it wants a line in the README and an opt-out.
