package cn.ayase.chisabot

/** 续期令牌只属于绑定时的服务器；旧 API 请求也必须仍属于当前登录的服务器。 */
internal fun boundDeviceToken(requestOrigin: String, activeOrigin: String?, boundOrigin: String?, token: String?): String? =
    token?.takeIf { it.startsWith("cbd_") && requestOrigin == activeOrigin && requestOrigin == boundOrigin }
