package dev.pasky.pisuper

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.CallAudioState
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * The one place that knows whether a call is up, and in what shape.
 *
 * A process-wide singleton because the three parties involved live in three different
 * Android components with no reference to each other: the WebView bridge (activity), the
 * [PiConnectionService] the system instantiates on its own, and the foreground service
 * that carries the notification. Telecom hands us a Connection through a callback, so
 * there is no way to thread this state along a call stack.
 *
 * Two modes, deliberately mutually exclusive:
 *  - TELECOM     — a self-managed [android.telecom.Connection]. The system then owns audio
 *                  mode and routing, other apps' media is paused for a *call* rather than
 *                  ducked, headset/car hang-up buttons reach us, and a cellular call
 *                  interrupts us properly. We must not touch AudioManager ourselves here:
 *                  mixing Telecom routing with setCommunicationDevice() breaks the route.
 *  - AUDIO_FOCUS — the fallback for when Telecom refuses (an emergency call is up, an OEM
 *                  denies self-managed accounts, MANAGE_OWN_CALLS missing). We take
 *                  exclusive voice-communication focus and MODE_IN_COMMUNICATION by hand.
 *                  Media still stops; the call-specific niceties do not happen.
 */
object CallHub {
	private const val TAG = "PiSuperCall"
	private const val ACCOUNT_ID = "pi-super-voice"
	/**
	 * Telecom is asynchronous and may simply never call us back; don't hang the call on it.
	 * Must stay comfortably under the page's own watchdog (native-call.ts), or the page
	 * opens the microphone before either mode has claimed the audio route — which is the
	 * one ordering this whole app exists to get right.
	 */
	private const val TELECOM_TIMEOUT_MS = 2500L

	/** the extra we tag a placeCall with, to recognise our own callback later */
	private const val EXTRA_ATTEMPT = "dev.pasky.pisuper.ATTEMPT"

	enum class Mode { NONE, TELECOM, AUDIO_FOCUS }

	/** JSON events destined for the page; set by the activity while the WebView lives */
	@Volatile
	var listener: ((JSONObject) -> Unit)? = null

	private val main = Handler(Looper.getMainLooper())

	private var appContext: Context? = null
	private var mode = Mode.NONE
	private var callId: String? = null
	private var connection: PiConnection? = null
	private var focusRequest: AudioFocusRequest? = null
	private var savedAudioMode = AudioManager.MODE_NORMAL
	private var pendingId: String? = null
	private var timeout: Runnable? = null
	private var muted = false
	/**
	 * Whether we have already had our one say about where the audio goes. Telecom starts a
	 * call on the earpiece — right for a phone held to your head, wrong for an assistant you
	 * are talking to across a room. We move it to the speaker once, and then never again, so
	 * a user (or a car kit) who picks something else keeps it.
	 */
	private var routed = false
	/**
	 * Bumped by every dial and every hang-up. `placeCall` cannot be cancelled, so the only
	 * way to tell our own callback from the ghost of a call the user already hung up on is
	 * to tag the request and compare on the way back.
	 */
	private var attempt = 0

	val active: Boolean
		get() = mode != Mode.NONE

	val telecomMode: Boolean
		get() = mode == Mode.TELECOM

	fun handle(ctx: Context): PhoneAccountHandle =
		PhoneAccountHandle(ComponentName(ctx.applicationContext, PiConnectionService::class.java), ACCOUNT_ID)

	/**
	 * Register the self-managed phone account. Idempotent and cheap; Telecom keeps the
	 * registration across reboots, but re-registering costs nothing and survives the user
	 * clearing app data.
	 */
	fun registerAccount(ctx: Context) {
		if (!hasPermission(ctx, Manifest.permission.MANAGE_OWN_CALLS)) return
		val telecom = ctx.getSystemService(TelecomManager::class.java) ?: return
		val account = PhoneAccount.builder(handle(ctx), ctx.getString(R.string.app_name))
			.setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
			.addSupportedUriScheme("sip")
			.setShortDescription(ctx.getString(R.string.call_ongoing))
			.build()
		try {
			telecom.registerPhoneAccount(account)
		} catch (e: Exception) {
			Log.w(TAG, "registerPhoneAccount failed", e)
		}
	}

	// ------------------------------------------------------------------ from the page

	/** "The user pressed dial." Answers asynchronously with a `callReady` event. */
	fun startCall(ctx: Context, id: String) {
		val app = ctx.applicationContext
		appContext = app
		if (active) {
			// A redial without a hang-up (voice.ts reconnects in place): keep the call we have,
			// under the id it already has — renaming it would let a stale document take it over.
			emitReady()
			return
		}
		muted = false
		routed = false
		callId = id
		attempt++
		if (tryTelecom(app, id)) return
		startAudioFocus(app, "telecom unavailable")
	}

	private fun tryTelecom(ctx: Context, id: String): Boolean {
		if (!hasPermission(ctx, Manifest.permission.MANAGE_OWN_CALLS)) return false
		val telecom = ctx.getSystemService(TelecomManager::class.java) ?: return false
		registerAccount(ctx)
		val handle = handle(ctx)
		try {
			if (!telecom.isOutgoingCallPermitted(handle)) return false
			val extras = Bundle().apply {
				putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
				putBoolean(TelecomManager.EXTRA_START_CALL_WITH_SPEAKERPHONE, false)
				putBundle(
					TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS,
					Bundle().apply { putInt(EXTRA_ATTEMPT, attempt) },
				)
			}
			pendingId = id
			// Not a real address; Telecom needs *some* handle and shows it in car/watch UIs.
			telecom.placeCall(Uri.fromParts("sip", "super@pi-super", null), extras)
		} catch (e: SecurityException) {
			Log.w(TAG, "placeCall denied", e)
			pendingId = null
			return false
		} catch (e: Exception) {
			Log.w(TAG, "placeCall failed", e)
			pendingId = null
			return false
		}
		// placeCall() returning is not admission: onCreateOutgoingConnection may never come.
		val mine = attempt
		val t = Runnable {
			if (mine == attempt && pendingId != null && connection == null) {
				pendingId = null
				appContext?.let { startAudioFocus(it, "telecom did not answer") }
			}
		}
		timeout = t
		main.postDelayed(t, TELECOM_TIMEOUT_MS)
		return true
	}

	/** The page's WebRTC is up: promote the Telecom call from dialing to active. */
	fun markActive(id: String) {
		if (callId != id) return
		connection?.setActive()
	}

	/** The page hung up. */
	fun endCall(id: String?) {
		if (id != null && callId != null && id != callId) return
		val hadConnection = connection
		clearTimeout()
		attempt++ // any Telecom callback still in flight is now a ghost
		pendingId = null
		callId = null
		connection = null
		hadConnection?.finish(DisconnectCause.LOCAL)
		releaseAudioFocus()
		mode = Mode.NONE
		muted = false
		appContext?.let { CallService.stop(it) }
	}

	/**
	 * The page muted/unmuted its own mic track. There is no public API for a self-managed
	 * app to push mute into Telecom (only an InCallService can), so this is bookkeeping for
	 * the notification — the mute the *system* knows about arrives the other way round, in
	 * [onAudioStateChanged].
	 */
	fun setMuted(id: String, value: Boolean) {
		if (callId != id) return
		muted = value
		appContext?.let { CallService.refresh(it, muted) }
	}

	/** speaker | earpiece | bluetooth | wired — best effort, Telecom mode only. */
	@Suppress("DEPRECATION") // setAudioRoute: see PiConnection.onCallAudioStateChanged
	fun setRoute(id: String, route: String) {
		if (callId != id) return
		// The user has now had their say; stop second-guessing the route (see `routed`).
		routed = true
		val conn = connection ?: run {
			if (mode == Mode.AUDIO_FOCUS) setRouteWithoutTelecom(route)
			return
		}
		val target = when (route) {
			"speaker" -> CallAudioState.ROUTE_SPEAKER
			"earpiece" -> CallAudioState.ROUTE_EARPIECE
			"bluetooth" -> CallAudioState.ROUTE_BLUETOOTH
			"wired" -> CallAudioState.ROUTE_WIRED_HEADSET
			else -> return
		}
		conn.setAudioRoute(target)
	}

	// ------------------------------------------------------------- from the framework

	/**
	 * Telecom admitted a call. Possibly not *the* call: placeCall cannot be cancelled, so
	 * this may be the ghost of an attempt the user already hung up on, or one that timed
	 * out into the audio-focus fallback. Either way it must be destroyed, not adopted — the
	 * two modes may never be live at once.
	 */
	fun onConnectionCreated(conn: PiConnection) {
		if (conn.attempt != attempt || callId == null || mode == Mode.AUDIO_FOCUS) {
			Log.i(TAG, "discarding a stale telecom connection (attempt ${conn.attempt}, ours $attempt)")
			conn.finish(DisconnectCause.CANCELED)
			return
		}
		clearTimeout()
		pendingId = null
		connection = conn
		mode = Mode.TELECOM
		appContext?.let { CallService.start(it, phoneCall = true) }
		emitReady()
	}

	fun onConnectionFailed(attemptOf: Int, reason: String) {
		if (attemptOf != attempt || callId == null) return
		clearTimeout()
		pendingId = null
		if (connection != null) return
		// A late failure for an attempt that has already fallen back must not fall back twice:
		// the second focus request would orphan the first and lose the saved audio mode.
		if (mode != Mode.NONE) return
		appContext?.let { startAudioFocus(it, reason) }
	}

	/**
	 * Hang-up that did not come from the page: headset button, car, notification, system.
	 * [from] is the connection that is telling us, if any — Telecom is already tearing that
	 * one down, but a hang-up from our own notification has to finish it by hand or the call
	 * outlives its own UI. [reason] is shown to the user when we can say something useful
	 * about why their call went away.
	 */
	fun onRemoteHangup(from: PiConnection? = null, reason: String? = null) {
		// A callback from a connection we have already let go of is the ghost of an old call;
		// acting on it would hang up the one that replaced it.
		if (from != null && from !== connection) {
			Log.i(TAG, "ignoring a hang-up from a stale connection")
			return
		}
		if (!active && callId == null) return
		val hadConnection = connection
		val id = callId
		connection = null
		clearTimeout()
		attempt++
		pendingId = null
		callId = null
		if (hadConnection != null && hadConnection !== from) hadConnection.finish(DisconnectCause.LOCAL)
		releaseAudioFocus()
		mode = Mode.NONE
		muted = false
		appContext?.let { CallService.stop(it) }
		val ev = JSONObject().put("type", "disconnect").put("callId", id)
		if (reason != null) ev.put("reason", reason)
		emit(ev)
	}

	fun onAudioStateChanged(from: PiConnection, state: CallAudioState) {
		if (from !== connection) return
		preferSpeaker(from, state)
		val routes = JSONArray()
		val mask = state.supportedRouteMask
		if (mask and CallAudioState.ROUTE_EARPIECE != 0) routes.put("earpiece")
		if (mask and CallAudioState.ROUTE_SPEAKER != 0) routes.put("speaker")
		if (mask and CallAudioState.ROUTE_BLUETOOTH != 0) routes.put("bluetooth")
		if (mask and CallAudioState.ROUTE_WIRED_HEADSET != 0) routes.put("wired")
		val current = when (state.route) {
			CallAudioState.ROUTE_EARPIECE -> "earpiece"
			CallAudioState.ROUTE_SPEAKER -> "speaker"
			CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
			CallAudioState.ROUTE_WIRED_HEADSET -> "wired"
			else -> "unknown"
		}
		emit(
			JSONObject()
				.put("type", "audioRoute")
				.put("callId", callId)
				.put("route", current)
				.put("routes", routes)
				.put("muted", state.isMuted),
		)
	}

	/**
	 * Hands-free by default, but never over a headset. A route that is already bluetooth or
	 * wired is the user's own choice of ear, and speaker would be the rude answer.
	 */
	@Suppress("DEPRECATION") // setAudioRoute: see PiConnection.onCallAudioStateChanged
	private fun preferSpeaker(conn: PiConnection, state: CallAudioState) {
		if (routed) return
		routed = true
		if (state.route != CallAudioState.ROUTE_EARPIECE) return
		if (state.supportedRouteMask and CallAudioState.ROUTE_SPEAKER == 0) return
		conn.setAudioRoute(CallAudioState.ROUTE_SPEAKER)
	}

	// --------------------------------------------------------------------- fallback

	private fun startAudioFocus(ctx: Context, why: String) {
		if (callId == null) return // hung up while we were negotiating
		if (mode != Mode.NONE) return // already in one mode or the other; never both
		val mine = attempt
		val am = ctx.getSystemService(AudioManager::class.java)
		if (am == null) {
			emitReady(fallbackReason = why)
			return
		}
		val attrs = AudioAttributes.Builder()
			.setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
			.setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
			.build()
		// EXCLUSIVE: a call is not something to duck music under, the music should stop.
		val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
			.setAudioAttributes(attrs)
			.setOnAudioFocusChangeListener { change ->
				// Losing focus for good means something took the audio away from us (a real
				// phone call, another VoIP app). Report it as a hang-up rather than sit on a
				// call the user can no longer hear — but only for the call that requested it:
				// a loss queued for an abandoned attempt must not stop its successor.
				if (change == AudioManager.AUDIOFOCUS_LOSS && mine == attempt) {
					onRemoteHangup(reason = "another app took the audio")
				}
			}
			.build()
		// Focus can be refused, and the likely reason is the one that made Telecom refuse too:
		// somebody else's call has the audio. Then MODE_IN_COMMUNICATION and a route of our
		// choosing would be us reaching into *their* call, so we take neither and say so. The
		// call still comes up — as plain media audio, which is what a browser gives us anyway.
		val granted = am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
		if (granted) {
			focusRequest = req
			savedAudioMode = am.mode
			am.mode = AudioManager.MODE_IN_COMMUNICATION
			preferSpeakerWithoutTelecom(am)
		} else {
			Log.w(TAG, "audio focus refused ($why)")
		}
		mode = Mode.AUDIO_FOCUS
		CallService.start(ctx, phoneCall = false)
		emitReady(fallbackReason = if (granted) why else "$why; audio focus refused, media audio")
	}

	private fun setRouteWithoutTelecom(route: String) {
		val am = appContext?.getSystemService(AudioManager::class.java) ?: return
		try {
			if (Build.VERSION.SDK_INT >= 31) {
				val wanted = when (route) {
					"speaker" -> AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
					"earpiece" -> AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
					"bluetooth" -> AudioDeviceInfo.TYPE_BLUETOOTH_SCO
					"wired" -> AudioDeviceInfo.TYPE_WIRED_HEADSET
					else -> return
				}
				am.availableCommunicationDevices.firstOrNull { it.type == wanted }?.let { am.setCommunicationDevice(it) }
			} else {
				setLegacyRoute(am, route)
			}
			emitFallbackRoute(am)
		} catch (e: Exception) {
			Log.w(TAG, "could not set the route", e)
		}
	}

	/**
	 * The same thing before API 31, where routing a communication stream meant three
	 * independent switches rather than one device to pick. A wired headset is not one of
	 * them: the platform routes to it whenever it is plugged in and nothing louder is
	 * demanded, so "wired" here just means "stop asking for the others".
	 */
	@Suppress("DEPRECATION") // the pre-31 API is the only API there is on those devices
	private fun setLegacyRoute(am: AudioManager, route: String) {
		if (route == "bluetooth") {
			am.isSpeakerphoneOn = false
			am.startBluetoothSco()
			am.isBluetoothScoOn = true
			return
		}
		if (am.isBluetoothScoOn || am.isSpeakerphoneOn) {
			am.isBluetoothScoOn = false
			am.stopBluetoothSco()
		}
		am.isSpeakerphoneOn = route == "speaker"
	}

	/**
	 * TYPE_BLE_HEADSET is an API 31 constant, but it is only ever compared against a type an
	 * older device cannot report, so the inlined value is harmless there.
	 */
	@Suppress("InlinedApi")
	private fun routeName(type: Int): String = when (type) {
		AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
		AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
		AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
		AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
		else -> "other"
	}

	/** The routes this device could send call audio to, named as the page names them. */
	@Suppress("DEPRECATION")
	private fun availableRoutes(am: AudioManager): List<String> {
		val types = if (Build.VERSION.SDK_INT >= 31) {
			am.availableCommunicationDevices.map { it.type }
		} else {
			am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }
		}
		return types.map { routeName(it) }.filter { it != "other" }.distinct()
	}

	/** Where the audio is going right now, as best as this API level can tell us. */
	@Suppress("DEPRECATION")
	private fun currentRoute(am: AudioManager): String {
		if (Build.VERSION.SDK_INT >= 31) return am.communicationDevice?.let { routeName(it.type) } ?: "unknown"
		if (am.isSpeakerphoneOn) return "speaker"
		if (am.isBluetoothScoOn) return "bluetooth"
		val routes = availableRoutes(am)
		// Below 31 nothing reports the active output; a plugged-in headset takes it implicitly.
		return if (routes.contains("wired")) "wired" else if (routes.contains("earpiece")) "earpiece" else "unknown"
	}

	/** Fallback mode has no CallAudioState, so the page is told what we can see instead. */
	private fun emitFallbackRoute(am: AudioManager) {
		try {
			val routes = JSONArray()
			for (r in availableRoutes(am)) routes.put(r)
			emit(
				JSONObject()
					.put("type", "audioRoute")
					.put("callId", callId)
					.put("route", currentRoute(am))
					.put("routes", routes)
					.put("muted", muted),
			)
		} catch (e: Exception) {
			Log.w(TAG, "could not report the route", e)
		}
	}

	/** The same hands-free default in fallback mode, where there is no Telecom to ask. */
	private fun preferSpeakerWithoutTelecom(am: AudioManager) {
		try {
			// a headset of any kind wins; we only override the earpiece
			val routes = availableRoutes(am)
			if (!routes.contains("bluetooth") && !routes.contains("wired")) setRouteWithoutTelecom("speaker")
			else emitFallbackRoute(am)
		} catch (e: Exception) {
			Log.w(TAG, "could not choose the speaker", e)
		}
	}

	@Suppress("DEPRECATION")
	private fun releaseAudioFocus() {
		val am = appContext?.getSystemService(AudioManager::class.java) ?: return
		focusRequest?.let {
			// A communication device stays selected for the lifetime of the *process*, so a call
			// we forget to unpin would still be routing the next app's audio (and ours) hours
			// later. Same for the pre-31 switches, which are equally global.
			try {
				if (Build.VERSION.SDK_INT >= 31) {
					am.clearCommunicationDevice()
				} else {
					am.isBluetoothScoOn = false
					am.stopBluetoothSco()
					am.isSpeakerphoneOn = false
				}
			} catch (e: Exception) {
				Log.w(TAG, "could not release the route", e)
			}
			am.abandonAudioFocusRequest(it)
			am.mode = savedAudioMode
		}
		focusRequest = null
	}

	// ----------------------------------------------------------------------- plumbing

	private fun clearTimeout() {
		timeout?.let { main.removeCallbacks(it) }
		timeout = null
	}

	private fun emitReady(fallbackReason: String? = null) {
		val ev = JSONObject()
			.put("type", "callReady")
			.put("callId", callId)
			.put("mode", if (mode == Mode.TELECOM) "telecom" else "audiofocus")
		if (fallbackReason != null) ev.put("reason", fallbackReason)
		emit(ev)
	}

	private fun emit(ev: JSONObject) {
		val l = listener
		if (l == null) return
		main.post { l(ev) }
	}

	private fun hasPermission(ctx: Context, perm: String): Boolean =
		ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
}
