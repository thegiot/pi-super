package dev.pasky.pisuper

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.widget.FrameLayout
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.security.MessageDigest

/**
 * The whole app, UI-wise: the existing pi-super PWA in a WebView, plus a bridge that lets
 * its voice mode open a real Android call around itself. Nothing about the web app is
 * reimplemented here — if the bridge is missing (plain Chrome), voice.ts just runs as it
 * always did.
 */
class MainActivity : AppCompatActivity() {
	private lateinit var web: WebView
	private var origin: String = ""

	private val permissionLauncher = registerForActivityResult(
		androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions(),
	) { }

	/** the page's pending `<input type=file>`, which must be answered exactly once */
	private var pendingFiles: ValueCallback<Array<Uri>>? = null
	private val filePicker = registerForActivityResult(
		androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(),
	) { result ->
		val cb = pendingFiles
		pendingFiles = null
		// null on cancel, and the page waits forever if we skip this
		cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val url = Prefs.url(this)
		if (url.isNullOrBlank()) {
			startActivity(Intent(this, SetupActivity::class.java))
			finish()
			return
		}
		origin = originOf(url)

		Insets.edgeToEdge(this)
		web = WebView(this)
		web.setBackgroundColor(getColor(R.color.bg))
		// The insets go on a container, not on the WebView: Chromium installs its own
		// OnApplyWindowInsetsListener when the WebView is attached, quietly replacing ours,
		// so padding the WebView directly does nothing at all on a real phone.
		val frame = FrameLayout(this)
		frame.setBackgroundColor(getColor(R.color.bg))
		frame.addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		setContentView(frame, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		// Only the keyboard: the page's own env(safe-area-inset-*) handles the status bar and
		// the gesture pill (it has to, for the Chrome PWA), and it can see them as soon as we
		// declare edge-to-edge above. What it cannot see is Gboard, which an edge-to-edge
		// window no longer gets out of the way of on its own.
		Insets.padKeyboard(frame)
		configure(web)
		bridge(web)
		CallHub.registerAccount(this)
		askPermissions()
		if (savedInstanceState == null) web.loadUrl(url)
		// a handoff callback that created us is consumed in onResume; see there
	}

	private fun askPermissions() {
		val wanted = mutableListOf(Manifest.permission.RECORD_AUDIO)
		if (Build.VERSION.SDK_INT >= 33) wanted += Manifest.permission.POST_NOTIFICATIONS
		if (Build.VERSION.SDK_INT >= 31) wanted += Manifest.permission.BLUETOOTH_CONNECT
		val missing = wanted.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
		if (missing.isNotEmpty()) permissionLauncher.launch(missing.toTypedArray())
	}

	private fun configure(web: WebView) {
		web.settings.apply {
			javaScriptEnabled = true
			domStorageEnabled = true
			// The remote audio element is created deep inside an async dial, long after the
			// tap that started it, so gesture-gated playback would silence the call.
			mediaPlaybackRequiresUserGesture = false
			allowFileAccess = false
			allowContentAccess = false
			mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
			userAgentString = "$userAgentString pi-super-android/${BuildConfig.VERSION_NAME}"
		}
		// Deliberately *not* enabling WebView's WebAuthn: in app mode the passkey belongs to
		// this app, and Android will only allow that for an RP ID Google can crawl
		// (/.well-known/assetlinks.json is fetched by Google's Digital Asset Links service, not
		// by the phone). A tailnet box cannot be crawled, so it would fail every time, with an
		// error that reads like a broken passkey. Sign-in goes through a browser instead — see
		// Handoff.kt.
		if (Build.VERSION.SDK_INT >= 29) web.isForceDarkAllowed = false
		WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

		web.webChromeClient = object : WebChromeClient() {
			/**
			 * `<input type=file>` — the image button in the composer. A WebView does nothing at
			 * all here unless the app opens the picker for it, which is why that button looked
			 * dead: the page was asking and nobody was listening.
			 */
			override fun onShowFileChooser(
				view: WebView?,
				callback: ValueCallback<Array<Uri>>?,
				params: FileChooserParams?,
			): Boolean {
				// a picker already open: the old request will never be answered otherwise
				pendingFiles?.onReceiveValue(null)
				pendingFiles = callback
				return try {
					// createIntent() carries the page's own accept= and multiple attributes
					filePicker.launch(params?.createIntent() ?: throw IllegalStateException("no intent"))
					true
				} catch (e: Exception) {
					Log.w("PiSuperCall", "no file picker", e)
					pendingFiles = null
					callback?.onReceiveValue(null)
					false
				}
			}

			override fun onPermissionRequest(request: PermissionRequest) {
				val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
				val trusted = originOf(request.origin.toString()) == origin
				val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
				if (wantsMic && trusted && granted) {
					// only the mic: never hand over the camera or protected media just because
					// the page asked for them in the same request
					request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
				} else {
					request.deny()
					if (wantsMic && !granted) {
						askPermissions()
						toast("microphone permission is needed for voice mode")
					}
				}
			}
		}

		web.webViewClient = object : WebViewClient() {
			override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
				// A new document has no idea a call is up, and pi-super reloads itself whenever
				// the server is rebuilt. Without this the Telecom call and its notification
				// outlive the WebRTC session they were wrapping, with nobody left to hang up.
				CallHub.endCall(null)
			}

			override fun onRenderProcessGone(view: WebView?, detail: android.webkit.RenderProcessGoneDetail?): Boolean {
				CallHub.endCall(null)
				toast("the page crashed")
				finish()
				return true // we handled it; not doing so kills the whole process
			}

			override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
				val target = request.url.toString()
				if (originOf(target) == origin) return false
				// anything off our own server is the open web: hand it to a real browser
				startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target)))
				return true
			}

			override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
				// A self-hosted box often has a private CA the phone does not know. Rather
				// than proceed() blindly (which would accept any cert, forever), pin: show the
				// fingerprint once and remember exactly that certificate.
				val fp = fingerprint(error)
				if (fp != null && fp == Prefs.pinnedCert(this@MainActivity)) {
					handler.proceed()
					return
				}
				// Below API 29 there is no way to get the certificate's own bytes out of
				// SslCertificate — only the two distinguished names, which anyone can copy. So
				// there is nothing to pin: ask every time, and say why.
				val body = if (fp != null) {
					"SHA-256:\n$fp\n\nTrust this exact certificate?"
				} else {
					"This Android is too old to identify the certificate, so it cannot be " +
						"remembered or verified. Continue anyway, this once?"
				}
				AlertDialog.Builder(this@MainActivity)
					.setTitle("Untrusted certificate")
					.setMessage("${error.url}\n\n$body")
					.setPositiveButton("Trust") { _, _ ->
						if (fp != null) Prefs.setPinnedCert(this@MainActivity, fp)
						handler.proceed()
					}
					.setNegativeButton("Cancel") { _, _ -> handler.cancel() }
					.setOnCancelListener { handler.cancel() }
					.show()
			}
		}
	}

	/** The certificate's own SHA-256, or null when this Android cannot give us its bytes. */
	private fun fingerprint(error: SslError): String? {
		if (Build.VERSION.SDK_INT < 29) return null
		val der = error.certificate?.x509Certificate?.encoded ?: return null
		return MessageDigest.getInstance("SHA-256").digest(der).joinToString(":") { "%02X".format(it) }
	}

	// ------------------------------------------------------------------------- bridge

	private fun bridge(web: WebView) {
		if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
			// Origin-scoped, unlike addJavascriptInterface, which is injected into every frame
			// (including a third-party iframe) with no way to tell who called.
			WebViewCompat.addWebMessageListener(web, "PiNative", setOf(origin)) { _, message, sourceOrigin, isMainFrame, _ ->
				if (!isMainFrame || sourceOrigin.toString().trimEnd('/') != origin) return@addWebMessageListener
				handle(message.data ?: return@addWebMessageListener)
			}
			CallHub.listener = { ev -> post(ev) }
		} else {
			// Without the bridge the page is still perfectly usable; voice mode just behaves
			// exactly as it does in Chrome, which is the thing this app exists to fix.
			toast("this Android WebView is too old for native call support")
		}
	}

	private fun handle(raw: String) {
		val msg = try {
			JSONObject(raw)
		} catch (_: Exception) {
			return
		}
		val id = msg.optString("callId")
		when (msg.optString("type")) {
			"startCall" -> CallHub.startCall(this, id)
			"markActive" -> CallHub.markActive(id)
			"endCall" -> CallHub.endCall(id.ifBlank { null })
			"setMuted" -> CallHub.setMuted(id, msg.optBoolean("muted"))
			"setRoute" -> CallHub.setRoute(id, msg.optString("route"))
			"login" -> signInViaBrowser()
		}
	}

	/** Hand the passkey ceremony to a real browser; we get the session back by deep link. */
	private fun signInViaBrowser() {
		val intent = Intent(Intent.ACTION_VIEW, Uri.parse(Handoff.startUrl(this, origin)))
			// CATEGORY_BROWSABLE keeps this out of our own deep-link filter
			.addCategory(Intent.CATEGORY_BROWSABLE)
		try {
			startActivity(intent)
			Log.i("PiSuperCall", "handoff: sent the browser to the login page")
		} catch (_: Exception) {
			toast("no browser to sign in with")
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		setIntent(intent)
	}

	override fun onResume() {
		super.onResume()
		// Not in onCreate: with saved state, onRestoreInstanceState runs *after* it and would
		// put the old page back over the redemption — having already spent the verifier.
		if (::web.isInitialized) consumeHandoff()
	}

	private fun consumeHandoff() {
		val data = intent?.data ?: return
		if (data.scheme != "pi-super" || data.host != "handoff") return
		// Whatever happens next, this intent is spent: it must not be replayed by the next
		// onResume (a rotation, or coming back from the recents list).
		intent.data = null
		val redeem = Handoff.redeem(this, origin, data)
		if (redeem == null) {
			Log.i("PiSuperCall", "handoff callback with no verifier of ours")
			toast("that sign-in did not start here")
			return
		}
		Log.i("PiSuperCall", "handoff: redeeming")
		// A navigation, not a fetch: the Set-Cookie has to land in the WebView's own jar.
		web.postUrl(redeem.first, redeem.second)
	}

	private fun post(ev: JSONObject) {
		val json = ev.toString().replace("\\", "\\\\").replace("'", "\\'")
		web.evaluateJavascript("window.dispatchEvent(new CustomEvent('pi-native',{detail:JSON.parse('$json')}))", null)
	}

	// ------------------------------------------------------------------------ plumbing

	private fun originOf(url: String): String = try {
		val u = Uri.parse(url)
		val port = if (u.port == -1) "" else ":${u.port}"
		"${u.scheme}://${u.host}$port"
	} catch (_: Exception) {
		""
	}

	private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		if (::web.isInitialized) web.saveState(outState)
	}

	override fun onRestoreInstanceState(state: Bundle) {
		super.onRestoreInstanceState(state)
		if (::web.isInitialized) web.restoreState(state)
	}

	override fun onDestroy() {
		pendingFiles?.onReceiveValue(null)
		pendingFiles = null
		// The page is going away, so the WebRTC session is too; leaving a Telecom call
		// registered would show a phantom call in the car forever.
		if (!isChangingConfigurations) {
			CallHub.listener = null
			CallHub.endCall(null)
		}
		if (::web.isInitialized) web.destroy()
		super.onDestroy()
	}

	@Deprecated("androidx back handling not worth a dependency for one WebView")
	override fun onBackPressed() {
		if (::web.isInitialized && web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
	}
}
