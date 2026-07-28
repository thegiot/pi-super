plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

android {
	namespace = "dev.pasky.pisuper"
	compileSdk = 35

	defaultConfig {
		applicationId = "dev.pasky.pisuper"
		// self-managed Telecom (ConnectionService with CAPABILITY_SELF_MANAGED) lands in O
		minSdk = 26
		targetSdk = 35
		versionCode = 1
		versionName = "1.0"
	}

	buildFeatures {
		buildConfig = true
	}

	buildTypes {
		release {
			isMinifyEnabled = false
			// A sideloaded app nobody publishes: sign release with the debug key so
			// `assembleRelease` produces something installable without a keystore dance.
			signingConfig = signingConfigs.getByName("debug")
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}
	kotlinOptions {
		jvmTarget = "17"
	}
}

dependencies {
	implementation("androidx.core:core-ktx:1.15.0")
	implementation("androidx.appcompat:appcompat:1.7.0")
	// WebViewCompat.addWebMessageListener: an origin-scoped bridge, unlike
	// addJavascriptInterface which is injected into every frame with no origin check
	implementation("androidx.webkit:webkit:1.12.1")
	testImplementation("junit:junit:4.13.2")
}
