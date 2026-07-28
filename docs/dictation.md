# Dictating prompts into the composer

Gboard's voice typing is what the phone offers today, and it is mediocre on exactly the
words we type most: `tmux`, `pi-super`, `npm run build`, flag names, file paths. This note
records what the alternatives actually are, with numbers measured against the live APIs on
2026-07-28, and recommends one.

Everything below is about the **composer** (`#input`), not about voice calls. A dictation
button drops text into the textarea and the user still edits and sends it; the call in
`src/client/voice.ts` is a separate, conversational thing.

## The constraint that decides it: which credentials this box has

`~/.pi/agent/auth.json` holds an `openai-codex` OAuth (the ChatGPT subscription), an
`anthropic` OAuth, and an `openrouter` API key. There is **no `OPENAI_API_KEY`**.

That matters more than any feature comparison, because it rules out the obvious answer:

| attempt | result |
| --- | --- |
| Codex OAuth → `POST api.openai.com/v1/audio/transcriptions` | `401 Missing scopes: api.model.audio.request` |
| Codex OAuth → `POST chatgpt.com/backend-api/transcribe` (what the ChatGPT app's dictation uses) | `403`, Cloudflare interstitial |

The token is *recognised* at `api.openai.com` — it is simply not entitled to the Audio API.
So the subscription buys us realtime *conversation* (which is why voice calls are free) but
not transcription. Anthropic has no STT at all.

## (1) OpenAI Realtime transcription sessions

They exist and they are the right shape for a mic button:
[docs](https://developers.openai.com/api/docs/guides/realtime-transcription). A session with
`type: "transcription"` has no assistant and no audio output — you append audio, it streams
`conversation.item.input_audio_transcription.delta` and `.completed` back. WebRTC is
supported, so our existing `POST /api/voice/offer` proxy pattern (browser sends SDP, server
attaches the credential, returns the answer) would carry over almost unchanged.

```jsonc
{ "type": "session.update", "session": {
    "type": "transcription",
    "audio": { "input": {
      "format": { "type": "audio/pcm", "rate": 24000 },
      "transcription": { "model": "gpt-realtime-whisper", "language": "en", "delay": "low" },
      "turn_detection": null          // commit manually for push-to-talk
    } } } }
```

Cost: `gpt-realtime-whisper` is **$0.034/min** (~$0.0085 per 15-second prompt), roughly 6×
the file-based models, which is the price of seeing words appear as you speak.

**Blocked:** needs an OpenAI API key. If one is ever added, this is the upgrade path from
the recommendation below, and it is a drop-in for the same UI.

### The free-with-subscription hack, for completeness

A gpt-live call *already* hands us the user's transcript: `voice.ts` reads it out of
`turn.done` (role `user`). A "dictation" mode could dial the existing codex realtime
endpoint with instructions to stay silent, never attach the remote audio element, and route
`turn.done` into the composer instead of into the meta agent. Free, and reuses all the
plumbing.

It is not recommended: a WebRTC dial costs ~1–2s before the first word (or we keep a call
warm and burn subscription quota while idle), the model is a conversational one being told
not to converse, and we would be depending on a private endpoint for a core input path. Nice
fallback if the budget ever needs to be exactly zero.

## (2) The option we can actually use today: OpenRouter `/audio/transcriptions`

OpenRouter added a transcription endpoint that takes the same Bearer key as chat, and we
have that key. Tested end to end — 15s of jargon-heavy speech, encoded as Opus in WebM
(*exactly* what `MediaRecorder` produces on Android Chrome, so no client-side transcoding):

Reference: *"In pi-super, rebase the tmux ribbon commit onto main, run npm run build, then
restart the systemd user unit. Also grep the dist directory for stale WebRTC SDP handling."*

| model | latency | cost/clip | errors |
| --- | --- | --- | --- |
| `openai/gpt-4o-transcribe` | 1.3s | $0.0008 | **none — perfect, including `pi-super`** |
| `openai/gpt-4o-mini-transcribe` | 1.0s | $0.0004 | `piSuper` |
| `openai/whisper-large-v3` (Groq) | 0.9s | $0.0004 | `PI Super` |
| `qwen/qwen3-asr-flash` | 1.5s | $0.0005 | `Pi Super`, `TMUX` |
| `mistralai/voxtral-mini-transcribe` | 0.7s | $0.0008 | `PySuper`, `TMUX` |
| `deepgram/nova-3` | 0.9s | $0.0011 | `PY super`, `TMUX` |
| `openai/whisper-1` | 1.0s | $0.0016 | `PySuper`, `tmux-ribbon-commit` |

At roughly a tenth of a cent per prompt, cost is not a design input. Latency is: ~1s after
you stop talking is fine for a hold-to-talk button, and everything here clears that.

Contract (`POST https://openrouter.ai/api/v1/audio/transcriptions`, JSON):
`model`, `input_audio: { data: <raw base64, not a data: URI>, format: "webm"|"m4a"|"wav"|… }`,
optional `language`. Response is `{ text, usage: { seconds, cost } }`. Limits: 60s upstream
timeout, 25 MB, no streaming and no audio URLs. Fine for push-to-talk clips, useless for a
live-caption feel.

### Vocabulary biasing is the real win over Gboard

Top-level `prompt` is ignored, but `provider.options.openai.prompt` (and `.groq.prompt`) is
forwarded, and it works — same audio, same model:

```
whisper-1, no prompt : "In PySuper, rebase the tmux-ribbon-commit onto main, …"
whisper-1, + prompt  : "In pi-super, rebase the tmux-ribbon commit onto main, …"
```

We can build that prompt server-side from things we already have: the tmux window names, the
current pane's recent output, the session's cwd. That is a hint Gboard structurally cannot
have, and it is what makes this *better* rather than merely *different*.

## (3) The browser's own Web Speech API

Already in the tree — `voice.ts`'s `local` provider uses `webkitSpeechRecognition` when the
server has no realtime credential. Pointing it at the composer instead of at the meta agent
is ~30 lines.

But on Android it delegates to the same Google speech service Gboard uses, so it is unlikely
to fix the complaint; `continuous` has been unreliable there for a decade (we already
restart it in `onend`); and there is no way to bias vocabulary. Worth keeping strictly as the
no-credential fallback, not as the answer.

## Recommendation

Ship a **hold-to-talk mic button in the composer, recording with `MediaRecorder` and
transcribing through OpenRouter `gpt-4o-transcribe`**, with a server-built vocabulary prompt
from the live tmux context. Fall back to the Web Speech API when no STT credential is
configured, and leave the realtime-session path documented above as the upgrade if an
`OPENAI_API_KEY` ever appears.

### Integration sketch

**Client** (`src/client/dictate.ts`, new; ~120 lines)

- `<button id="btn-mic">🎤</button>` in `#composer`, left of `#btn-insert`. The composer,
  not the ribbon: the ribbon is hidden in the meta view, and dictating at super is the case
  that matters most.
- Tap to start, tap to stop (not `pointerdown`/`up`: a long press fights the browser's own
  touch handling, and prompts run long). Button goes red with an elapsed counter; hard cap
  around 2 minutes.
- `getUserMedia({ audio: { echoCancellation, noiseSuppression, autoGainControl } })`, then
  `MediaRecorder` with the first supported of `audio/webm;codecs=opus` → `audio/mp4`
  (iOS Safari; send it as format `m4a`). Stop the tracks afterwards — a live mic indicator
  that never goes away is alarming on a phone.
- POST the blob to `/api/stt`, insert `text` at the cursor exactly like `upload()` does,
  `autogrow()`, refresh the `draft` in localStorage. **Never auto-send**: the whole point is
  that the user proofreads the jargon.
- Disable the button while a voice call is live (one mic, and the call already owns it).

**Server** (`POST /api/stt` in `server.ts`, logic in a new `src/server/stt.ts`)

- `originAllowed` + `readBody` with a ~10 MB cap, same as `/api/upload`.
- Credential from `OPENROUTER_API_KEY`, else `openrouter.key` in pi's `auth.json` — mirror
  `readCodexAuth()`, which already establishes that precedent.
- Model from `PI_SUPER_STT_MODEL`, default `openai/gpt-4o-transcribe`.
- Build `provider.options.{openai,groq}.prompt` from the target window's name and a short
  `tmux.capture()` tail, plus a static core vocabulary. Cap it hard — it is a hint, not
  context, and a huge one costs latency.
- Return `{ text, cost }`; log the cost, since this is the first thing in pi-super that
  spends money per action.
- Advertise availability in `GET /api/voice/config` (or a sibling `GET /api/stt/config`) so
  the client can hide the button rather than fail on tap.

**Privacy**: audio would leave the machine for OpenRouter, which load-balances across
providers. That is a step beyond the current state, where the only outbound audio is a voice
call the user explicitly dials. Worth a line in the README and, if it bites, a
`PI_SUPER_STT_PROVIDER=none` opt-out.
