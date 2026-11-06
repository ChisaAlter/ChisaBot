package cn.ayase.chisabot.md

/**
 * 聊天用的轻量 Markdown（纯 Kotlin，便于单测）：块级解析 + 按空行切气泡（DESIGN §69.1）。
 * 支持：段落、标题、无序 / 有序列表、引用、表格、围栏代码（```lang；```draft 草稿卡 §69.2；```doc / ```summary 文档卡 §76）、
 * 图片行 ![alt](url)、单独一行的链接（链接卡 §48）。行内样式由界面层（MarkdownView）解析。
 * 流式时没闭合的围栏按一整段代码处理。
 */
sealed class Block {
    data class Paragraph(val text: String) : Block()
    data class Heading(val level: Int, val text: String) : Block()
    data class ListBlock(val ordered: Boolean, val items: List<String>, val start: Int = 1) : Block()
    data class Quote(val text: String) : Block()
    data class Table(val header: List<String>, val align: List<Char>, val rows: List<List<String>>) : Block()
    data class Code(val lang: String, val code: String, val closed: Boolean) : Block()
    data class Draft(val title: String, val body: String) : Block()
    data class Doc(val title: String, val body: String) : Block()
    /** 晨报卡（```brief / ```morning-brief），正文按 meta 行 / 小节 / 列表项解析（同网页 parseBriefBody）。 */
    data class Brief(val title: String, val body: String) : Block()
    data class Image(val alt: String, val url: String) : Block()
    data class LinkCard(val url: String, val label: String? = null) : Block()
    /** 独立一行的站内操作（`[连接 GitHub](/settings/…)`）：胶囊按钮，href 交给界面层解释。 */
    data class ActionPill(val label: String, val href: String) : Block()
    /** `:::group` / `:::card{title="" status=""}` 状态卡组（连接器全景、巡检动态等，同网页 StatusCardGroup）。 */
    data class StatusCards(val cards: List<StatusCard>) : Block()
}

data class StatusCard(val title: String, val status: String?, val body: String)

/** 一个气泡：几块连在一起（列表 / 表格前的「…：」引导句、标题跟着下一段）。wide = 整列宽；bare = 不套气泡（代码、草稿、文档卡）。 */
data class Bubble(val blocks: List<Block>, val wide: Boolean, val bare: Boolean)

object Markdown {
    private val FENCE = Regex("^(\\s{0,3})(`{3,}|~{3,})\\s*([^`\\s]*)\\s*$")
    private val HEADING = Regex("^(#{1,6})\\s+(.*)$")
    private val UL = Regex("^\\s{0,3}[-*+]\\s+(.*)$")
    private val OL = Regex("^\\s{0,3}(\\d{1,3})[.)]\\s+(.*)$")
    private val IMAGE = Regex("^!\\[([^\\]]*)]\\((\\S+?)(?:\\s+\"[^\"]*\")?\\)$")
    private val BARE_URL = Regex("^<?(https?://[^\\s<>]+)>?$")
    private val TABLE_SEP = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")
    /** 独立一行的带标签链接 / 站内操作胶囊（同网页 parseActionPillSegment 的形状；标签 2–32 字才是胶囊）。 */
    private val LINK_LINE = Regex("^\\[([^\\]]+)]\\((\\S+?)\\)$")
    private val ACTION_HREF = Regex("^/[a-zA-Z0-9/_?=&#-]*$")
    private val CARD_ATTR = Regex("(title|status)=\"([^\"]*)\"")

    fun parse(src: String): List<Block> {
        val lines = src.replace("\r\n", "\n").split("\n")
        val out = mutableListOf<Block>()
        var i = 0
        val para = StringBuilder()
        fun flush() {
            if (para.isNotBlank()) out += Block.Paragraph(para.toString().trim('\n'))
            para.clear()
        }
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()
            val fence = FENCE.matchEntire(line)
            if (fence != null) {
                flush()
                val marker = fence.groupValues[2]
                val lang = fence.groupValues[3].lowercase()
                val body = StringBuilder()
                var closed = false
                i++
                while (i < lines.size) {
                    val l = lines[i]
                    val t = l.trim()
                    if (t.length >= marker.length && t.all { it == marker[0] } && t.startsWith(marker)) { closed = true; i++; break }
                    body.append(l).append('\n')
                    i++
                }
                val code = body.toString().trimEnd('\n')
                out += when (lang) {
                    "brief", "morning-brief", "daily-brief" -> {
                        val first = code.lineSequence().firstOrNull().orEmpty()
                        val titled = first.startsWith("标题：") || first.startsWith("标题:") || first.startsWith("title:", ignoreCase = true)
                        var title = if (titled) first.substringAfter('：').substringAfter(':').trim() else ""
                        val rest = if (titled) code.substringAfter('\n', "") else code
                        if (title.isEmpty() && out.lastOrNull() is Block.Heading) title = (out.removeAt(out.lastIndex) as Block.Heading).text
                        Block.Brief(title.ifEmpty { "今日晨报" }, rest)
                    }
                    "cards" -> {
                        // ```cards = :::card 指令块的围栏写法（网页 normalizeDirectiveCards 归一成这种）。
                        statusCards(code.lineSequence().toList())?.let { it }
                            ?: Block.Code(lang, code, closed)
                    }
                    "draft", "doc", "summary" -> {
                        val first = code.lineSequence().firstOrNull().orEmpty()
                        val titled = first.startsWith("标题：") || first.startsWith("标题:")
                        var title = if (titled) first.substringAfter('：').substringAfter(':').trim() else ""
                        val rest = if (titled) code.substringAfter('\n', "") else code
                        // 没写标题行、代码块正上方是一行 Markdown 标题：用那行当卡片标题（§76.1）
                        if (title.isEmpty() && out.lastOrNull() is Block.Heading) title = (out.removeAt(out.lastIndex) as Block.Heading).text
                        if (lang == "draft") Block.Draft(title.ifEmpty { "草稿" }, rest) else Block.Doc(title.ifEmpty { "文档" }, rest)
                    }
                    else -> Block.Code(lang, code, closed)
                }
                continue
            }
            if (trimmed.isEmpty()) { flush(); i++; continue }
            val heading = HEADING.matchEntire(trimmed)
            if (heading != null) {
                flush(); out += Block.Heading(heading.groupValues[1].length, heading.groupValues[2].trim().trimEnd('#').trim()); i++
                continue
            }
            if (trimmed.startsWith("|") && i + 1 < lines.size && TABLE_SEP.matches(lines[i + 1])) {
                flush()
                val header = cells(trimmed)
                val align = cells(lines[i + 1]).map { c ->
                    val t = c.trim()
                    when { t.startsWith(":") && t.endsWith(":") -> 'c'; t.endsWith(":") -> 'r'; else -> 'l' }
                }
                i += 2
                val rows = mutableListOf<List<String>>()
                while (i < lines.size && lines[i].trim().startsWith("|")) { rows += cells(lines[i].trim()); i++ }
                out += Block.Table(header, align, rows)
                continue
            }
            if (UL.matches(line) || OL.matches(line)) {
                flush()
                val ordered = OL.matches(line)
                val start = OL.matchEntire(line)?.groupValues?.get(1)?.toIntOrNull() ?: 1
                val items = mutableListOf<String>()
                while (i < lines.size) {
                    val l = lines[i]
                    val m = (if (ordered) OL else UL).matchEntire(l)
                    if (m != null) { items += m.groupValues.last(); i++; continue }
                    // 续行（缩进）并进上一项
                    if (l.isNotBlank() && l.startsWith("  ") && items.isNotEmpty()) { items[items.lastIndex] = items.last() + "\n" + l.trim(); i++; continue }
                    break
                }
                out += Block.ListBlock(ordered, items, start)
                continue
            }
            if (trimmed.startsWith(">")) {
                flush()
                val q = StringBuilder()
                while (i < lines.size && lines[i].trim().startsWith(">")) { q.append(lines[i].trim().removePrefix(">").trimStart()).append('\n'); i++ }
                out += Block.Quote(q.toString().trimEnd())
                continue
            }
            if (trimmed == ":::group" || trimmed.startsWith(":::card")) {
                flush()
                val grouped = trimmed == ":::group"
                var title = ""; var status: String? = null
                var cur: StringBuilder? = null
                val cards = mutableListOf<StatusCard>()
                fun closeCard() { cur?.let { cards += StatusCard(title.ifEmpty { "信息卡片" }, status, it.toString().trim()) }; cur = null }
                fun openCard(header: String) {
                    closeCard()
                    val attrs = CARD_ATTR.findAll(header).associate { it.groupValues[1] to it.groupValues[2] }
                    title = attrs["title"].orEmpty(); status = attrs["status"]
                    cur = StringBuilder()
                }
                // 单独的 :::card{…}（不在 :::group 里）：首行就是它自己的卡头。
                if (!grouped) openCard(trimmed)
                i++
                while (i < lines.size) {
                    val l = lines[i].trim()
                    if (l.startsWith(":::card")) { openCard(l); i++; continue }
                    if (l == ":::") { i++; if (cur != null) closeCard() else break; if (!grouped) break; continue }
                    if (cur == null) { if (grouped && l.isEmpty()) { i++; continue } else break }
                    cur.append(lines[i]).append('\n'); i++
                }
                closeCard()
                if (cards.isNotEmpty()) out += Block.StatusCards(cards)
                continue
            }
            val image = IMAGE.matchEntire(trimmed)
            if (image != null) { flush(); out += Block.Image(image.groupValues[1], image.groupValues[2]); i++; continue }
            val linkLine = LINK_LINE.matchEntire(trimmed)
            if (linkLine != null) {
                flush()
                val label = linkLine.groupValues[1].trim()
                val href = linkLine.groupValues[2]
                if (ACTION_HREF.matches(href) && label.length in 2..32) out += Block.ActionPill(label, href)
                else out += Block.LinkCard(href, label.ifEmpty { null })
                i++; continue
            }
            val bare = BARE_URL.matchEntire(trimmed)
            if (bare != null) { flush(); out += Block.LinkCard(bare.groupValues[1]); i++; continue }
            para.append(line).append('\n')
            i++
        }
        flush()
        return out
    }

    /** :::card 指令 / ```cards 围栏体 → 状态卡列表；一张都没有返回 null（交给调用方按代码块画）。 */
    private fun statusCards(body: List<String>): Block.StatusCards? {
        val cards = mutableListOf<StatusCard>()
        var title = ""; var status: String? = null
        var cur: StringBuilder? = null
        fun close() { cur?.let { cards += StatusCard(title.ifEmpty { "信息卡片" }, status, it.toString().trim()) }; cur = null }
        for (raw in body) {
            val l = raw.trim()
            when {
                l == ":::group" || l == "```cards" || l == "```" -> Unit
                l.startsWith(":::card") -> {
                    close()
                    val attrs = CARD_ATTR.findAll(l).associate { it.groupValues[1] to it.groupValues[2] }
                    title = attrs["title"].orEmpty(); status = attrs["status"]
                    cur = StringBuilder()
                }
                l == ":::" -> close()
                else -> cur?.append(raw)?.append('\n')
            }
        }
        close()
        return if (cards.isEmpty()) null else Block.StatusCards(cards)
    }

    /** 表格行按「没转义的」| 切格：\| 是字面竖线（GFM 转义规则：奇数个反斜杠后才是转义）。 */
    private fun cells(row: String): List<String> {
        var r = row.trim()
        if (r.startsWith("|")) r = r.substring(1)
        var trailing = 0
        var i = r.length - 2
        while (i >= 0 && r[i] == '\\') { trailing++; i-- }
        if (r.endsWith("|") && trailing % 2 == 0) r = r.dropLast(1)
        val out = mutableListOf<String>()
        var cell = StringBuilder()
        var slashes = 0
        for (ch in r) {
            if (ch == '|' && slashes % 2 == 0) { out += cell.toString(); cell = StringBuilder() } else cell.append(ch)
            slashes = if (ch == '\\') slashes + 1 else 0
        }
        out += cell.toString()
        return out.map { it.trim().replace("\\|", "|") }
    }

    private fun isWide(b: Block) = when (b) {
        is Block.Table, is Block.Code, is Block.Draft, is Block.Doc, is Block.Brief, is Block.StatusCards -> true
        is Block.ListBlock -> b.items.size >= 3
        else -> false
    }

    private fun isBare(b: Block) = b is Block.Code || b is Block.Draft || b is Block.Doc || b is Block.Brief ||
        b is Block.LinkCard || b is Block.Image || b is Block.ActionPill || b is Block.StatusCards

    /** 按块切气泡，最多 6 个（多的并进最后一个，不丢字）。链接卡放到最后。 */
    fun bubbles(src: String, max: Int = 6): List<Bubble> {
        val blocks = parse(src)
        val links = blocks.filterIsInstance<Block.LinkCard>().distinctBy { it.url }
        val groups = mutableListOf<MutableList<Block>>()
        var pendingHeading: Block? = null
        for (b in blocks) {
            if (b is Block.LinkCard) continue
            if (b is Block.Heading) { pendingHeading?.let { groups += mutableListOf(it) }; pendingHeading = b; continue }
            val prev = groups.lastOrNull()?.lastOrNull()
            val leadIn = prev is Block.Paragraph && (prev.text.endsWith("：") || prev.text.endsWith(":")) && prev.text.length <= 60 &&
                (b is Block.ListBlock || b is Block.Table) && pendingHeading == null && groups.last().size == 1
            val heading = pendingHeading
            when {
                heading != null -> { groups.add(mutableListOf(heading, b)); pendingHeading = null }
                leadIn -> { groups.last().add(b) }
                else -> { groups.add(mutableListOf(b)) }
            }
        }
        pendingHeading?.let { groups += mutableListOf(it) }
        while (groups.size > max) { val last = groups.removeAt(groups.lastIndex); groups.last().addAll(last) }
        val out = groups.map { g -> Bubble(g, g.any(::isWide), g.size == 1 && isBare(g[0])) }.toMutableList()
        links.forEach { out += Bubble(listOf(it), wide = false, bare = true) }
        return out
    }
}
