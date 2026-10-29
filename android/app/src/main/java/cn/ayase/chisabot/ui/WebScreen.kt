package cn.ayase.chisabot.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.BuildConfig

/**
 * 还没做成原生的页面（设置、管理后台、不常见的卡片…）在这里用网页打开：同一个服务器、同一份 Cookie（会话），
 * 所以不用再登录，也不会走到死路。站外链接交给系统浏览器。
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebScreen(vm: AppViewModel, path: String, title: String) {
    val sky = LocalSky.current
    val origin = vm.origin() ?: return
    // 网页的深浅色存在它自己的 localStorage「chisabot-theme」里；兜底页跟原生界面一样跟随系统（不然深色手机上会突然亮一块）。
    val theme = if (sky.dark) "dark" else "light"
    var progress by remember { mutableStateOf(0) }
    var pageTitle by remember { mutableStateOf(title) }
    var web by remember { mutableStateOf<WebView?>(null) }
    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray()); fileCallback = null
    }
    // 网页要麦克风（语音输入）且系统还没给 RECORD_AUDIO 时，先问系统；拒绝就拒绝网页的请求。
    var micRequest by remember { mutableStateOf<PermissionRequest?>(null) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = micRequest ?: return@rememberLauncherForActivityResult
        micRequest = null
        if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
    }
    BackHandler {
        val w = web
        val fallback = { if (w != null && w.canGoBack()) w.goBack() else vm.back() }
        if (w == null) {
            fallback()
        } else {
            // 先让网页关掉打开的抽屉（window.__chisabotBack，CB-098）；它返回 true 就到此为止，
            // false / 旧网页没有这个接口 / 出错时走原来的 goBack 或返回上一屏。
            try {
                w.evaluateJavascript(
                    "(function(){try{return typeof window.__chisabotBack==='function'&&window.__chisabotBack()===true}catch(e){return false}})()",
                ) { result -> if (!isBackHandled(result)) fallback() }
            } catch (_: Throwable) {
                fallback()
            }
        }
    }
    Column(Modifier.fillMaxSize()) {
        TopBar(pageTitle, subtitle = "网页", onBack = { vm.back() })
        Box(Modifier.fillMaxSize()) {
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        setBackgroundColor(android.graphics.Color.TRANSPARENT)
                        CookieManager.getInstance().setAcceptCookie(true)
                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            mediaPlaybackRequiresUserGesture = false
                            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                            allowFileAccess = false
                            userAgentString = "$userAgentString ChisaBotAndroid/${BuildConfig.VERSION_NAME}"
                        }
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                val url = request.url
                                val same = url.scheme + "://" + url.authority == origin || (url.scheme == "http" || url.scheme == "https") && url.host == Uri.parse(origin).host && url.port == Uri.parse(origin).port
                                if (same) return false
                                runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, url)) }
                                return true
                            }
                            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) { syncTheme(view, theme) }
                            override fun onPageFinished(view: WebView, url: String) {
                                syncTheme(view, theme)
                                CookieManager.getInstance().flush()
                                if (Uri.parse(url).path?.startsWith("/login") == true) vm.expired()
                            }
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onProgressChanged(view: WebView, newProgress: Int) { progress = newProgress }
                            override fun onReceivedTitle(view: WebView, t: String?) { if (!t.isNullOrBlank() && !t.startsWith("http")) pageTitle = t }
                            // 只给本服务器的页面麦克风，别的来源、别的资源（摄像头等）一律拒绝。
                            override fun onPermissionRequest(request: PermissionRequest) {
                                val grant = micResourcesToGrant(request.origin?.toString(), origin, request.resources)
                                if (grant == null) {
                                    request.deny()
                                } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                                    request.grant(grant)
                                } else {
                                    micRequest?.deny()
                                    micRequest = request
                                    micPermission.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            }
                            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                                if (micRequest === request) micRequest = null
                            }
                            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                                fileCallback?.onReceiveValue(null)
                                fileCallback = cb
                                picker.launch(params.acceptTypes.firstOrNull()?.takeIf { it.isNotBlank() } ?: "*/*")
                                return true
                            }
                        }
                        loadUrl(origin + path)
                        web = this
                    }
                },
                // imePadding：edge-to-edge 下 adjustResize 不再缩 WebView，键盘高度只从 insets 来（CB-098）。
                modifier = Modifier.fillMaxSize().navigationBarsPadding().imePadding(),
                onRelease = { it.stopLoading(); it.destroy() },
            )
            androidx.compose.animation.AnimatedVisibility(visible = progress in 1..99, exit = fadeOut(tween(200))) {
                LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth().height(2.dp), color = sky.accent, trackColor = Color.Transparent)
            }
        }
    }
}

/** 把网页主题对齐到原生（同网页 lib/theme.ts applyDarkTheme：存储键 + html.dark + color-scheme）。 */
private fun syncTheme(view: WebView, theme: String) {
    view.evaluateJavascript(
        "(function(t){try{if(localStorage.getItem('chisabot-theme')!==t)localStorage.setItem('chisabot-theme',t);localStorage.setItem('openbot-theme',t);" +
            "var r=document.documentElement;if(r){r.classList.toggle('dark',t==='dark');r.style.colorScheme=t;}}catch(e){}})('$theme')",
        null,
    )
}

/**
 * 网页的权限请求里能给的部分：只有本服务器（[appOrigin]，协议 + 主机 + 端口都相同）要麦克风时，
 * 才给 RESOURCE_AUDIO_CAPTURE；别的来源、或者除了麦克风还要别的（摄像头、受保护媒体等）都返回 null（拒绝）。
 */
internal fun micResourcesToGrant(requestOrigin: String?, appOrigin: String, resources: Array<String>): Array<String>? {
    if (resources.isEmpty() || resources.any { it != PermissionRequest.RESOURCE_AUDIO_CAPTURE }) return null
    val asked = originKey(requestOrigin) ?: return null
    if (asked != originKey(appOrigin)) return null
    return arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
}

/** 「协议://主机:端口」，主机小写、默认端口补齐；解析不了返回 null。 */
private fun originKey(origin: String?): String? {
    val uri = runCatching { java.net.URI(origin?.trim().orEmpty()) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    val host = uri.host?.lowercase() ?: return null
    if (scheme != "https" && scheme != "http") return null
    val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80
    return "$scheme://$host:$port"
}

/** evaluateJavascript 回来的是 JSON 文本：只有字面量 true 表示网页已经处理了返回键。 */
internal fun isBackHandled(result: String?): Boolean = result?.trim() == "true"
