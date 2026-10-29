package cn.ayase.chisabot.chat

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** 聊天画面里的一行（从上到下）。key 稳定，LazyColumn 靠它保持位置不跳（DESIGN §35）。 */
/** 确认卡片（DESIGN §58）：/api/confirmations/requests 的一条，或上游审批（/api/approvals，§58 外观）。 */
data class ConfirmCard(
    val id: String,
    val toolCallId: String,
    val category: String,          // message | delete | purchase | device
    val title: String,
    val target: String?,
    val details: List<Triple<String, String, String>>, // label, value, style(""|code|diff)
    val status: String,            // pending | approved | denied | expired | cancelled
    val decidedNote: String? = null,
    /** upstream = /api/approvals 的请求（决定用 allow_once / deny / handled），否则确认卡片。 */
    val upstream: Boolean = false,
    val handOff: Boolean = false,
    val eyebrow: String? = null,
)

sealed class Row(val key: String) {
    /** editable = 人发的、这一轮没在跑时可以编辑后重发（§67）。 */
    class User(val msg: ChatMessage, val editable: Boolean = false) : Row("u:" + msg.id)
    /** 服务器放进对话的「用户角色」消息（定时任务 / 后台任务结果 / 确认后接着做），一行淡色小字。 */
    class Server(key: String, val text: String) : Row(key)
    /** 工具调用下面的确认卡片。 */
    class Confirm(val card: ConfirmCard) : Row("cf:" + card.id)
    /** 机器人的一段话：opening = 开场一句，result = 结果，process = 过程话（还在跑时淡色显示，结束后收起）。 */
    class Bot(key: String, val text: String, val kind: Kind, val streaming: Boolean, val copyable: Boolean, val regenerate: Boolean = false) : Row(key)
    /** 一轮一张干活卡（§75）：live = 这一轮还在跑。 */
    class Work(key: String, val turnKey: String, val calls: List<ToolCall>, val live: Boolean) : Row(key)
    /** render_ui 画的卡片（json-render spec）。 */
    class Card(key: String, val spec: String) : Row(key)
    /** 还没有干活卡、这一轮在跑、末尾不是字：「思考中」。 */
    class Thinking(key: String) : Row(key)
    /** 末尾是字、这一轮还在跑、没有干活卡：停住 0.9 秒后出小点（§78.2，由界面计时）。 */
    class Pause(key: String, val lastText: String) : Row(key)
    class Error(key: String, val text: String) : Row(key)

    enum class Kind { Opening, Process, Result }
}

private sealed class Seg {
    class Text(val id: String, val text: String) : Seg()
    class Tool(val call: ToolCall) : Seg()
}

object Turns {
    /** render_ui 的 spec：参数 {spec: "<json 字符串>"} 或 {spec: {…}}。 */
    fun renderSpec(call: ToolCall): String? {
        val args = WorkSteps.parseArgs(call.args)
        val spec = args["spec"] ?: return null
        return (spec as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: spec.toString()
    }

    fun build(messages: List<ChatMessage>, running: Boolean, error: String?, confirms: Map<String, List<ConfirmCard>> = emptyMap()): List<Row> {
        val rows = mutableListOf<Row>()
        val lastHuman = messages.indexOfLast { it.role == "user" && !ServerRows.isServerRow(it.text) }.let { if (it >= 0) messages[it].id else null }
        // 第一条用户消息之前的机器人消息（欢迎语等）也按一轮处理
        val turns = mutableListOf<Pair<ChatMessage?, MutableList<ChatMessage>>>()
        for (m in messages) {
            if (m.role == "user") turns += m to mutableListOf()
            else if (turns.isEmpty()) turns += null to mutableListOf(m)
            else turns.last().second += m
        }
        for ((index, turn) in turns.withIndex()) {
            val (user, replies) = turn
            if (user != null) {
                rows += if (ServerRows.isServerRow(user.text)) Row.Server("s:" + user.id, ServerRows.label(user.text))
                else Row.User(user, editable = !running && user.id == lastHuman)
            }
            val last = index == turns.lastIndex
            buildTurn(rows, user?.id ?: "pre", replies, running && last, confirms)
        }
        // 重新生成（§67.4）：最后一轮最后一段看得见的回答下面；没在回答、最后一轮有人发的消息时才有
        if (!running && lastHuman != null && turns.lastOrNull()?.first?.id == lastHuman) {
            val at = rows.indexOfLast { it is Row.Bot || it is Row.User || it is Row.Server }
            val r = rows.getOrNull(at)
            if (r is Row.Bot) rows[at] = Row.Bot(r.key, r.text, r.kind, r.streaming, r.copyable, regenerate = true)
        }
        if (!running && error != null) rows += Row.Error("err:" + (turns.lastOrNull()?.first?.id ?: "x"), error)
        return rows
    }

    private fun buildTurn(rows: MutableList<Row>, turnKey: String, replies: List<ChatMessage>, live: Boolean, confirms: Map<String, List<ConfirmCard>>) {
        val segs = mutableListOf<Seg>()
        for (m in replies) {
            if (m.text.isNotBlank()) segs += Seg.Text(m.id, m.text)
            for (c in m.toolCalls) segs += Seg.Tool(c)
        }
        val calls = segs.filterIsInstance<Seg.Tool>().map { it.call }
        val workIdx = segs.indexOfFirst { it is Seg.Tool && WorkSteps.isWorkCall(it.call.name) }
        val lastToolIdx = segs.indexOfLast { it is Seg.Tool }
        // 最后一个真的在干活的步骤（不含 render_ui、记忆写入等）：它之后的全部文字都是回答，不是过程话
        val lastWorkIdx = segs.indexOfLast { it is Seg.Tool && WorkSteps.splitsReply(it.call.name) }
        // 结果：最后一个工具之后的字；以卡片收尾（后面没字）且这一轮结束 → 卡片前最后一段话当结果（§75.3）
        var resultIdx = -1
        if (lastToolIdx < 0) {
            resultIdx = segs.indexOfLast { it is Seg.Text }
        } else {
            // 还在跑时照旧以最后一个工具为界（结果没定）；结束后以最后一个干活步骤为界
            val after = ((if (live) lastToolIdx else lastWorkIdx) + 1 until segs.size).lastOrNull { segs[it] is Seg.Text }
            if (after != null) resultIdx = after
            else if (!live) {
                val lastTool = (segs[lastToolIdx] as Seg.Tool).call
                if (lastTool.name == "render_ui") resultIdx = (0 until lastToolIdx).lastOrNull { segs[it] is Seg.Text } ?: -1
            }
        }
        var workPlaced = false
        val hasWork = workIdx >= 0
        // 后面还有干活的工具：这段话是过程话，还在跑也马上收起（§90），不在卡片下面散成一段
        fun workAfter(n: Int) = (n + 1 until segs.size).any { val s = segs[it]; s is Seg.Tool && WorkSteps.splitsReply(s.call.name) }
        val replyFrom = if (!live && resultIdx > lastWorkIdx) lastWorkIdx else segs.size
        for ((n, seg) in segs.withIndex()) {
            when (seg) {
                is Seg.Text -> {
                    val streamingNow = live && n == segs.lastIndex
                    when {
                        n == resultIdx -> rows += Row.Bot("t:" + seg.id, seg.text, Row.Kind.Result, streamingNow, !live)
                        // 结果之前、最后一个干活步骤之后的话（连发几条回答）：照旧是气泡，不收起
                        n > replyFrom -> rows += Row.Bot("t:" + seg.id, seg.text, Row.Kind.Opening, streamingNow, false)
                        !hasWork || n < workIdx -> rows += Row.Bot("t:" + seg.id, seg.text, Row.Kind.Opening, streamingNow, false)
                        live && !workAfter(n) -> rows += Row.Bot("t:" + seg.id, seg.text, Row.Kind.Process, streamingNow, false)
                        else -> Unit // 结束后过程话收起（§75）
                    }
                }
                is Seg.Tool -> {
                    if (n == workIdx && !workPlaced) {
                        rows += Row.Work("w:$turnKey", turnKey, calls, live)
                        workPlaced = true
                    }
                    if (seg.call.name == "render_ui") renderSpec(seg.call)?.let { rows += Row.Card("c:" + seg.call.id, it) }
                    confirms[seg.call.id]?.forEach { rows += Row.Confirm(it) }
                }
            }
        }
        if (live) {
            val tail = segs.lastOrNull()
            when {
                hasWork -> Unit // 有卡时末尾不再画「思考中」，卡片本身在动
                tail is Seg.Text -> rows += Row.Pause("p:$turnKey", tail.text)
                else -> rows += Row.Thinking("k:$turnKey")
            }
        }
    }
}
