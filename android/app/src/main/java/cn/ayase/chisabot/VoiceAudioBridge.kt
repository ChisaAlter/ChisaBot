package cn.ayase.chisabot

import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.net.URI

/** 「协议://主机:端口」，主机小写、默认端口补齐；解析不了返回 null。 */
internal fun normalizeVoiceOriginKey(origin: String?): String? {
    val uri = runCatching { URI(origin?.trim().orEmpty()) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    val host = uri.host?.lowercase() ?: return null
    if (scheme != "https" && scheme != "http") return null
    val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80
    return "$scheme://$host:$port"
}

/**
 * WebView 受限同源语音音频桥：
 * - 仅允许当前主框架 URL 与配置的服务器 origin 一致时调用原生音频能力；
 * - 暴露首选约束（`native-aec3-v1` / `web-aec-v1` 与 AEC/NS/AGC 约束）及通信音频焦点开关。
 */
class VoiceAudioBridge(
    private val audioManager: VoiceCallAudioManager,
    allowedOrigin: String,
    private val currentMainFrameUrl: () -> String?,
) {
    private val expectedOriginKey: String? = normalizeVoiceOriginKey(allowedOrigin)

    internal fun isSameOrigin(): Boolean {
        val expected = expectedOriginKey ?: return false
        val current = normalizeVoiceOriginKey(currentMainFrameUrl()) ?: return false
        return current == expected
    }

    @JavascriptInterface
    fun getPreferredConstraints(): String? {
        if (!isSameOrigin()) return null
        return JSONObject().apply {
            put("audioProcessing", audioManager.negotiatedAudioProcessing())
            put(
                "constraints",
                JSONObject().apply {
                    put("echoCancellation", true)
                    put("noiseSuppression", true)
                    put("autoGainControl", true)
                },
            )
        }.toString()
    }

    @JavascriptInterface
    fun acquireCommunicationAudio(speakerphoneOn: Boolean): Boolean {
        if (!isSameOrigin()) return false
        return audioManager.acquireCommunicationAudio(speakerphoneOn)
    }

    @JavascriptInterface
    fun releaseCommunicationAudio() {
        if (!isSameOrigin()) return
        audioManager.release()
    }
}
