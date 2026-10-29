package cn.ayase.chisabot

import cn.ayase.chisabot.chat.AgUiReducer
import cn.ayase.chisabot.chat.ChatMessage
import cn.ayase.chisabot.chat.Row
import cn.ayase.chisabot.chat.ToolCall
import cn.ayase.chisabot.chat.Turns
import cn.ayase.chisabot.chat.WorkSteps
import cn.ayase.chisabot.chat.parseHistory
import cn.ayase.chisabot.chat.ConfirmCard
import cn.ayase.chisabot.chat.withEditedText
import kotlinx.serialization.json.JsonPrimitive
import cn.ayase.chisabot.md.Block
import cn.ayase.chisabot.md.Markdown
import cn.ayase.chisabot.ui.hideIncompleteTail
import cn.ayase.chisabot.ui.isBackHandled
import cn.ayase.chisabot.ui.micResourcesToGrant
import cn.ayase.chisabot.ui.siteOf
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeLogicTest {
    private fun ev(s: String) = Json.parseToJsonElement(s) as JsonObject

    @Test fun reducerStreamsTextAndTools() {
        val r = AgUiReducer(listOf(ChatMessage("u1", "user", "hi")))
        listOf(
            """{"type":"RUN_STARTED"}""",
            """{"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"skill_list","parentMessageId":"a1"}""",
            """{"type":"TOOL_CALL_END","toolCallId":"c1"}""",
            """{"type":"TEXT_MESSAGE_START","messageId":"a2","role":"assistant"}""",
            """{"type":"TEXT_MESSAGE_CONTENT","messageId":"a2","delta":"我去"}""",
            """{"type":"TEXT_MESSAGE_CONTENT","messageId":"a2","delta":"查一下。"}""",
            """{"type":"TOOL_CALL_START","toolCallId":"c2","toolCallName":"web_search","parentMessageId":"a2"}""",
            """{"type":"TOOL_CALL_ARGS","toolCallId":"c2","delta":"{\"quer"}""",
            """{"type":"TOOL_CALL_ARGS","toolCallId":"c2","delta":"y\":\"价格\"}"}""",
            """{"type":"TOOL_CALL_RESULT","toolCallId":"c2","messageId":"t2","content":"ok"}""",
        ).forEach { r.apply(ev(it)) }
        assertTrue(r.running)
        assertEquals("我去查一下。", r.messages.first { it.id == "a2" }.text)
        val call = r.messages.flatMap { it.toolCalls }.first { it.id == "c2" }
        assertEquals("{\"query\":\"价格\"}", call.args)
        assertEquals("ok", call.result)
        assertEquals("正在搜索「价格」", WorkSteps.current(r.messages.flatMap { it.toolCalls }))
        r.apply(ev("""{"type":"RUN_FINISHED"}"""))
        assertFalse(r.running)
    }

    @Test fun historyMergesToolResults() {
        val hist = Json.parseToJsonElement("""[
          {"id":"u","role":"user","content":[{"type":"text","text":"看图"},{"type":"image","source":{"type":"url","url":"https://x/a.png","mimeType":"image/png"}}]},
          {"id":"a","role":"assistant","toolCalls":[{"id":"c","type":"function","function":{"name":"web_fetch","arguments":"{\"url\":\"https://www.apple.com.cn/x\"}"}}]},
          {"id":"t","role":"tool","toolCallId":"c","content":"done"},
          {"id":"b","role":"assistant","content":"好了"}]""") as JsonArray
        val m = parseHistory(hist)
        assertEquals(3, m.size)
        assertEquals("看图", m[0].text)
        assertEquals(listOf("https://x/a.png"), m[0].images)
        assertEquals("done", m[1].toolCalls[0].result)
        assertEquals("正在读取 apple.com.cn", WorkSteps.current(m[1].toolCalls))
    }

    @Test fun workStepsPrepAndDoneLabel() {
        val calls = listOf(ToolCall("1", "skill_list"), ToolCall("2", "web_search", "{\"query\":\"a\"}"), ToolCall("3", "web_search", "{\"query\":\"b\"}"), ToolCall("4", "web_fetch", "{\"url\":\"https://e.com\"}"))
        assertEquals("正在准备", WorkSteps.current(calls.take(1)))
        assertEquals(3, WorkSteps.stepCount(calls))
        assertEquals("搜索 2 次 · 看了 1 个网页", WorkSteps.doneLabel(calls))
        assertEquals(listOf("搜索「a」", "搜索「b」", "读取 e.com"), WorkSteps.lines(calls))
        assertEquals("做了 2 步", WorkSteps.doneLabel(listOf(ToolCall("1", "web_search"), ToolCall("2", "memory_save"))))
        assertNull(WorkSteps.doneLabel(listOf(ToolCall("1", "render_ui"))))
        // 参数还在流式写（不完整 JSON）
        assertEquals("正在搜索", WorkSteps.current(listOf(ToolCall("1", "web_search", "{\"que"))))
        assertEquals("正在处理", WorkSteps.current(listOf(ToolCall("1", "mystery_tool"))))
    }

    @Test fun turnsPlaceOneWorkCardAndCollapseProcess() {
        val msgs = listOf(
            ChatMessage("u", "user", "WORK"),
            ChatMessage("a1", "assistant", "", listOf(ToolCall("c0", "skill_list", "{}", "x", true))),
            ChatMessage("a2", "assistant", "我去查一下。", listOf(ToolCall("c1", "web_search", "{\"query\":\"q\"}", "r", true))),
            ChatMessage("a3", "assistant", "再核对一下。", listOf(ToolCall("c2", "web_fetch", "{}", "r", true))),
            ChatMessage("a4", "assistant", "结果在这。"),
        )
        val live = Turns.build(msgs, running = true, error = null)
        assertEquals(1, live.count { it is Row.Work })
        // 后面又调了工具的过程话，还在跑时也收起（§90）
        assertFalse(live.any { it is Row.Bot && it.text == "再核对一下。" })
        val workAt = live.indexOfFirst { it is Row.Work }
        assertTrue(live.indexOfFirst { it is Row.Bot && it.text == "我去查一下。" } < workAt)
        val done = Turns.build(msgs, running = false, error = null)
        assertFalse(done.any { it is Row.Bot && it.kind == Row.Kind.Process })
        assertEquals("结果在这。", (done.last() as Row.Bot).text)
        assertTrue((done.last() as Row.Bot).copyable)
        assertEquals(live.first { it is Row.Work }.key, done.first { it is Row.Work }.key) // 同一个 key：原地换样子，不跳
    }

    @Test fun narrationFoldsIntoWorkCard() {
        // 过程话 → 工具：还在跑时，最后一段（后面还没工具）照旧露着
        val msgs = listOf(
            ChatMessage("u", "user", "装一下"),
            ChatMessage("a1", "assistant", "我先检查。", listOf(ToolCall("c1", "device_run_shell", "{}", "r", true))),
            ChatMessage("a2", "assistant", "没装，我用 winget 装。", listOf(ToolCall("c2", "device_run_shell", "{}", null, false))),
        )
        val live = Turns.build(msgs, running = true, error = null)
        assertFalse(live.any { it is Row.Bot && it.text == "没装，我用 winget 装。" })
        // 过程话 → 被中断的工具 → 出错：结束后收起，不当结果
        val failed = Turns.build(msgs.dropLast(1) + ChatMessage("a2", "assistant", "没装，我用 winget 装。", listOf(ToolCall("c2", "device_run_shell", "{}", "interrupted", true))), running = false, error = "暂时连不上模型服务。")
        assertFalse(failed.any { it is Row.Bot && it.text == "没装，我用 winget 装。" })
        assertTrue(failed.last() is Row.Error)
        // 过程话就是结果（没出错）：照旧是结果气泡
        val ok = Turns.build(msgs.dropLast(1) + ChatMessage("a2", "assistant", "装好了。"), running = false, error = null)
        assertTrue(ok.any { it is Row.Bot && it.kind == Row.Kind.Result && it.text == "装好了。" })
    }

    @Test fun turnsThinkingAndPause() {
        val onlyUser = Turns.build(listOf(ChatMessage("u", "user", "hi")), running = true, error = null)
        assertTrue(onlyUser.last() is Row.Thinking)
        val text = Turns.build(listOf(ChatMessage("u", "user", "hi"), ChatMessage("a", "assistant", "我先看一下。")), running = true, error = null)
        assertTrue(text.last() is Row.Pause)
    }

    @Test fun cardEndingTurnUsesLastTextAsResult() {
        val spec = "{\"spec\":\"{\\\"root\\\":\\\"r\\\",\\\"elements\\\":{}}\"}"
        val msgs = listOf(
            ChatMessage("u", "user", "CARD"),
            ChatMessage("a1", "assistant", "我去查一下。", listOf(ToolCall("c1", "web_search", "{}", "r", true))),
            ChatMessage("a2", "assistant", "表里深圳未核实。", listOf(ToolCall("c2", "render_ui", spec, "ok", true))),
        )
        val done = Turns.build(msgs, running = false, error = null)
        assertTrue(done.any { it is Row.Card })
        assertTrue(done.any { it is Row.Bot && it.kind == Row.Kind.Result && it.text == "表里深圳未核实。" })
    }

    @Test fun markdownBlocksAndBubbles() {
        val md = "这是表：\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n```kotlin\nval x = 1\n```\n\n- 一\n- 二\n- 三\n\n## 标题\n正文\n\nhttps://kotlinlang.org/\n"
        val blocks = Markdown.parse(md)
        assertTrue(blocks[0] is Block.Paragraph)
        val t = blocks[1] as Block.Table
        assertEquals(listOf('l', 'r'), t.align)
        assertEquals("kotlin", (blocks[2] as Block.Code).lang)
        assertEquals(3, (blocks[3] as Block.ListBlock).items.size)
        assertTrue(blocks.last() is Block.LinkCard)
        val bubbles = Markdown.bubbles(md)
        // 「这是表：」和表格合成一个气泡；链接卡在最后
        assertEquals(2, bubbles[0].blocks.size)
        assertTrue(bubbles.last().blocks[0] is Block.LinkCard)
    }

    @Test fun docAndDraftCards() {
        val b = Markdown.parse("结论。\n\n````doc\n标题：React 19\n## Actions\n```js\nx\n```\n````\n")
        val doc = b[1] as Block.Doc
        assertEquals("React 19", doc.title)
        assertTrue(doc.body.contains("```js"))
        val unclosed = Markdown.parse("```python\nprint(1)")
        assertFalse((unclosed[0] as Block.Code).closed)
        val draft = Markdown.parse("### 给老板的邮件\n```draft\n你好\n```")
        assertEquals("给老板的邮件", (draft[0] as Block.Draft).title)
    }

    @Test fun bubblesCapAtSix() {
        val md = (1..9).joinToString("\n\n") { "第${it}段" }
        val bubbles = Markdown.bubbles(md)
        assertEquals(6, bubbles.size)
        assertEquals(4, bubbles.last().blocks.size)
    }

    @Test fun siteGrouping() {
        assertEquals("open-meteo.com", siteOf("api.open-meteo.com"))
        assertEquals("weather.com.cn", siteOf("www2.weather.com.cn"))
        assertEquals("jma.go.jp", siteOf("www.jma.go.jp"))
    }

    @Test fun streamingHidesHalfImage() {
        assertEquals("好的\n", hideIncompleteTail("好的\n![示例图](https:/"))
        assertEquals("看 ", hideIncompleteTail("看 [链接](http"))
        assertEquals("看 [链接](http://a)", hideIncompleteTail("看 [链接](http://a)"))
    }

    @Test fun historyReadsAttachmentParts() {
        val hist = Json.parseToJsonElement("""[{"id":"u1","role":"user","content":[{"type":"text","text":"看看"},
          {"type":"image","source":{"type":"url","value":"/api/attachments/a1","mimeType":"image/png"},"metadata":{"attachmentId":"a1","filename":"猫.png","width":800,"height":600}},
          {"type":"document","source":{"type":"url","value":"/api/attachments/a2","mimeType":"text/csv"},"metadata":{"attachmentId":"a2","filename":"表.csv"}}]}]""") as JsonArray
        val m = parseHistory(hist).single()
        assertEquals("看看", m.text)
        assertEquals(listOf("/api/attachments/a1"), m.images)
        assertEquals(listOf("猫.png", "表.csv"), m.files.map { it.name })
        assertFalse(m.files[1].image)
        assertEquals(800 to 600, m.files[0].width to m.files[0].height)
        assertNull(m.files[1].width)
    }

    @Test fun editKeepsAttachments() {
        val c = Json.parseToJsonElement("""[{"type":"text","text":"旧"},{"type":"image","source":{"type":"url","value":"/api/attachments/a1"}}]""")
        val e = withEditedText(c, " 新 ") as JsonArray
        assertEquals(2, e.size)
        assertEquals("新", ((e[0] as JsonObject)["text"] as JsonPrimitive).content)
        assertEquals(JsonPrimitive("改"), withEditedText(JsonPrimitive("旧"), "改"))
        assertNull(withEditedText(JsonPrimitive("旧"), "  "))
    }

    @Test fun turnsServerRowsRegenerateAndConfirms() {
        val call = ToolCall("c1", "panel_remove", "{}", null, true)
        val msgs = listOf(
            ChatMessage("u1", "user", "删掉旧面板"),
            ChatMessage("a1", "assistant", "我把它删掉。", listOf(call)),
            ChatMessage("u2", "user", "⟦chisabot:confirm:x⟧ 用户确认了「删除面板」"),
            ChatMessage("a2", "assistant", "删好了。"),
        )
        val card = ConfirmCard("cf1", "c1", "delete", "删除面板", null, emptyList(), "approved")
        val rows = Turns.build(msgs, running = false, error = null, confirms = mapOf("c1" to listOf(card)))
        assertTrue(rows.any { it is Row.Confirm })
        val server = rows.filterIsInstance<Row.Server>().single()
        assertEquals("你确认了「删除面板」，机器人接着做", server.text)
        // 最后一轮是服务器行开的：没有重新生成；人发的 u1 可以编辑
        assertFalse(rows.filterIsInstance<Row.Bot>().any { it.regenerate })
        assertTrue((rows.first() as Row.User).editable)
        val plain = Turns.build(msgs.take(2) + ChatMessage("u3", "user", "再说一次") + ChatMessage("a3", "assistant", "好。"), false, null)
        assertTrue(plain.filterIsInstance<Row.Bot>().last().regenerate)
        assertFalse(plain.filterIsInstance<Row.User>().first().editable)
        assertFalse(Turns.build(msgs.take(2) + ChatMessage("u3", "user", "再说一次"), true, null).filterIsInstance<Row.User>().any { it.editable })
    }

    @Test
    fun webBackOnlyStopsOnLiteralTrue() {
        assertTrue(isBackHandled("true"))
        assertFalse(isBackHandled("false"))
        assertFalse(isBackHandled("null"))
        assertFalse(isBackHandled(null))
        assertFalse(isBackHandled("\"true\""))
    }

    @Test
    fun webMicOnlyForOwnOriginAndOnlyAudio() {
        val audio = "android.webkit.resource.AUDIO_CAPTURE"
        val video = "android.webkit.resource.VIDEO_CAPTURE"
        val app = "https://chat.example.com"
        // 本服务器要麦克风：给，且只给麦克风。WebView 的 origin 常带结尾斜杠、主机大小写不定、默认端口可写可不写。
        assertEquals(listOf(audio), micResourcesToGrant("https://chat.example.com/", app, arrayOf(audio))?.toList())
        assertEquals(listOf(audio), micResourcesToGrant("https://Chat.Example.com:443", app, arrayOf(audio))?.toList())
        // 别的来源、别的协议 / 端口 / 子域名：拒绝。
        assertNull(micResourcesToGrant("https://evil.example.com/", app, arrayOf(audio)))
        assertNull(micResourcesToGrant("http://chat.example.com/", app, arrayOf(audio)))
        assertNull(micResourcesToGrant("https://chat.example.com:8443/", app, arrayOf(audio)))
        assertNull(micResourcesToGrant("https://chat.example.com.evil.net/", app, arrayOf(audio)))
        assertNull(micResourcesToGrant(null, app, arrayOf(audio)))
        assertNull(micResourcesToGrant("file:///android_asset/x.html", app, arrayOf(audio)))
        // 本服务器但还要摄像头、或者什么都没要：拒绝。
        assertNull(micResourcesToGrant("https://chat.example.com/", app, arrayOf(audio, video)))
        assertNull(micResourcesToGrant("https://chat.example.com/", app, arrayOf(video)))
        assertNull(micResourcesToGrant("https://chat.example.com/", app, arrayOf()))
        // 自建服务器带端口（如 :8443）时按同一端口比较。
        assertEquals(listOf(audio), micResourcesToGrant("https://10.0.0.5:8443/", "https://10.0.0.5:8443", arrayOf(audio))?.toList())
    }
}
