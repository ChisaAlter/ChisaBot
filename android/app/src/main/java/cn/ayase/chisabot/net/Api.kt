package cn.ayase.chisabot.net

import android.webkit.CookieManager
import cn.ayase.chisabot.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 当前服务器（给图片用：消息里 / 头像接口给的是相对路径 /api/…）。AppViewModel 换服务器时更新。 */
@Volatile var currentOrigin: String? = null

/** 相对路径补成当前服务器的绝对地址；本来就是绝对地址 / data: 的原样返回。 */
fun absUrl(url: String): String = when {
    url.startsWith("/") && !url.startsWith("//") -> (currentOrigin ?: "") + url
    else -> url
}

class ApiError(val status: Int, message: String) : IOException(message)
class Unauthorized : IOException("登录已过期")

/**
 * 和服务器说话的唯一出口。Cookie 存在 android.webkit.CookieManager 里——和以前的网页外壳是同一份，
 * 所以从 WebView 版更新过来的手机不用重新登录；网页兜底页（WebScreen）也自动带着同一个会话。
 */
class Api(val origin: String, private val renew: (suspend () -> Boolean)? = null) {
    companion object {
        val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }
        private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

        val cookieJar = object : CookieJar {
            override fun loadForRequest(url: HttpUrl): List<Cookie> {
                val raw = CookieManager.getInstance().getCookie(url.toString()) ?: return emptyList()
                return raw.split(';').mapNotNull { part ->
                    val kv = part.trim()
                    val eq = kv.indexOf('=')
                    if (eq <= 0) null else Cookie.parse(url, "$kv; Path=/") ?: runCatching {
                        Cookie.Builder()
                            .name(kv.substring(0, eq).trim())
                            .value(kv.substring(eq + 1).trim())
                            .hostOnlyDomain(url.host)
                            .path("/")
                            .apply { if (url.isHttps) secure() }
                            .build()
                    }.getOrNull()
                }
            }

            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                val cm = CookieManager.getInstance()
                for (c in cookies) cm.setCookie(url.toString(), c.toString())
                cm.flush()
            }
        }

        val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .cookieJar(cookieJar)
                .followRedirects(false)
                .connectTimeout(12, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build()
        }
        /** 图片（Coil）：同一个 Cookie，跟随跳转（文件下载会 302 到签名地址）。 */
        val imageClient: OkHttpClient by lazy { client.newBuilder().followRedirects(true).build() }
        /** 流式回复：读超时关掉（一轮可能几分钟，中间停顿几十秒也正常）。 */
        val streamClient: OkHttpClient by lazy { client.newBuilder().readTimeout(0, TimeUnit.SECONDS).build() }
    }

    private fun request(path: String, method: String, body: JsonElement?, sse: Boolean = false): Request {
        val b = Request.Builder().url(origin + path)
            .header("Origin", origin)
            .header("User-Agent", "ChisaBotAndroid/${BuildConfig.VERSION_NAME} native")
            .header("Accept", if (sse) "text/event-stream" else "application/json")
        val rb = body?.let { json.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON_TYPE) }
        when (method) {
            "GET" -> b.get()
            "DELETE" -> b.delete(rb)
            else -> b.method(method, rb ?: "{}".toRequestBody(JSON_TYPE))
        }
        return b.build()
    }

    private fun isAuthFail(r: Response) = r.code == 401 || (r.code in 300..399 && (r.header("Location") ?: "").contains("login"))

    private fun errorText(code: Int, body: String): String {
        val msg = runCatching { (json.parseToJsonElement(body) as? JsonObject)?.get("error")?.toString()?.trim('"') }.getOrNull()
        return msg?.takeIf { it.isNotBlank() && it != "null" } ?: when {
            code >= 500 -> "服务器暂时不可用（$code），请稍后再试"
            code == 404 -> "找不到（404）"
            else -> "请求失败（$code）"
        }
    }

    suspend fun call(path: String, method: String = "GET", body: JsonElement? = null): JsonElement = withContext(Dispatchers.IO) {
        for (attempt in 0..1) {
            val r = client.newCall(request(path, method, body)).execute()
            val auth = isAuthFail(r)
            if (auth) {
                r.close()
                if (attempt == 0 && renew != null && renew.invoke()) continue
                throw Unauthorized()
            }
            val text = r.use { it.body?.string().orEmpty() }
            if (!r.isSuccessful) throw ApiError(r.code, errorText(r.code, text))
            return@withContext if (text.isBlank()) JsonObject(emptyMap()) else json.parseToJsonElement(text)
        }
        throw Unauthorized()
    }

    /** multipart 上传（聊天附件）：一个文件字段 + 几个普通字段。 */
    suspend fun upload(path: String, fields: Map<String, String>, fileName: String, mime: String, bytes: ByteArray): JsonObject = withContext(Dispatchers.IO) {
        for (attempt in 0..1) {
            val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM).apply {
                fields.forEach { (k, v) -> addFormDataPart(k, v) }
                addFormDataPart("file", fileName, bytes.toRequestBody(mime.toMediaType()))
            }.build()
            val req = Request.Builder().url(origin + path).header("Origin", origin)
                .header("User-Agent", "ChisaBotAndroid/${BuildConfig.VERSION_NAME} native").header("Accept", "application/json").post(body).build()
            val r = client.newBuilder().writeTimeout(120, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build().newCall(req).execute()
            if (isAuthFail(r)) {
                r.close()
                if (attempt == 0 && renew != null && renew.invoke()) continue
                throw Unauthorized()
            }
            val text = r.use { it.body?.string().orEmpty() }
            if (!r.isSuccessful) throw ApiError(r.code, errorText(r.code, text))
            return@withContext (runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject) ?: JsonObject(emptyMap())
        }
        throw Unauthorized()
    }

    suspend fun get(path: String) = call(path) as? JsonObject ?: JsonObject(emptyMap())
    suspend fun post(path: String, body: JsonElement? = null) = call(path, "POST", body) as? JsonObject ?: JsonObject(emptyMap())

    /**
     * SSE（AG-UI 事件流）：每个 `data:` 事件解析成 JsonObject 交给 onEvent。返回 Call 供「停止」取消。
     * 抛出：Unauthorized / ApiError / IOException（网络断）。
     */
    suspend fun stream(path: String, body: JsonElement, onCall: (Call) -> Unit, onEvent: suspend (JsonObject) -> Unit) = withContext(Dispatchers.IO) {
        var attempt = 0
        while (true) {
            val call = streamClient.newCall(request(path, "POST", body, sse = true))
            onCall(call)
            val r = call.execute()
            if (isAuthFail(r)) {
                r.close()
                if (attempt == 0 && renew != null && renew.invoke()) { attempt++; continue }
                throw Unauthorized()
            }
            r.use { resp ->
                if (!resp.isSuccessful) throw ApiError(resp.code, errorText(resp.code, resp.body?.string().orEmpty()))
                val source = resp.body?.source() ?: return@withContext
                val data = StringBuilder()
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val line = source.readUtf8Line() ?: break
                    if (line.isEmpty()) {
                        if (data.isNotEmpty()) {
                            val text = data.toString(); data.clear()
                            if (text != "[DONE]") runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()?.let { onEvent(it) }
                        }
                    } else if (line.startsWith("data:")) {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(line.removePrefix("data:").removePrefix(" "))
                    }
                }
                if (data.isNotEmpty()) runCatching { json.parseToJsonElement(data.toString()) as? JsonObject }.getOrNull()?.let { onEvent(it) }
            }
            return@withContext
        }
    }
}
