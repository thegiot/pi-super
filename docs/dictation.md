# Dictating prompts into the composer

Gboard's voice typing is what the phone offers today, and it is mediocre on exactly the
words we type most: `tmux`, `pi-super`, `npm run build`, flag names, file paths. This note
records what the alternatives actually are, with numbers measured against the live APIs on
2026-07-28, and recommends one.

Everything below is about the **composer** (`#input`), not about voice calls. Dictation
drops text into the textarea and the user still edits and sends it; the call in
`src/client/voice.ts` is a separate, conversational thing.

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
fixes both. Four runs (`node tests/dictation-probe.mjs --dictation`):

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

## Recommendation

**Primary: a gpt-live dictation session.** It is free, the words appear while you speak,
it is listening 0.8s after the tap, it got the jargon right 4/4, and the transport, the
credential handling and the SDP proxy all exist already. The two rough edges (turn splits,
an unwanted spoken reply) are handled by accumulating deltas and not attaching the audio.

**Fallback: OpenRouter `gpt-4o-transcribe`** for anyone without ChatGPT auth — a plain POST
of a `MediaRecorder` blob, equal accuracy, a tenth of a cent per prompt, no WebRTC. This is
also the sane thing to build *first* if the WebRTC path turns fiddly, since the composer
side of the work is shared.

Keep the Web Speech API as the last resort, as `voice.ts` already does for calls.

### Integration sketch

**Client** (`src/client/dictate.ts`, new)

- `<button id="btn-mic">🎤</button>` in `#composer`, left of `#btn-insert`. The composer,
  not the ribbon: the ribbon is hidden in the meta view, and dictating at super is the case
  that matters most.
- Tap to start, tap to stop — not `pointerdown`/`up`: a long press fights the browser's own
  touch handling, and dictated prompts run long. Red button plus an elapsed counter, hard
  cap around 2 minutes.
- gpt-live path: reuse `voice.ts`'s connect/teardown (mic → `RTCPeerConnection` →
  `POST /api/voice/offer`), but with `?mode=dictation`, no remote audio element, and an
  event handler that only accumulates `input_transcript.added` deltas. Show them live in the
  textarea as you speak. Hang up on stop.
- OpenRouter path: `MediaRecorder` with the first supported of `audio/webm;codecs=opus` →
  `audio/mp4` (iOS Safari; send that as format `m4a`), POST the blob to `/api/stt`.
- Either way: insert at the cursor exactly like `upload()` does, `autogrow()`, refresh the
  `draft` in localStorage, and **never auto-send** — the point is that the user proofreads
  the jargon. Stop the mic tracks afterwards; a live mic indicator that never goes away is
  alarming on a phone.
- Disable the button while a call is live (one mic, and the call owns it).

**Server**

- `src/meta/dictation-prompt.md` next to `voice-prompt.md`, selected by
  `?mode=dictation` on `POST /api/voice/offer`. Build the vocabulary paragraph at request
  time from the target window's name plus a short `tmux.capture()` tail — the hint is what
  makes this better than Gboard rather than merely different. Cap it; it is a hint, not
  context.
- `POST /api/stt` (new `src/server/stt.ts`) for the fallback: `originAllowed` + `readBody`
  with a ~10 MB cap like `/api/upload`; key from `OPENROUTER_API_KEY`, else `openrouter.key`
  in pi's `auth.json` (mirror `readCodexAuth()`); model from `PI_SUPER_STT_MODEL`, default
  `openai/gpt-4o-transcribe`; the same vocabulary text into
  `provider.options.{openai,groq}.prompt`; return `{ text, cost }` and log the cost, since
  this would be the first thing in pi-super that spends money per action.
- Advertise which paths are available in `GET /api/voice/config` so the client hides the
  button instead of failing on tap.

**Privacy**: with gpt-live the audio goes where call audio already goes. The OpenRouter
fallback is a step further — OpenRouter load-balances across providers — so it deserves a
line in the README and a `PI_SUPER_STT_PROVIDER=none` opt-out.
