package dev.pasky.pisuper

import android.app.Activity
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Who keeps content out from under the system bars: the page, mostly.
 *
 * The web app already handles `env(safe-area-inset-*)` for the Chrome PWA, and a WebView
 * *does* report those insets — but only once the app has declared, with
 * setDecorFitsSystemWindows(false), that it handles them itself. Without that declaration
 * the page is told nothing and draws under the clock; with it, the page does the right
 * thing on its own, and any padding we add on top of that is simply doubled (47px of
 * status bar, twice, which is exactly what it looked like).
 *
 * So the split is: the page owns the system bars and the cutout, and we own only the
 * keyboard — which the page cannot see, and which an edge-to-edge window no longer gets
 * out of the way of by itself, adjustResize or not.
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

	/** Everything, for a view with no page behind it to know better (the setup screen). */
	fun pad(view: View) {
		apply(view) {
			it.getInsets(
				WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
			)
		}
	}

	/**
	 * Only the keyboard, for the WebView: the page has the rest covered, and doubling it
	 * leaves a band of dead space under the status bar.
	 */
	fun padKeyboard(view: View) {
		apply(view) { it.getInsets(WindowInsetsCompat.Type.ime()) }
	}

	private fun apply(view: View, wanted: (WindowInsetsCompat) -> androidx.core.graphics.Insets) {
		val base = intArrayOf(view.paddingLeft, view.paddingTop, view.paddingRight, view.paddingBottom)
		ViewCompat.setOnApplyWindowInsetsListener(view) { v, windowInsets ->
			val bars = wanted(windowInsets)
			v.setPadding(base[0] + bars.left, base[1] + bars.top, base[2] + bars.right, base[3] + bars.bottom)
			windowInsets
		}
		ViewCompat.requestApplyInsets(view)
	}
}
