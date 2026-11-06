package cn.ayase.chisabot.ui

import android.net.Uri
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.Bot
import cn.ayase.chisabot.Panel
import cn.ayase.chisabot.Screen
import kotlinx.coroutines.launch

/** 面板（§77，只读）：搭建中写「正在搭建…」+ 小点；底部一行「来源 +N · 3 分钟前更新 · 每小时」；刷新中在同一位置写「正在刷新…」。 */
@Composable
fun PanelsScreen(vm: AppViewModel, bot: Bot) {
    val sky = LocalSky.current
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize()) {
        TopBar("面板", subtitle = bot.name, onBack = { vm.back() }) {
            IconText("↻", "重新读取", { vm.loadPanels(bot, poll = true) })
        }
        val panels = vm.panels
        when {
            panels.isEmpty() && vm.panelsLoading -> Column(Modifier.padding(14.dp)) { Box(Modifier.fillMaxWidth().height(180.dp).glass(sky, level = 1)) }
            panels.isEmpty() && vm.panelsError != null -> ErrorCard(vm.panelsError ?: "") { vm.loadPanels(bot) }
            panels.isEmpty() -> Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text("还没有面板", color = sky.ink1, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(6.dp))
                Text("在聊天里说「做一个比特币价格面板」，${bot.name} 会搭一个，会自己按时刷新。", color = sky.ink3, fontSize = 14.sp)
            }
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(panels, key = { it.id }) { p ->
                    PanelCard(p, RenderActions(
                        ask = { text -> scope.launch { vm.back(); if (vm.chatBot?.id != bot.id) vm.openChat(bot); vm.send(text) } },
                        fallback = { vm.push(Screen.Web("/channel/new?agent=${bot.id}", "面板")) },
                    ))
                }
            }
        }
    }
}

@Composable
private fun PanelCard(p: Panel, actions: RenderActions) {
    val sky = LocalSky.current
    val stale = p.error != null && p.status != "building"
    Column(Modifier.fillMaxWidth().glass(sky, RoundedCornerShape(18.dp), 2).padding(14.dp).animateContentSize(tween(220))) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(p.title, color = sky.ink1, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
            if (stale) { Spacer(Modifier.width(8.dp)); Pill("可能已过期", sky.warn) }
        }
        Spacer(Modifier.height(10.dp))
        when {
            p.status == "building" || p.spec.isNullOrBlank() -> Column {
                Box(Modifier.fillMaxWidth().height(64.dp).clip(RoundedCornerShape(12.dp)).background(sky.glass1))
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (p.status == "failed") "搭建没有完成" else "正在搭建…", color = sky.ink3, fontSize = 13.sp)
                    if (p.status != "failed") { Spacer(Modifier.width(6.dp)); Dots(sky.ink3, 4.dp) }
                }
            }
            else -> {
                // 面板卡片自己就是那层外壳（§29）：里面的 Card 平铺、和面板同名的标题不画第二遍
                val spec = p.spec
                Box(Modifier.alpha(if (stale) 0.6f else 1f)) {
                    val shown = remember(spec, p.title) { dropDuplicatePanelTitle(spec, p.title) }
                    CompositionLocalProvider(LocalInShell provides true) {
                        JsonRenderView(shown, actions, Modifier.fillMaxWidth(), autoShell = false)
                    }
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        PanelFoot(p)
    }
}

/** 来源按网站合并：取主域名（weather.com.cn 这种二级后缀留三段），同一网站只写一次。 */
fun groupSources(sources: List<Pair<String, String>>): List<String> {
    val seen = LinkedHashMap<String, String>()
    for ((name, url) in sources) {
        val host = runCatching { Uri.parse(url).host }.getOrNull()?.removePrefix("www.")
        val site = host?.let { siteOf(it) } ?: "name:$name"
        if (site !in seen) seen[site] = name.ifBlank { host ?: "来源" }
    }
    // 同一网站几条来源的名字取公共前缀（「Open-Meteo 东京…」「Open-Meteo 上海…」→「Open-Meteo」）
    return seen.map { (site, first) ->
        val names = sources.filter { (n, u) -> (runCatching { Uri.parse(u).host }.getOrNull()?.removePrefix("www.")?.let { siteOf(it) } ?: "name:$n") == site }.map { it.first }
        val prefix = names.reduceOrNull { a, b -> a.commonPrefixWith(b) }?.trim()?.trimEnd('-', '·', ' ')
        if (!prefix.isNullOrBlank() && prefix.length >= 2) prefix else first
    }
}

fun siteOf(host: String): String {
    val parts = host.split('.')
    if (parts.size <= 2) return host
    val sld = parts[parts.size - 2]
    return if (sld in setOf("com", "net", "org", "gov", "edu", "co", "ac", "go", "ne", "or") && parts.last().length == 2) parts.takeLast(3).joinToString(".") else parts.takeLast(2).joinToString(".")
}

@Composable
private fun PanelFoot(p: Panel) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    var expanded by remember { mutableStateOf(false) }
    val groups = remember(p.sources) { groupSources(p.sources) }
    Ticker(30_000)
    val cadence = when {
        p.refreshAt != null -> "每天 ${p.refreshAt}"
        p.refreshMinutes == null -> null
        p.refreshMinutes % 1440 == 0 -> "每天"
        p.refreshMinutes % 60 == 0 -> if (p.refreshMinutes == 60) "每小时" else "每 ${p.refreshMinutes / 60} 小时"
        else -> "每 ${p.refreshMinutes} 分钟"
    }
    Row(Modifier.fillMaxWidth().height(22.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            if (groups.isNotEmpty()) {
                Text(groups.first(), color = sky.ink3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false)
                    .clickable { p.sources.firstOrNull()?.second?.takeIf { it.startsWith("http") }?.let { openUrl(ctx, it) } })
                if (groups.size > 1) { Spacer(Modifier.width(4.dp)); Text(if (expanded) "收起" else "+${groups.size - 1}", color = sky.accent, fontSize = 11.5.sp,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(sky.accentSoft).clickable { expanded = !expanded }.padding(horizontal = 6.dp, vertical = 1.dp)) }
            }
        }
        if (p.refreshing) {
            CircularProgressIndicator(Modifier.size(11.dp), color = sky.ink3, strokeWidth = 1.5.dp)
            Text(" 正在刷新…", color = sky.ink3, fontSize = 12.sp)
        } else {
            val updated = relativeTime(p.refreshedAt).let { if (it.isEmpty()) "" else if (it == "刚刚") "刚刚更新" else "${it}更新" }
            Text(listOfNotNull(updated.ifEmpty { null }, cadence).joinToString(" · "), color = sky.ink3, fontSize = 12.sp, maxLines = 1)
        }
    }
    if (expanded) Column(Modifier.padding(top = 4.dp)) {
        groups.drop(1).forEach { Text(it, color = sky.ink3, fontSize = 12.sp) }
    }
}
