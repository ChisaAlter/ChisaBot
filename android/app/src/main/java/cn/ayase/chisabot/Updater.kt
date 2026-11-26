package cn.ayase.chisabot

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

private val SAFE_UPDATE_VERSION_REGEX = Regex("^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
private const val MAX_UPDATE_FEED_BYTES = 1024 * 1024

/** 校验更新源或 APK 下载地址必须为合法 https:// URL，禁止明文 HTTP 与内嵌凭据。 */
internal fun requireHttpsUpdateUrl(raw: String, label: String = "更新地址"): URL {
    val trimmed = raw.trim()
    val parsed = runCatching { URL(trimmed) }.getOrNull()
        ?: throw IllegalArgumentException("$label 格式无效")
    if (!parsed.protocol.equals("https", ignoreCase = true) || parsed.host.isNullOrBlank()) {
        throw IllegalArgumentException("$label 仅允许 https:// 地址")
    }
    if (parsed.userInfo != null) {
        throw IllegalArgumentException("$label 不允许包含账号密码")
    }
    return parsed
}

/** 校验更新版本号满足安全白名单且不含路径穿越片段 `..`。 */
internal fun validateUpdateVersion(version: String): String {
    val v = version.trim()
    if (!SAFE_UPDATE_VERSION_REGEX.matches(v) || v.contains("..")) {
        throw IllegalArgumentException("非法的更新版本号")
    }
    return v
}

/** 解析更新 APK 落盘路径并校验 canonicalPath 严格位于 [updatesDir] 目录内，防止路径穿越。 */
internal fun resolveSafeUpdateApkFile(updatesDir: File, version: String): File {
    val safeVersion = validateUpdateVersion(version)
    val baseCanonical = updatesDir.canonicalFile
    val targetCanonical = File(baseCanonical, "ChisaBot-Android-$safeVersion.apk").canonicalFile
    val basePrefix = if (baseCanonical.path.endsWith(File.separator)) baseCanonical.path else baseCanonical.path + File.separator
    if (targetCanonical.parentFile != baseCanonical || !targetCanonical.path.startsWith(basePrefix)) {
        throw SecurityException("更新包目标路径越界")
    }
    return targetCanonical
}

private fun readUtf8Bounded(input: InputStream, maxBytes: Int, label: String): String {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(16 * 1024)
    var total = 0
    while (true) {
        val n = input.read(buf)
        if (n < 0) break
        total += n
        if (total > maxBytes) throw IllegalStateException("$label 响应体积超过限制")
        out.write(buf, 0, n)
    }
    return out.toByteArray().toString(Charsets.UTF_8)
}

/**
 * APK 在线更新。更新源是一个 JSON（BuildConfig.UPDATE_FEED：构建期 CHISABOT_ANDROID_UPDATE_FEED，
 * 否则 GitHub Releases 的 latest/download/chisabot-android.json；都没有就不检查）：
 * {"version":"0.1.0","versionCode":206,"url":"ChisaBot-Android-0.1.0.apk","sha256":"…","notes":"…"}
 * url 可以是相对地址（相对 latest.json）。versionCode 比本机大才提示；下载后校验 sha256 再交给系统安装器
 * （同一把签名密钥才能覆盖安装）。
 */
class Updater(private val activity: Activity) {

    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var waitingForPermission: File? = null
    private var activeDialog: AlertDialog? = null
    @Volatile private var downloading = false
    @Volatile private var closed = false

    private fun alive(): Boolean = !closed && !activity.isFinishing && !activity.isDestroyed

    private fun dismissActiveDialog() {
        val dlg = activeDialog
        activeDialog = null
        if (dlg != null && dlg.isShowing) {
            runCatching { dlg.dismiss() }
        }
    }

    private fun showDialog(dialog: AlertDialog): AlertDialog {
        dismissActiveDialog()
        activeDialog = dialog
        dialog.setOnDismissListener {
            if (activeDialog === dialog) activeDialog = null
        }
        dialog.show()
        return dialog
    }

    /** Activity 销毁时取消所有后台协程并释放 Dialog / Activity 引用，防止内存泄漏。 */
    fun close() {
        closed = true
        downloading = false
        waitingForPermission = null
        dismissActiveDialog()
        ioScope.cancel()
    }

    fun cancel() = close()

    data class Release(val version: String, val code: Int, val url: String, val sha256: String, val notes: String)

    fun check(silent: Boolean) {
        if (closed || downloading) return
        if (BuildConfig.UPDATE_FEED.isBlank()) {
            if (!silent) toast("这个版本没有配置更新源")
            return
        }
        ioScope.launch {
            val release = try {
                fetch()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                null
            }
            withContext(Dispatchers.Main) {
                if (!alive()) return@withContext
                when {
                    release == null -> if (!silent) toast("检查更新失败")
                    release.code <= BuildConfig.VERSION_CODE -> if (!silent) toast("已是最新版本 ${BuildConfig.VERSION_NAME}")
                    else -> prompt(release)
                }
            }
        }
    }

    fun onResume() {
        if (!alive()) return
        val apk = waitingForPermission ?: return
        if (canInstall()) {
            waitingForPermission = null
            installWithIoVerify(apk)
        }
    }

    private fun fetch(): Release {
        val feed = requireHttpsUpdateUrl(BuildConfig.UPDATE_FEED, "更新源")
        val conn = (feed.openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 10_000
            useCaches = false
            setRequestProperty("Cache-Control", "no-cache")
        }
        val text = try {
            requireHttpsUpdateUrl(conn.url.toString(), "更新源")
            conn.inputStream.use { readUtf8Bounded(it, MAX_UPDATE_FEED_BYTES, "更新源") }
        } finally {
            conn.disconnect()
        }
        val j = JSONObject(text)
        val version = validateUpdateVersion(j.getString("version"))
        val resolvedApkUrl = requireHttpsUpdateUrl(URL(feed, j.getString("url")).toString(), "更新包地址").toString()
        return Release(
            version = version,
            code = j.getInt("versionCode"),
            url = resolvedApkUrl,
            sha256 = j.getString("sha256").lowercase(),
            notes = j.optString("notes", ""),
        )
    }

    private fun prompt(r: Release) {
        if (!alive() || downloading) return
        val dialog = AlertDialog.Builder(activity)
            .setTitle("ChisaBot ${r.version} 可用")
            .setMessage(buildString {
                append("当前版本 ${BuildConfig.VERSION_NAME}")
                if (r.notes.isNotBlank()) append("\n\n").append(r.notes)
            })
            .setPositiveButton("下载并安装") { _, _ -> download(r) }
            .setNegativeButton("稍后", null)
            .create()
        showDialog(dialog)
    }

    private fun download(r: Release) {
        if (!alive() || downloading) return
        downloading = true
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        val label = TextView(activity).apply { text = "正在下载…" }
        val pad = (20 * activity.resources.displayMetrics.density).toInt()
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
            addView(label)
            addView(bar)
        }
        val dialog = showDialog(
            AlertDialog.Builder(activity)
                .setTitle("下载 ChisaBot ${r.version}")
                .setView(box)
                .setCancelable(false)
                .create(),
        )

        ioScope.launch {
            val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            var out: File? = null
            val finalResult: Result<String?> = try {
                val apkUrl = requireHttpsUpdateUrl(r.url, "更新包地址")
                val target = resolveSafeUpdateApkFile(dir, r.version)
                out = target
                val conn = (apkUrl.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                }
                val md = MessageDigest.getInstance("SHA-256")
                try {
                    requireHttpsUpdateUrl(conn.url.toString(), "更新包地址")
                    val total = conn.contentLengthLong
                    conn.inputStream.use { input ->
                        target.outputStream().use { output ->
                            val buf = ByteArray(64 * 1024)
                            var done = 0L
                            var last = -1
                            var lastUiAt = 0L
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val n = input.read(buf)
                                if (n < 0) break
                                output.write(buf, 0, n)
                                md.update(buf, 0, n)
                                done += n
                                if (total > 0) {
                                    val pct = (done * 100 / total).toInt()
                                    val nowMs = SystemClock.uptimeMillis()
                                    if (pct != last && (nowMs - lastUiAt >= 100L || pct >= 100)) {
                                        last = pct
                                        lastUiAt = nowMs
                                        withContext(Dispatchers.Main) {
                                            if (alive() && dialog.isShowing) {
                                                bar.progress = pct
                                                label.text = "正在下载… $pct%"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } finally {
                    conn.disconnect()
                }
                val hex = md.digest().joinToString("") { "%02x".format(it) }
                check(hex == r.sha256) { "校验失败（sha256 不一致）" }
                // 将 getPackageArchiveInfo APK 证书解析放在 Dispatchers.IO，避免阻塞 UI 线程 100–500ms。
                Result.success(signatureProblem(target))
            } catch (e: CancellationException) {
                out?.delete()
                throw e
            } catch (t: Throwable) {
                Result.failure(t)
            }
            withContext(Dispatchers.Main) {
                downloading = false
                if (activeDialog === dialog) dismissActiveDialog() else if (alive() && dialog.isShowing) runCatching { dialog.dismiss() }
                if (!alive()) {
                    out?.delete()
                    return@withContext
                }
                finalResult.onSuccess { sigError ->
                    val target = out
                    if (sigError != null || target == null) {
                        target?.delete()
                        toast(sigError ?: "更新下载失败")
                    } else {
                        launchInstaller(target)
                    }
                }.onFailure {
                    out?.delete()
                    toast("更新下载失败：${it.message}")
                }
            }
        }
    }

    private fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    /** 在 Dispatchers.IO 复验 APK 签名后再切主线程拉起系统安装器（如从未知来源权限页返回时）。 */
    private fun installWithIoVerify(apk: File) {
        ioScope.launch {
            val sigError = signatureProblem(apk)
            withContext(Dispatchers.Main) {
                if (!alive()) return@withContext
                if (sigError != null) {
                    apk.delete()
                    toast(sigError)
                } else {
                    launchInstaller(apk)
                }
            }
        }
    }

    private fun launchInstaller(apk: File) {
        if (!alive()) return
        if (!canInstall()) {
            waitingForPermission = apk
            val dialog = AlertDialog.Builder(activity)
                .setTitle("需要安装权限")
                .setMessage("请允许 ChisaBot 安装应用，返回后会自动继续安装更新。")
                .setPositiveButton("去设置") { _, _ ->
                    activity.startActivity(
                        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                    )
                }
                .setNegativeButton("取消") { _, _ -> waitingForPermission = null }
                .create()
            showDialog(dialog)
            return
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { activity.startActivity(intent) }.onFailure { toast("无法打开安装器：${it.message}") }
    }

    /**
     * sha256 只保证下载没坏；装不上的两种签名问题在这里先说清楚：
     * 更新包没签名（CI 没配 keystore）；签名和当前安装的不一致（换了签名渠道，覆盖安装必失败）。
     */
    @Suppress("DEPRECATION") // GET_SIGNATURES 在 API 28+ 已过时、旧签名 getPackage*(int) 在 API 33+ 已过时，老系统还需要
    private fun signatureProblem(apk: File): String? {
        val update = readPackageInfo(apk.absolutePath)?.let(::firstSigner)
            ?: return "更新包没有签名或已损坏，无法安装"
        val mine = readPackageInfo(null)?.let(::firstSigner)
        if (mine != null && !mine.contentEquals(update)) {
            return "更新包签名和当前安装的不一致，无法覆盖安装——请先卸载，再安装同一个渠道出的包"
        }
        return null
    }

    /** path=null 读本机自己，否则读磁盘上的安装包。 */
    @Suppress("DEPRECATION")
    private fun readPackageInfo(path: String?): PackageInfo? {
        val pm = activity.packageManager
        val flags = PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val f = PackageManager.PackageInfoFlags.of(flags.toLong())
                if (path == null) pm.getPackageInfo(activity.packageName, f) else pm.getPackageArchiveInfo(path, f)
            } else if (path == null) pm.getPackageInfo(activity.packageName, flags) else pm.getPackageArchiveInfo(path, flags)
        }.getOrNull()
    }

    /** 包的第一位签名者证书（API 28+ signingInfo，以下用老 signatures；都没 → 未签名）。 */
    private fun firstSigner(info: PackageInfo): ByteArray? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.let { si -> (if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory)?.firstOrNull()?.toByteArray() }
        } else {
            @Suppress("DEPRECATION") info.signatures?.firstOrNull()?.toByteArray()
        }

    private fun toast(msg: String) = Toast.makeText(activity, msg, Toast.LENGTH_LONG).show()
}
