package dev.pasky.pisuper

import android.content.Context
import android.net.Uri
import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Signing the app in, by borrowing a browser.
 *
 * WebView cannot run the passkey ceremony for pi-super: Android only lets an app use a
 * passkey for an RP ID that *Google* can crawl (`/.well-known/assetlinks.json` is fetched
 * by Google's Digital Asset Links service, not by the phone), and the whole point of this
 * server is that it lives on a tailnet nobody can crawl. Chrome has no such problem — it
 * is a browser, the origin is just an origin.
 *
 * So: open the login page in the browser with a PKCE challenge, let the passkey happen
 * there, and come back over `pi-super://handoff?code=…`. The code is redeemed by a plain
 * navigation inside the WebView, which is the only way a cookie can land in the WebView's
 * own jar — it shares nothing with Chrome.
 *
 * PKCE and not just a code, because any app on the phone may claim the `pi-super` scheme.
 * The verifier never leaves this app, so an intercepted code is worthless.
 */
object Handoff {
	// On disk, not in a field: this flow puts a whole browser in front of us, and coming
	// back to a process Android killed in the meantime is the normal case, not the odd one.
	private const val KEY = "handoff-verifier"
	/** a sign-in the user walked away from must not still be redeemable tomorrow */
	private const val TTL_MS = 10 * 60 * 1000L

	private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

	/** The browser URL that starts a sign-in, remembering the verifier that finishes it. */
	fun startUrl(ctx: Context, origin: String): String {
		val v = b64(ByteArray(32).also { SecureRandom().nextBytes(it) })
		Prefs.setHandoffVerifier(ctx, KEY, "${System.currentTimeMillis()}:$v")
		val challenge = b64(MessageDigest.getInstance("SHA-256").digest(v.toByteArray()))
		return "$origin/?handoff=$challenge"
	}

	/**
	 * The redeem request for a `pi-super://handoff?code=…` callback, or null if it is not
	 * ours. A POST, so neither half of the credential ends up in a URL — and therefore not
	 * in the WebView's history, a proxy's log, or a Referer.
	 */
	fun redeem(ctx: Context, origin: String, callback: Uri): Pair<String, ByteArray>? {
		val code = callback.getQueryParameter("code") ?: return null
		// One shot: a verifier that is reused is a verifier that can be replayed.
		val stored = Prefs.takeHandoffVerifier(ctx, KEY) ?: return null
		val at = stored.substringBefore(':').toLongOrNull() ?: return null
		val v = stored.substringAfter(':')
		if (v.isEmpty() || System.currentTimeMillis() - at > TTL_MS) return null
		val body = "code=${Uri.encode(code)}&verifier=${Uri.encode(v)}"
		return "$origin/api/auth/handoff/redeem" to body.toByteArray()
	}
}
