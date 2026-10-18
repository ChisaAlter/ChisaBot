plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// 签名只从环境变量读（CI 用仓库 Secrets 解出 keystore）；没有就产出未签名的 release APK。
val ksFile = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() && file(it).exists() }

// 构建期默认值（CI 从仓库变量写入；都为空 = 通用版：首次运行让用户填自己的服务器地址）。
fun env(name: String) = System.getenv(name)?.trim().orEmpty()
val defaultServer = env("CHISABOT_SERVER_URL")
val githubRepo = env("CHISABOT_GITHUB_REPO").ifEmpty { env("GITHUB_REPOSITORY") }
val updateFeed = env("CHISABOT_ANDROID_UPDATE_FEED").ifEmpty {
    if (githubRepo.isNotEmpty()) "https://github.com/$githubRepo/releases/latest/download/chisabot-android.json" else ""
}
fun quoted(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "cn.ayase.chisabot"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.ayase.chisabot"
        minSdk = 24
        targetSdk = 34
        versionCode = 238        // 只增不减（已安装的 Android 按它判断更新）；2026-10-12 版本号重置为 0.1.0 时从 206 接着往上
        versionName = "0.1.32"
        buildConfigField("String", "DEFAULT_SERVER", quoted(defaultServer))
        buildConfigField("String", "UPDATE_FEED", quoted(updateFeed))
        // 只有 debug 包允许 http://10.0.2.2（模拟器连本机预览）；正式包一律 https。
        buildConfigField("boolean", "ALLOW_LOCAL_HTTP", "false")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (ksFile != null) {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "ALLOW_LOCAL_HTTP", "true")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (ksFile != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }
    packaging { resources { excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/*.version", "DebugProbesKt.bin", "kotlin-tooling-metadata.json") } }
    testOptions { unitTests.isReturnDefaultValues = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // 原生界面（Kotlin + Jetpack Compose，Material3）。
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    // 网络：OkHttp（SSE 流式回复自己按行解析）+ kotlinx.serialization；图片：Coil。
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("io.coil-kt:coil-compose:2.6.0")
    // 扫码绑定（DESIGN.md §33）：内嵌 ZXing 扫码界面，不依赖 Google Play 服务（国产手机也能用）。
    implementation("com.journeyapps:zxing-android-embedded:4.3.0") { isTransitive = false }
    implementation("com.google.zxing:core:3.5.3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
}
