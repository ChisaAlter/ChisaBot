package cn.ayase.chisabot.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
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
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.BuildConfig

/**
 * 还没做成原生的页面（设置、管理后台、Claude Code、不常见的卡片…）在这里用网页打开：同一个服务器、同一份 Cookie（会话），
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
    BackHandler {
        val w = web
        if (w != null && w.canGoBack()) w.goBack() else vm.back()
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
                modifier = Modifier.fillMaxSize().navigationBarsPadding(),
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
