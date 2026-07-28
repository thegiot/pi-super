package dev.pasky.pisuper

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
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
	/** Telecom is asynchronous and may simply never call us back; don't hang the call on it */
	private const val TELECOM_TIMEOUT_MS = 4000L

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
			// a redial without a hang-up (voice.ts reconnects in place); keep the call we have
			callId = id
			emitReady()
			return
		}
		muted = false
		callId = id
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
		val t = Runnable {
			if (pendingId != null && connection == null) {
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
	fun setRoute(route: String) {
		val conn = connection ?: return
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

	fun onConnectionCreated(conn: PiConnection) {
		clearTimeout()
		val id = pendingId ?: callId
		pendingId = null
		callId = id
		connection = conn
		mode = Mode.TELECOM
		appContext?.let { CallService.start(it, phoneCall = true) }
		emitReady()
	}

	fun onConnectionFailed(reason: String) {
		clearTimeout()
		pendingId = null
		if (connection != null) return
		appContext?.let { startAudioFocus(it, reason) }
	}

	/** Hang-up that did not come from the page: headset button, car, notification, system. */
	fun onRemoteHangup() {
		if (!active && callId == null) return
		connection = null
		clearTimeout()
		pendingId = null
		callId = null
		releaseAudioFocus()
		mode = Mode.NONE
		appContext?.let { CallService.stop(it) }
		emit(JSONObject().put("type", "disconnect"))
	}

	fun onAudioStateChanged(state: CallAudioState) {
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
				.put("route", current)
				.put("routes", routes)
				.put("muted", state.isMuted),
		)
	}

	// --------------------------------------------------------------------- fallback

	private fun startAudioFocus(ctx: Context, why: String) {
		if (callId == null) return // hung up while we were negotiating
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
				// call the user can no longer hear.
				if (change == AudioManager.AUDIOFOCUS_LOSS) onRemoteHangup()
			}
			.build()
		focusRequest = req
		am.requestAudioFocus(req)
		savedAudioMode = am.mode
		am.mode = AudioManager.MODE_IN_COMMUNICATION
		mode = Mode.AUDIO_FOCUS
		CallService.start(ctx, phoneCall = false)
		emitReady(fallbackReason = why)
	}

	private fun releaseAudioFocus() {
		val am = appContext?.getSystemService(AudioManager::class.java) ?: return
		focusRequest?.let {
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
