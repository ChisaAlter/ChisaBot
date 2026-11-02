package cn.ayase.chisabot

import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

/**
 * 本机登录页用的网络请求（和 PC 的 pc/src/agent/auth.js 同一套规则）：
 *  - normalize：补 https://、去掉路径和末尾 /；
 *  - probe：/auth/session（登录网关，不需要登录）→ /health → /api/version，有 HTTP 回应就算连得上；
 *  - login：直接 POST 服务器登录网关 /auth/login（和网页登录表单同一个请求，带 Origin），
 *    不是网关的部署退回 Better Auth（/api/auth/sign-in/email）；返回服务器下发的 Set-Cookie 原文；
 *  - logout：POST /auth/logout；
 *  - 扫码绑定（DESIGN.md §33）：pair = 用一次性绑定码换设备令牌（/api/devices/agent/pair）；
 *    deviceSession = 用设备令牌向登录网关换 30 天会话（/auth/device-session）；unenroll = 手机自己解除绑定。
 * 错误统一成 LoginError(kind, 中文说明)，kind = unreachable | cert | auth | rate | invalid | server | scan | revoked | nogw（没有登录网关）。
 */
object GatewayAuth {

    class LoginError(val kind: String, message: String) : Exception(message)

    class Session(val gateway: Boolean, val authenticated: Boolean?)

    fun normalize(input: String): String {
        var text = input.trim().trimEnd('/')
        if (text.isEmpty()) throw LoginError("invalid", "请填写服务器地址。")
        if (!text.contains("://")) text = "https://$text"
        val url = try {
            URL(text)
        } catch (_: Exception) {
            throw LoginError("invalid", "服务器地址格式不对，例如 chisabot.example.com:8443")
        }
        // http 只放行局域网 / 环回地址（内网自建部署走 http 是常态；调试包连模拟器的 10.0.2.2 也在这条规则里）。
        // 公网 http 一律拒：明文 + 没有证书校验等于裸奔。平台层 cleartext 已放开，真正的闸门在这里。
        val http = url.protocol.equals("http", true)
        if (!http && !url.protocol.equals("https", true)) throw LoginError("invalid", "服务器地址必须是 https。")
        if (http && !privateHost(url.host)) {
            throw LoginError("invalid", "服务器地址必须是 https；http 只支持局域网地址（192.168.x.x、10.x.x.x、localhost 等）。")
        }
        if (url.host.isNullOrBlank()) throw LoginError("invalid", "服务器地址格式不对，例如 chisabot.example.com:8443")
        if (url.userInfo != null) throw LoginError("invalid", "服务器地址里不能包含账号密码。")
        if (http) return "http://" + url.host + (if (url.port == -1 || url.port == 80) "" else ":" + url.port)
        return "https://" + url.host + (if (url.port == -1 || url.port == 443) "" else ":" + url.port)
    }

    /**
     * 局域网 / 环回地址（http 的放行范围）：localhost 和 *.local（mDNS 只在链路内解析）、
     * IPv4 私网段 10/8 · 172.16/12 · 192.168/16、环回 127/8、链路本地 169.254/16，IPv6 ::1 / ULA(fc00::/7) / 链路本地 fe80::。
     * 域名不猜——能解析到公网的域名走 http 没有保护，统一要求 https。
     */
    private fun privateHost(host: String?): Boolean {
        if (host.isNullOrBlank()) return false
        val h = host.removePrefix("[").removeSuffix("]").lowercase()
        if (h == "localhost" || h.endsWith(".local")) return true
        if (h.contains(':')) return h == "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")
        val parts = h.split('.')
        if (parts.size != 4) return false
        val n = parts.map { it.toIntOrNull() ?: return false }
        if (n.any { it !in 0..255 }) return false
        return n[0] == 10 || n[0] == 127 || (n[0] == 172 && n[1] in 16..31) || (n[0] == 192 && n[1] == 168) || (n[0] == 169 && n[1] == 254)
    }

    private fun networkError(e: Throwable): LoginError {
        var cause: Throwable? = e
        while (cause != null) {
            if (cause is SSLException || cause is CertificateException) {
                return LoginError("cert", "证书错误：服务器的 HTTPS 证书无效或不受信任（${cause.javaClass.simpleName}）。")
            }
            cause = cause.cause
        }
        return when (e) {
            is UnknownHostException -> LoginError("unreachable", "地址无法连接：找不到这个域名，请检查拼写。")
            is ConnectException -> LoginError("unreachable", "地址无法连接：服务器拒绝连接，请检查端口。")
            is SocketTimeoutException -> LoginError("unreachable", "地址无法连接：服务器没有响应（超时）。")
            else -> LoginError("unreachable", "地址无法连接（${e.javaClass.simpleName}），请检查地址和网络。")
        }
    }

    private class Reply(val status: Int, val body: String, val setCookies: List<String>)

    private fun request(
        url: String,
        method: String,
        origin: String?,
        cookie: String?,
        json: String?,
        timeoutMs: Int = 10000,
        extraHeaders: Map<String, String> = emptyMap(),
    ): Reply {
        val conn = try {
            URL(url).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            throw networkError(e)
        }
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.useCaches = false
            conn.requestMethod = method
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", "ChisaBotAndroid/${BuildConfig.VERSION_NAME}")
            if (origin != null) conn.setRequestProperty("Origin", origin)
            if (!cookie.isNullOrBlank()) conn.setRequestProperty("Cookie", cookie)
            for ((key, value) in extraHeaders) conn.setRequestProperty(key, value)
            if (json != null) {
                val bytes = json.toByteArray(Charsets.UTF_8)
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setFixedLengthStreamingMode(bytes.size)
                conn.outputStream.use { it.write(bytes) }
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            val cookies = conn.headerFields.entries
                .filter { it.key != null && it.key.equals("Set-Cookie", true) }
                .flatMap { it.value }
            return Reply(status, body, cookies)
        } catch (e: LoginError) {
            throw e
        } catch (e: IOException) {
            throw networkError(e)
        } finally {
            conn.disconnect()
        }
    }

    fun probe(origin: String, cookie: String?): Session {
        var last: LoginError? = null
        for (path in listOf("/auth/session", "/health", "/api/version")) {
            val reply = request(origin + path, "GET", null, cookie, null, 8000)
            if (path == "/auth/session" && reply.status == 200) {
                val body = runCatching { JSONObject(reply.body) }.getOrNull()
                if (body != null && body.has("authenticated")) return Session(true, body.optBoolean("authenticated"))
            }
            if (reply.status < 500 && reply.status != 404) return Session(false, null)
            if (reply.status >= 500) last = LoginError("server", "服务器暂时不可用（${reply.status}），请稍后再试。")
        }
        throw last ?: LoginError("invalid", "这个地址能打开，但不像 ChisaBot 服务器，请检查地址。")
    }

    private fun error(reply: Reply, fallback: String): String =
        runCatching { JSONObject(reply.body).optString("error").ifBlank { null } }.getOrNull() ?: fallback

    /** 返回服务器下发的 Set-Cookie 原文（交给 CookieManager）。 */
    fun login(origin: String, username: String, password: String, remember: Boolean): List<String> {
        if (username.isBlank() || password.isEmpty()) throw LoginError("auth", "请填写账号和密码。")
        val gatewayBody = JSONObject().put("username", username).put("password", password).put("remember", remember).toString()
        var reply = request("$origin/auth/login", "POST", origin, null, gatewayBody)
        if (reply.status == 404 || reply.status == 405) {
            val body = JSONObject().put("email", username).put("password", password).put("rememberMe", remember).toString()
            reply = request("$origin/api/auth/sign-in/email", "POST", origin, null, body)
            if (reply.status == 404 || reply.status == 405) throw LoginError("nogw", "这个服务器没有登录网关。")
        }
        when {
            reply.status == 429 -> throw LoginError("rate", "尝试次数过多，请稍后再试。")
            reply.status == 401 || reply.status == 400 -> throw LoginError("auth", "账号或密码错误。")
            reply.status == 403 -> throw LoginError("invalid", error(reply, "服务器拒绝了这次登录（来源不匹配），请确认地址和浏览器里打开的完全一致。"))
            reply.status >= 500 -> throw LoginError("server", "服务器暂时不可用（${reply.status}），请稍后再试。")
            reply.status !in 200..299 -> throw LoginError("invalid", error(reply, "登录失败（${reply.status}）。"))
        }
        if (reply.setCookies.isEmpty()) throw LoginError("invalid", "登录成功但服务器没有返回会话，请检查服务器地址。")
        return reply.setCookies
    }

    class Paired(val token: String, val deviceId: String, val deviceName: String)

    /** 扫码后：一次性绑定码 → 设备令牌（只返回一次，存在本机）。 */
    fun pair(origin: String, code: String, name: String, model: String, osVersion: String): Paired {
        val body = JSONObject()
            .put("code", code)
            .put("name", name)
            .put("model", model)
            .put("osVersion", osVersion)
            .put("platform", "android")
            .put("clientVersion", BuildConfig.VERSION_NAME)
            .toString()
        val reply = request("$origin/api/devices/agent/pair", "POST", origin, null, body)
        when {
            reply.status == 429 -> throw LoginError("rate", "尝试次数过多，请稍后再试。")
            reply.status == 404 || reply.status == 405 ->
                throw LoginError("invalid", "这个服务器还不支持扫码绑定，请先把 ChisaBot 服务器更新到最新版本，或用账号密码登录。")
            reply.status == 410 || reply.status == 400 -> throw LoginError("scan", error(reply, "二维码无效或已过期，请在网页上刷新二维码后重新扫码。"))
            reply.status == 401 || reply.status == 403 -> throw LoginError("invalid", error(reply, "服务器拒绝了这次绑定（${reply.status}）。"))
            reply.status >= 500 -> throw LoginError("server", error(reply, "服务器暂时不可用（${reply.status}），请稍后再试。"))
            reply.status !in 200..299 -> throw LoginError("invalid", error(reply, "绑定失败（${reply.status}）。"))
        }
        val json = runCatching { JSONObject(reply.body) }.getOrNull()
            ?: throw LoginError("invalid", "服务器返回的内容无法识别，请检查地址。")
        val token = json.optString("token")
        val device = json.optJSONObject("device")
        if (!token.startsWith("cbd_") || device == null) throw LoginError("invalid", "服务器返回的内容无法识别，请检查地址。")
        return Paired(token, device.optString("id"), device.optString("name", name))
    }

    /**
     * 用设备令牌换登录网关的会话 Cookie（30 天）。撤销过的令牌 → LoginError("revoked")。
     * 不是网关部署（没有 /auth/device-session）→ LoginError("invalid")，提示改用账号密码。
     */
    fun deviceSession(origin: String, deviceToken: String, osVersion: String): List<String> {
        val body = JSONObject().put("clientVersion", BuildConfig.VERSION_NAME).put("osVersion", osVersion).toString()
        val reply = request("$origin/auth/device-session", "POST", origin, null, body, extraHeaders = mapOf("X-Device-Token" to deviceToken))
        when {
            reply.status == 429 -> throw LoginError("rate", "尝试次数过多，请稍后再试。")
            reply.status == 401 -> {
                val revoked = runCatching { JSONObject(reply.body).optBoolean("revoked") }.getOrDefault(false)
                throw LoginError("revoked", if (revoked) "这台手机已在网页上被撤销，请重新扫码绑定。" else "绑定已失效，请重新扫码绑定。")
            }
            reply.status == 404 || reply.status == 405 ->
                throw LoginError("invalid", "这个服务器的登录网关还不支持扫码登录，请更新服务器或用账号密码登录。")
            reply.status == 403 -> throw LoginError("invalid", error(reply, "服务器拒绝了这次登录（来源不匹配），请确认服务器地址。"))
            reply.status >= 500 -> throw LoginError("server", error(reply, "服务器暂时不可用（${reply.status}），请稍后再试。"))
            reply.status !in 200..299 -> throw LoginError("invalid", error(reply, "登录失败（${reply.status}）。"))
        }
        if (reply.setCookies.isEmpty()) throw LoginError("invalid", "服务器没有返回会话，请检查服务器地址。")
        return reply.setCookies
    }

    /** 手机上退出登录：作废自己的设备令牌（设备列表里显示为已撤销）。失败不影响本机退出。 */
    fun unenroll(origin: String, deviceToken: String) {
        runCatching { request("$origin/api/devices/agent/unenroll", "POST", origin, null, "{}", 6000, mapOf("X-Device-Token" to deviceToken)) }
    }

    fun logout(origin: String, cookie: String?) {
        runCatching { request("$origin/auth/logout", "POST", origin, cookie, null, 6000) }
    }
}
