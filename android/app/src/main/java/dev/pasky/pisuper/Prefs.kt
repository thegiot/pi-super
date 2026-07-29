package dev.pasky.pisuper

import android.content.Context

/** The two things this app remembers: where the server is, and which cert we accepted. */
object Prefs {
	private const val FILE = "pi-super"

	private fun of(ctx: Context) = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

	fun url(ctx: Context): String? = of(ctx).getString("url", null)

	fun setUrl(ctx: Context, url: String) {
		// a new server means the old pinned certificate is meaningless
		of(ctx).edit().putString("url", url).remove("cert").apply()
	}

	fun pinnedCert(ctx: Context): String? = of(ctx).getString("cert", null)

	fun setPinnedCert(ctx: Context, fingerprint: String) {
		of(ctx).edit().putString("cert", fingerprint).apply()
	}

	/** commit(), not apply(): the very next thing that happens is a browser taking over */
	fun setHandoffVerifier(ctx: Context, key: String, verifier: String) {
		of(ctx).edit().putString(key, verifier).commit()
	}

	fun takeHandoffVerifier(ctx: Context, key: String): String? {
		val v = of(ctx).getString(key, null)
		of(ctx).edit().remove(key).commit()
		return v
	}
}
