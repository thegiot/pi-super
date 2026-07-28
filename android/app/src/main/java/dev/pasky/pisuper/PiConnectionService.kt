package dev.pasky.pisuper

import android.net.Uri
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * The self-managed call itself. The system instantiates this service; all it does is
 * mint a [PiConnection] and hand it to [CallHub], which is what the rest of the app talks
 * to.
 */
class PiConnectionService : ConnectionService() {
	override fun onCreateOutgoingConnection(
		account: PhoneAccountHandle?,
		request: ConnectionRequest?,
	): Connection {
		val conn = PiConnection()
		conn.setAddress(request?.address ?: Uri.fromParts("sip", "super@pi-super", null), TelecomManager.PRESENTATION_ALLOWED)
		conn.setCallerDisplayName(getString(R.string.app_name), TelecomManager.PRESENTATION_ALLOWED)
		conn.setDialing()
		CallHub.onConnectionCreated(conn)
		return conn
	}

	override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
		CallHub.onConnectionFailed("telecom refused the call")
	}
}

class PiConnection : Connection() {
	init {
		connectionProperties = PROPERTY_SELF_MANAGED
		// No CAPABILITY_HOLD: the realtime session cannot actually be held, and claiming
		// otherwise gets us put on hold by a car kit with nothing on the other end.
		connectionCapabilities = 0
		audioModeIsVoip = true
	}

	override fun onDisconnect() {
		CallHub.onRemoteHangup()
		finish(DisconnectCause.LOCAL)
	}

	override fun onAbort() {
		CallHub.onRemoteHangup()
		finish(DisconnectCause.CANCELED)
	}

	override fun onReject() {
		CallHub.onRemoteHangup()
		finish(DisconnectCause.REJECTED)
	}

	// Deprecated in API 34 in favour of onCallEndpointChanged, but still delivered, and it
	// is the only version that exists back to API 26. Migrating means carrying both.
	@Deprecated("CallAudioState is superseded by CallEndpoint on API 34+")
	@Suppress("DEPRECATION")
	override fun onCallAudioStateChanged(state: CallAudioState?) {
		state?.let { CallHub.onAudioStateChanged(it) }
	}

	fun finish(cause: Int) {
		setDisconnected(DisconnectCause(cause))
		destroy()
	}
}
