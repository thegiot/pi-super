# The Android app — voice mode as an actual phone call

The PWA is the product; this app exists for one reason. In Chrome, voice mode is *media*:
a car kit plays it over A2DP with the microphone still on the phone, your music ducks
instead of stopping, the headset's call button does nothing, and Android is free to treat
the tab as a background page the moment the screen goes off. None of that is fixable from
JavaScript — there is no web API for "this is a call".

So `android/` is a **thin wrapper**: the same PWA, loaded from the same server into a
WebView, with a native call layer around it. No part of the web app is reimplemented, and
the app has no server of its own — point it at the URL pi-super prints and it is the app
you already had, plus a call.

## Why a wrapper and not a companion app

The other obvious shape is a tiny app the PWA launches by intent when a call starts, with
the web app staying in Chrome. It cannot work, and the reason is worth writing down so
nobody tries it twice:

**Audio routing on Android is per-UID.** `AudioAttributes`, audio focus,
`setCommunicationDevice()`, `MODE_IN_COMMUNICATION` and a Telecom `Connection` all describe
*your own process's* streams. A companion app can hold a call, pause everyone's music and
own the Bluetooth headset — and Chrome's WebRTC audio still comes out of a different UID as
media, with the phone's own microphone. There is no API to donate your call's audio session
to another app, and the framework explicitly resolves communication-route ownership by UID.
A companion could fake the *notification* of a call; it could not make it *be* one.

Once the web app has to live in the same process as the call, a WebView wrapper is the
minimal thing that works. (A Trusted Web Activity does not help: the content is still
rendered by the browser, in the browser's process.)

## What the app adds

* A **self-managed Telecom call** (`ConnectionService` with `CAPABILITY_SELF_MANAGED`,
  `MANAGE_OWN_CALLS`) that opens when voice mode dials and closes when it hangs up. This
  is what makes the system route the audio as a call: HFP/SCO to a headset or car kit,
  other apps' media *stopped* rather than ducked, the call visible to Android Auto and
  watches, and the headset/car hang-up button arriving as `Connection.onDisconnect`.
* A **fallback to plain audio focus** (`AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` with
  `USAGE_VOICE_COMMUNICATION`, plus `MODE_IN_COMMUNICATION`) for when Telecom refuses —
  an emergency call is up, an OEM does not allow self-managed accounts. Media still stops;
  the call-specific niceties do not happen. The page is told which of the two it got. If
  even the focus request is refused — typically the *same* emergency call that made Telecom
  refuse — the call is reported as hung up rather than forcing `MODE_IN_COMMUNICATION` on
  top of somebody else's, which would take the microphone and talk to nobody.
* **Hands-free by default**: a call starts on the earpiece, which is wrong for an assistant
  across the room, so the route is moved to the speaker exactly once at the start and only
  when it is on the earpiece — a headset is somebody's deliberate choice. After that, and
  after any tap on the call bar's route button (which cycles through the routes the phone
  actually offers), the route is never second-guessed again. Below API 31 the fallback
  drives the pre-`setCommunicationDevice` switches (`setSpeakerphoneOn`, SCO) instead, and
  either way the selection is released on hang-up: it is process-wide, not call-wide.
* A **foreground service** (`phoneCall|microphone`) with an ongoing-call notification and a
  hang-up action, so the microphone survives the screen going off.
* The **microphone permission** flow WebView needs
  (`WebChromeClient.onPermissionRequest` → `RESOURCE_AUDIO_CAPTURE`, granted only for our
  own origin and only for audio).

Everything else — terminal, chat, peek, uploads, passkeys — is the PWA, unchanged.

## The bridge

`src/client/native-call.ts` is the whole web-side surface, and it is a no-op unless the
wrapper injected `window.PiNative`. `voice.ts` calls it unconditionally:

| when | JS → native | why there |
| --- | --- | --- |
| dialling, before `getUserMedia` | `startCall` | the audio route is decided when the mic opens |
| WebRTC up | `markActive` | promotes the call from "dialing" to "active" |
| mute toggled | `setMuted` | keeps the notification honest |
| hang up | `endCall` | a *reconnect* does not: the call spans redials |

and back, as a `pi-native` CustomEvent: `callReady` (with `mode: telecom | audiofocus`),
`disconnect` (a hang-up that came from the car, the headset or the notification, with a
`reason` when there is something to say) and `audioRoute`.

The wrapper also takes **no screen wake lock** — `voice.ts` skips it when the bridge is
there. The foreground service is what keeps the call alive, so the screen is free to time
out, which is the whole point of the call-like treatment.

The bridge is `WebViewCompat.addWebMessageListener` scoped to the configured origin, not
`addJavascriptInterface`, which is injected into every frame with no way to tell who called.

## Building and installing

```sh
npm run build:android          # or: cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

No cable handy: `contrib/serve-apk.sh` serves the APK on this machine's tailnet address for
30 minutes and prints a QR code to scan with the phone.

Needs a JDK 17+ and an Android SDK; point `android/local.properties` at it
(`sdk.dir=/path/to/android-sdk`). A bare command-line SDK is enough:

```sh
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

`assembleRelease` signs with the debug key on purpose: this is a sideloaded app for one
person, not a Play listing.

`versionCode`/`versionName` in `android/app/build.gradle.kts` are kept in step with the npm
package by hand, and a release that changes anything under `android/` should attach the
APK to the GitHub release — otherwise “which build is on the phone” has no answer, and the
only way to get one is to have the SDK installed.

On first launch, give it the URL pi-super printed, token and all — the field prefills from
a share or from the clipboard, because a tailnet hostname plus a token is not something
anyone types on a phone. The app remembers it; the launcher shortcut ("Change server") gets
back to that screen.

### Passkeys: the ceremony happens in a browser

A WebView cannot run pi-super's passkey ceremony, and no amount of configuration fixes it.
In WebView's app mode the passkey belongs to *the app*, so Android first checks that the
app may claim the RP ID — and that check is a **Digital Asset Links lookup performed by
Google's servers**, which fetch `https://<rpID>/.well-known/assetlinks.json` themselves.
A tailnet-only box is not crawlable by Google, so the check can never pass. (Browser mode
would avoid it, but it needs `CREDENTIAL_MANAGER_SET_ORIGIN` and Google's allowlisting of
privileged browsers. Doing the ceremony natively with Credential Manager has exactly the
same problem: same app identity, same asset-link requirement.) So the app does not enable
WebView WebAuthn at all — it would fail every time, with an error that reads like a broken
passkey.

Instead, the sign-in is borrowed from a browser, where an origin is just an origin:

1. The lock screen inside the app offers **Unlock in browser**, which posts `login` over
   the bridge.
2. The app opens `https://…/?handoff=<PKCE challenge>` in the real browser and remembers
   the verifier **on disk** — Android routinely kills the app while a browser is in front
   of it (the emulator test caught exactly that), and the stored verifier expires in ten
   minutes.
3. The browser shows an explicit **“Sign in the app?”** approval, which costs a passkey
   assertion *there and then*, and only then mints a one-time code and navigates to
   `pi-super://handoff?code=…`.
4. The app POSTs it to `/api/auth/handoff/redeem` **as a navigation inside the WebView**,
   which is the only way a `Set-Cookie` can land in the WebView's own cookie jar (it shares
   nothing with Chrome). A POST, so neither half of the credential is ever in an *HTTP*
   URL, a history entry or a proxy log. The code does travel in the `pi-super://` URL of
   step 3, which is the part PKCE is there to cover: it is one-time, minutes old, and
   worthless to the app that intercepts it without the verifier.

Step 3 is the load-bearing one, and it must never become silent. PKCE stops an eavesdropper
from stealing an honest app's code — it says nothing about *who wrote the challenge*, and on
Android that is whichever app claimed the `pi-super:` scheme. A hostile app can pick its own
verifier and open that URL; the only thing between it and a shell is that exporting a
session costs a deliberate, named, user-verified approval. The server enforces the same
thing from its side: it will not mint a handoff for a session older than three minutes.

Be clear about what that buys: it is **consent, not caller authentication**. Nothing here
tells the browser *which* app asked — a hostile one can reproduce the whole “Unlock in
browser” flow, screen included. The defence is that the user is told, in words, that they
are handing out a shell, at a moment they did not initiate. Binding the code to a verified
caller would need an app-attestation the tailnet cannot serve (the same Digital Asset Links
lookup that keeps passkeys out of the WebView in the first place).

The code is single-use, expires in two minutes, only one lives per challenge (a reloaded
page does not leave a usable sibling behind), and it is refused if the passkey *or the
browser session it came from* was revoked in the meantime. The app gets a session of its
own, so logging it out does not log the browser out.

Enrolling a *new* passkey still has to be done in a browser; the app only borrows sessions.

### https, and why voice needs it

`getUserMedia` needs a secure origin — in WebView exactly as in Chrome. Over plain http
the terminal and chat work fine and voice mode cannot start. Put a TLS proxy or
`tailscale serve` in front, as the README suggests.

Private CAs are honoured (system + user trust anchors), and if the certificate still does
not validate the app shows its SHA-256 once and remembers that exact certificate — rather
than the usual `handler.proceed()`, which accepts anything forever. Below Android 10 there
is no way to get the certificate's own bytes out of `SslCertificate`, so nothing can be
remembered there and the question is asked every time. Note that this is an *exception*
list, not pinning: a certificate that validates normally is never checked against it.

Plain http is allowed but the setup screen argues with you first: that URL carries the
token to a page with shell access, so on http anyone on the network can read it and
replace the page.

## Testing

* `node tests/native-call.test.mjs` (part of `npm test`) — the bridge contract, both
  directions, with a fake `window.PiNative`. Catches the failure mode where a message name
  drifts and voice mode quietly goes back to media audio.
* `node tests/android-call.mjs` — boots a headless emulator, installs the APK, drives the
  bridge from a throwaway page and then asks the *system*: `dumpsys telecom` for a real
  self-managed call, `dumpsys activity services` for the foreground service, `dumpsys
  audio` for the audio mode, `dumpsys notification` for the ongoing-call notification. It
  also covers the two ways a call gets orphaned — a page reload and a revoked microphone
  permission (which kills the app) — because both leave a phantom call in the car if the
  native side is not reconciled. Needs an SDK with a system image and KVM; skips otherwise.

**What no test here can tell us**, and what therefore needs an actual phone with an actual
headset: whether WebView's WebRTC audio follows the Telecom route onto HFP. Chromium's
Android audio path does use communication mode and `setCommunicationDevice()`, and being
in our own process is what makes that route ours to own — but WebView is a separately
updated component and this is the one claim in the design that only a car kit can confirm.
If it ever turns out false, the fallback is to move the peer connection into native
libwebrtc and keep the WebView for the UI.
