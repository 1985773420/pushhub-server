import java.util.Properties

plugins {
    id("com.android.application")
}

// A stable release signature so every future build upgrades the installed app in place.
// Reuse keystore.properties when present (one per deployment); otherwise fall back to the
// two secrets supplied through the environment (CI / local first build).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(key: String): String? = keystoreProps.getProperty(key) ?: System.getenv(key)

android {
    namespace = "com.pushhub.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.pushhub.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 11
        versionName = "1.8.0"
        resourceConfigurations += listOf("zh", "en")
    }

    signingConfigs {
        create("release") {
            storeFile = file(signingValue("PUSH_RELEASE_STORE_FILE") ?: "release.jks")
            storePassword = signingValue("PUSH_RELEASE_STORE_PASSWORD")
            keyAlias = signingValue("PUSH_RELEASE_KEY_ALIAS") ?: "pushhub"
            keyPassword = signingValue("PUSH_RELEASE_KEY_PASSWORD") ?: storePassword
        }
    }

    buildTypes {
        release {
            // No obfuscation: the APK stays readable for anyone auditing privacy.
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.core:core:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.lifecycle:lifecycle-service:2.8.4")
        implementation("com.google.android.material:material:1.12.0")
}
