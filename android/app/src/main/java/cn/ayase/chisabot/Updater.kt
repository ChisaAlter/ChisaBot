package cn.ayase.chisabot

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * APK 在线更新。更新源是一个 JSON（BuildConfig.UPDATE_FEED：构建期 CHISABOT_ANDROID_UPDATE_FEED，
 * 否则 GitHub Releases 的 latest/download/chisabot-android.json；都没有就不检查）：
 * {"version":"0.1.0","versionCode":206,"url":"ChisaBot-Android-0.1.0.apk","sha256":"…","notes":"…"}
 * url 可以是相对地址（相对 latest.json）。versionCode 比本机大才提示；下载后校验 sha256 再交给系统安装器
 * （同一把签名密钥才能覆盖安装）。
 */
class Updater(private val activity: Activity) {

    private val main = Handler(Looper.getMainLooper())
    private var waitingForPermission: File? = null
    @Volatile private var downloading = false

    private fun alive(): Boolean = !activity.isFinishing && !activity.isDestroyed

    data class Release(val version: String, val code: Int, val url: String, val sha256: String, val notes: String)

    fun check(silent: Boolean) {
        if (downloading) return
        if (BuildConfig.UPDATE_FEED.isBlank()) {
            if (!silent) toast("这个版本没有配置更新源")
            return
        }
        thread(name = "update-check") {
            val release = runCatching { fetch() }.getOrNull()
            main.post {
                if (!alive()) return@post
                when {
                    release == null -> if (!silent) toast("检查更新失败")
                    release.code <= BuildConfig.VERSION_CODE -> if (!silent) toast("已是最新版本 ${BuildConfig.VERSION_NAME}")
                    else -> prompt(release)
                }
            }
        }
    }

    fun onResume() {
        val apk = waitingForPermission ?: return
        if (canInstall()) {
            waitingForPermission = null
            install(apk)
        }
    }

    private fun fetch(): Release {
        val feed = URL(BuildConfig.UPDATE_FEED)
        val conn = (feed.openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 10_000
            useCaches = false
            setRequestProperty("Cache-Control", "no-cache")
        }
        val text = conn.inputStream.bufferedReader().use { it.readText() }
        val j = JSONObject(text)
        return Release(
            version = j.getString("version"),
            code = j.getInt("versionCode"),
            url = URL(feed, j.getString("url")).toString(),
            sha256 = j.getString("sha256").lowercase(),
            notes = j.optString("notes", ""),
        )
    }

    private fun prompt(r: Release) {
        if (!alive() || downloading) return
        AlertDialog.Builder(activity)
            .setTitle("ChisaBot ${r.version} 可用")
            .setMessage(buildString {
                append("当前版本 ${BuildConfig.VERSION_NAME}")
                if (r.notes.isNotBlank()) append("\n\n").append(r.notes)
            })
            .setPositiveButton("下载并安装") { _, _ -> download(r) }
            .setNegativeButton("稍后", null)
            .show()
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
        val dialog = AlertDialog.Builder(activity)
            .setTitle("下载 ChisaBot ${r.version}")
            .setView(box)
            .setCancelable(false)
            .show()

        thread(name = "update-download") {
            val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val out = File(dir, "ChisaBot-Android-${r.version}.apk")
            val result = runCatching {
                val conn = (URL(r.url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                }
                val total = conn.contentLengthLong
                val md = MessageDigest.getInstance("SHA-256")
                conn.inputStream.use { input ->
                    out.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        var done = 0L
                        var last = -1
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            output.write(buf, 0, n)
                            md.update(buf, 0, n)
                            done += n
                            if (total > 0) {
                                val pct = (done * 100 / total).toInt()
                                if (pct != last) {
                                    last = pct
                                    main.post {
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
                val hex = md.digest().joinToString("") { "%02x".format(it) }
                check(hex == r.sha256) { "校验失败（sha256 不一致）" }
            }
            main.post {
                downloading = false
                if (alive() && dialog.isShowing) runCatching { dialog.dismiss() }
                if (!alive()) return@post
                result.onSuccess { install(out) }.onFailure {
                    out.delete()
                    toast("更新下载失败：${it.message}")
                }
            }
        }
    }

    private fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    private fun install(apk: File) {
        if (!alive()) return
        if (!canInstall()) {
            waitingForPermission = apk
            AlertDialog.Builder(activity)
                .setTitle("需要安装权限")
                .setMessage("请允许 ChisaBot 安装应用，返回后会自动继续安装更新。")
                .setPositiveButton("去设置") { _, _ ->
                    activity.startActivity(
                        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                    )
                }
                .setNegativeButton("取消") { _, _ -> waitingForPermission = null }
                .show()
            return
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { activity.startActivity(intent) }.onFailure { toast("无法打开安装器：${it.message}") }
    }

    private fun toast(msg: String) = Toast.makeText(activity, msg, Toast.LENGTH_LONG).show()
}
