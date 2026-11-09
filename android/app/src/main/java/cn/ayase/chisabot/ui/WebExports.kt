package cn.ayase.chisabot.ui

import android.util.Base64
import android.webkit.WebView
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import org.json.JSONTokener
import kotlin.coroutines.resume

internal data class WebExport(val name: String, val mime: String, val bytes: ByteArray)

/** A picker hint only: generic browser MIME must not append .txt to a named code export. */
internal fun webExportPickerMime(name: String, source: String): String {
    val mime = source.substringBefore(';').trim().lowercase()
    if (mime !in setOf("text/plain", "application/octet-stream")) return mime
    return when (name.substringAfterLast('.', "").lowercase()) {
        "js", "mjs", "cjs" -> "application/javascript"
        "json" -> "application/json"
        "html", "htm" -> "text/html"
        "css" -> "text/css"
        "csv" -> "text/csv"
        "md" -> "text/markdown"
        "svg" -> "image/svg+xml"
        else -> mime
    }
}

/** Capture only a user-triggered, same-origin blob link before the page revokes its URL. */
internal fun installWebExportCapture(view: WebView) {
    view.evaluateJavascript("""
        (() => {
          if (window.__chisabotExports) return;
          const entries = new Map();
          const prepare = anchor => {
            if (!navigator.userActivation.isActive || !anchor.hasAttribute('download')) return;
            const url = anchor.href;
            if (!url.startsWith('blob:') || new URL(url).origin !== location.origin || entries.has(url)) return;
            const entry = { state: 'pending', name: anchor.download || '下载内容' };
            entries.set(url, entry);
            setTimeout(() => entries.delete(url), 60000);
            fetch(url).then(response => response.blob()).then(blob => {
              if (blob.size > 20 * 1024 * 1024) throw new Error('这个导出超过 20 MB，请从桌面浏览器下载。');
              entry.mime = blob.type || 'application/octet-stream';
              const reader = new FileReader();
              reader.onload = () => { entry.data = reader.result; entry.state = 'ready'; };
              reader.onerror = () => { entry.error = '无法读取导出内容，请重试。'; entry.state = 'error'; };
              reader.readAsDataURL(blob);
            }).catch(error => { entry.error = error.message; entry.state = 'error'; });
          };
          document.addEventListener('click', event => {
            const anchor = event.target.closest?.('a[download]');
            if (anchor) prepare(anchor);
          }, true);
          const click = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function() { prepare(this); return click.call(this); };
          window.__chisabotExports = {
            read(url) { const entry = entries.get(url); if (entry?.state !== 'pending') entries.delete(url); return entry || null; }
          };
        })()
    """.trimIndent(), null)
}

/** No JavascriptInterface: the app pulls only the blob named by WebView's download callback. */
internal suspend fun readWebExport(view: WebView, url: String): WebExport {
    repeat(100) {
        val raw = suspendCancellableCoroutine<String?> { continuation ->
            view.evaluateJavascript("JSON.stringify(window.__chisabotExports?.read(${JSONObject.quote(url)}) ?? null)") {
                if (continuation.isActive) continuation.resume(it)
            }
        }
        val decoded = raw?.let { JSONTokener(it).nextValue() as? String }
        val entry = decoded?.takeIf { it != "null" }?.let(::JSONObject)
        when (entry?.optString("state")) {
            "ready" -> {
                val data = entry.getString("data")
                val bytes = Base64.decode(data.substringAfter(','), Base64.DEFAULT)
                val name = entry.getString("name").substringAfterLast('/').substringAfterLast('\\')
                    .replace(Regex("[\\x00-\\x1f\\x7f]"), "").ifBlank { "下载内容" }
                return WebExport(name, entry.getString("mime"), bytes)
            }
            "error" -> throw IllegalStateException(entry.optString("error", "无法读取导出内容，请重试。"))
        }
        delay(100)
    }
    throw IllegalStateException("导出内容已失效，请重新点击下载。")
}
