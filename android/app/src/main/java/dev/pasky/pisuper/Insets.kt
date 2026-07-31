package dev.pasky.pisuper

import android.app.Activity
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
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
	/**
	 * Ask for edge-to-edge explicitly instead of inheriting it from targetSdk.
	 *
	 * Not cosmetic: on API 35+ we get it whether we ask or not, but on 34 and below we do
	 * not — so without this the padding below is dead code on exactly the Android versions
	 * a test emulator is most likely to be running, and the overlay bug can only be found
	 * on a real phone. Same behaviour everywhere is worth more than the inch of screen.
	 */
	fun edgeToEdge(activity: Activity) {
		WindowCompat.setDecorFitsSystemWindows(activity.window, false)
	}

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
