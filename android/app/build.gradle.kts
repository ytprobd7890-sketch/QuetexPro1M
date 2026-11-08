plugins {
    id("com.android.application") version "8.5.2"
    id("org.jetbrains.kotlin.android") version "1.9.24"
}

android {
    namespace = "com.quetex.pro1m"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.quetex.pro1m"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // Replace with your deployed https URL, or leave the placeholder and type
        // the URL in the app on first launch (stored in SharedPreferences).
        buildConfigField("String", "APP_URL", "\"https://your-quetex-host.example/\"")
    }

    buildFeatures {
        buildConfig = true
        viewBinding = false
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
}
