plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.craftagent.android"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.craftagent.android"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  buildFeatures {
    viewBinding = true
    buildConfig = true
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
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
  implementation("androidx.activity:activity-ktx:1.9.3")
  implementation("androidx.coordinatorlayout:coordinatorlayout:1.2.0")
  implementation("androidx.recyclerview:recyclerview:1.3.2")
  implementation("androidx.webkit:webkit:1.12.1")
  implementation("com.google.android.material:material:1.12.0")
}
