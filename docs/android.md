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
  the call-specific niceties do not happen. The page is told which of the two it got.
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
`disconnect` (a hang-up that came from the car, the headset or the notification) and
`audioRoute`.

The bridge is `WebViewCompat.addWebMessageListener` scoped to the configured origin, not
`addJavascriptInterface`, which is injected into every frame with no way to tell who called.

## Building and installing

```sh
npm run build:android          # or: cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Needs a JDK 17+ and an Android SDK; point `android/local.properties` at it
(`sdk.dir=/path/to/android-sdk`). A bare command-line SDK is enough:

```sh
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

`assembleRelease` signs with the debug key on purpose: this is a sideloaded app for one
person, not a Play listing.

On first launch, paste the URL pi-super printed, token and all. The app remembers it; the
launcher shortcut ("Change server") gets back to that screen.

### https, and why voice needs it

`getUserMedia` needs a secure origin — in WebView exactly as in Chrome. Over plain http
the terminal and chat work fine and voice mode cannot start. Put a TLS proxy or
`tailscale serve` in front, as the README suggests.

Private CAs are honoured (system + user trust anchors), and if the certificate still does
not validate the app shows its SHA-256 once and pins that exact certificate if you accept
it — rather than the usual `handler.proceed()`, which accepts anything forever.

## Testing

* `node tests/native-call.test.mjs` (part of `npm test`) — the bridge contract, both
  directions, with a fake `window.PiNative`. Catches the failure mode where a message name
  drifts and voice mode quietly goes back to media audio.
* `node tests/android-call.mjs` — boots a headless emulator, installs the APK, drives the
  bridge from a throwaway page and then asks the *system*: `dumpsys telecom` for a real
  self-managed call, `dumpsys activity services` for the foreground service, `dumpsys
  audio` for the audio mode. Needs an SDK with a system image and KVM; skips otherwise.

**What no test here can tell us**, and what therefore needs an actual phone with an actual
headset: whether WebView's WebRTC audio follows the Telecom route onto HFP. Chromium's
Android audio path does use communication mode and `setCommunicationDevice()`, and being
in our own process is what makes that route ours to own — but WebView is a separately
updated component and this is the one claim in the design that only a car kit can confirm.
If it ever turns out false, the fallback is to move the peer connection into native
libwebrtc and keep the WebView for the UI.
