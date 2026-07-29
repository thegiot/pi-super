package dev.pasky.pisuper

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Ongoing-call notification plus the foreground promotion that keeps the WebView's
 * microphone alive with the screen off. Telecom does not do this for us: a self-managed
 * app owns its own call UI.
 */
class CallService : Service() {
	override fun onBind(intent: Intent?): IBinder? = null

	private fun granted(perm: String) = checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		when (intent?.action) {
			ACTION_HANGUP -> {
				CallHub.onRemoteHangup()
				stopSelf()
				return START_NOT_STICKY
			}
		}
		val phoneCall = intent?.getBooleanExtra(EXTRA_PHONE_CALL, false) ?: false
		val muted = intent?.getBooleanExtra(EXTRA_MUTED, false) ?: false
		var type = 0
		if (Build.VERSION.SDK_INT >= 30) {
			// Each type has to be *earned*: on API 34+ promoting with `microphone` while
			// RECORD_AUDIO is denied throws, and `phoneCall` needs MANAGE_OWN_CALLS plus an
			// actual self-managed call. Ask only for what we can back up.
			if (granted(Manifest.permission.RECORD_AUDIO)) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
			if (phoneCall && granted(Manifest.permission.MANAGE_OWN_CALLS)) {
				type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
			}
		}
		// startForegroundService() obliges us to promote within seconds or be killed with
		// ForegroundServiceDidNotStartInTimeException, so we always try, even with no type to
		// declare (which is itself fatal on API 34+ — hence the catch, and the guard in start()
		// that keeps us from getting here in the first place).
		try {
			ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(muted), type)
		} catch (e: Exception) {
			// An OEM or a background-start restriction refusing the promotion must not take
			// the call down with it: the call keeps working, as killable as a browser tab.
			Log.w("PiSuperCall", "startForeground failed", e)
			stopSelf()
		}
		return START_NOT_STICKY
	}

	private fun notification(muted: Boolean): Notification {
		val nm = getSystemService(NotificationManager::class.java)
		if (nm.getNotificationChannel(CHANNEL) == null) {
			nm.createNotificationChannel(
				NotificationChannel(CHANNEL, getString(R.string.call_channel), NotificationManager.IMPORTANCE_LOW).apply {
					setShowBadge(false)
					setSound(null, null)
				},
			)
		}
		val open = PendingIntent.getActivity(
			this,
			0,
			Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
			PendingIntent.FLAG_IMMUTABLE,
		)
		val hangup = PendingIntent.getService(
			this,
			1,
			Intent(this, CallService::class.java).setAction(ACTION_HANGUP),
			PendingIntent.FLAG_IMMUTABLE,
		)
		return NotificationCompat.Builder(this, CHANNEL)
			.setSmallIcon(R.drawable.ic_call)
			.setContentTitle(getString(R.string.call_ongoing))
			.setContentText(if (muted) "muted" else null)
			.setCategory(NotificationCompat.CATEGORY_CALL)
			.setOngoing(true)
			.setContentIntent(open)
			.addAction(R.drawable.ic_call, getString(R.string.call_hangup), hangup)
			.build()
	}

	companion object {
		private const val CHANNEL = "voice-call"
		private const val NOTIFICATION_ID = 42
		private const val ACTION_HANGUP = "dev.pasky.pisuper.HANGUP"
		private const val EXTRA_PHONE_CALL = "phoneCall"
		private const val EXTRA_MUTED = "muted"

		fun start(ctx: Context, phoneCall: Boolean) {
			// Do not start what cannot be promoted. On API 34+ a service whose declared types
			// are all unbacked by permissions cannot go foreground at all, and one started with
			// startForegroundService() that fails to is killed with an exception.
			if (!canPromote(ctx, phoneCall)) {
				Log.i("PiSuperCall", "no permission for a foreground service; the call is unprotected")
				return
			}
			val i = Intent(ctx, CallService::class.java).putExtra(EXTRA_PHONE_CALL, phoneCall)
			startQuietly(ctx, i)
		}

		/**
		 * A refused start (ForegroundServiceStartNotAllowedException when the app has since
		 * gone to the background, or an OEM's own restriction) is a worse notification, not a
		 * worse call. It must never be the thing that crashes us.
		 */
		private fun startQuietly(ctx: Context, i: Intent) {
			try {
				ctx.startForegroundService(i)
			} catch (e: Exception) {
				Log.w("PiSuperCall", "could not start the call service", e)
			}
		}

		private fun canPromote(ctx: Context, phoneCall: Boolean): Boolean {
			if (Build.VERSION.SDK_INT < 30) return true
			val has = { p: String -> ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED }
			return has(Manifest.permission.RECORD_AUDIO) || (phoneCall && has(Manifest.permission.MANAGE_OWN_CALLS))
		}

		fun refresh(ctx: Context, muted: Boolean) {
			if (!CallHub.active || !canPromote(ctx, CallHub.telecomMode)) return
			val i = Intent(ctx, CallService::class.java)
				.putExtra(EXTRA_PHONE_CALL, CallHub.telecomMode)
				.putExtra(EXTRA_MUTED, muted)
			startQuietly(ctx, i)
		}

		fun stop(ctx: Context) {
			ctx.stopService(Intent(ctx, CallService::class.java))
		}
	}
}
