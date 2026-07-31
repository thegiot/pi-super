package dev.pasky.pisuper

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/** Where the server URL (token and all) is pasted. Reachable later via the app shortcut. */
class SetupActivity : AppCompatActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_setup)
		// targetSdk 35 draws edge to edge, so without this the first line of text sits under
		// the status bar and the button under the gesture pill.
		Insets.pad(findViewById(R.id.root))
		val field = findViewById<EditText>(R.id.url)
		// Nobody is going to type a tailnet hostname and a token by hand on a phone. Take it
		// from a share (Chrome's Share → super) or from the clipboard, whichever we can find.
		field.setText(Prefs.url(this) ?: shared() ?: clipboardUrl() ?: "")
		field.setSelection(field.text.length)
		findViewById<Button>(R.id.save).setOnClickListener {
			val url = field.text.toString().trim()
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				Toast.makeText(this, "needs to start with http:// or https://", Toast.LENGTH_LONG).show()
				return@setOnClickListener
			}
			// That URL carries the token to a page that is a shell. Over http it is readable by
			// anyone on the way, and the page itself can be replaced — worth one deliberate tap.
			if (url.startsWith("http://")) {
				AlertDialog.Builder(this)
					.setTitle("No encryption")
					.setMessage(
						"http:// sends your token in the clear and lets anyone on the network replace " +
							"the page, which has shell access. Voice mode will not work either: the " +
							"microphone needs a secure origin. Use it anyway?",
					)
					.setPositiveButton("Use anyway") { _, _ -> save(url) }
					.setNegativeButton("Cancel", null)
					.show()
				return@setOnClickListener
			}
			save(url)
		}
	}

	private fun shared(): String? {
		val text = intent?.getStringExtra(Intent.EXTRA_TEXT) ?: intent?.dataString
		return text?.let(::firstUrl)
	}

	private fun clipboardUrl(): String? {
		val clip = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
		val item = clip.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0) ?: return null
		return firstUrl(item.coerceToText(this).toString())
	}

	/** A shared link often arrives with a title and a newline wrapped around it. */
	private fun firstUrl(text: String): String? =
		text.split(Regex("\\s+")).firstOrNull { it.startsWith("http://") || it.startsWith("https://") }

	private fun save(url: String) {
		Prefs.setUrl(this, url)
		startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
		finish()
	}
}
