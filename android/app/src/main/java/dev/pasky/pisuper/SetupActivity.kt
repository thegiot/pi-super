package dev.pasky.pisuper

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
		val field = findViewById<EditText>(R.id.url)
		field.setText(Prefs.url(this) ?: "")
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

	private fun save(url: String) {
		Prefs.setUrl(this, url)
		startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
		finish()
	}
}
