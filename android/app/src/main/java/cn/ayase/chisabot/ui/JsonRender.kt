package cn.ayase.chisabot.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.chat.a
import cn.ayase.chisabot.chat.o
import cn.ayase.chisabot.chat.s
import cn.ayase.chisabot.chat.str
import cn.ayase.chisabot.net.Api
import coil.compose.AsyncImage
import cn.ayase.chisabot.net.absUrl
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * json-render（render_ui 卡片、右栏面板）的原生渲染：读同一份 {root, elements} spec（shared/json-render/catalog.ts）。
 * 常用组件都是原生的；表单类（Input / Select / Checkbox）和不认识的组件交给 onFallback（在应用内网页里看）。
 * §29：对话里缺外壳的界面自己当外壳（autoShell + needsShell），外壳/面板卡片里的 Card 平铺成小节、
 * Metric / 表格 / 列表去底（LocalInShell），和 shared/json-render/shell.ts、panel-title.ts 同一套规则。
 */
class RenderActions(val ask: (String) -> Unit, val fallback: () -> Unit)

val LocalRenderActions = compositionLocalOf { RenderActions({}, {}) }

/** 已经在外壳（玻璃卡 / 面板卡片）里：里面的 Card 平铺成小节、Metric / 表格 / 列表不再各自带底（§29）。 */
val LocalInShell = compositionLocalOf { false }

private val FALLBACK_TYPES = setOf("Input", "Select", "Checkbox")

/** 自己有底色的组件：可以直接放在天空/背景上（和 shell.ts 的 SURFACED 一致）。 */
private val SURFACED_TYPES = setOf("Metric", "List", "Alert", "Hero", "Products", "Link", "Badge", "Button", "Delta")

/** 有这个属性时多出一行直接画在背景上的小字（和 shell.ts 的 LABELLED 一致）。 */
private val LABELLED_PROPS = mapOf("Separator" to "label", "Image" to "caption", "Icon" to "label")

/** 只负责排版、自己不画字的容器：看它的孩子（和 shell.ts 的 LAYOUT 一致）。 */
private val LAYOUT_TYPES = setOf("Stack", "Grid", "Carousel", "Tabs")

private fun JsonObject?.bareText(key: String): Boolean =
    (this?.get(key) as? JsonPrimitive)?.let { it.isString && it.content.isNotBlank() } == true

/** spec 串 → JsonObject；还在流式写或格式不对时按没有界面处理（同 WorkSteps.parseArgs 的口径）。 */
private fun parseSpec(spec: String): JsonObject? =
    runCatching { Api.json.parseToJsonElement(spec) as? JsonObject }.getOrNull()

/** 这个元素自己有没有直接画在背景上的东西（不看孩子；shell.ts 的 drawsBare）。 */
private fun drawsBare(type: String, props: JsonObject?): Boolean {
    if (type in SURFACED_TYPES) return false
    LABELLED_PROPS[type]?.let { return props.bareText(it) }
    if (type == "Tabs") return props.p("variant") == "tabs"
    return type !in LAYOUT_TYPES
}

/**
 * 界面缺的那层外壳（DESIGN.md §29）：从根往下只穿过 Stack / Grid / Carousel / Tabs，遇到 Card 就停；
 * 路上碰到自己没有底的东西（Text、Heading、KeyValue、图表……）就返回 true——它直接画在天空上。
 * 流式时还没写到的孩子先跳过；互相引用只看一次。shared/json-render/shell.ts 的 Kotlin 版。
 */
fun needsShell(spec: JsonObject?): Boolean {
    val elements = spec?.o("elements") ?: return false
    val root = spec.s("root") ?: return false
    val seen = HashSet<String>()
    fun bare(key: String): Boolean {
        if (!seen.add(key)) return false
        val element = elements.o(key) ?: return false
        val type = element.s("type") ?: return false
        if (type == "Card") return false
        if (drawsBare(type, element.o("props"))) return true
        if (type !in LAYOUT_TYPES) return false
        return element.a("children")?.mapNotNull { it.str() }?.any { bare(it) } == true
    }
    return bare(root)
}

private fun normTitle(value: String?): String =
    value.orEmpty().lowercase().replace(Regex("(?U)[\\s\\p{P}\\p{S}]+"), "")

/** 忽略空白和标点后相同、或一方包含另一方（短的那个至少 2 字）：算同一个标题（panel-title.ts 的 sameTitle）。 */
fun sameTitle(a: String?, b: String?): Boolean {
    val x = normTitle(a); val y = normTitle(b)
    if (x.isEmpty() || y.isEmpty()) return false
    return x == y || (minOf(x.length, y.length) >= 2 && (x.contains(y) || y.contains(x)))
}

/**
 * 面板卡片头已经写了标题，规范里同名的 Card.title / 第一个 Heading 不再画第二遍（panel-title.ts 的 dropDuplicateTitle）。
 * 只去一次；Card 只去 title（description 留作副标题），Heading 整个去掉。返回新的 spec 字符串。
 */
fun dropDuplicatePanelTitle(spec: String, title: String?): String {
    if (title.isNullOrBlank()) return spec
    val parsed = parseSpec(spec) ?: return spec
    val elements = parsed.o("elements") ?: return spec
    fun rewrite(key: String, element: JsonObject) =
        JsonObject(parsed + ("elements" to JsonObject(elements + (key to element)))).toString()
    var key: String? = parsed.s("root") ?: return spec
    repeat(4) {
        val k = key ?: return spec
        val element = elements.o(k) ?: return spec
        val props = element.o("props")
        if (element.s("type") == "Card" && sameTitle(props.p("title"), title)) {
            val newProps = JsonObject((props ?: JsonObject(emptyMap())) + ("title" to JsonNull))
            return rewrite(k, JsonObject(element + ("props" to newProps)))
        }
        val kids = element.a("children")?.mapNotNull { it.str() } ?: emptyList()
        val first = kids.firstOrNull()
        if (first != null && elements.o(first)?.s("type") == "Heading" && sameTitle(elements.o(first).p("text"), title)) {
            return rewrite(k, JsonObject(element + ("children" to JsonArray(kids.drop(1).map { JsonPrimitive(it) }))))
        }
        if (element.s("type") == "Card" && props.p("title") != null) return spec
        key = first
    }
    return spec
}

@Composable
fun JsonRenderView(spec: String, actions: RenderActions, modifier: Modifier = Modifier, autoShell: Boolean = true) {
    val parsed = remember(spec) { parseSpec(spec) }
    val elements = parsed?.o("elements")
    val root = parsed?.s("root")
    val asShell = autoShell && remember(parsed) { needsShell(parsed) }
    CompositionLocalProvider(LocalRenderActions provides actions) {
        Column(modifier) {
            if (elements == null || root == null || elements[root] == null) FallbackRow("这张卡片还在生成或格式不对")
            else if (asShell) {
                val sky = LocalSky.current
                Column(Modifier.fillMaxWidth().glass(sky, RoundedCornerShape(16.dp), 2).padding(14.dp)) {
                    CompositionLocalProvider(LocalInShell provides true) { Element(elements, root, 0) }
                }
            } else Element(elements, root, 0)
        }
    }
}

private fun JsonObject?.p(key: String): String? = this?.get(key)?.str()
private fun JsonObject?.num(key: String): Double? = (this?.get(key) as? JsonPrimitive)?.let { it.doubleOrNull ?: it.content.replace(",", "").toDoubleOrNull() }
private fun JsonObject?.bool(key: String) = this?.get(key)?.str() == "true"
private fun numbers(el: JsonElement?): List<Double?> = (el as? JsonArray)?.map { (it as? JsonPrimitive)?.let { p -> p.doubleOrNull ?: p.content.replace(",", "").toDoubleOrNull() } } ?: emptyList()

@Composable
fun toneColor(tone: String?): Color {
    val sky = LocalSky.current
    return when (tone?.lowercase()) {
        "accent", "brand", "primary", "blue", "sky" -> sky.accent
        "info", "cyan", "teal", "purple" -> Color(0xFF2E9BC6)
        "success", "good", "ok", "positive", "green", "up" -> sky.success
        "warn", "warning", "amber", "yellow", "orange", "caution" -> sky.warn
        "danger", "bad", "error", "negative", "red", "down", "critical" -> sky.danger
        else -> sky.ink2
    }
}

@Composable
private fun FallbackRow(text: String) {
    val sky = LocalSky.current
    val actions = LocalRenderActions.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(sky.glass1).clickable { actions.fallback() }.padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = sky.ink3, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Text("在网页中打开 ↗", color = sky.accent, fontSize = 13.sp)
    }
}

/** 一项的点击动作：href 打开链接 / ask 替用户发一句 / copy 复制。 */
@Composable
private fun Modifier.itemAction(props: JsonObject?): Modifier {
    val ctx = LocalContext.current
    val actions = LocalRenderActions.current
    val href = props.p("href")?.takeIf { it.startsWith("http") }
    val ask = props.p("ask")
    val copy = props.p("copy")
    return when {
        href != null -> this.clickable { openUrl(ctx, href) }
        ask != null -> this.clickable { actions.ask(ask) }
        copy != null -> this.clickable { copyText(ctx, copy) }
        else -> this
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Element(els: JsonObject, key: String, depth: Int) {
    if (depth > 12) return
    val el = els.o(key) ?: return
    val type = el.s("type") ?: return
    val props = el.o("props")
    val children = el.a("children")?.mapNotNull { it.str() } ?: emptyList()
    val sky = LocalSky.current
    val ctx = LocalContext.current
    val inShell = LocalInShell.current
    val gap = when (props.p("gap")) { "sm" -> 6.dp; "lg" -> 16.dp; else -> 10.dp }
    @Composable fun kids() { children.forEach { Element(els, it, depth + 1) } }
    when (type) {
        "Card" -> {
            val title = props.p("title")
            val description = props.p("description")
            // 外壳里平铺成小节（§29）：标题降成一行淡色小标题，不再画玻璃底
            if (inShell) Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(gap)) {
                if (title != null || description != null) Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    title?.let { Text(it, color = sky.ink3, fontSize = 13.sp, fontWeight = FontWeight.Medium) }
                    description?.let { Text(it, color = sky.ink3, fontSize = 12.5.sp) }
                }
                kids()
            } else Column(Modifier.fillMaxWidth().glass(sky, RoundedCornerShape(16.dp), 2).padding(14.dp), verticalArrangement = Arrangement.spacedBy(gap)) {
                title?.let { Text(it, color = sky.ink1, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold) }
                description?.let { Text(it, color = sky.ink3, fontSize = 13.sp) }
                CompositionLocalProvider(LocalInShell provides true) { kids() }
            }
        }
        "Stack" -> if (props.p("direction") == "horizontal") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(gap), verticalArrangement = Arrangement.spacedBy(gap)) { kids() }
        } else Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(gap)) { kids() }
        "Grid" -> BoxWithConstraints(Modifier.fillMaxWidth()) {
            val want = props.num("columns")?.toInt() ?: 2
            val cols = if (maxWidth < 300.dp) minOf(want, 2).coerceAtLeast(1) else want.coerceIn(1, 4)
            Column(verticalArrangement = Arrangement.spacedBy(gap)) {
                children.chunked(cols).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                        row.forEach { Box(Modifier.weight(1f)) { Element(els, it, depth + 1) } }
                        repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        "Heading" -> Text(props.p("text") ?: "", color = sky.ink1, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        "Text" -> {
            val tone = props.p("tone")
            val c = when (tone) { "muted" -> sky.ink3; null, "default" -> sky.ink1; else -> toneColor(tone) }
            val size = if (props.p("size") == "sm") 13f else 15f
            val weight = when (props.p("weight")) { "bold" -> FontWeight.Bold; "medium" -> FontWeight.Medium; else -> FontWeight.Normal }
            val text = props.p("text") ?: ""
            // 「·」隔开的几项每项不拆开，只在「·」处换行（§77.3）
            if (text.contains(" · ") && !text.contains('\n')) FlowRow {
                val parts = text.split(" · ")
                parts.forEachIndexed { i, part -> Text(part + if (i < parts.lastIndex) " · " else "", color = c, fontSize = size.sp, fontWeight = weight, softWrap = false) }
            } else Text(text, color = c, fontSize = size.sp, fontWeight = weight, lineHeight = (size * 1.5f).sp)
        }
        "Metric" -> {
            val tinted = props.p("variant") == "tinted"
            val flat = inShell && !tinted
            val tc = toneColor(props.p("tone"))
            Column(
                Modifier.fillMaxWidth()
                    .then(if (flat) Modifier else Modifier.clip(RoundedCornerShape(14.dp))
                        .background(if (tinted) Brush.linearGradient(listOf(tc.copy(alpha = 0.18f), tc.copy(alpha = 0.06f))) else Brush.linearGradient(listOf(sky.glass1, sky.glass1))))
                    .itemAction(props).padding(if (flat) 0.dp else 12.dp),
            ) {
                Text(props.p("label") ?: "", color = sky.ink3, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(props.p("value") ?: "", color = sky.ink1, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                props.p("delta")?.let { DeltaPill(it, props.p("trend"), false, null) }
                val spark = numbers(props?.get("spark"))
                if (spark.count { it != null } >= 2) Spark(spark, toneFor(spark), Modifier.fillMaxWidth().height(28.dp).padding(top = 4.dp))
            }
        }
        "Table" -> {
            val cols = props?.a("columns")?.mapNotNull { it as? JsonObject } ?: emptyList()
            val rows = props?.a("rows")?.mapNotNull { it as? JsonObject } ?: emptyList()
            Column {
                Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                    Column(Modifier.then(if (inShell) Modifier else Modifier.clip(RoundedCornerShape(10.dp)).border(1.dp, sky.ink4.copy(alpha = 0.35f), RoundedCornerShape(10.dp)))) {
                        Row(Modifier.background(sky.accentSoft)) { cols.forEachIndexed { i, c -> TCell(c.s("label") ?: "", c.s("align"), true, inShell && i == 0, inShell && i == cols.lastIndex) } }
                        rows.forEachIndexed { i, r ->
                            Row(Modifier.background(if (i % 2 == 1) sky.glass1 else Color.Transparent)) { cols.forEachIndexed { j, c -> TCell(r[c.s("key") ?: ""].str() ?: "", c.s("align"), false, inShell && j == 0, inShell && j == cols.lastIndex) } }
                        }
                    }
                }
                props.p("caption")?.let { Text(it, color = sky.ink3, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp)) }
            }
        }
        "List" -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val ordered = props.bool("ordered")
            props?.a("items")?.mapNotNull { it as? JsonObject }?.forEachIndexed { i, it ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).itemAction(it).padding(vertical = if (inShell) 9.dp else 7.dp, horizontal = if (inShell) 0.dp else 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (ordered) Text("${i + 1}.", color = sky.ink3, fontSize = 14.sp, modifier = Modifier.width(24.dp))
                    it.s("image")?.takeIf { u -> u.startsWith("https") }?.let { u ->
                        AsyncImage(absUrl(u), null, contentScale = ContentScale.Crop, modifier = Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).background(sky.glass1))
                        Spacer(Modifier.width(10.dp))
                    }
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(it.s("title") ?: "", color = sky.ink1, fontSize = 14.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
                            it.s("badge")?.let { b -> Spacer(Modifier.width(6.dp)); Pill(b, toneColor(it.s("tone") ?: "accent")) }
                        }
                        it.s("description")?.let { d -> Text(d, color = sky.ink3, fontSize = 12.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    }
                    val meta = it.s("meta") ?: it.s("time")?.let { t -> relativeTime(t).ifEmpty { t } }
                    meta?.let { m -> Text(m, color = sky.ink3, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp)) }
                    if (it.s("href") != null) Text(" ↗", color = sky.ink3, fontSize = 12.sp)
                }
            }
        }
        "Badge" -> Box(Modifier.itemAction(props)) { Pill(props.p("text") ?: "", toneColor(props.p("tone"))) }
        "Button" -> {
            val primary = props.p("variant") == "primary" || props.p("variant") == null
            Text(
                props.p("label") ?: "", color = if (primary) Color.White else sky.accent, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.clip(RoundedCornerShape(18.dp)).background(if (primary) sky.accent else sky.accentSoft).itemAction(props).padding(horizontal = 16.dp, vertical = 9.dp),
            )
        }
        "Alert" -> {
            val tc = toneColor(props.p("tone") ?: props.p("variant") ?: "info")
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(tc.copy(alpha = 0.12f)).itemAction(props).padding(12.dp)) {
                props.p("title")?.let { Text(it, color = tc, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
                Text(props.p("message") ?: "", color = sky.ink1, fontSize = 14.sp)
            }
        }
        "Progress" -> Column {
            Row {
                Text(props.p("label") ?: "", color = sky.ink2, fontSize = 13.sp, modifier = Modifier.weight(1f))
                Text(props.p("valueText") ?: "${props.num("value")?.toInt() ?: 0}%", color = sky.ink3, fontSize = 13.sp)
            }
            Box(Modifier.padding(top = 4.dp).fillMaxWidth().height(8.dp).clip(CircleShape).background(sky.ink4.copy(alpha = 0.25f))) {
                Box(Modifier.fillMaxWidth(((props.num("value") ?: 0.0) / 100.0).toFloat().coerceIn(0f, 1f)).height(8.dp).clip(CircleShape).background(toneColor(props.p("tone") ?: "accent")))
            }
        }
        "Image" -> Column {
            val ratio = when (props.p("aspect")) { "16:9" -> 16f / 9f; "4:3" -> 4f / 3f; "1:1" -> 1f; else -> null }
            AsyncImage(props.p("src")?.let(::absUrl), props.p("alt"), contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxWidth().then(if (ratio != null) Modifier.aspectRatio(ratio) else Modifier.heightIn(max = 360.dp)).clip(RoundedCornerShape(12.dp)).background(sky.glass1).itemAction(props))
            props.p("caption")?.let { Text(it, color = sky.ink3, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp)) }
        }
        "Separator" -> Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(1.dp).background(sky.ink4.copy(alpha = 0.3f)))
            props.p("label")?.let { Text(" $it ", color = sky.ink3, fontSize = 12.sp); Box(Modifier.weight(1f).height(1.dp).background(sky.ink4.copy(alpha = 0.3f))) }
        }
        "Sparkline" -> Row(verticalAlignment = Alignment.CenterVertically) {
            val data = numbers(props?.get("data"))
            props.p("label")?.let { Text(it, color = sky.ink2, fontSize = 13.sp, modifier = Modifier.width(72.dp)) }
            Spark(data, props.p("tone")?.let { toneColor(it) } ?: toneFor(data), Modifier.weight(1f).height(28.dp))
            props.p("value")?.let { Text(" $it", color = sky.ink1, fontSize = 13.sp, fontWeight = FontWeight.Medium) }
        }
        "Chart" -> ChartView(props)
        "Ring", "Gauge" -> RingView(props, type == "Gauge")
        "HeatStrip" -> Column {
            props.p("label")?.let { Text(it, color = sky.ink2, fontSize = 13.sp) }
            val v = numbers(props?.get("values"))
            val max = v.maxOfOrNull { it ?: 0.0 }?.takeIf { it > 0 } ?: 1.0
            val tc = toneColor(props.p("tone") ?: "success")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                v.forEach { x -> Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(if (x == null) sky.ink4.copy(alpha = 0.2f) else tc.copy(alpha = (0.2 + 0.8 * x / max).toFloat()))) }
            }
            props.p("caption")?.let { Text(it, color = sky.ink3, fontSize = 12.sp) }
        }
        "Hero" -> Box(Modifier.fillMaxWidth().height(150.dp).clip(RoundedCornerShape(16.dp)).background(Brush.linearGradient(listOf(toneColor(props.p("tone") ?: "accent"), toneColor(props.p("tone") ?: "accent").copy(alpha = 0.5f)))).itemAction(props)) {
            props.p("image")?.let { AsyncImage(absUrl(it), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(150.dp)) }
            Box(Modifier.fillMaxWidth().height(150.dp).background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.55f)))))
            Column(Modifier.align(Alignment.BottomStart).padding(14.dp)) {
                props.p("value")?.let { Text(it, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold) }
                Text(props.p("title") ?: "", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                props.p("subtitle")?.let { Text(it, color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp) }
            }
        }
        "Avatar" -> Row(Modifier.itemAction(props), verticalAlignment = Alignment.CenterVertically) {
            val src = props.p("src")
            if (src != null) AsyncImage(absUrl(src), null, contentScale = ContentScale.Crop, modifier = Modifier.size(40.dp).clip(if (props.p("shape") == "square") RoundedCornerShape(8.dp) else CircleShape))
            else BotAvatar(props.p("name") ?: "?", props.p("name") ?: "", 40.dp)
            Spacer(Modifier.width(10.dp))
            Column {
                Text(props.p("name") ?: "", color = sky.ink1, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                props.p("subtitle")?.let { Text(it, color = sky.ink3, fontSize = 12.5.sp) }
            }
        }
        "Link" -> props.p("href")?.let { LinkCardView(it, props.p("title"), props.p("description")) }
        // 图标字库在网页是 Tabler；原生没有这套字形，label 画成字、没 label 画名字，不再静默丢掉。
        "Icon" -> (props.p("label") ?: props.p("icon") ?: props.p("name"))?.let {
            Text(it, color = sky.ink3, fontSize = 13.sp)
        }
        "Status" -> Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(toneColor(props.p("tone"))))
            Spacer(Modifier.width(8.dp))
            Text(props.p("label") ?: "", color = sky.ink1, fontSize = 14.sp, modifier = Modifier.weight(1f))
            props.p("detail")?.let { Text(it, color = sky.ink3, fontSize = 13.sp, fontFamily = FontFamily.Monospace) }
        }
        "Delta" -> DeltaPill(props.p("value") ?: "", props.p("trend"), props.bool("invert"), props.p("label"))
        "Tabs" -> {
            val tabs = props?.a("tabs")?.mapNotNull { it.str() } ?: emptyList()
            var sel by remember(key) { mutableIntStateOf(0) }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.clip(RoundedCornerShape(12.dp)).background(sky.glass1).padding(3.dp)) {
                    tabs.forEachIndexed { i, t ->
                        Text(t, color = if (i == sel) sky.ink1 else sky.ink3, fontSize = 13.sp, fontWeight = if (i == sel) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(if (i == sel) sky.glass3 else Color.Transparent).clickable { sel = i }.padding(horizontal = 12.dp, vertical = 6.dp))
                    }
                }
                children.getOrNull(sel)?.let { Element(els, it, depth + 1) }
            }
        }
        "Products" -> {
            val items = props?.a("items")?.mapNotNull { it as? JsonObject } ?: emptyList()
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items.chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { it ->
                            Column(Modifier.weight(1f).glass(sky, RoundedCornerShape(14.dp), 2).clickable { it.s("url")?.let { u -> openUrl(ctx, u) } }) {
                                Box {
                                    AsyncImage(it.s("image")?.let(::absUrl), it.s("name"), contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().aspectRatio(1f).background(sky.glass1))
                                    it.s("badge")?.let { b -> Box(Modifier.padding(6.dp)) { Pill(b, sky.accent) } }
                                }
                                Column(Modifier.padding(10.dp)) {
                                    Text(it.s("name") ?: "", color = sky.ink1, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    it.s("price")?.let { p -> Text(p, color = sky.danger, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
                                    it.s("note")?.let { n -> Text(n, color = sky.ink3, fontSize = 12.sp, maxLines = 2) }
                                }
                            }
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
        "Carousel" -> Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val w = when (props.p("itemWidth")) { "sm" -> 160.dp; "lg" -> 300.dp; else -> 230.dp }
            children.forEach { Box(Modifier.width(w)) { Element(els, it, depth + 1) } }
        }
        "Timeline" -> Column {
            props?.a("items")?.mapNotNull { it as? JsonObject }?.forEach { it ->
                Row {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(18.dp)) {
                        Box(Modifier.padding(top = 5.dp).size(9.dp).clip(CircleShape).background(toneColor(it.s("tone") ?: "accent")))
                        Box(Modifier.width(2.dp).height(36.dp).background(sky.ink4.copy(alpha = 0.35f)))
                    }
                    Column(Modifier.padding(start = 6.dp, bottom = 6.dp)) {
                        Row { Text(it.s("title") ?: "", color = sky.ink1, fontSize = 14.sp, modifier = Modifier.weight(1f)); it.s("time")?.let { t -> Text(relativeTime(t).ifEmpty { t }, color = sky.ink3, fontSize = 12.sp) } }
                        it.s("description")?.let { d -> Text(d, color = sky.ink3, fontSize = 12.5.sp) }
                    }
                }
            }
        }
        "KeyValue" -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            props?.a("items")?.mapNotNull { it as? JsonObject }?.forEach { it ->
                Row(Modifier.fillMaxWidth().itemAction(it).padding(vertical = 3.dp)) {
                    Text(it.s("label") ?: "", color = sky.ink3, fontSize = 13.5.sp, modifier = Modifier.weight(1f))
                    Text(it.s("value") ?: "", color = it.s("tone")?.let { t -> toneColor(t) } ?: sky.ink1, fontSize = 13.5.sp,
                        fontFamily = if (it.s("mono") == "true") FontFamily.Monospace else null, fontWeight = FontWeight.Medium)
                }
            }
        }
        "Accordion" -> {
            var open by remember(key) { mutableStateOf(props.bool("open")) }
            Column(Modifier.fillMaxWidth().animateContentSize()) {
                Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 6.dp)) {
                    Text(props.p("title") ?: "", color = sky.ink1, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                    props.p("summary")?.let { Text(it, color = sky.ink3, fontSize = 12.5.sp) }
                    Text(if (open) " ⌃" else " ⌄", color = sky.ink3)
                }
                if (open) Column(verticalArrangement = Arrangement.spacedBy(gap)) { kids() }
            }
        }
        "Countdown" -> {
            val now = Ticker(1000)
            val target = props.p("target")?.let { parseIso(it) }
            Column {
                props.p("label")?.let { Text(it, color = sky.ink3, fontSize = 13.sp) }
                val left = (target ?: now) - now
                val text = if (target == null) "—" else if (left <= 0) (props.p("doneText") ?: "已到时间") else {
                    val s = left / 1000; "${s / 86400} 天 ${(s % 86400) / 3600} 时 ${(s % 3600) / 60} 分" + if (s < 86400) " ${s % 60} 秒" else ""
                }
                Text(text, color = sky.ink1, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                props.p("caption")?.let { Text(it, color = sky.ink3, fontSize = 12.sp) }
            }
        }
        "Clock" -> {
            val now = Ticker(1000)
            val tz = props.p("timezone")?.let { java.util.TimeZone.getTimeZone(it) } ?: java.util.TimeZone.getDefault()
            val f = java.text.SimpleDateFormat(if (props.bool("showSeconds")) "HH:mm:ss" else "HH:mm", java.util.Locale.CHINA).apply { timeZone = tz }
            Column {
                props.p("label")?.let { Text(it, color = sky.ink3, fontSize = 13.sp) }
                Text(f.format(java.util.Date(now)), color = sky.ink1, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        "RelativeTime" -> { Ticker(30_000); Text(relativeTime(props.p("time") ?: props.p("value")), color = sky.ink3, fontSize = 13.sp) }
        else -> if (type in FALLBACK_TYPES) FallbackRow("这张卡片里有要填写的内容，原生端还填不了") else FallbackRow("这一块暂不支持原生显示")
    }
}

@Composable
private fun TCell(text: String, align: String?, header: Boolean, trimStart: Boolean = false, trimEnd: Boolean = false) {
    val sky = LocalSky.current
    Box(Modifier.widthIn(min = 76.dp, max = 220.dp).padding(start = if (trimStart) 0.dp else 10.dp, top = 7.dp, end = if (trimEnd) 0.dp else 10.dp, bottom = 7.dp),
        contentAlignment = when (align) { "right" -> Alignment.CenterEnd; "center" -> Alignment.Center; else -> Alignment.CenterStart }) {
        Text(text, color = if (header) sky.ink2 else sky.ink1, fontSize = 13.5.sp, fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal)
    }
}

@Composable
fun Pill(text: String, color: Color) {
    Text(text, color = color, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(color.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 3.dp))
}

@Composable
private fun DeltaPill(value: String, trend: String?, invert: Boolean, label: String?) {
    val sky = LocalSky.current
    val up = trend == "up" || (trend == null && value.trim().startsWith("+"))
    val down = trend == "down" || (trend == null && (value.trim().startsWith("-") || value.trim().startsWith("−")))
    val good = if (invert) down else up
    val c = when { up || down -> if (good) sky.success else sky.danger; else -> sky.ink3 }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Pill((if (up) "▲ " else if (down) "▼ " else "") + value, c)
        label?.let { Text(" $it", color = sky.ink3, fontSize = 12.sp) }
    }
}

@Composable
private fun toneFor(data: List<Double?>): Color {
    val sky = LocalSky.current
    val v = data.filterNotNull()
    return if (v.size >= 2 && v.last() < v.first()) sky.danger else sky.success
}

@Composable
private fun Spark(data: List<Double?>, color: Color, modifier: Modifier) {
    Canvas(modifier) { drawSeries(data, color, area = true, size = size) }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSeries(data: List<Double?>, color: Color, area: Boolean, size: Size, lo: Double? = null, hi: Double? = null) {
    val pts = data.withIndex().filter { it.value != null }
    if (pts.size < 2) return
    val min = lo ?: pts.minOf { it.value!! }
    val max = hi ?: pts.maxOf { it.value!! }
    val span = (max - min).takeIf { it > 0 } ?: 1.0
    val n = (data.size - 1).coerceAtLeast(1)
    fun at(i: Int, v: Double) = Offset(size.width * i / n, (size.height * (1 - (v - min) / span)).toFloat().coerceIn(1f, size.height - 1f))
    val path = Path()
    pts.forEachIndexed { k, p -> val o = at(p.index, p.value!!); if (k == 0) path.moveTo(o.x, o.y) else path.lineTo(o.x, o.y) }
    if (area) {
        val fill = Path().apply { addPath(path); lineTo(at(pts.last().index, min).x, size.height); lineTo(at(pts.first().index, min).x, size.height); close() }
        drawPath(fill, Brush.verticalGradient(listOf(color.copy(alpha = 0.28f), color.copy(alpha = 0f))))
    }
    drawPath(path, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
}

@Composable
private fun ChartView(props: JsonObject?) {
    val sky = LocalSky.current
    val kind = props.p("kind") ?: "line"
    val single = numbers(props?.get("data"))
    val series = props?.a("series")?.mapNotNull { it as? JsonObject }?.map { (it.s("name") ?: "") to (numbers(it["data"]) to it.s("tone")) }
        ?: listOf("" to (single to props.p("tone")))
    val labels = props?.a("labels")?.mapNotNull { it.str() } ?: emptyList()
    val all = series.flatMap { it.second.first }.filterNotNull()
    if (all.isEmpty()) return
    val lo = all.min(); val hi = all.max()
    val palette = listOf(sky.accent, Color(0xFF7C5CFF), Color(0xFF1F9D8B))
    val colors = series.mapIndexed { i, s -> s.second.second?.let { toneColor(it) } ?: palette[i % 3] }
    val h = (props.num("height") ?: 140.0).dp
    Column {
        Row { Text(props.p("unit")?.let { "$it ${fmt(hi)}" } ?: fmt(hi), color = sky.ink3, fontSize = 11.sp) }
        Canvas(Modifier.fillMaxWidth().height(h).padding(vertical = 4.dp)) {
            if (kind == "bar") {
                val n = series[0].second.first.size.coerceAtLeast(1)
                val w = size.width / n
                series[0].second.first.forEachIndexed { i, v ->
                    if (v == null) return@forEachIndexed
                    val base = minOf(0.0, lo); val span = (hi - base).takeIf { it > 0 } ?: 1.0
                    val bh = (size.height * ((v - base) / span)).toFloat()
                    drawRoundRect(colors[0], Offset(i * w + w * 0.18f, size.height - bh), Size(w * 0.64f, bh), androidx.compose.ui.geometry.CornerRadius(4.dp.toPx()))
                }
            } else series.forEachIndexed { i, s -> drawSeries(s.second.first, colors[i], area = kind == "area" || series.size == 1, size = size, lo = lo, hi = hi) }
        }
        if (labels.isNotEmpty()) Row(Modifier.fillMaxWidth()) {
            Text(labels.first(), color = sky.ink3, fontSize = 11.sp, modifier = Modifier.weight(1f))
            Text(labels.last(), color = sky.ink3, fontSize = 11.sp)
        }
        if (series.size > 1) Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 4.dp)) {
            series.forEachIndexed { i, s -> Row(verticalAlignment = Alignment.CenterVertically) { Box(Modifier.size(8.dp).clip(CircleShape).background(colors[i])); Text(" ${s.first}", color = sky.ink2, fontSize = 12.sp) } }
        }
        props.p("caption")?.let { Text(it, color = sky.ink3, fontSize = 12.sp) }
    }
}

private fun fmt(v: Double) = if (v == Math.floor(v) && kotlin.math.abs(v) < 1e12) v.toLong().toString() else "%.2f".format(v)

@Composable
private fun RingView(props: JsonObject?, gauge: Boolean) {
    val sky = LocalSky.current
    val segs = props?.a("segments")?.mapNotNull { it as? JsonObject }
    val max = props.num("max") ?: 100.0
    val min = props.num("min") ?: 0.0
    val value = props.num("value") ?: 0.0
    val frac = ((value - min) / ((max - min).takeIf { it > 0 } ?: 1.0)).toFloat().coerceIn(0f, 1f)
    val color = toneColor(props.p("tone") ?: "accent")
    val track = sky.ink4.copy(alpha = 0.25f)
    val segColors = segs?.mapIndexed { i, s -> s.s("tone")?.let { toneColor(it) } ?: listOf(sky.accent, Color(0xFF7C5CFF), Color(0xFF1F9D8B), sky.warn, sky.danger, sky.success)[i % 6] }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(if (props.p("size") == "sm") 64.dp else 88.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxWidth().aspectRatio(1f)) {
                val sw = 9.dp.toPx()
                val start = if (gauge) 180f else -90f
                val sweepAll = if (gauge) 180f else 360f
                drawArc(track, start, sweepAll, false, style = Stroke(sw, cap = StrokeCap.Round), topLeft = Offset(sw / 2, sw / 2), size = Size(size.width - sw, size.height - sw))
                if (segs != null && segColors != null) {
                    val total = segs.sumOf { it.num("value") ?: 0.0 }.takeIf { it > 0 } ?: 1.0
                    var a = start
                    segs.forEachIndexed { i, s -> val sweep = (sweepAll * ((s.num("value") ?: 0.0) / total)).toFloat(); drawArc(segColors[i], a, sweep, false, style = Stroke(sw), topLeft = Offset(sw / 2, sw / 2), size = Size(size.width - sw, size.height - sw)); a += sweep }
                } else drawArc(color, start, sweepAll * frac, false, style = Stroke(sw, cap = StrokeCap.Round), topLeft = Offset(sw / 2, sw / 2), size = Size(size.width - sw, size.height - sw))
            }
            Text(props.p("center") ?: if (segs != null) "" else (if (gauge) fmt(value) + (props.p("unit") ?: "") else "${(frac * 100).toInt()}%"), color = sky.ink1, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.width(12.dp))
        Column {
            props.p("label")?.let { Text(it, color = sky.ink1, fontSize = 14.sp, fontWeight = FontWeight.Medium) }
            props.p("caption")?.let { Text(it, color = sky.ink3, fontSize = 12.5.sp) }
            segs?.forEachIndexed { i, s -> Row(verticalAlignment = Alignment.CenterVertically) { Box(Modifier.size(8.dp).clip(CircleShape).background(segColors!![i])); Text(" ${s.s("label") ?: ""} ${s.s("value") ?: ""}", color = sky.ink2, fontSize = 12.sp) } }
        }
    }
}
