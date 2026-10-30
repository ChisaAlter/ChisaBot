package cn.ayase.chisabot

import android.app.Application
import android.content.Context
import android.webkit.CookieManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import android.net.Uri
import android.provider.OpenableColumns
import cn.ayase.chisabot.chat.AgUiReducer
import cn.ayase.chisabot.chat.Attachment
import cn.ayase.chisabot.chat.ChatMessage
import cn.ayase.chisabot.chat.ConfirmCard
import cn.ayase.chisabot.chat.contentAll
import cn.ayase.chisabot.chat.withEditedText
import cn.ayase.chisabot.net.ApiError
import kotlinx.serialization.json.JsonElement
import cn.ayase.chisabot.chat.a
import cn.ayase.chisabot.chat.o
import cn.ayase.chisabot.chat.parseHistory
import cn.ayase.chisabot.chat.s
import cn.ayase.chisabot.net.Api
import cn.ayase.chisabot.net.Unauthorized
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import cn.ayase.chisabot.ui.AvatarShapes
import okhttp3.Call
import java.util.UUID

private val Context.store by preferencesDataStore("native")
private val BOTS_CACHE = stringPreferencesKey("bots")

/**
 * 机器人头像（DESIGN §81，GET /api/bot-avatars）：image = 上传的图（url 相对路径，带 ?v= 版本），emoji / monogram = 渐变底 + 字，
 * shape = 形象（形状 + 形象底色的键名，见 ui/ShapeAvatar.kt）。null = 默认（按 avatarSeed）。
 */
data class BotAvatarSpec(val kind: String, val url: String? = null, val emoji: String? = null, val color: String? = null, val shape: String? = null)

data class Bot(val id: String, val name: String, val title: String, val seed: String, val main: Boolean, val avatar: BotAvatarSpec? = null)

internal fun parseAvatar(el: kotlinx.serialization.json.JsonElement?): BotAvatarSpec? {
    val o = el as? JsonObject ?: return null
    val kind = o.s("kind") ?: return null
    if (kind == "shape") {
        // 形状或颜色是这版不认识的（服务器以后加了新的）：退回默认头像，不乱画。
        val shape = o.s("shape")
        val color = o.s("color")
        if (!AvatarShapes.isShape(shape) || !AvatarShapes.isColor(color)) return null
        return BotAvatarSpec(kind, color = color, shape = shape)
    }
    if (kind !in setOf("image", "emoji", "monogram")) return null
    return BotAvatarSpec(kind, o.s("url"), o.s("emoji"), o.s("color"))
}

data class Panel(
    val id: String, val title: String, val status: String, val spec: String?, val sources: List<Pair<String, String>>,
    val refreshedAt: String?, val refreshMinutes: Int?, val refreshAt: String?, val refreshing: Boolean, val error: String?,
)

sealed class Screen {
    data object Login : Screen()
    data object Bots : Screen()
    data class Chat(val bot: Bot) : Screen()
    data class Panels(val bot: Bot) : Screen()
    data class Web(val path: String, val title: String) : Screen()
    data object Settings : Screen()
}

/** 输入框上方待发的附件（§56）：选了就上传，传好才能发。 */
data class PendingFile(
    val localId: String, val uri: String, val name: String, val mime: String, val image: Boolean, val size: Long,
    val state: String = "uploading", // uploading | ready | failed
    val serverId: String? = null, val error: String? = null,
    val width: Int? = null, val height: Int? = null,
)

/** 设置 → 设备（只读）。 */
data class DeviceRow(val id: String, val name: String, val platform: String, val online: Boolean, val paused: Boolean, val lastSeenAt: String?, val clientVersion: String?, val thisPhone: Boolean)

/**
 * 整个应用的状态。登录信息沿用 WebView 版的 SharedPreferences「chisabot」（同一组键）和 CookieManager，
 * 原生版只多一个 DataStore「native」缓存机器人列表（冷启动先画缓存，不白屏）。
 */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    val prefs = app.getSharedPreferences("chisabot", Context.MODE_PRIVATE)
    private val ctx get() = getApplication<Application>()

    val stack = mutableStateListOf<Screen>()
    val screen: Screen get() = stack.lastOrNull() ?: Screen.Login
    var notice by mutableStateOf("")

    val server: String get() = prefs.getString("server", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.DEFAULT_SERVER
    fun origin(): String? = runCatching { GatewayAuth.normalize(server) }.getOrNull()

    private var apiCache: Api? = null
    val api: Api?
        get() {
            val o = origin() ?: return null
            if (apiCache?.origin != o) apiCache = Api(o) { renewWithDevice(o) }
            cn.ayase.chisabot.net.currentOrigin = o
            return apiCache
        }

    // ---------- 登录 ----------

    private val deviceToken: String?
        get() = prefs.getString("deviceToken", null)?.takeIf { it.startsWith("cbd_") && prefs.getString("deviceServer", null) == origin() }

    private var lastRenewAt = 0L
    /** 会话没了：用扫码绑定的设备令牌静默换一个（60 秒内最多一次）。 */
    private suspend fun renewWithDevice(o: String): Boolean = withContext(Dispatchers.IO) {
        val token = deviceToken ?: return@withContext false
        if (System.currentTimeMillis() - lastRenewAt < 60_000) return@withContext false
        lastRenewAt = System.currentTimeMillis()
        try {
            setCookies(o, GatewayAuth.deviceSession(o, token, Pairing.osVersion()))
            true
        } catch (e: GatewayAuth.LoginError) {
            if (e.kind == "revoked") {
                prefs.edit().remove("deviceToken").remove("deviceServer").remove("deviceId").remove("deviceName").apply()
                withContext(Dispatchers.Main) { notice = e.message ?: "" }
            }
            false
        } catch (_: Exception) { false }
    }

    private fun setCookies(o: String, lines: List<String>) {
        val cm = CookieManager.getInstance()
        for (line in lines) cm.setCookie("$o/", line)
        cm.flush()
    }

    fun start() {
        if (stack.isNotEmpty()) return
        if (prefs.getString("server", null).isNullOrBlank()) { stack += Screen.Login; return }
        stack += Screen.Bots
        viewModelScope.launch {
            runCatching { ctx.store.data.first()[BOTS_CACHE] }.getOrNull()?.let { cached ->
                runCatching { bots = parseBots(Api.json.parseToJsonElement(cached) as JsonArray) }
            }
            loadBots()
        }
    }

    fun recentServers(): List<String> = runCatching {
        org.json.JSONArray(prefs.getString("recent", "[]")).let { arr -> (0 until arr.length()).map { arr.getString(it) } }
    }.getOrDefault(emptyList())

    private fun saveRecent(o: String) {
        val list = listOf(o) + recentServers().filter { it != o }
        prefs.edit().putString("recent", org.json.JSONArray(list.take(6)).toString()).apply()
    }

    /** 扫码 / 系统相机链接：绑定码 → 设备令牌 → 网关会话（和 WebView 版同一套请求）。 */
    suspend fun pair(link: Pairing.Link) = withContext(Dispatchers.IO) {
        val os = Pairing.osVersion()
        val paired = GatewayAuth.pair(link.server, link.code, Pairing.deviceName(ctx.contentResolver), Pairing.model(), os)
        val oldToken = prefs.getString("deviceToken", null)
        val oldServer = prefs.getString("deviceServer", null)
        if (oldToken != null && oldServer != null) GatewayAuth.unenroll(oldServer, oldToken)
        prefs.edit().putString("deviceToken", paired.token).putString("deviceServer", link.server)
            .putString("deviceId", paired.deviceId).putString("deviceName", paired.deviceName).apply()
        setCookies(link.server, GatewayAuth.deviceSession(link.server, paired.token, os))
        prefs.edit().putString("server", link.server).putBoolean("remember", true).putBoolean("loggedIn", true).apply()
        saveRecent(link.server)
    }

    suspend fun passwordLogin(serverInput: String, username: String, password: String, remember: Boolean) = withContext(Dispatchers.IO) {
        val o = GatewayAuth.normalize(serverInput)
        GatewayAuth.probe(o, null)
        setCookies(o, GatewayAuth.login(o, username.trim(), password, remember))
        val oldServer = prefs.getString("deviceServer", null)
        if (oldServer != null && oldServer != o) prefs.getString("deviceToken", null)?.let { GatewayAuth.unenroll(oldServer, it) }
        prefs.edit().putString("server", o).putString("username", username.trim()).putBoolean("remember", remember).putBoolean("loggedIn", true).apply()
        saveRecent(o)
    }

    /** 没有登录网关的服务器（自己部署、本机预览）：只记地址，直接进。 */
    suspend fun openWithoutGateway(serverInput: String) = withContext(Dispatchers.IO) {
        val o = GatewayAuth.normalize(serverInput)
        GatewayAuth.probe(o, null)
        prefs.edit().putString("server", o).putBoolean("loggedIn", true).apply()
        saveRecent(o)
    }

    fun enterApp() {
        notice = ""
        stack.clear(); stack += Screen.Bots
        bots = emptyList()
        viewModelScope.launch { loadBots() }
    }

    fun logout() {
        val o = origin()
        val token = deviceToken
        viewModelScope.launch(Dispatchers.IO) {
            if (o != null) {
                if (token != null) GatewayAuth.unenroll(o, token)
                GatewayAuth.logout(o, CookieManager.getInstance().getCookie("$o/"))
            }
        }
        prefs.edit().putBoolean("loggedIn", false).remove("deviceToken").remove("deviceServer").remove("deviceId").remove("deviceName").apply()
        CookieManager.getInstance().removeAllCookies(null)
        stopRun()
        stack.clear(); stack += Screen.Login
    }

    /** 会话失效（服务器把我们带回登录）：不解除绑定，只回登录页；有设备令牌时下次请求会先静默续期。 */
    fun expired() {
        stopRun()
        notice = if (notice.isNotBlank()) notice else "登录已过期，请重新登录或扫码绑定。"
        stack.clear(); stack += Screen.Login
    }

    // ---------- 导航 ----------
    fun push(s: Screen) { stack += s }
    fun back(): Boolean {
        if (stack.size <= 1) return false
        val top = stack.removeAt(stack.lastIndex)
        if (top is Screen.Chat) stopWatching()
        return true
    }

    // ---------- 机器人 ----------
    var bots by mutableStateOf<List<Bot>>(emptyList())
    var botsLoading by mutableStateOf(false)
    var botsError by mutableStateOf<String?>(null)

    private fun parseBots(arr: JsonArray, mainId: String? = null): List<Bot> {
        val list = arr.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            if (o["hidden"]?.toString() == "true") return@mapNotNull null
            Bot(o.s("id") ?: return@mapNotNull null, o.s("name") ?: "机器人", o.s("title") ?: "", o.s("avatarSeed") ?: "", o["main"]?.toString() == "true", parseAvatar(o["avatar"]))
        }
        val withMain = if (mainId != null) list.map { it.copy(main = it.id == mainId) } else list
        // 主机器人置顶（ADR-0001：左栏只列机器人，主机器人在最上面）
        return withMain.sortedByDescending { it.main }
    }

    fun loadBots() {
        val api = api ?: return
        botsLoading = true
        viewModelScope.launch {
            try {
                val agents = api.get("/api/agents").a("agents") ?: JsonArray(emptyList())
                val mainId = runCatching { api.get("/api/settings/preferences").o("preferences")?.s("mainBotId") }.getOrNull()
                // 头像是单独的接口（只列有自定义头像的机器人）；老服务器没有这个接口 → 全用默认头像。
                val avatars = runCatching { api.get("/api/bot-avatars").o("avatars") }.getOrNull()
                bots = parseBots(agents, mainId).map { b -> b.copy(avatar = parseAvatar(avatars?.get(b.id))) }
                botsError = null
                val cache = buildJsonArray { bots.forEach { b -> add(buildJsonObject { put("id", b.id); put("name", b.name); put("title", b.title); put("avatarSeed", b.seed); put("main", b.main)
                    b.avatar?.let { av -> put("avatar", buildJsonObject { put("kind", av.kind); av.url?.let { put("url", it) }; av.emoji?.let { put("emoji", it) }; av.color?.let { put("color", it) }; av.shape?.let { put("shape", it) } }) }
                }) } }
                ctx.store.edit { it[BOTS_CACHE] = cache.toString() }
            } catch (_: Unauthorized) {
                expired()
            } catch (e: Exception) {
                botsError = e.message ?: "无法加载机器人列表"
            } finally { botsLoading = false }
        }
    }

    // ---------- 聊天 ----------
    var chatBot by mutableStateOf<Bot?>(null)
    var threadId by mutableStateOf<String?>(null)
    var channelId by mutableStateOf<String?>(null)
    var messages by mutableStateOf<List<ChatMessage>>(emptyList())
    var running by mutableStateOf(false)
    var runError by mutableStateOf<String?>(null)
    var chatLoading by mutableStateOf(false)
    var chatLoadError by mutableStateOf<String?>(null)
    /** 这台手机上看着干活卡跑起来的时间（turnKey → 毫秒），收成一行时才能写用时（§70.2）。 */
    val workStarted = HashMap<String, Long>()
    val workEnded = HashMap<String, Long>()
    private var runJob: Job? = null
    private var watchJob: Job? = null
    private var liveCall: Call? = null

    fun openChat(bot: Bot) {
        stopRun()
        chatBot = bot; threadId = null; channelId = null; messages = emptyList(); runError = null; chatLoadError = null
        confirms = emptyMap(); files.clear(); confirmJob?.cancel()
        push(Screen.Chat(bot))
        loadChat(bot)
    }

    fun loadChat(bot: Bot) {
        val api = api ?: return
        chatLoading = true
        viewModelScope.launch {
            try {
                val channels = api.get("/api/channels?limit=100").a("channels") ?: JsonArray(emptyList())
                // 机器人这一行打开它最近的一对一会话（和网页 latestChannelFor 一样；列表按最近排序）
                val mine = channels.mapNotNull { it as? JsonObject }.filter { c ->
                    val ids = c.a("agentIds")?.map { (it as? JsonPrimitive)?.content }
                    ids?.size == 1 && ids[0] == bot.id
                }
                val chosen = mine.maxByOrNull { it.s("lastMessageAt") ?: "" } ?: mine.firstOrNull()
                val t = chosen?.s("threadId")
                threadId = t
                channelId = chosen?.s("id")
                if (t != null) {
                    val hist = api.get("/api/copilotkit/threads/$t/messages").a("messages") ?: JsonArray(emptyList())
                    if (!running) messages = parseHistory(hist)
                    val inbox = runCatching { api.get("/api/copilotkit/threads/$t/inbox") }.getOrNull()
                    if (inbox?.get("running")?.toString() == "true" && !running) watch(bot, t)
                    kickConfirms()
                }
                chatLoadError = null
            } catch (_: Unauthorized) { expired() }
            catch (e: Exception) { chatLoadError = e.message ?: "无法加载对话" }
            finally { chatLoading = false }
        }
    }

    /** 别的设备上正在回答（或刷新前开始的一轮）：每 1.5 秒读一次历史，直到这一轮结束。流式续接放到第二阶段。 */
    private fun watch(bot: Bot, t: String) {
        watchJob?.cancel()
        watchJob = viewModelScope.launch {
            val api = api ?: return@launch
            running = true
            kickConfirms()
            try {
                while (true) {
                    delay(1500)
                    if (chatBot?.id != bot.id || threadId != t) break
                    val hist = api.get("/api/copilotkit/threads/$t/messages").a("messages") ?: break
                    messages = parseHistory(hist)
                    val inbox = api.get("/api/copilotkit/threads/$t/inbox")
                    if (inbox["running"]?.toString() != "true") break
                }
            } catch (_: Exception) { } finally { running = false }
        }
    }

    private fun stopWatching() { watchJob?.cancel(); watchJob = null }

    /** 这段对话的会话（频道）：没有就先建一个一对一的（POST /api/channels）。附件要先有会话才能上传。 */
    private suspend fun ensureChannel(api: Api, bot: Bot): Pair<String, String> {
        val t = threadId; val c = channelId
        if (t != null && c != null) return c to t
        val created = api.post("/api/channels", buildJsonObject { putJsonArray("agentIds") { add(JsonPrimitive(bot.id)) } })
        val nt = created.o("channel")?.s("threadId") ?: throw IllegalStateException("无法开始会话")
        val nc = created.o("channel")?.s("id") ?: throw IllegalStateException("无法开始会话")
        threadId = nt; channelId = nc
        return nc to nt
    }

    /** 发一条：没有会话就先建，带上传好的附件（AG-UI image / document 段），然后 POST /api/copilotkit/agent/<bot>/run 读事件流。 */
    suspend fun send(text: String): Boolean {
        val bot = chatBot ?: return false
        val api = api ?: return false
        if (running) return false
        if (files.any { it.state == "uploading" }) return false
        val ready = files.filter { it.state == "ready" && it.serverId != null }
        if (text.isBlank() && ready.isEmpty()) return false
        runError = null
        try {
            val (_, t) = ensureChannel(api, bot)
            val content: JsonElement = if (ready.isEmpty()) JsonPrimitive(text) else buildJsonArray {
                if (text.isNotBlank()) add(buildJsonObject { put("type", "text"); put("text", text) })
                ready.forEach { f ->
                    add(buildJsonObject {
                        put("type", if (f.image) "image" else "document")
                        putJsonObject("source") { put("type", "url"); put("value", "/api/attachments/${f.serverId}"); put("mimeType", f.mime) }
                        putJsonObject("metadata") {
                            put("attachmentId", f.serverId); put("filename", f.name)
                            if (f.image && f.width != null && f.height != null) { put("width", f.width); put("height", f.height) }
                        }
                    })
                }
            }
            val (tx, imgs, fl) = contentAll(content)
            // 刚选的图先用本机的图显示（不等服务器那份），历史读回来后换成服务器地址
            val localFiles = fl.mapIndexed { i, a -> ready.getOrNull(i)?.let { a.copy(url = it.uri) } ?: a }
            val userMsg = ChatMessage(UUID.randomUUID().toString(), "user", tx, images = localFiles.filter { it.image }.map { it.url }, files = localFiles, content = content)
            files.clear(); uploadGroup = UUID.randomUUID().toString()
            startTurn(api, bot, t, userMsg)
            return true
        } catch (_: Unauthorized) { expired(); return false }
        catch (e: Exception) { runError = e.message ?: "发送失败"; return false }
    }

    private fun startTurn(api: Api, bot: Bot, t: String, userMsg: ChatMessage) {
        messages = messages + userMsg
        running = true
        stopping = false
        runJob = viewModelScope.launch { runTurn(api, bot, t, userMsg) }
        kickConfirms()
    }

    private suspend fun runTurn(api: Api, bot: Bot, t: String, userMsg: ChatMessage) {
        val reducer = AgUiReducer(messages)
        val body = buildJsonObject {
            put("threadId", t)
            put("runId", UUID.randomUUID().toString())
            // 服务器以存下的历史为准，客户端只追加新消息（server local-conversations.ts prepareConversationMessages）
            putJsonArray("messages") { add(buildJsonObject { put("id", userMsg.id); put("role", "user"); put("content", userMsg.content ?: JsonPrimitive(userMsg.text)) }) }
            putJsonArray("tools") {}
            putJsonArray("context") {}
            putJsonObject("state") {}
            putJsonObject("forwardedProps") {}
        }
        var lastPush = 0L
        try {
            api.stream("/api/copilotkit/agent/${bot.id}/run", body, onCall = { liveCall = it }) { event ->
                reducer.apply(event)
                val now = System.currentTimeMillis()
                // 每 50ms 最多推一次画面（逐字平滑由界面负责，§ streaming.md）
                if (now - lastPush >= 50 || event.s("type") == "RUN_FINISHED" || event.s("type")?.startsWith("TOOL_CALL") == true) {
                    lastPush = now
                    val snapshot = reducer.messages.toList()
                    withContext(Dispatchers.Main) { if (threadId == t) messages = snapshot }
                }
            }
            withContext(Dispatchers.Main) {
                if (threadId == t) {
                    messages = reducer.messages.toList()
                    runError = reducer.error
                }
            }
        } catch (_: Unauthorized) { withContext(Dispatchers.Main) { expired() } }
        catch (e: Exception) {
            withContext(Dispatchers.Main) {
                if (threadId == t && liveCall?.isCanceled() != true) runError = "连接断了：${e.message ?: e.javaClass.simpleName}"
            }
        } finally {
            withContext(Dispatchers.Main) {
                running = false
                stopping = false
                liveCall = null
                kickConfirms()
                // 读一次服务器存下的历史，让本机和别的设备一致（含 MESSAGES_SNAPSHOT 之外的整理）
                if (threadId == t) runCatching { api.get("/api/copilotkit/threads/$t/messages").a("messages") }.getOrNull()?.let {
                    val parsed = parseHistory(it)
                    if (parsed.isNotEmpty()) messages = parsed
                }
            }
        }
    }

    /** 停止（§38）：请服务器停这一轮（确认卡片一起作废），稍后断开本机的流。按钮在这期间显示「停止中」。 */
    var stopping by mutableStateOf(false)
    fun stop() {
        val bot = chatBot ?: return
        val t = threadId ?: return
        val api = api ?: return
        if (stopping) return
        stopping = true
        viewModelScope.launch {
            runCatching { api.post("/api/copilotkit/agent/${bot.id}/stop/$t") }
            delay(400)
            liveCall?.cancel()
            watchJob?.cancel()
            delay(2500)
            stopping = false
        }
    }

    // ---------- 重新生成 / 编辑后重发（§67）：服务器先截断，再用新 id 发一轮 ----------

    private suspend fun truncate(api: Api, t: String, fromId: String, mode: String) {
        try {
            api.post("/api/copilotkit/threads/$t/truncate", buildJsonObject { put("fromMessageId", fromId); put("mode", mode) })
        } catch (e: ApiError) {
            throw IllegalStateException(when (e.status) {
                409 -> e.message?.takeIf { Regex("[\\u4e00-\\u9fa5]").containsMatchIn(it) } ?: "机器人正在回答，等它说完再试。"
                404 -> "这条消息已经不在了（可能在别的设备上改过），刷新看看。"
                else -> "没能重发，稍后再试。"
            })
        }
    }

    /** 重新生成最后一轮：截掉最后一条用户消息那一轮，原内容（文字 + 附件段）换个新 id 重发。 */
    suspend fun regenerate(): Boolean {
        val bot = chatBot ?: return false; val api = api ?: return false; val t = threadId ?: return false
        if (running) return false
        val at = messages.indexOfLast { it.role == "user" && !cn.ayase.chisabot.chat.ServerRows.isServerRow(it.text) }
        if (at < 0) return false
        val last = messages[at]
        runError = null
        return try {
            truncate(api, t, last.id, "regenerate")
            messages = messages.take(at)
            startTurn(api, bot, t, last.copy(id = UUID.randomUUID().toString()))
            true
        } catch (_: Unauthorized) { expired(); false }
        catch (e: Exception) { notice = e.message ?: "没能重发"; false }
    }

    /** 编辑后重发：从这条起截掉，新文字（附件保留）作为新的一条发出。 */
    suspend fun editAndResend(messageId: String, text: String): Boolean {
        val bot = chatBot ?: return false; val api = api ?: return false; val t = threadId ?: return false
        if (running) return false
        val at = messages.indexOfFirst { it.id == messageId }
        if (at < 0) return false
        val old = messages[at]
        val content = withEditedText(old.content ?: JsonPrimitive(old.text), text) ?: return false
        runError = null
        return try {
            truncate(api, t, old.id, "edit")
            messages = messages.take(at)
            val (tx, imgs, fl) = contentAll(content)
            startTurn(api, bot, t, ChatMessage(UUID.randomUUID().toString(), "user", tx, images = imgs, files = fl, content = content))
            true
        } catch (_: Unauthorized) { expired(); false }
        catch (e: Exception) { notice = e.message ?: "没能重发"; false }
    }

    // ---------- 附件（§56）：选了就传到这段会话（POST /api/channels/<id>/attachments），传好才能发 ----------

    val files = mutableStateListOf<PendingFile>()
    private var uploadGroup = UUID.randomUUID().toString()
    private val imageMimes = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
    private val textMimes = setOf("text/plain", "text/markdown", "text/csv", "application/json")

    private fun guessMime(name: String, given: String?): String {
        val g = given?.lowercase()?.substringBefore(';')?.trim()
        if (!g.isNullOrBlank() && (g in imageMimes || g in textMimes)) return g
        // 文件管理器给的别名（text/comma-separated-values、text/x-markdown、text/x-java…）按扩展名再认一次
        val byExt = when (name.substringAfterLast('.', "").lowercase()) {
            "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"; "webp" -> "image/webp"
            "md", "markdown" -> "text/markdown"; "csv" -> "text/csv"; "json" -> "application/json"
            "txt", "log", "kt", "ts", "js", "py", "java", "xml", "yml", "yaml", "html", "css", "sh" -> "text/plain"
            else -> null
        }
        return byExt ?: when {
            g == null || g.isBlank() -> "application/octet-stream"
            g.startsWith("text/") -> "text/plain"
            g.endsWith("+json") || g.endsWith("/x-json") -> "application/json"
            else -> g
        }
    }

    /** 选好的文件 / 照片 → 检查类型和大小 → 逐个上传。 */
    fun addFiles(uris: List<Uri>) {
        val bot = chatBot ?: return
        val api = api ?: return
        for (uri in uris) {
            if (files.size >= 8) { notice = "一条消息最多带 8 个附件"; break }
            var name = "文件"; var size = -1L
            runCatching {
                ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it) ?: name }
                        c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { if (!c.isNull(it)) size = c.getLong(it) }
                    }
                }
            }
            if (uri.scheme == "file") name = uri.lastPathSegment ?: name
            val mime = guessMime(name, ctx.contentResolver.getType(uri))
            val image = mime in imageMimes
            val localId = UUID.randomUUID().toString()
            val reject = when {
                !image && mime !in textMimes -> if (mime.startsWith("image/")) "不支持这种图片格式（可以发 PNG、JPEG、GIF、WebP）" else "不支持这种文件（可以发图片和文本类文件：txt、md、csv、json）"
                image && size > 8L * 1024 * 1024 -> "图片超过 8 MB"
                !image && size > 1024L * 1024 -> "文本文件超过 1 MB"
                else -> null
            }
            files += PendingFile(localId, uri.toString(), name, mime, image, size, if (reject != null) "failed" else "uploading", error = reject)
            if (reject == null) viewModelScope.launch { upload(api, bot, localId, uri) }
        }
    }

    private fun readBounded(input: java.io.InputStream, maxBytes: Int, tooLargeMessage: String): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > maxBytes) throw IllegalStateException(tooLargeMessage)
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    private suspend fun upload(api: Api, bot: Bot, localId: String, uri: Uri) {
        fun update(change: (PendingFile) -> PendingFile) { val i = files.indexOfFirst { it.localId == localId }; if (i >= 0) files[i] = change(files[i]) }
        try {
            val f = files.firstOrNull { it.localId == localId } ?: return
            val maxBytes = if (f.image) 8 * 1024 * 1024 else 1024 * 1024
            val limitMsg = if (f.image) "图片超过 8 MB" else "文本文件超过 1 MB"
            val bytes = withContext(Dispatchers.IO) {
                ctx.contentResolver.openInputStream(uri)?.use { readBounded(it, maxBytes, limitMsg) }
            } ?: throw IllegalStateException("读不到这个文件")
            val (cid, _) = ensureChannel(api, bot)
            val res = api.upload("/api/channels/$cid/attachments", mapOf("uploadGroup" to uploadGroup), f.name, f.mime, bytes)
            val id = res.s("id") ?: throw IllegalStateException("上传失败，请重试")
            // 宽高：服务器回的为准（§83.2），老服务器没有就本机读图片头（不解码像素）
            var w = res.s("width")?.toDoubleOrNull()?.toInt(); var h = res.s("height")?.toDoubleOrNull()?.toInt()
            if ((w == null || h == null) && f.image) runCatching {
                val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
                if (o.outWidth > 0 && o.outHeight > 0) { w = o.outWidth; h = o.outHeight }
            }
            update { it.copy(state = "ready", serverId = id, mime = res.s("mimeType") ?: it.mime, width = w, height = h) }
            if (uri.scheme == "file") uri.path?.let { p -> if (p.contains("/cache/camera/")) runCatching { java.io.File(p).deleteOnExit() } }
        } catch (_: Unauthorized) { update { it.copy(state = "failed", error = "登录已过期") } }
        catch (e: ApiError) {
            update { it.copy(state = "failed", error = when (e.status) {
                415 -> "不支持这种文件"; 413 -> "文件太大"; 409 -> "附件太多了"; 403 -> "没有权限在这段对话里上传"; else -> "上传失败（${e.status}），点一下重试"
            }) }
        } catch (e: Exception) { update { it.copy(state = "failed", error = e.message ?: "上传失败，点一下重试") } }
    }

    fun retryFile(localId: String) {
        val bot = chatBot ?: return; val api = api ?: return
        val i = files.indexOfFirst { it.localId == localId }; if (i < 0) return
        val f = files[i]
        if (f.error != null && f.serverId == null && f.state == "failed" && (f.error.startsWith("不支持") || f.error.contains("超过"))) return
        files[i] = f.copy(state = "uploading", error = null)
        viewModelScope.launch { upload(api, bot, localId, Uri.parse(f.uri)) }
    }

    fun removeFile(localId: String) { files.removeAll { it.localId == localId } }

    /** 拍照用的临时文件（FileProvider，cache/camera/）。 */
    fun cameraUri(): Uri {
        val dir = java.io.File(ctx.cacheDir, "camera").apply { mkdirs() }
        val f = java.io.File(dir, "photo-${System.currentTimeMillis()}.jpg")
        return androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
    }

    // ---------- 确认卡片（§58）+ 上游审批：画在对应的工具调用下面，所有设备读同一份 ----------

    var confirms by mutableStateOf<Map<String, List<ConfirmCard>>>(emptyMap())
    private var confirmJob: Job? = null

    private fun parseConfirm(o: JsonObject): ConfirmCard? {
        val id = o.s("id") ?: return null
        val call = o.s("toolCallId") ?: return null
        val details = o.a("details")?.mapNotNull { d ->
            val x = d as? JsonObject ?: return@mapNotNull null
            Triple(x.s("label") ?: "", x.s("value") ?: "", if (x["diff"]?.toString() == "true") "diff" else if (x["code"]?.toString() == "true") "code" else "")
        } ?: emptyList()
        return ConfirmCard(id, call, o.s("category") ?: "device", o.s("title") ?: "需要你确认", o.s("target"), details, o.s("status") ?: "pending",
            decidedNote = if (o.s("decidedVia") == "device" && o.s("status") in setOf("approved", "denied")) "在电脑上决定" else null)
    }

    private fun zhReason(reason: String?): String? = when {
        reason.isNullOrBlank() -> null
        Regex("pay|purchas|money", RegexOption.IGNORE_CASE).containsMatchIn(reason) -> "付款、购买、转账要你亲自完成"
        Regex("password|passcode|credential|two-factor|recovery", RegexOption.IGNORE_CASE).containsMatchIn(reason) -> "改密码、验证码等登录凭据要你亲自完成"
        Regex("security|sharing|access settings", RegexOption.IGNORE_CASE).containsMatchIn(reason) -> "改安全、共享或权限设置要你亲自完成"
        Regex("rule asks", RegexOption.IGNORE_CASE).containsMatchIn(reason) -> "你的规则要求先问你"
        Regex("review changes", RegexOption.IGNORE_CASE).containsMatchIn(reason) -> "你设置了改动前先问你"
        Regex("[\\u4e00-\\u9fff]").containsMatchIn(reason) -> reason
        else -> "这一步需要你确认"
    }

    /** 上游审批（云端浏览器的安全规则等，/api/approvals）：只画还在等的、这段对话的。 */
    private fun parseApproval(o: JsonObject, t: String): ConfirmCard? {
        if (o.s("status") != "pending") return null
        val action = o.o("action") ?: return null
        if (action.s("threadId") != t) return null
        val call = action.s("toolCallId") ?: return null
        val policy = action.o("policy")
        val handOff = policy?.s("behaviour") == "hand_off"
        val scope = action.s("scope") ?: ""
        val what = (action.s("toolRef") ?: "").replace(Regex("^computer_|^host/"), "").replace("_", " ")
        val reason = zhReason(policy?.s("reason"))
        val pay = Regex("pay|checkout|purchase|付款|支付|下单", RegexOption.IGNORE_CASE).containsMatchIn("${policy?.s("reason") ?: ""} $scope")
        return ConfirmCard(o.s("id") ?: return null, call, if (pay) "purchase" else "device",
            if (handOff) reason ?: "$what：$scope" else "云端浏览器：$what", scope,
            if (reason != null && !handOff) listOf(Triple("原因", reason, "")) else emptyList(), "pending",
            upstream = true, handOff = handOff, eyebrow = if (handOff) "这一步要你亲自完成" else null)
    }

    private suspend fun fetchConfirms(api: Api, t: String) {
        val list = runCatching { api.get("/api/confirmations/requests?thread=$t&limit=100").a("requests") }.getOrNull()
        val ups = runCatching { api.get("/api/approvals").a("requests") }.getOrNull()
        if (threadId != t) return
        val cards = mutableListOf<ConfirmCard>()
        list?.forEach { (it as? JsonObject)?.let(::parseConfirm)?.let(cards::add) }
        ups?.forEach { (it as? JsonObject)?.let { o -> parseApproval(o, t) }?.let(cards::add) }
        // 服务器按新到旧给；同一个调用下按先后画
        confirms = cards.reversed().groupBy { it.toolCallId }
    }

    /** 取一次；这一轮在跑或有卡片在等时每 1.5 秒取一次（和网页 useThreadConfirmations 一样）。 */
    fun kickConfirms() {
        if (confirmJob?.isActive == true) return
        val t = threadId ?: return
        val api = api ?: return
        confirmJob = viewModelScope.launch {
            while (threadId == t && screen is Screen.Chat) {
                fetchConfirms(api, t)
                val pending = confirms.values.any { l -> l.any { it.status == "pending" } }
                if (!running && !pending) break
                delay(1500)
            }
        }
    }

    /** 确认 / 取消（always = 「以后这类直接做」：先改偏好再确认）。决定后服务器接着做这一轮；本机没在读流时去看服务器有没有接着跑。 */
    suspend fun decide(card: ConfirmCard, approve: Boolean, always: Boolean = false): Boolean {
        val api = api ?: return false
        val t = threadId ?: return false
        return try {
            if (card.upstream) {
                api.post("/api/approvals/${card.id}/decision", buildJsonObject { put("decision", if (!approve) "deny" else if (card.handOff) "handled" else "allow_once") })
            } else {
                if (always) api.call("/api/confirmations/prefs/${card.category}", "PUT", buildJsonObject { put("mode", "auto"); put("note", "在确认卡片上选了「以后这类直接做」") })
                api.post("/api/confirmations/requests/${card.id}", buildJsonObject { put("decision", if (approve) "approve" else "deny") })
            }
            val next = card.copy(status = if (approve) "approved" else "denied")
            confirms = confirms.mapValues { (_, l) -> l.map { if (it.id == card.id) next else it } }
            if (always) notice = "以后这类直接做，可以在 设置 → 审批偏好 改回"
            kickConfirms()
            if (!running) viewModelScope.launch {
                delay(1200)
                val bot = chatBot ?: return@launch
                val inbox = runCatching { api.get("/api/copilotkit/threads/$t/inbox") }.getOrNull()
                if (inbox?.get("running")?.toString() == "true" && !running && threadId == t) watch(bot, t)
                else if (threadId == t) runCatching { api.get("/api/copilotkit/threads/$t/messages").a("messages") }.getOrNull()?.let { if (!running) messages = parseHistory(it) }
            }
            true
        } catch (_: Unauthorized) { expired(); false }
        catch (e: Exception) { notice = e.message ?: "没能保存你的决定"; false }
    }

    /** 新话题：下一条消息建一个新的一对一会话（和网页「新话题」一样，旧会话留在历史里）。 */
    fun newTopic() {
        if (running) return
        threadId = null; channelId = null; messages = emptyList(); runError = null
        workStarted.clear(); workEnded.clear(); confirms = emptyMap(); files.clear()
    }

    private fun stopRun() { liveCall?.cancel(); runJob?.cancel(); stopWatching(); running = false }

    // ---------- 设置（原生基础部分）：外观、账号、服务器、设备（只读） ----------

    /** 外观：system（跟随系统）| light | dark。存在 SharedPreferences「chisabot」的 theme 键（网页兜底页跟着同步）。 */
    var themeMode by mutableStateOf(prefs.getString("theme", "system") ?: "system")
        private set
    fun setTheme(mode: String) { themeMode = mode; prefs.edit().putString("theme", mode).apply() }

    var meName by mutableStateOf<String?>(null)
    var meEmail by mutableStateOf<String?>(null)
    var devices by mutableStateOf<List<DeviceRow>>(emptyList())
    var devicesLoading by mutableStateOf(false)
    var devicesError by mutableStateOf<String?>(null)
    val thisDeviceName: String? get() = prefs.getString("deviceName", null)
    val username: String? get() = prefs.getString("username", null)

    fun openSettings() { push(Screen.Settings); loadSettings() }

    fun loadSettings() {
        val api = api ?: return
        viewModelScope.launch {
            runCatching { api.get("/api/me").o("user") }.getOrNull()?.let { u ->
                meName = u.s("name") ?: u.s("displayName") ?: u.s("username")
                meEmail = u.s("email")
            }
        }
        devicesLoading = true
        viewModelScope.launch {
            try {
                val mine = prefs.getString("deviceId", null)
                val arr = api.get("/api/devices").a("devices") ?: JsonArray(emptyList())
                devices = arr.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    if (o["revoked"]?.toString() == "true") return@mapNotNull null
                    val id = o.s("id") ?: return@mapNotNull null
                    DeviceRow(id, o.s("name") ?: "设备", o.s("platform") ?: "", o["online"]?.toString() == "true", o["paused"]?.toString() == "true",
                        o.s("lastSeenAt"), o.s("clientVersion"), id == mine)
                }.sortedWith(compareByDescending<DeviceRow> { it.thisPhone }.thenByDescending { it.online })
                devicesError = null
            } catch (_: Unauthorized) { expired() }
            catch (e: Exception) { devicesError = e.message ?: "无法加载设备列表" }
            finally { devicesLoading = false }
        }
    }

    /** 切换服务器：回登录页（不退出当前账号，登录页里可以换地址）。 */
    fun switchServer() { stopRun(); stack.clear(); stack += Screen.Login }

    // ---------- 面板（只读，§77） ----------
    var panels by mutableStateOf<List<Panel>>(emptyList())
    var panelsLoading by mutableStateOf(false)
    var panelsError by mutableStateOf<String?>(null)
    private var panelsJob: Job? = null

    fun openPanels(bot: Bot) { push(Screen.Panels(bot)); loadPanels(bot, poll = true) }

    fun loadPanels(bot: Bot, poll: Boolean = false) {
        val api = api ?: return
        panelsJob?.cancel()
        panelsJob = viewModelScope.launch {
            panelsLoading = true
            do {
                try {
                    val items = api.get("/api/live-panels?botId=${bot.id}").a("items") ?: JsonArray(emptyList())
                    panels = items.mapNotNull { el ->
                        val o = el as? JsonObject ?: return@mapNotNull null
                        Panel(
                            o.s("id") ?: return@mapNotNull null, o.s("title") ?: "面板", o.s("status") ?: "ready", o.s("spec"),
                            o.a("sources")?.mapNotNull { s -> (s as? JsonObject)?.let { (it.s("name") ?: "") to (it.s("url") ?: "") } } ?: emptyList(),
                            o.s("refreshedAt"), o.s("refreshMinutes")?.toIntOrNull(), o.s("refreshAt"), o["refreshing"]?.toString() == "true", o.s("error"),
                        )
                    }
                    panelsError = null
                } catch (_: Unauthorized) { expired(); return@launch }
                catch (e: Exception) { panelsError = e.message ?: "无法加载面板" }
                panelsLoading = false
                // 有正在搭建 / 刷新的面板：5 秒后再看一次（只读，不触发刷新）
                val busy = panels.any { it.status == "building" || it.refreshing }
                if (!poll || !busy || screen !is Screen.Panels) break
                delay(5000)
            } while (true)
        }
    }
}
