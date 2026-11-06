package cn.ayase.chisabot.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.md.Block
import cn.ayase.chisabot.md.Bubble
import cn.ayase.chisabot.md.Markdown
import coil.compose.AsyncImage
import cn.ayase.chisabot.net.absUrl
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

fun openUrl(ctx: Context, url: String) { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }

/**
 * 站内操作胶囊（`[连接 GitHub](/settings/…)`）点击交给外层：有的路径原生能办（GitHub 令牌对话框），
 * 办不了的外层用网页兜底打开。默认就是当链接打开（absUrl 拼上服务器 origin）。
 */
val LocalActionPill = androidx.compose.runtime.staticCompositionLocalOf<(String) -> Unit> {
    { href -> } // 无人接时吞掉：比点开一个打不开的相对地址好
}

/** 预览类代码块（mermaid / svg / html）在原生只画代码；「在网页中打开预览」交给外层兜底，默认不显示。 */
val LocalPreviewFallback = androidx.compose.runtime.staticCompositionLocalOf<(() -> Unit)?> { null }

fun copyText(ctx: Context, text: String) {
    (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("ChisaBot", text))
}

private val INLINE = Regex("(\\*\\*(.+?)\\*\\*)|(`([^`]+)`)|(\\[([^\\]]+)]\\((\\S+?)\\))|(~~(.+?)~~)|(?<![*\\w])\\*(?!\\s)(.+?)(?<!\\s)\\*(?!\\*)|(https?://[^\\s<>()\\]]+)")

/** 行内 Markdown → AnnotatedString（粗体、斜体、行内代码、链接、删除线、裸链接）。链接打 "url" 注解。 */
fun inline(text: String, sky: Sky, base: Color = sky.ink1): AnnotatedString = buildAnnotatedString {
    var last = 0
    for (m in INLINE.findAll(text)) {
        append(text.substring(last, m.range.first))
        val g = m.groups
        when {
            g[2] != null -> { pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold)); append(inline(g[2]!!.value, sky, base)); pop() }
            g[4] != null -> { pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = sky.codeBg, fontSize = 13.5.sp)); append(" ${g[4]!!.value} "); pop() }
            g[6] != null -> {
                pushStringAnnotation("url", g[7]!!.value)
                pushStyle(SpanStyle(color = sky.accent)); append(g[6]!!.value); pop(); pop()
            }
            g[9] != null -> { pushStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)); append(g[9]!!.value); pop() }
            g[10] != null -> { pushStyle(SpanStyle(fontStyle = FontStyle.Italic)); append(g[10]!!.value); pop() }
            g[11] != null -> {
                val url = g[11]!!.value.trimEnd('.', ',', '。', '，', ')', '）')
                pushStringAnnotation("url", url); pushStyle(SpanStyle(color = sky.accent)); append(url); pop(); pop()
                append(g[11]!!.value.substring(url.length))
            }
        }
        last = m.range.last + 1
    }
    append(text.substring(last))
}

@Composable
fun InlineText(text: String, color: Color? = null, size: Float = 15.5f, weight: FontWeight = FontWeight.Normal, maxLines: Int = Int.MAX_VALUE) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    val onAction = LocalActionPill.current
    val c = color ?: sky.ink1
    val annotated = remember(text, sky, c) { inline(text, sky, c) }
    ClickableText(
        annotated,
        style = TextStyle(color = c, fontSize = size.sp, lineHeight = (size * 1.55f).sp, fontWeight = weight),
        maxLines = maxLines, overflow = TextOverflow.Ellipsis,
    ) { offset ->
        annotated.getStringAnnotations("url", offset, offset).firstOrNull()?.let {
            if (it.item.startsWith("/")) onAction(it.item) else openUrl(ctx, it.item)
        }
    }
}

/** 一段机器人回复：按 §69.1 切成几个气泡（最多 6 个），宽内容整列宽；代码 / 草稿 / 文档 / 链接卡不套气泡。 */
@Composable
fun BotBubbles(text: String, modifier: Modifier = Modifier, muted: Boolean = false) {
    val bubbles = remember(text) { Markdown.bubbles(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (b in bubbles) BubbleView(b, muted)
    }
}

@Composable
private fun BubbleView(b: Bubble, muted: Boolean) {
    val sky = LocalSky.current
    if (b.bare) { BlockView(b.blocks[0], muted); return }
    Column(
        (if (b.wide) Modifier.fillMaxWidth() else Modifier.widthIn(max = 560.dp))
            .clip(RoundedCornerShape(18.dp, 18.dp, 18.dp, 6.dp))
            .background(if (muted) Color.Transparent else sky.glass2)
            .then(if (muted) Modifier else Modifier.border(1.dp, sky.glassEdge, RoundedCornerShape(18.dp, 18.dp, 18.dp, 6.dp)))
            .padding(horizontal = 13.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) { for (blk in b.blocks) BlockView(blk, muted) }
}

@Composable
fun BlockView(b: Block, muted: Boolean = false) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    val ink = if (muted) sky.ink3 else sky.ink1
    val size = if (muted) 13.5f else 15.5f
    when (b) {
        is Block.Paragraph -> InlineText(b.text, ink, size)
        is Block.Heading -> InlineText(b.text, ink, if (b.level <= 2) 16.5f else 15.5f, FontWeight.SemiBold)
        is Block.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            b.items.forEachIndexed { i, item ->
                Row {
                    Text(if (b.ordered) "${b.start + i}." else "•", color = sky.ink3, fontSize = size.sp, modifier = Modifier.width(if (b.ordered) 22.dp else 14.dp))
                    Box(Modifier.weight(1f)) { InlineText(item, ink, size) }
                }
            }
        }
        is Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(sky.accent.copy(alpha = 0.6f)))
            Spacer(Modifier.width(8.dp))
            InlineText(b.text, sky.ink3, size - 1f)
        }
        is Block.Table -> TableView(b)
        is Block.Code -> CodeCard(b)
        is Block.Draft -> CardShell("✎", b.title, "草稿", onCopy = { copyText(ctx, b.body) }) {
            Text(b.body, color = sky.ink1, fontSize = 15.sp, lineHeight = 23.sp)
        }
        is Block.Doc -> DocCard(b)
        is Block.Image -> AsyncImage(
            model = absUrl(b.url), contentDescription = b.alt.ifBlank { "图片" }, contentScale = ContentScale.FillWidth,
            modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth().heightIn(min = 80.dp, max = 420.dp).clip(RoundedCornerShape(14.dp))
                .background(sky.glass1).clickable { openUrl(ctx, absUrl(b.url)) },
        )
        is Block.LinkCard -> LinkCardView(b.url, title = b.label)
        is Block.ActionPill -> ActionPillView(b)
        is Block.StatusCards -> StatusCardsView(b.cards)
        is Block.Brief -> BriefCardView(b.title, b.body)
    }
}

@Composable
fun LinkCardView(url: String, title: String? = null, description: String? = null) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    val resolved = remember(url) { absUrl(url) }
    val host = remember(resolved) { runCatching { Uri.parse(resolved).host?.removePrefix("www.") }.getOrNull() ?: url }
    Row(
        Modifier.widthIn(max = 420.dp).fillMaxWidth().glass(sky, RoundedCornerShape(14.dp), level = 2).clickable { openUrl(ctx, resolved) }.padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(32.dp).height(32.dp).clip(RoundedCornerShape(8.dp)).background(sky.accentSoft), contentAlignment = Alignment.Center) {
            Text(host.take(1).uppercase(), color = sky.accent, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title ?: host, color = sky.ink1, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(description ?: url.removePrefix("https://"), color = sky.ink3, fontSize = 12.5.sp, maxLines = if (description != null) 2 else 1, overflow = TextOverflow.Ellipsis)
        }
        Text("↗", color = sky.ink3, fontSize = 15.sp)
    }
}

/** 站内操作胶囊（同网页 hark-action-pill）：白底圆角药丸，点了走 LocalActionPill。 */
@Composable
private fun ActionPillView(b: Block.ActionPill) {
    val onAction = LocalActionPill.current
    Row(
        Modifier.height(40.dp).clip(RoundedCornerShape(20.dp)).background(Color.White).clickable { onAction(b.href) }.padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("↗", color = Color(0xFF334155), fontSize = 14.sp)
        Spacer(Modifier.width(8.dp))
        Text(b.label, color = Color(0xFF1E293B), fontSize = 14.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** `:::card` 状态卡组（同网页 StatusCardGroup）：一张卡一个玻璃小节，body 是 Markdown。 */
@Composable
private fun StatusCardsView(cards: List<cn.ayase.chisabot.md.StatusCard>) {
    val sky = LocalSky.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (card in cards) {
            Column(Modifier.fillMaxWidth().glass(sky, RoundedCornerShape(16.dp), level = 2)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(card.title, color = sky.ink1, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    card.status?.let { Text(it, color = sky.ink3, fontSize = 11.sp) }
                }
                if (card.body.isNotBlank()) {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(sky.ink4.copy(alpha = 0.25f)))
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (blk in remember(card.body) { Markdown.parse(card.body) }) BlockView(blk)
                    }
                }
            }
        }
    }
}

private data class BriefSection(val heading: String, val items: List<String>, val kind: String)

/** 晨报正文 → 头（日期 / 天气 / 导语）+ 小节（同网页 parseBriefBody）。 */
private fun parseBrief(body: String, fallback: String): BriefView {
    var title = fallback.ifEmpty { "今日晨报" }; var date = ""; var weather = ""; var greeting = ""
    val sections = mutableListOf<MutableList<String>>(); val heads = mutableListOf<Pair<String, String>>()
    val kindOf = { h: String -> when {
        Regex("日程|日历|会议|calendar|agenda|schedule", RegexOption.IGNORE_CASE).containsMatchIn(h) -> "calendar"
        Regex("邮件|收件箱|信件|mail|inbox|email", RegexOption.IGNORE_CASE).containsMatchIn(h) -> "mail"
        Regex("提醒|待办|定时|todo|reminder|task", RegexOption.IGNORE_CASE).containsMatchIn(h) -> "reminder"
        else -> "highlight"
    } }
    val clean = { s: String -> s.replace(Regex("\\*\\*([^*]+)\\*\\*"), "$1").replace(Regex("\\*([^*]+)\\*"), "$1").trim() }
    for (raw in body.replace("\r\n", "\n").split("\n")) {
        val l = raw.trim(); if (l.isEmpty()) continue
        val meta = Regex("^(日期|date|天气|weather|问候|导语|greeting|标题|title)\\s*[：:]\\s*(.+)$", RegexOption.IGNORE_CASE).find(l)
        if (meta != null && heads.isEmpty()) {
            val v = meta.groupValues[2].trim()
            when (meta.groupValues[1].lowercase()) {
                "标题", "title" -> title = v; "日期", "date" -> date = v
                "天气", "weather" -> weather = v; else -> greeting = v
            }
            continue
        }
        val h = Regex("^#{1,4}\\s+(.+)$").find(l)
        if (h != null) { heads += h.groupValues[1].trim() to kindOf(h.groupValues[1].trim()); sections += mutableListOf<String>(); continue }
        val item = Regex("^(?:[-*+]|\\d+[.)、])\\s+(.+)$").find(l)
        if (item != null || heads.isNotEmpty()) {
            if (heads.isEmpty()) { heads += "今日要点" to "highlight"; sections += mutableListOf<String>() }
            sections.last() += clean(item?.groupValues?.get(1) ?: l)
        } else if (greeting.isEmpty()) greeting = clean(l)
    }
    return BriefView(title, date, weather, greeting, heads.mapIndexed { i, h -> BriefSection(h.first, sections[i], h.second) })
}

private data class BriefView(val title: String, val date: String, val weather: String, val greeting: String, val sections: List<BriefSection>)

/** 晨报卡（同网页 BriefCard）：头部（徽标 + 标题 + 日期 + 天气 + 导语）+ 小节栅格。 */
@Composable
private fun BriefCardView(title: String, body: String) {
    val sky = LocalSky.current
    val brief = remember(body, title) { parseBrief(body, title) }
    Column(Modifier.fillMaxWidth().glass(sky, RoundedCornerShape(16.dp), level = 2)) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("☀", color = sky.accent, fontSize = 16.sp); Spacer(Modifier.width(6.dp))
                Text("晨报", color = sky.ink3, fontSize = 11.sp)
                if (brief.weather.isNotEmpty()) { Spacer(Modifier.width(8.dp)); Text(brief.weather, color = sky.ink3, fontSize = 11.sp) }
            }
            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(brief.title, color = sky.ink1, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (brief.date.isNotEmpty()) Text(brief.date, color = sky.ink3, fontSize = 12.sp)
            }
            if (brief.greeting.isNotEmpty()) Text(brief.greeting, color = sky.ink2, fontSize = 13.5.sp, modifier = Modifier.padding(top = 4.dp))
        }
        if (brief.sections.isNotEmpty()) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(sky.ink4.copy(alpha = 0.25f)))
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                for (sec in brief.sections.take(4)) {
                    Column {
                        Text(sec.heading, color = sky.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        for (item in sec.items.take(6)) Text("· $item", color = sky.ink1, fontSize = 13.5.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 2.dp))
                        if (sec.items.size > 6) Text("还有 ${sec.items.size - 6} 条…", color = sky.ink3, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun TableView(t: Block.Table) {
    val sky = LocalSky.current
    val cols = maxOf(t.header.size, t.rows.maxOfOrNull { it.size } ?: 0)
    Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Column(Modifier.clip(RoundedCornerShape(10.dp)).border(1.dp, sky.ink4.copy(alpha = 0.35f), RoundedCornerShape(10.dp))) {
            @Composable
            fun line(cells: List<String>, header: Boolean, odd: Boolean) {
                Row(Modifier.background(if (header) sky.accentSoft else if (odd) sky.glass1 else Color.Transparent)) {
                    for (c in 0 until cols) {
                        val align = t.align.getOrNull(c) ?: 'l'
                        Box(Modifier.widthIn(min = 72.dp, max = 220.dp).padding(horizontal = 10.dp, vertical = 7.dp),
                            contentAlignment = when (align) { 'r' -> Alignment.CenterEnd; 'c' -> Alignment.Center; else -> Alignment.CenterStart }) {
                            InlineText(cells.getOrElse(c) { "" }, if (header) sky.ink2 else sky.ink1, 14f, if (header) FontWeight.SemiBold else FontWeight.Normal)
                        }
                    }
                }
            }
            line(t.header, header = true, odd = false)
            t.rows.forEachIndexed { i, r -> line(r, header = false, odd = i % 2 == 1) }
        }
    }
}

@Composable
private fun CodeCard(c: Block.Code) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    val previewFallback = LocalPreviewFallback.current
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (sky.dark) Color(0xFF0B1424) else Color(0xFF14233A))) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(c.lang.ifBlank { "代码" }, color = Color(0xFF9FB3CF), fontSize = 12.sp, modifier = Modifier.weight(1f))
            CopyChip(Color(0xFF9FB3CF)) { copyText(ctx, c.code) }
        }
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 12.dp, top = 2.dp)) {
            Text(c.code, color = Color(0xFFE6EDF7), fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 19.sp, softWrap = false)
        }
        // mermaid / svg / html 在网页有预览卡；原生只出代码，给一条去网页看的出路（显式降级）。
        if (c.lang in PREVIEW_LANGS && previewFallback != null) {
            Text(
                "在网页中打开可预览 ↗", color = Color(0xFF9FB3CF), fontSize = 12.5.sp,
                modifier = Modifier.fillMaxWidth().clickable { previewFallback() }.padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
            )
        }
    }
}

private val PREVIEW_LANGS = setOf("mermaid", "svg", "html")

/** 图片 / 文件工具的成果卡（同网页 ImagePile + FileToolCard，§56）：图片直接画，文件一行图标 + 名字 + 类型。 */
@Composable
fun FileCardsView(files: List<cn.ayase.chisabot.chat.ChatFile>) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (f in files) {
            if (f.image) AsyncImage(
                model = absUrl(f.url), contentDescription = f.prompt ?: f.name, contentScale = ContentScale.FillWidth,
                modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth().heightIn(min = 80.dp, max = 420.dp).clip(RoundedCornerShape(14.dp))
                    .background(sky.glass1).clickable { openUrl(ctx, absUrl(f.url)) },
            )
            else Row(
                Modifier.fillMaxWidth().glass(sky, RoundedCornerShape(14.dp), level = 2).clickable { openUrl(ctx, absUrl(f.url)) }.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.width(32.dp).height(32.dp).clip(RoundedCornerShape(8.dp)).background(sky.accentSoft), contentAlignment = Alignment.Center) {
                    Text("▤", color = sky.accent, fontSize = 14.sp)
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(f.name, color = sky.ink1, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(f.mimeType, color = sky.ink3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text("↗", color = sky.ink3, fontSize = 15.sp)
            }
        }
    }
}

/** 复制：点一下变「已复制 ✓」1.5 秒（按钮内反馈，DESIGN §2）。 */
@Composable
fun CopyChip(color: Color, onCopy: () -> Unit) {
    var done by remember { mutableStateOf(false) }
    LaunchedEffect(done) { if (done) { delay(1500); done = false } }
    Text(
        if (done) "已复制 ✓" else "复制", color = color, fontSize = 12.5.sp,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onCopy(); done = true }.padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

@Composable
private fun CardShell(icon: String, title: String, tag: String?, onCopy: () -> Unit, content: @Composable () -> Unit) {
    val sky = LocalSky.current
    Column(Modifier.fillMaxWidth().glass(sky, RoundedCornerShape(16.dp), level = 2)) {
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(icon, color = sky.accent, fontSize = 14.sp)
            Spacer(Modifier.width(6.dp))
            Text(title, color = sky.ink1, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (tag != null) Text(tag, color = sky.ink3, fontSize = 12.sp)
            CopyChip(sky.accent, onCopy)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(sky.ink4.copy(alpha = 0.25f)))
        Box(Modifier.padding(14.dp)) { content() }
    }
}

/** 文档卡（§76）：正文超过约 300dp 时封顶、底部淡出，「展开全文 ⌄」；流式时也封顶，只有用户点才长高。 */
@Composable
private fun DocCard(d: Block.Doc) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    var expanded by remember { mutableStateOf(false) }
    var overflow by remember { mutableStateOf(false) }
    val arrow by animateFloatAsState(if (expanded) 180f else 0f, tween(180), label = "arrow")
    val blocks = remember(d.body) { Markdown.parse(d.body) }
    CardShell("▤", d.title, null, onCopy = { copyText(ctx, d.body) }) {
        Column {
            Box(
                Modifier.fillMaxWidth().animateContentSize(tween(220))
                    .then(if (expanded) Modifier else Modifier.heightIn(max = 300.dp))
                    .clipToBounds()
                    .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                    .drawWithContent {
                        drawContent()
                        if (!expanded && overflow) drawRect(
                            Brush.verticalGradient(listOf(Color.Black, Color.Transparent), startY = size.height - 72.dp.toPx(), endY = size.height),
                            blendMode = BlendMode.DstIn,
                        )
                    },
            ) {
                Column(
                    Modifier.wrapContentHeight(Alignment.Top, unbounded = true).onHeight { overflow = overflow || it > 300 },
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (b in blocks) BlockView(if (b is Block.Heading) b.copy(level = 3) else b)
                }
            }
            if (overflow) Row(
                Modifier.clip(RoundedCornerShape(8.dp)).clickable { expanded = !expanded }.padding(top = 8.dp, bottom = 2.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(if (expanded) "收起" else "展开全文", color = sky.accent, fontSize = 13.5.sp)
                Spacer(Modifier.width(4.dp))
                Text("⌄", color = sky.accent, fontSize = 13.5.sp, modifier = Modifier.rotate(arrow))
            }
        }
    }
}

/** 量一下内容的自然高度（dp）。 */
@Composable
private fun Modifier.onHeight(cb: (Float) -> Unit): Modifier {
    val density = androidx.compose.ui.platform.LocalDensity.current.density
    return this.onSizeChanged { cb(it.height / density) }
}

/**
 * 逐字平滑放出（和网页 smooth-reveal.ts 同一规则，docs/streaming.md）：速度 = 积压 / 180ms，最少 40 字/秒，收到的字最多 400ms 内显示；
 * 新内容不是旧内容的延续就整段显示；不流式（历史消息）直接显示。
 */
@Composable
fun rememberSmoothText(target: String, streaming: Boolean): String {
    var shown by remember { mutableIntStateOf(if (streaming) 0 else target.length) }
    var base by remember { mutableStateOf(target) }
    if (!target.startsWith(base.take(shown))) { shown = target.length }
    base = target
    LaunchedEffect(streaming) {
        if (!streaming) { shown = Int.MAX_VALUE; return@LaunchedEffect }
        var lastTick = System.nanoTime()
        while (isActive) {
            delay(16)
            val now = System.nanoTime()
            val dt = (now - lastTick) / 1e9f
            lastTick = now
            val total = base.length
            val backlog = total - shown
            if (backlog > 0) {
                val rate = maxOf(40f, backlog / 0.18f)
                val step = maxOf(1, (rate * dt).toInt())
                // 不拆 emoji 代理对
                var next = minOf(total, shown + step)
                if (next < total && Character.isHighSurrogate(base[next - 1])) next++
                shown = next
            }
        }
    }
    return if (shown >= target.length) target else target.substring(0, shown)
}
