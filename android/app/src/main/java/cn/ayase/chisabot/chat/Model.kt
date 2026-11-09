package cn.ayase.chisabot.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** 一次工具调用（AG-UI toolCalls[] + 对应的 tool 消息）。 */
data class ToolCall(
    val id: String,
    val name: String,
    val args: String = "",
    val result: String? = null,
    val ended: Boolean = false,
)

/** 用户消息里的附件（AG-UI image / document 段，source.url = /api/attachments/<id>）。 */
data class Attachment(val name: String, val mime: String, val url: String, val image: Boolean, val width: Int? = null, val height: Int? = null)

/** 界面用的一条消息（从 AG-UI Message 或流式事件来）。content = 原样的 AG-UI content（重新生成 / 编辑时原样重发附件段）。 */
data class ChatMessage(
    val id: String,
    val role: String,
    val text: String = "",
    val toolCalls: List<ToolCall> = emptyList(),
    val images: List<String> = emptyList(),
    val files: List<Attachment> = emptyList(),
    val content: JsonElement? = null,
)

/** 服务器放进对话、以 user 角色出现但不是人说的消息（DESIGN §68.2）：画成一行淡色小字，不给编辑。 */
object ServerRows {
    private const val SCHEDULE = "⟦chisabot:schedule:"
    private const val WORKER = "⟦chisabot:worker-result:"
    private const val LOCAL_AGENT = "⟦chisabot:local-agent-result:"
    private const val CONFIRM = "⟦chisabot:confirm:"
    /** 定时 / 长期任务 / 跟进到点那一轮的触发帧（shared/routine-firing.ts 的首句），不是人打的字。 */
    private const val FIRING = "One of your routines is firing right now"

    fun isServerRow(text: String) = text.startsWith(SCHEDULE) || text.startsWith(WORKER) || text.startsWith(LOCAL_AGENT) || text.startsWith(CONFIRM) || text.startsWith(FIRING)

    /** 那一行显示的话。 */
    fun label(text: String): String = when {
        text.startsWith(CONFIRM) -> Regex("用户确认了「([^」]*)」").find(text)?.groupValues?.get(1)?.let { "你确认了「$it」，机器人接着做" } ?: "你确认了，机器人接着做"
        text.startsWith(SCHEDULE) -> "定时任务到点了，机器人开始做"
        text.startsWith(FIRING) -> "定时任务已运行，机器人开始做"
        text.startsWith(WORKER) -> "后台任务交回了结果"
        else -> "电脑上的助手交回了结果"
    }
}

/** 编辑后的内容（同网页 withEditedText）：纯文字直接换；带附件的只换文字段，附件原样保留。空 → null。 */
fun withEditedText(content: JsonElement?, text: String): JsonElement? {
    val said = text.trim()
    if (content !is JsonArray) return if (said.isNotEmpty()) JsonPrimitive(said) else null
    val parts = mutableListOf<JsonElement>()
    var placed = false
    for (part in content) {
        val isText = (part as? JsonObject)?.s("type") == "text"
        if (!isText) { parts += part; continue }
        if (!placed && said.isNotEmpty()) parts += JsonObject((part as JsonObject) + ("text" to JsonPrimitive(said)))
        placed = true
    }
    if (!placed && said.isNotEmpty()) parts.add(0, JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(said))))
    return if (parts.isEmpty()) null else JsonArray(parts)
}

fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
fun JsonObject.s(key: String): String? = this[key].str()
fun JsonObject.o(key: String): JsonObject? = this[key] as? JsonObject
fun JsonObject.a(key: String): JsonArray? = this[key] as? JsonArray

/** 工具结果里交付的文件（同 shared/chat-files.ts 的 ChatFileView 子集）。 */
data class ChatFile(
    val name: String,
    val mimeType: String,
    val url: String,
    val prompt: String? = null,
    val width: Int? = null,
    val height: Int? = null,
) { val image get() = mimeType.startsWith("image/") }

private const val CHAT_FILES_MARKER = "⟦chisabot:files⟧"
private const val CHAT_FILE_URL_PREFIX = "/api/chat-files/"

/** 工具结果最后一行的 `⟦chisabot:files⟧[…]` 清单（同网页 filesFromToolResult）；没有 / 解析失败返回空。 */
fun filesFromToolResult(raw: String?): List<ChatFile> {
    if (raw == null) return emptyList()
    val text = raw.trim().let { t ->
        if (t.startsWith("\"")) runCatching {
            (kotlinx.serialization.json.Json.parseToJsonElement(t) as? JsonPrimitive)?.contentOrNull
        }.getOrNull() ?: t else t
    }
    val at = text.lastIndexOf(CHAT_FILES_MARKER)
    if (at < 0) return emptyList()
    val arr = runCatching {
        kotlinx.serialization.json.Json.parseToJsonElement(text.substring(at + CHAT_FILES_MARKER.length).trim()) as? JsonArray
    }.getOrNull() ?: return emptyList()
    return arr.mapNotNull { el ->
        val f = el as? JsonObject ?: return@mapNotNull null
        val url = f.s("url")?.takeIf { it.startsWith(CHAT_FILE_URL_PREFIX) } ?: return@mapNotNull null
        ChatFile(
            name = f.s("name") ?: "文件",
            mimeType = f.s("mimeType") ?: "application/octet-stream",
            url = url,
            prompt = f.s("prompt"),
            width = f.s("width")?.toIntOrNull(), height = f.s("height")?.toIntOrNull(),
        )
    }
}

/** user 消息的 content 可能是字符串，也可能是 [{type:text,text}, {type:image|document, source:{type:url,value}, metadata}]。 */
fun contentParts(content: JsonElement?): Pair<String, List<String>> = contentAll(content).let { it.first to it.second }

/** 文字、图片地址、附件（图片也在附件里，带文件名）。 */
fun contentAll(content: JsonElement?): Triple<String, List<String>, List<Attachment>> {
    if (content == null || content is JsonNull) return Triple("", emptyList(), emptyList())
    if (content is JsonPrimitive) return Triple(content.contentOrNull ?: "", emptyList(), emptyList())
    val text = StringBuilder()
    val images = mutableListOf<String>()
    val files = mutableListOf<Attachment>()
    (content as? JsonArray)?.forEach { part ->
        val p = part as? JsonObject ?: return@forEach
        when (p.s("type")) {
            "text" -> p.s("text")?.let { if (text.isNotEmpty()) text.append("\n"); text.append(it) }
            else -> {
                val src = p.o("source")
                // AG-UI 0.0.5x：source = {type:"url", value} 或 {type:"data", value(base64)}；老格式 url / image_url.url
                val url = p.s("url") ?: src?.let { s -> if (s.s("type") == "data") s.s("value")?.let { v -> "data:${s.s("mimeType") ?: "application/octet-stream"};base64,$v" } else s.s("value") ?: s.s("url") } ?: p.o("image_url")?.s("url")
                val mime = p.s("mimeType") ?: src?.s("mimeType") ?: ""
                val isImage = p.s("type") == "image" || p.s("type") == "image_url" || mime.startsWith("image/")
                val meta = p.o("metadata")
                val name = meta?.s("filename") ?: if (isImage) "图片" else "文件"
                // 图片宽高（DESIGN §83.2，cb-img-dims：part 的 metadata.width / height）：有就按比例先留框，没有就固定方框
                val w = meta?.s("width")?.toDoubleOrNull()?.toInt()?.takeIf { it in 1..20000 }
                val h = meta?.s("height")?.toDoubleOrNull()?.toInt()?.takeIf { it in 1..20000 }
                if (url != null) {
                    if (isImage) images += url
                    files += Attachment(name, mime, url, isImage, if (w != null && h != null) w else null, if (w != null && h != null) h else null)
                }
            }
        }
    }
    return Triple(text.toString(), images, files)
}

/** GET /api/conversations/threads/<id>/messages 的 messages[] → 界面消息（tool 结果并进对应的调用）。 */
fun parseHistory(messages: JsonArray): List<ChatMessage> {
    val out = mutableListOf<ChatMessage>()
    val results = HashMap<String, String>()
    for (el in messages) {
        val m = el as? JsonObject ?: continue
        if (m.s("role") == "tool") m.s("toolCallId")?.let { results[it] = m["content"].let { c -> c.str() ?: c.toString() } }
    }
    for (el in messages) {
        val m = el as? JsonObject ?: continue
        val role = m.s("role") ?: continue
        if (role == "tool" || role == "system" || role == "developer") continue
        val (text, images, files) = contentAll(m["content"])
        val calls = m.a("toolCalls")?.mapNotNull { c ->
            val call = c as? JsonObject ?: return@mapNotNull null
            val id = call.s("id") ?: return@mapNotNull null
            val fn = call.o("function")
            ToolCall(id, fn?.s("name") ?: "", fn?.s("arguments") ?: "", results[id], ended = true)
        } ?: emptyList()
        out += ChatMessage(m.s("id") ?: "m${out.size}", role, text, calls, images, files, m["content"])
    }
    return out
}

/**
 * AG-UI 事件 → 消息列表（纯函数，便于单测）。只处理画面需要的事件；其余（STATE_*、ACTIVITY_*、REASONING_* …）忽略。
 */
class AgUiReducer(initial: List<ChatMessage> = emptyList()) {
    val messages = initial.toMutableList()
    var running = false
        private set
    var error: String? = null
        private set
    var finished = false
        private set

    private fun indexOf(id: String) = messages.indexOfFirst { it.id == id }

    private fun ensureAssistant(id: String?): Int {
        if (id != null) {
            val at = indexOf(id)
            if (at >= 0) return at
            messages += ChatMessage(id, "assistant")
            return messages.lastIndex
        }
        val last = messages.lastIndex
        if (last >= 0 && messages[last].role == "assistant") return last
        messages += ChatMessage("a${messages.size}", "assistant")
        return messages.lastIndex
    }

    private fun updateCall(callId: String, change: (ToolCall) -> ToolCall) {
        for (i in messages.indices.reversed()) {
            val m = messages[i]
            val at = m.toolCalls.indexOfFirst { it.id == callId }
            if (at >= 0) {
                messages[i] = m.copy(toolCalls = m.toolCalls.toMutableList().also { it[at] = change(it[at]) })
                return
            }
        }
    }

    fun apply(event: JsonObject) {
        when (event.s("type")) {
            "RUN_STARTED" -> { running = true; error = null }
            "RUN_FINISHED" -> { running = false; finished = true }
            "RUN_ERROR" -> { running = false; finished = true; error = event.s("message") ?: "这一轮没有完成" }
            "TEXT_MESSAGE_START" -> { if ((event.s("role") ?: "assistant") == "assistant") ensureAssistant(event.s("messageId")) }
            "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK" -> {
                val delta = event.s("delta") ?: return
                val at = ensureAssistant(event.s("messageId"))
                messages[at] = messages[at].copy(text = messages[at].text + delta)
            }
            "TOOL_CALL_START", "TOOL_CALL_CHUNK" -> {
                val id = event.s("toolCallId") ?: return
                if (messages.any { m -> m.toolCalls.any { it.id == id } }) {
                    event.s("delta")?.let { d -> updateCall(id) { it.copy(args = it.args + d) } }
                    return
                }
                val at = ensureAssistant(event.s("parentMessageId"))
                val call = ToolCall(id, event.s("toolCallName") ?: "", event.s("delta") ?: "")
                messages[at] = messages[at].copy(toolCalls = messages[at].toolCalls + call)
            }
            "TOOL_CALL_ARGS" -> {
                val id = event.s("toolCallId") ?: return
                val d = event.s("delta") ?: return
                updateCall(id) { it.copy(args = it.args + d) }
            }
            "TOOL_CALL_END" -> event.s("toolCallId")?.let { id -> updateCall(id) { it.copy(ended = true) } }
            "TOOL_CALL_RESULT" -> event.s("toolCallId")?.let { id ->
                val content = event["content"].let { c -> c.str() ?: c.toString() }
                updateCall(id) { it.copy(result = content, ended = true) }
            }
            "MESSAGES_SNAPSHOT" -> event.a("messages")?.let { snap ->
                val parsed = parseHistory(snap)
                if (parsed.isNotEmpty()) { messages.clear(); messages.addAll(parsed) }
            }
        }
    }
}
