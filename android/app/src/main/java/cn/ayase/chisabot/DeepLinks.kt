package cn.ayase.chisabot

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * 跨端深链与系统分享模型（与 `shared/notifications.ts` 保持协议一致）：
 * - `chisabot://agent/<id>` -> `/channel/new?agent=<id>`
 * - `chisabot://channel/<id>[?agent=<id>]` -> `/channel/<id>`
 */
sealed class ChisaDeepLink {
    data class Agent(val agentId: String) : ChisaDeepLink()
    data class Channel(val channelId: String, val agentId: String? = null) : ChisaDeepLink()

    fun toWebPath(): String = when (this) {
        is Agent -> "/channel/new?agent=${URLEncoder.encode(agentId, "UTF-8")}"
        is Channel -> "/channel/${URLEncoder.encode(channelId, "UTF-8")}"
    }
}

/** 外部应用通过 `ACTION_SEND` 分享到 ChisaBot 的待预填草稿。 */
data class ShareDraft(
    val id: String,
    val text: String? = null,
    val imageName: String? = null,
    val imageMime: String? = null,
    val imageBase64: String? = null,
)

object DeepLinks {
    private val SAFE_ID = Regex("^[A-Za-z0-9._:-]{1,200}$")

    fun parse(raw: String?): ChisaDeepLink? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty() || text.length > 2048) return null
        if (text.any { it.code < 0x20 || it.code == 0x7f }) return null
        val uri = runCatching { URI(text) }.getOrNull() ?: return null
        if (!uri.scheme.equals("chisabot", ignoreCase = true)) return null
        if (!uri.userInfo.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) return null

        val host = uri.host?.lowercase() ?: return null
        if (host != "agent" && host != "channel") return null

        val rawSegments = uri.rawPath.orEmpty().split('/').filter { it.isNotEmpty() }
        if (rawSegments.size != 1) return null
        val decodedId = runCatching {
            URLDecoder.decode(rawSegments[0].replace("+", "%2B"), "UTF-8")
        }.getOrNull() ?: return null
        if (!SAFE_ID.matches(decodedId) || decodedId == "." || decodedId == "..") return null

        if (host == "agent") {
            if (!uri.rawQuery.isNullOrEmpty()) return null
            return ChisaDeepLink.Agent(decodedId)
        }

        val queryParams = uri.rawQuery.orEmpty().split('&').mapNotNull { entry ->
            val eq = entry.indexOf('=')
            if (eq <= 0) null
            else entry.substring(0, eq) to runCatching {
                URLDecoder.decode(entry.substring(eq + 1).replace("+", "%2B"), "UTF-8")
            }.getOrNull().orEmpty()
        }.toMap()
        val agentParam = queryParams["agent"]?.trim()?.takeIf { it.isNotEmpty() }
        if (agentParam != null && !SAFE_ID.matches(agentParam)) return null
        return ChisaDeepLink.Channel(decodedId, agentParam)
    }
}
