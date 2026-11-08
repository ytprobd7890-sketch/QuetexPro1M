plugins {
    id("com.android.application") version "8.5.2"
    id("org.jetbrains.kotlin.android") version "1.9.24"
}

// CI (or you, locally) can override these:
//   gradle assembleDebug -PappUrl="https://your-host/" -PversionCode=12 -PversionName=1.0.12
val appUrl: String = (findProperty("appUrl") as String?)?.takeIf { it.isNotBlank() }
    ?: "https://your-quetex-host.example/"
val buildVersionCode: Int = (findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
val buildVersionName: String = (findProperty("versionName") as String?)?.takeIf { it.isNotBlank() } ?: "1.0"

android {
    namespace = "com.quetex.pro1m"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.quetex.pro1m"
        minSdk = 26
        targetSdk = 34
        versionCode = buildVersionCode
        versionName = buildVersionName

        // Baked-in default URL. Leave the placeholder and the app will ask for the
        // URL on first launch instead (stored in SharedPreferences).
        buildConfigField("String", "APP_URL", "\"${appUrl.replace("\"", "\\\"")}\"")
    }

    buildFeatures {
        buildConfig = true
        viewBinding = false
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // Signed with the standard debug key so CI artifacts are directly
            // installable on a phone. Replace with a real keystore before
            // publishing anywhere public.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
}
