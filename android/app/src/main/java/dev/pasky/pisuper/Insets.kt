package dev.pasky.pisuper

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keep content out from under the system bars.
 *
 * From targetSdk 35 every window is edge-to-edge whether it asked or not, so a view that
 * does nothing about insets gets its first line drawn behind the clock and its last behind
 * the gesture pill. The web app knows about `env(safe-area-inset-*)`, but a WebView is not
 * told about the status bar the way a browser tab is, so the padding has to happen here.
 */
object Insets {
	fun pad(view: View, keyboard: Boolean = true) {
		val base = intArrayOf(view.paddingLeft, view.paddingTop, view.paddingRight, view.paddingBottom)
		ViewCompat.setOnApplyWindowInsetsListener(view) { v, windowInsets ->
			val types = if (keyboard) {
				WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
			} else {
				WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
			}
			val bars = windowInsets.getInsets(types)
			v.setPadding(base[0] + bars.left, base[1] + bars.top, base[2] + bars.right, base[3] + bars.bottom)
			windowInsets
		}
		ViewCompat.requestApplyInsets(view)
	}
}
