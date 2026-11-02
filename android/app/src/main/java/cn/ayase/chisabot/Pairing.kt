package cn.ayase.chisabot

import android.content.ContentResolver
import android.os.Build
import android.provider.Settings

/**
 * 扫码绑定（DESIGN.md §33）。网页「设置 → 设备 → 绑定手机」的二维码内容：
 * `chisabot://pair?server=<https 源>&code=cbp_<32 位 base64url>`（和 shared/devices.ts 的 pairingUri 同一格式）。
 */
object Pairing {

    class Link(val server: String, val code: String)

    /** inspect 的结果：Ok = 能用的绑定码；Bad = 界面上直接给用户看的中文原因。 */
    sealed class Result {
        class Ok(val link: Link) : Result()
        class Bad(val reason: String) : Result()
    }

    private val CODE = Regex("^cbp_[A-Za-z0-9_-]{32}$")

    /** 解析二维码 / 链接；不能用返回 null（等价 inspect().link）。 */
    fun parse(text: String?): Link? = (inspect(text) as? Result.Ok)?.link

    /**
     * 扫码结果 → 绑定码或原因。三种情况分开说，别都报「不是绑定二维码」：
     * 不是本应用的码（带上认出来的地址，方便判断扫错了哪张）；是绑定码但内容不全（截断 / 旧版格式）；
     * 服务器地址不行（release 包必须 https，内网 http 部署会走到这条）。
     */
    fun inspect(text: String?): Result {
        val raw = text?.trim().orEmpty()
        if (raw.isEmpty()) return Result.Bad("没有扫到二维码内容。")
        if (raw.length > 600) return Result.Bad("扫到的内容太长，不是绑定二维码。")
        val uri = runCatching { java.net.URI(raw) }.getOrNull() ?: return notPair(raw)
        if (!uri.scheme.equals("chisabot", true) || !uri.host.equals("pair", true)) return notPair(raw)
        val params = uri.rawQuery.orEmpty().split('&').mapNotNull {
            val eq = it.indexOf('=')
            if (eq <= 0) null else it.substring(0, eq) to runCatching { java.net.URLDecoder.decode(it.substring(eq + 1), "UTF-8") }.getOrNull().orEmpty()
        }.toMap()
        val code = params["code"]?.trim().orEmpty()
        val server = params["server"]?.trim().orEmpty()
        if (server.isEmpty() || !CODE.matches(code)) {
            return Result.Bad("这是 ChisaBot 的绑定二维码，但内容不完整——请在网页上刷新二维码后重新扫。")
        }
        val origin = try {
            GatewayAuth.normalize(server)
        } catch (e: GatewayAuth.LoginError) {
            return Result.Bad("绑定二维码里的服务器地址（$server）不能用：${e.message ?: "格式不对"}")
        }
        return Result.Ok(Link(origin, code))
    }

    /** 不是本应用的码：认得出 URL 就带出来（不带路径，免得把地址里的敏感参数露出来）。 */
    private fun notPair(raw: String): Result.Bad {
        val u = runCatching { java.net.URI(raw) }.getOrNull()
        val hint = if (u != null && (u.scheme.equals("http", true) || u.scheme.equals("https", true)) && !u.host.isNullOrBlank()) {
            "\n扫到的是：${u.scheme}://${u.host}"
        } else ""
        return Result.Bad("这不是 ChisaBot 的绑定二维码。$hint")
    }

    /** 设备列表里显示的名字：系统「设备名称」（如「Ayase 的 Xiaomi 14」），没有就用厂商 + 型号。 */
    fun deviceName(resolver: ContentResolver): String {
        val named = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
            runCatching { Settings.Global.getString(resolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        } else null
        return named?.trim()?.takeIf { it.isNotEmpty() }?.take(64) ?: model()
    }

    fun model(): String {
        val maker = Build.MANUFACTURER.orEmpty().trim().replaceFirstChar { it.uppercase() }
        val model = Build.MODEL.orEmpty().trim()
        val text = if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model".trim()
        return text.ifEmpty { "Android 手机" }.take(64)
    }

    fun osVersion(): String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
}
