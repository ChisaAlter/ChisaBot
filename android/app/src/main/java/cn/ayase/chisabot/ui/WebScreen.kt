package cn.ayase.chisabot.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.provider.MediaStore
import android.os.Environment
import android.widget.Toast
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.webkit.URLUtil
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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.BuildConfig
import cn.ayase.chisabot.ShareDraft
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 与桌面共用 React 应用，按 WebView 的真实手机 viewport 响应式布局。
 * 不套原生聊天导航；原生层只处理文件、下载、权限与 Android 返回键。
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebScreen(vm: AppViewModel, path: String, title: String) {
    val sky = LocalSky.current
    val origin = vm.origin() ?: return
    val theme = if (sky.dark) "dark" else "light"
    val scope = rememberCoroutineScope()
    var progress by remember(origin) { mutableStateOf(0) }
    var loadError by remember(origin) { mutableStateOf<String?>(null) }
    var renewing by remember(origin) { mutableStateOf(false) }
    var web by remember(origin) { mutableStateOf<WebView?>(null) }
    var pageReady by remember(origin) { mutableStateOf(false) }
    val latestTheme by rememberUpdatedState(theme)
    val density = LocalDensity.current
    val layoutDir = LocalLayoutDirection.current
    val statusBars = WindowInsets.statusBars
    val navigationBars = WindowInsets.navigationBars
    val displayCutout = WindowInsets.displayCutout
    val ime = WindowInsets.ime
    // 用 derivedStateOf 仅订阅「键盘是否可见」布尔翻转，避免 60/120Hz 键盘动画每帧触发整个 WebScreen 重组。
    val imeVisible by remember(ime, density) {
        derivedStateOf { ime.getBottom(density) > 0 }
    }
    val topPx = maxOf(statusBars.getTop(density), displayCutout.getTop(density))
    val leftPx = maxOf(navigationBars.getLeft(density, layoutDir), displayCutout.getLeft(density, layoutDir))
    val rightPx = maxOf(navigationBars.getRight(density, layoutDir), displayCutout.getRight(density, layoutDir))
    val bottomPx = effectiveBottomInsetPx(
        maxOf(navigationBars.getBottom(density), displayCutout.getBottom(density)),
        if (imeVisible) 1 else 0,
    )
    val d = density.density.coerceAtLeast(1f)
    val safeInsets = SafeInsetsDp(
        top = topPx / d,
        right = rightPx / d,
        bottom = bottomPx / d,
        left = leftPx / d,
    )
    val latestInsets by rememberUpdatedState(safeInsets)

    LaunchedEffect(web, pageReady, safeInsets) {
        val w = web ?: return@LaunchedEffect
        if (!pageReady) return@LaunchedEffect
        if (originKey(w.url) != originKey(origin)) return@LaunchedEffect
        syncAndroidSafeInsets(w, safeInsets)
    }

    LaunchedEffect(web, vm.pendingWebRoute) {
        val w = web ?: return@LaunchedEffect
        if (vm.pendingWebRoute == null) return@LaunchedEffect
        val consumed = vm.consumePendingWebRoute() ?: return@LaunchedEffect
        if (consumed.startsWith("/") && !consumed.startsWith("//")) {
            pageReady = false
            w.loadUrl(origin + consumed)
        }
    }

    LaunchedEffect(web, pageReady, vm.pendingShareDraft) {
        val w = web ?: return@LaunchedEffect
        if (!pageReady) return@LaunchedEffect
        if (originKey(w.url) != originKey(origin)) return@LaunchedEffect
        if (vm.pendingShareDraft == null) return@LaunchedEffect
        val draft = vm.consumePendingShareDraft() ?: return@LaunchedEffect
        injectNativeShareDraft(w, draft)
    }
    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var cameraUri by remember { mutableStateOf<Uri?>(null) }
    var cameraFile by remember { mutableStateOf<File?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val selected = if (result.resultCode == Activity.RESULT_OK) {
            result.data?.clipData?.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } }
                ?: result.data?.data?.let { arrayOf(it) }
                ?: WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
                ?: cameraUri?.let { arrayOf(it) }
        } else null
        fileCallback?.onReceiveValue(selected); fileCallback = null
        if (selected == null) cameraFile?.delete()
        cameraUri = null; cameraFile = null
    }
    // 网页要麦克风（语音输入）且系统还没给 RECORD_AUDIO 时，先问系统；拒绝就拒绝网页的请求。
    // 被拒时要告诉用户：这次拒绝给一句提示；选了「不再询问」（拒绝后系统不再给理由提示）就弹框引导去应用设置。
    val context = LocalContext.current
    val pendingDownloadIds = remember { mutableSetOf<Long>() }
    // 用系统 ACTION_DOWNLOAD_COMPLETE 广播替代每秒轮询 DownloadManager，消除 60 次 IPC 并兼容 >60s 大文件下载。
    DisposableEffect(context) {
        val appContext = context.applicationContext
        val manager = appContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                if (id == -1L || !pendingDownloadIds.remove(id)) return
                scope.launch {
                    val state = withContext(Dispatchers.IO) {
                        runCatching {
                            manager.query(DownloadManager.Query().setFilterById(id))?.use { row ->
                                if (row.moveToFirst()) {
                                    row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) to
                                        row.getInt(row.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                                } else null
                            }
                        }.getOrNull()
                    }
                    if (state?.first == DownloadManager.STATUS_FAILED) {
                        android.util.Log.w("ChisaDownload", "Download failed: ${state.second}")
                        Toast.makeText(context, "下载失败，请检查网络后重试。", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
        ContextCompat.registerReceiver(
            appContext,
            receiver,
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED,
        )
        onDispose {
            pendingDownloadIds.clear()
            runCatching { appContext.unregisterReceiver(receiver) }
        }
    }
    var pendingExport by remember { mutableStateOf<WebExport?>(null) }
    var readingExport by remember { mutableStateOf(false) }
    val saveExport = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val export = pendingExport; pendingExport = null
        val destination = result.data?.data
        if (result.resultCode == Activity.RESULT_OK && destination != null && export != null) scope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(destination, "w")?.use { it.write(export.bytes) }
                        ?: throw IllegalStateException("无法写入这个位置。")
                }
            }.onSuccess { Toast.makeText(context, "已保存 ${export.name}", Toast.LENGTH_SHORT).show() }
                .onFailure { Toast.makeText(context, "保存失败，请重新选择位置。", Toast.LENGTH_LONG).show() }
        }
    }
    fun chooseFile(params: WebChromeClient.FileChooserParams) {
        val mime = params.acceptTypes.filter { it.isNotBlank() }
        val intent = params.createIntent().apply { addCategory(Intent.CATEGORY_OPENABLE) }
        if (mime.any { it.startsWith("image/") } && ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            val file = File.createTempFile("capture-", ".jpg", File(context.cacheDir, "camera").apply { mkdirs() })
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            cameraFile = file; cameraUri = uri
            val capture = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (params.isCaptureEnabled) picker.launch(capture)
            else picker.launch(Intent.createChooser(intent, "选择照片或文件").putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(capture)))
        } else picker.launch(intent)
    }
    var cameraParams by remember { mutableStateOf<WebChromeClient.FileChooserParams?>(null) }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val params = cameraParams; cameraParams = null
        if (params != null) {
            if (granted || !params.isCaptureEnabled) chooseFile(params)
            else { fileCallback?.onReceiveValue(null); fileCallback = null; Toast.makeText(context, "未开启相机权限，可以从文件中选择照片。", Toast.LENGTH_LONG).show() }
        }
    }
    var micRequest by remember { mutableStateOf<PermissionRequest?>(null) }
    var showMicSettings by remember { mutableStateOf(false) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = micRequest ?: return@rememberLauncherForActivityResult
        micRequest = null
        if (granted) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            request.deny()
            val activity = context.findActivity()
            val rationale = activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.RECORD_AUDIO)
            if (isMicPermanentlyDenied(rationale)) showMicSettings = true
            else Toast.makeText(context, MIC_DENIED_ONCE_MESSAGE, Toast.LENGTH_LONG).show()
        }
    }
    // 页面关闭（离开这一屏、WebView 销毁）时，还在等系统弹框的网页请求直接拒掉，别挂着。
    DisposableEffect(Unit) {
        onDispose {
            micRequest?.let { runCatching { it.deny() } }
            micRequest = null
            fileCallback?.onReceiveValue(null); fileCallback = null
        }
    }
    if (showMicSettings) {
        AlertDialog(
            onDismissRequest = { showMicSettings = false },
            title = { Text("需要麦克风权限") },
            text = { Text(MIC_DENIED_SETTINGS_MESSAGE) },
            confirmButton = {
                TextButton(onClick = {
                    showMicSettings = false
                    runCatching {
                        context.startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }) { Text("去设置") }
            },
            dismissButton = { TextButton(onClick = { showMicSettings = false }) { Text("取消") } },
        )
    }
    BackHandler {
        val w = web
        val fallback = { if (w != null && w.canGoBack()) w.goBack() else if (!vm.back()) context.findActivity()?.moveTaskToBack(true); Unit }
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
    androidx.compose.runtime.key(origin) {
        val desiredBgColor = if (sky.dark) android.graphics.Color.rgb(13, 22, 36) else android.graphics.Color.rgb(247, 249, 252)
        val desiredVisibility = if (loadError == null) View.VISIBLE else View.INVISIBLE
        var lastBgColor by remember(origin) { mutableStateOf<Int?>(null) }
        Box(Modifier.fillMaxSize().imePadding()) {
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        setBackgroundColor(desiredBgColor)
                        lastBgColor = desiredBgColor
                        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
                        CookieManager.getInstance().setAcceptCookie(true)
                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            mediaPlaybackRequiresUserGesture = false
                            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                            allowFileAccess = false
                            // 无 native 后缀：保留 web 工具合同，同时让网页识别应用壳、停用 PWA 安装提示。
                            userAgentString = "$userAgentString ChisaBotAndroid/${BuildConfig.VERSION_NAME}"
                            setSupportZoom(false)
                            textZoom = 100
                            useWideViewPort = true
                            loadWithOverviewMode = true
                        }
                        addJavascriptInterface(
                            object {
                                @JavascriptInterface
                                fun setTheme(mode: String?) {
                                    post {
                                        if (originKey(this@apply.url) != originKey(origin)) return@post
                                        val next = normalizeWebTheme(mode) ?: return@post
                                        if (next != vm.themeMode) vm.setTheme(next)
                                    }
                                }
                            },
                            "ChisaAndroid",
                        )
                        fun recoverLogin() {
                            if (renewing) return
                            renewing = true
                            scope.launch {
                                val restored = vm.renewWebSession()
                                renewing = false
                                if (restored) loadUrl(origin + path) else vm.expired()
                            }
                        }
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                val url = request.url
                                // originKey 已把协议 / 主机小写、默认端口补齐：https://host 和 https://host:443 算同一个。
                                val same = originKey(url.toString())?.let { it == originKey(origin) } == true
                                if (same) {
                                    if (isWebSignOutPath(url.path)) {
                                        vm.logout()
                                        return true
                                    }
                                    return false
                                }
                                if (request.isForMainFrame && url.scheme in setOf("https", "http", "mailto", "tel", "chisabot")) {
                                    runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, url)) }
                                }
                                return true
                            }
                            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) { loadError = null; pageReady = false }
                            override fun onPageCommitVisible(view: WebView, url: String) {
                                syncTheme(view, latestTheme)
                                if (originKey(url) == originKey(origin)) {
                                    syncAndroidSafeInsets(view, latestInsets)
                                }
                            }
                            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                                if (originKey(url)?.let { it == originKey(origin) } == true) {
                                    val uri = Uri.parse(url)
                                    if (isWebSignOutPath(uri.path)) {
                                        vm.logout()
                                        return
                                    }
                                    vm.rememberWebPath((uri.encodedPath?.takeIf { it.isNotBlank() } ?: "/") + (uri.encodedQuery?.let { "?$it" } ?: "") + (uri.encodedFragment?.let { "#$it" } ?: ""))
                                }
                            }
                            override fun onPageFinished(view: WebView, url: String) {
                                syncTheme(view, latestTheme)
                                if (originKey(url) == originKey(origin)) {
                                    syncAndroidSafeInsets(view, latestInsets)
                                    installWebExportCapture(view)
                                    pageReady = true
                                }
                                scope.launch(Dispatchers.IO) { CookieManager.getInstance().flush() }
                                if (originKey(url) == originKey(origin) && Uri.parse(url).path?.startsWith("/login") == true) recoverLogin()
                            }
                            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                                if (request.isForMainFrame) loadError = "暂时无法连接服务器，请检查网络后重试。"
                            }
                            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                                if (request.isForMainFrame && response.statusCode == 401) recoverLogin()
                                else if (request.isForMainFrame && response.statusCode >= 500) loadError = "服务器暂时不可用，请稍后重试。"
                            }
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onProgressChanged(view: WebView, newProgress: Int) { progress = newProgress }
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
                                try {
                                    if (params.isCaptureEnabled && params.acceptTypes.any { it.startsWith("image/") } && ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                                        cameraParams = params; cameraPermission.launch(Manifest.permission.CAMERA)
                                    } else chooseFile(params)
                                } catch (_: Exception) { cb.onReceiveValue(null); fileCallback = null; Toast.makeText(context, "无法打开文件选择器，请重试。", Toast.LENGTH_LONG).show() }
                                return true
                            }
                        }
                        setDownloadListener { url, ua, disposition, mime, _ ->
                            if (url.startsWith("blob:") && originKey(url.removePrefix("blob:")) == originKey(origin) && originKey(this.url) == originKey(origin)) {
                                if (!readingExport && pendingExport == null) scope.launch {
                                    readingExport = true
                                    try {
                                        val export = readWebExport(this@apply, url)
                                        pendingExport = export
                                        saveExport.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                                            .setType(webExportPickerMime(export.name, export.mime)).putExtra(Intent.EXTRA_TITLE, export.name))
                                    } catch (error: Exception) { Toast.makeText(context, error.message ?: "无法保存导出内容，请重试。", Toast.LENGTH_LONG).show() }
                                    finally { readingExport = false }
                                }
                            } else if (Uri.parse(url).scheme !in setOf("http", "https")) {
                                Toast.makeText(context, "无法下载这个链接。", Toast.LENGTH_LONG).show()
                            } else runCatching {
                                val name = webDownloadName(url, disposition, mime)
                                val request = DownloadManager.Request(Uri.parse(url)).setTitle(name).setMimeType(mime)
                                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                                    .addRequestHeader("User-Agent", ua)
                                if (originKey(url) == originKey(origin)) CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
                                val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                                val id = manager.enqueue(request)
                                pendingDownloadIds.add(id)
                                Toast.makeText(context, "已开始下载 $name", Toast.LENGTH_SHORT).show()
                            }.onFailure {
                                android.util.Log.w("ChisaDownload", "Download admission failed", it)
                                Toast.makeText(context, "下载未开始，请重试。", Toast.LENGTH_LONG).show()
                            }
                        }
                        loadUrl(origin + path)
                        web = this
                    }
                },
                // 主框架加载失败时 WebView 自己会画英文错误页（net::ERR_…），和上面的中文提示叠在一起；
                // 藏掉它（INVISIBLE 的 View 也不接触摸），让后面的错误页 SkyBackground 露出来。
                update = { view ->
                    if (lastBgColor != desiredBgColor) {
                        view.setBackgroundColor(desiredBgColor)
                        lastBgColor = desiredBgColor
                    }
                    if (view.visibility != desiredVisibility) {
                        view.visibility = desiredVisibility
                    }
                },
                // imePadding：edge-to-edge 下 adjustResize 不再缩 WebView，键盘高度只从 insets 来（CB-098）。
                modifier = Modifier.fillMaxSize(),
                onRelease = { it.stopLoading(); it.destroy() },
            )
            androidx.compose.animation.AnimatedVisibility(visible = progress in 1..99, exit = fadeOut(tween(200))) {
                LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth().statusBarsPadding().height(2.dp), color = sky.accent, trackColor = Color.Transparent)
            }
            loadError?.let { message ->
                SkyBackground(showClouds = true) {
                    Column(Modifier.fillMaxSize().systemBarsPadding().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(message, color = sky.ink1, textAlign = TextAlign.Center)
                        // 首屏加载就失败时 WebView 没有已提交的 URL，reload() 是空操作；退回原始地址重新加载。
                        TextButton(onClick = {
                            loadError = null
                            val w = web
                            if (w?.url != null) w.reload() else w?.loadUrl(origin + path)
                        }) { Text("重新连接") }
                        TextButton(onClick = { vm.switchServer() }) { Text("切换服务器") }
                    }
                }
            }
        }
    }
}

/** 仅向同源页面注入系统分享草稿，由网页侧 `useReplyNotifications` 预填至输入框或附件草稿。 */
private fun injectNativeShareDraft(view: WebView, draft: ShareDraft) {
    val payload = org.json.JSONObject().apply {
        draft.text?.let { put("text", it) }
        draft.imageName?.let { put("imageName", it) }
        draft.imageMime?.let { put("imageMime", it) }
        draft.imageBase64?.let { put("imageBase64", it) }
    }.toString()
    view.evaluateJavascript(
        "(function(detail){try{window.dispatchEvent(new CustomEvent('chisabot-native-share',{detail:detail}));}catch(e){}})($payload);",
        null,
    )
}

private data class SafeInsetsDp(
    val top: Float,
    val right: Float,
    val bottom: Float,
    val left: Float,
)

/** 将系统状态栏 / 导航栏 / 刘海安全区（CSS px）写入文档根元素，让网页顶/底避让系统栏同时背景壁纸铺满整屏。 */
private fun syncAndroidSafeInsets(view: WebView, insets: SafeInsetsDp) {
    val t = String.format(java.util.Locale.US, "%.2fpx", insets.top)
    val r = String.format(java.util.Locale.US, "%.2fpx", insets.right)
    val b = String.format(java.util.Locale.US, "%.2fpx", insets.bottom)
    val l = String.format(java.util.Locale.US, "%.2fpx", insets.left)
    view.evaluateJavascript(
        "(function(t,r,b,l){try{var s=document.documentElement&&document.documentElement.style;if(!s)return;" +
            "s.setProperty('--android-safe-t',t);s.setProperty('--android-safe-r',r);" +
            "s.setProperty('--android-safe-b',b);s.setProperty('--android-safe-l',l);" +
            "s.setProperty('--safe-t',t);s.setProperty('--safe-r',r);" +
            "s.setProperty('--safe-b',b);s.setProperty('--safe-l',l);}catch(e){}})('$t','$r','$b','$l')",
        null,
    )
}

/** 只接受浅色 / 深色主题名（忽略系统模式与非法值）。 */
internal fun normalizeWebTheme(raw: String?): String? = when (raw?.trim()?.lowercase()) {
    "dark" -> "dark"
    "light" -> "light"
    else -> null
}

/** 键盘弹出时底部已由 Box.imePadding() 顶起，网页安全区底边距归零避免重复留白。 */
internal fun effectiveBottomInsetPx(navBottom: Int, imeBottom: Int): Int =
    if (imeBottom > 0) 0 else navBottom.coerceAtLeast(0)

/** 首次使用沿用系统主题；之后由同一网页的设置控制，不能每次导航重写用户选择，并同步回原生状态栏。 */
private fun syncTheme(view: WebView, theme: String) {
    view.evaluateJavascript(
        "(function(t){try{var stored=localStorage.getItem('chisabot-theme');if(stored==='dark'||stored==='light'){t=stored;}else{localStorage.setItem('chisabot-theme',t);}" +
            "var r=document.documentElement;if(r){r.classList.toggle('dark',t==='dark');r.style.colorScheme=t;}" +
            "var notify=function(m){if(window.ChisaAndroid&&window.ChisaAndroid.setTheme){window.ChisaAndroid.setTheme(m);}};" +
            "notify(t);" +
            "if(r&&!window.__chisaThemeObs&&typeof MutationObserver==='function'){" +
            "window.__chisaThemeObs=new MutationObserver(function(){notify(r.classList.contains('dark')?'dark':'light');});" +
            "window.__chisaThemeObs.observe(r,{attributes:true,attributeFilter:['class']});" +
            "}}catch(e){}})('$theme')",
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

/** 这次拒绝了麦克风（下次还会问）时的提示，语气同网页侧 MIC_DENIED_*_MESSAGE（#410）。 */
internal const val MIC_DENIED_ONCE_MESSAGE = "麦克风权限被拒绝了，暂时用不了语音输入。需要时再点一次「重新录音」，在系统弹框里选「允许」。"

/** 选了「不再询问」后系统不会再弹框，只能去应用设置里打开。 */
internal const val MIC_DENIED_SETTINGS_MESSAGE = "麦克风权限被拒绝了。请到系统设置的「应用 → ChisaBot → 权限」里打开麦克风，再点「重新录音」。"

/**
 * 刚被拒绝之后：系统还愿意给理由提示（[shouldShowRationale] 为 true）说明只是这次拒绝；
 * 为 false 说明用户选了「不再询问」（或被策略禁止），系统不会再弹框，要引导去设置。
 */
internal fun isMicPermanentlyDenied(shouldShowRationale: Boolean): Boolean = !shouldShowRationale

private tailrec fun android.content.Context.findActivity(): android.app.Activity? = when (this) {
    is android.app.Activity -> this
    is android.content.ContextWrapper -> baseContext.findActivity()
    else -> null
}

/** evaluateJavascript 回来的是 JSON 文本：只有字面量 true 表示网页已经处理了返回键。 */
internal fun isBackHandled(result: String?): Boolean = result?.trim() == "true"

/** 网页内点击「退出登录」跳转到 /sign：同步清除原生设备令牌并回到登录页，避免再跳 /login 触发静默复登。 */
internal fun isWebSignOutPath(path: String?): Boolean = path == "/sign" || path?.startsWith("/sign/") == true

/** Android URLUtil 不识别服务器使用的 RFC 5987 filename*，否则中文文件会落成 UUID.bin。 */
internal fun webDownloadName(url: String, disposition: String?, mime: String?): String {
    val encoded = Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(disposition.orEmpty())?.groupValues?.get(1)
    val decoded = encoded?.let { runCatching { java.net.URLDecoder.decode(it.trim().trim('"').replace("+", "%2B"), "UTF-8") }.getOrNull() }
    val name = decoded?.substringAfterLast('/')?.substringAfterLast('\\')?.replace(Regex("[\\x00-\\x1f\\x7f]"), "")?.trim()
    return name?.takeIf { it.isNotEmpty() && it != "." && it != ".." } ?: URLUtil.guessFileName(url, disposition, mime)
}
