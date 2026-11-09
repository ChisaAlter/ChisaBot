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
import cn.ayase.chisabot.chat.a
import cn.ayase.chisabot.chat.filesFromToolResult
import cn.ayase.chisabot.chat.o
import cn.ayase.chisabot.chat.s
import cn.ayase.chisabot.chat.str
import kotlinx.serialization.json.JsonPrimitive
import cn.ayase.chisabot.md.Block
import cn.ayase.chisabot.md.Markdown
import cn.ayase.chisabot.ui.hideIncompleteTail
import cn.ayase.chisabot.ui.isBackHandled
import cn.ayase.chisabot.ui.MIC_DENIED_ONCE_MESSAGE
import cn.ayase.chisabot.ui.MIC_DENIED_SETTINGS_MESSAGE
import cn.ayase.chisabot.ui.isMicPermanentlyDenied
import cn.ayase.chisabot.ui.micResourcesToGrant
import cn.ayase.chisabot.ui.webDownloadName
import cn.ayase.chisabot.ui.webExportPickerMime
import cn.ayase.chisabot.ui.siteOf
import cn.ayase.chisabot.ui.needsShell
import cn.ayase.chisabot.ui.sameTitle
import cn.ayase.chisabot.ui.dropDuplicatePanelTitle
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

    @Test fun webDownloadPreservesServerUnicodeFilenameAndDropsPaths() {
        assertEquals("回滚验收文件.txt", webDownloadName("https://example.com/api/chat-files/id?download=1", "attachment; filename*=UTF-8''%E5%9B%9E%E6%BB%9A%E9%AA%8C%E6%94%B6%E6%96%87%E4%BB%B6.txt", "application/octet-stream"))
        assertEquals("a+b.txt", webDownloadName("https://example.com/file", "attachment; filename*=UTF-8''..%2Fa+b.txt", "text/plain"))
    }

    @Test fun exportPickerRetainsCodeExtensionWithoutOverridingSpecificMediaTypes() {
        assertEquals("application/javascript", webExportPickerMime("file.js", "text/plain;charset=utf-8"))
        assertEquals("image/png", webExportPickerMime("image.js", "image/png"))
        assertEquals("application/octet-stream", webExportPickerMime("unknown.custom", "application/octet-stream"))
    }

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
        // 胶囊只在干活时出现（§123）：这一轮一结束，干活那一行整行收起，不再留「✓ N 步」那行
        assertFalse(done.any { it is Row.Work })
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

    @Test fun allTextAfterLastWorkStaysVisible() {
        fun bots(rows: List<Row>) = rows.filterIsInstance<Row.Bot>().map { it.text }
        fun replyRow(rows: List<Row>, text: String) = rows.filterIsInstance<Row.Bot>().first { it.text == text }
        // 先干活、再连发两条（没有开场一句）：两条都是气泡，最后一条是结果
        val plain = Turns.build(listOf(
            ChatMessage("u", "user", "装一下"),
            ChatMessage("a1", "assistant", "", listOf(ToolCall("t1", "device_run_shell", "{}", "r", true))),
            ChatMessage("a2", "assistant", "装好了。"),
            ChatMessage("a3", "assistant", "版本是 1.2。"),
        ), running = false, error = null)
        assertEquals(listOf("装好了。", "版本是 1.2。"), bots(plain))
        assertEquals(Row.Kind.Result, (plain.last() as Row.Bot).kind)
        // 补出来的回答和结果一样：Result、带复制按钮（ChatScreen 只给 copyable 的 Result 画复制）
        assertTrue(replyRow(plain, "装好了。").kind == Row.Kind.Result && replyRow(plain, "装好了。").copyable)
        // 回答中间记了一笔（memory_save）：不当分界；干活前的开场一句照旧在卡片上面
        val mid = Turns.build(listOf(
            ChatMessage("u", "user", "装一下"),
            ChatMessage("a1", "assistant", "我先检查。", listOf(ToolCall("t1", "device_run_shell", "{}", "r", true))),
            ChatMessage("a2", "assistant", "装好了。", listOf(ToolCall("m1", "memory_save", "{\"content\":\"装了\"}", "ok", true))),
            ChatMessage("a3", "assistant", "版本是 1.2。"),
        ), running = false, error = null)
        assertEquals(listOf("我先检查。", "装好了。", "版本是 1.2。"), bots(mid))
        assertEquals(Row.Kind.Opening, replyRow(mid, "我先检查。").kind)
        assertTrue(replyRow(mid, "装好了。").kind == Row.Kind.Result && replyRow(mid, "装好了。").copyable)
        assertEquals(Row.Kind.Result, mid.filterIsInstance<Row.Bot>().last().kind)
        // 回答之后才记一笔（memory_save 在最后）：两条回答都在，最后一段字是结果
        val end = Turns.build(listOf(
            ChatMessage("u", "user", "装一下"),
            ChatMessage("a1", "assistant", "", listOf(ToolCall("t1", "device_run_shell", "{}", "r", true))),
            ChatMessage("a2", "assistant", "装好了。"),
            ChatMessage("a3", "assistant", "版本是 1.2。", listOf(ToolCall("m1", "memory_save", "{}", "ok", true))),
        ), running = false, error = null)
        assertEquals(listOf("装好了。", "版本是 1.2。"), bots(end))
        assertTrue(replyRow(end, "装好了。").kind == Row.Kind.Result && replyRow(end, "装好了。").copyable)
        assertEquals(Row.Kind.Result, end.filterIsInstance<Row.Bot>().last().kind)
        // 还在跑时照旧：不带复制
        val running = Turns.build(listOf(
            ChatMessage("u", "user", "装一下"),
            ChatMessage("a1", "assistant", "", listOf(ToolCall("t1", "device_run_shell", "{}", "r", true))),
            ChatMessage("a2", "assistant", "装好了。"),
        ), running = true, error = null)
        assertFalse(running.filterIsInstance<Row.Bot>().any { it.copyable })
    }

    @Test fun notWorkMatchesWeb() {
        // 同网页 work-steps.ts NOT_WORK：机器人往来、递交文件、生成 / 改图不算干活，也不数进收成的一行
        for (name in listOf("render_ui", "worker_plan", "skill_load", "skill_list", "message_bot", "file_share", "image_generate", "image_edit")) {
            assertFalse(name, WorkSteps.isWorkCall(name))
            assertFalse(name, WorkSteps.splitsReply(name))
        }
        // 记忆写入：干活卡里照旧算一步，但不当回答的分界
        assertTrue(WorkSteps.isWorkCall("memory_save"))
        assertFalse(WorkSteps.splitsReply("memory_save"))
        assertTrue(WorkSteps.splitsReply("device_run_shell"))
        assertNull(WorkSteps.doneLabel(listOf(ToolCall("1", "image_generate"), ToolCall("2", "file_share"), ToolCall("3", "message_bot"))))
        assertEquals("搜索 1 次", WorkSteps.doneLabel(listOf(ToolCall("1", "web_search"), ToolCall("2", "image_edit"), ToolCall("3", "file_share"))))
        assertEquals(WorkSteps.lines(listOf(ToolCall("1", "web_search", "{\"query\":\"a\"}"))), WorkSteps.lines(listOf(ToolCall("1", "web_search", "{\"query\":\"a\"}"), ToolCall("2", "image_generate", "{}"), ToolCall("3", "message_bot", "{}"))))
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

        // §124：触发帧（定时 / 长期任务 / 跟进到点）也是服务器行，不画成用户气泡、不给编辑。
        val firing = Turns.build(
            listOf(ChatMessage("u9", "user", "One of your routines is firing right now, on its schedule, and this is that firing.\nCarry out the instruction below in this turn: do the work now, then say what happened.\nDo not create, list or change any routine unless the instruction itself asks you to.\n\nYou scheduled this follow-up for yourself on 2026-11-04. Your reason: 看一眼"),),
            running = false, error = null,
        )
        assertEquals("定时任务已运行，机器人开始做", firing.filterIsInstance<Row.Server>().single().text)
        assertFalse(firing.any { it is Row.User })
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

    @Test fun micDeniedHint() {
        // 拒绝后系统不再给理由提示 = 选了「不再询问」，要引导去设置
        assertTrue(isMicPermanentlyDenied(shouldShowRationale = false))
        assertFalse(isMicPermanentlyDenied(shouldShowRationale = true))
        assertTrue(MIC_DENIED_SETTINGS_MESSAGE.contains("系统设置") && MIC_DENIED_SETTINGS_MESSAGE.contains("重新录音"))
        assertTrue(MIC_DENIED_ONCE_MESSAGE.contains("重新录音"))
    }

    @Test fun pairingInspectSeparatesReasons() {
        val good = Pairing.inspect("chisabot://pair?server=https%3A%2F%2Fchat.example.com%3A8443&code=cbp_${"a".repeat(32)}")
        assertTrue(good is Pairing.Result.Ok)
        assertEquals("https://chat.example.com:8443", (good as Pairing.Result.Ok).link.server)
        assertEquals("cbp_${"a".repeat(32)}", good.link.code)
        // 不是本应用的码：报不是绑定二维码；认得出 URL 的把 host 带上
        val other = Pairing.inspect("https://weixin.qq.com/some/path") as Pairing.Result.Bad
        assertTrue(other.reason.contains("不是 ChisaBot") && other.reason.contains("weixin.qq.com"))
        // 本应用的码 + 局域网 http 服务器（内网自建部署走 http 是常态）：直接能用
        val lan = Pairing.inspect("chisabot://pair?server=http%3A%2F%2F192.168.1.5%3A3000&code=cbp_${"a".repeat(32)}") as Pairing.Result.Ok
        assertEquals("http://192.168.1.5:3000", lan.link.server)
        // 本应用的码但服务器是公网 http：说明 http 只放局域网，别说「不是绑定二维码」
        val http = Pairing.inspect("chisabot://pair?server=http%3A%2F%2Fexample.com&code=cbp_${"a".repeat(32)}") as Pairing.Result.Bad
        assertTrue(http.reason.contains("example.com") && http.reason.contains("https"))
        // 码不完整 / 缺 server / 空 / null
        assertTrue(Pairing.inspect("chisabot://pair?server=https%3A%2F%2Fx&code=bad") is Pairing.Result.Bad)
        assertTrue(Pairing.inspect("chisabot://pair?code=cbp_${"a".repeat(32)}") is Pairing.Result.Bad)
        assertTrue(Pairing.inspect("") is Pairing.Result.Bad)
        assertTrue(Pairing.inspect(null) is Pairing.Result.Bad)
        assertTrue(Pairing.inspect("chisabot://pair?server=https%3A%2F%2Fx&code=cbp_${"a".repeat(31)}") is Pairing.Result.Bad)
    }

    @Test fun normalizePrivateHttp() {
        // 局域网 / 环回字面量 + localhost / *.local：http 放行（内网自建）
        assertEquals("http://192.168.1.5:3000", GatewayAuth.normalize("http://192.168.1.5:3000"))
        assertEquals("http://10.0.2.2:3000", GatewayAuth.normalize("http://10.0.2.2:3000"))
        assertEquals("http://172.16.8.1", GatewayAuth.normalize("http://172.16.8.1"))
        assertEquals("http://172.31.255.254", GatewayAuth.normalize("http://172.31.255.254"))
        assertEquals("http://127.0.0.1:8080", GatewayAuth.normalize("http://127.0.0.1:8080"))
        assertEquals("http://localhost:3000", GatewayAuth.normalize("http://localhost:3000"))
        assertEquals("http://nas.local", GatewayAuth.normalize("http://nas.local"))
        assertEquals("http://[::1]:3000", GatewayAuth.normalize("http://[::1]:3000"))
        // 公网 http 一律拒（含公网 IP、域名）
        for (bad in listOf("http://example.com", "http://8.8.8.8", "http://192.168.1.5.evil.com", "http://172.32.0.1", "ftp://192.168.1.5")) {
            val e = try { GatewayAuth.normalize(bad); null } catch (x: GatewayAuth.LoginError) { x }
            assertEquals("$bad", "invalid", e?.kind)
        }
        // 没写协议的默认 https；显式 :80 的 http 归一掉端口
        assertEquals("https://chat.example.com", GatewayAuth.normalize("chat.example.com"))
        assertEquals("http://192.168.1.5", GatewayAuth.normalize("http://192.168.1.5:80"))
    }

    @Test fun deviceRenewalNeverUsesAnotherServersBinding() {
        val first = "https://first.example.com"
        val second = "https://second.example.com"
        val token = "cbd_device-token"
        assertEquals(token, boundDeviceToken(first, first, first, token))
        // 第一台服务器的旧请求晚到 401，此时已经扫码登录第二台：不能把第二台令牌发给第一台。
        assertNull(boundDeviceToken(first, second, second, token))
        // 当前服务器、绑定服务器和请求目标三个值都要一致（端口也属于身份边界）。
        assertNull(boundDeviceToken(second, second, first, token))
        assertNull(boundDeviceToken(first, first, "$first:8443", token))
        assertNull(boundDeviceToken(first, null, first, token))
        assertNull(boundDeviceToken(first, first, first, null))
        assertNull(boundDeviceToken(first, first, first, "other-token"))
    }

    // ---- json-render §29：缺外壳时整张界面自己当外壳（对齐 shared/json-render/shell.test.ts）----

    private fun jr(type: String, children: List<String> = emptyList(), props: String = "{}") =
        """{"type":"$type","props":$props,"children":[${children.joinToString(",") { "\"$it\"" }}]}"""

    private fun jrSpec(elements: Map<String, String>, root: String = "root") =
        ev("""{"root":"$root","elements":{${elements.entries.joinToString(",") { "\"${it.key}\":${it.value}" }}}}""")

    @Test fun surfaceShellWhenTextSitsOnBackground() {
        // 2026-11-06 截图同款：Grid 两张对比卡 + 底下一行淡字 → 那行字落在天空上，要补外壳
        assertTrue(needsShell(jrSpec(mapOf(
            "root" to jr("Stack", listOf("grid", "note")),
            "grid" to jr("Grid", listOf("a", "b")),
            "a" to jr("Card", listOf("at"), """{"title":"方案 A"}"""),
            "at" to jr("Text"),
            "b" to jr("Card", listOf("bt"), """{"title":"方案 B"}"""),
            "bt" to jr("Text"),
            "note" to jr("Text", props = """{"tone":"muted","size":"sm"}"""),
        ))))
    }

    @Test fun surfaceShellSkippedWhenCardCovers() {
        assertFalse(needsShell(jrSpec(mapOf("root" to jr("Card", listOf("t")), "t" to jr("Text")))))
        assertFalse(needsShell(jrSpec(mapOf(
            "root" to jr("Stack", listOf("a", "b")),
            "a" to jr("Card", listOf("h", "kv")),
            "h" to jr("Heading"),
            "kv" to jr("KeyValue"),
            "b" to jr("Card"),
        ))))
    }

    @Test fun surfacedComponentsCanStandAlone() {
        assertFalse(needsShell(jrSpec(mapOf("root" to jr("Grid", listOf("m1", "m2")), "m1" to jr("Metric"), "m2" to jr("Metric")))))
        assertFalse(needsShell(jrSpec(mapOf(
            "root" to jr("Stack", listOf("b1", "b2"), """{"direction":"horizontal"}"""),
            "b1" to jr("Button"), "b2" to jr("Button"),
        ))))
        assertFalse(needsShell(jrSpec(mapOf("root" to jr("Stack", listOf("p", "l")), "p" to jr("Products"), "l" to jr("List")))))
        assertFalse(needsShell(jrSpec(mapOf("root" to jr("Carousel", listOf("l1", "l2")), "l1" to jr("Link"), "l2" to jr("Link")))))
    }

    @Test fun bareContentAsksForShell() {
        assertTrue(needsShell(jrSpec(mapOf("root" to jr("Text")))))
        assertTrue(needsShell(jrSpec(mapOf("root" to jr("Stack", listOf("h", "p")), "h" to jr("Heading"), "p" to jr("Products")))))
        assertTrue(needsShell(jrSpec(mapOf("root" to jr("Stack", listOf("kv")), "kv" to jr("KeyValue")))))
        assertTrue(needsShell(jrSpec(mapOf("root" to jr("Grid", listOf("c")), "c" to jr("Chart")))))
        // 轮播里一项是没有卡片的 Stack：里面的字一样落在背景上
        assertTrue(needsShell(jrSpec(mapOf("root" to jr("Carousel", listOf("s")), "s" to jr("Stack", listOf("t")), "t" to jr("Text")))))
    }

    @Test fun labelPropsTurnLineIntoText() {
        fun between(sep: String) = jrSpec(mapOf(
            "root" to jr("Stack", listOf("a", "sep", "b")),
            "a" to jr("Card"), "sep" to sep, "b" to jr("Card"),
        ))
        assertFalse(needsShell(between(jr("Separator"))))
        assertFalse(needsShell(between(jr("Separator", props = """{"label":"  "}"""))))
        assertTrue(needsShell(between(jr("Separator", props = """{"label":"更早"}"""))))
        assertFalse(needsShell(between(jr("Image", props = """{"src":"https://a.test/x.png"}"""))))
        assertTrue(needsShell(between(jr("Image", props = """{"src":"https://a.test/x.png","caption":"图注"}"""))))
    }

    @Test fun segmentedTabsAreSurfacedUnderlineTabsAreBare() {
        fun tabs(props: String, pane: String = "c1") = jrSpec(mapOf(
            "root" to jr("Tabs", listOf(pane, "c2"), props),
            "c1" to jr("Card"), "c2" to jr("Card"), "t" to jr("Text"),
        ))
        assertFalse(needsShell(tabs("""{"tabs":["今天","本周"]}""")))
        assertFalse(needsShell(tabs("""{"tabs":["今天","本周"],"variant":"segmented"}""")))
        assertTrue(needsShell(tabs("""{"tabs":["今天","本周"],"variant":"tabs"}""")))
        assertTrue(needsShell(tabs("""{"tabs":["今天","本周"]}""", "t")))
    }

    @Test fun streamingChildrenSkippedUntilTheyArrive() {
        assertFalse(needsShell(ev("""{"root":"root","elements":{}}""")))
        val grid = jr("Grid", listOf("a")); val card = jr("Card")
        assertFalse(needsShell(jrSpec(mapOf("root" to jr("Stack", listOf("grid", "note")), "grid" to grid, "a" to card))))
        assertTrue(needsShell(jrSpec(mapOf("root" to jr("Stack", listOf("grid", "note")), "grid" to grid, "a" to card, "note" to jr("Text")))))
    }

    @Test fun malformedSpecNeverThrows() {
        assertFalse(needsShell(null))
        assertFalse(needsShell(ev("""{"root":1,"elements":{}}""")))
        assertFalse(needsShell(ev("""{"root":"root"}""")))
        assertFalse(needsShell(jrSpec(mapOf("root" to """{"props":{}}"""))))
        assertFalse(needsShell(jrSpec(mapOf("root" to jr("Stack", listOf("missing"))))))
        // 互相引用：每个元素只看一次
        assertFalse(needsShell(jrSpec(mapOf("root" to jr("Stack", listOf("a")), "a" to jr("Stack", listOf("root"))))))
    }

    // ---- json-render §29：面板卡片头同名标题不画第二遍（对齐 shared/json-render/panel-title.test.ts）----

    @Test fun panelTitleMatching() {
        assertTrue(sameTitle("香港天气", " 香港 天气！"))
        assertTrue(sameTitle("比特币价格面板", "比特币价格"))
        assertFalse(sameTitle("香港天气", "上海天气"))
        assertFalse(sameTitle("", "香港天气"))
        assertFalse(sameTitle("甲", "乙"))
    }

    @Test fun panelTitleDedup() {
        val spec = """{"root":"root","elements":{"root":{"type":"Card","props":{"title":"香港天气","description":"副标题"},"children":["t"]},"t":{"type":"Text","props":{"text":"正文"},"children":[]}}}"""
        val card = ev(dropDuplicatePanelTitle(spec, "香港 天气")).o("elements")!!.o("root")!!
        assertNull(card.o("props")!!.s("title"))
        assertEquals("副标题", card.o("props")!!.s("description"))
        // 不同名不动、标题为空不动、没规格不动
        assertEquals(spec, dropDuplicatePanelTitle(spec, "别的东西"))
        assertEquals(spec, dropDuplicatePanelTitle(spec, null))
        assertEquals("bad json", dropDuplicatePanelTitle("bad json", "香港天气"))
        // 沿着孩子链往下，第一个孩子是同名 Heading 就整只去掉
        val headed = """{"root":"root","elements":{"root":{"type":"Stack","props":{},"children":["h","t"]},"h":{"type":"Heading","props":{"text":"香港 天气"},"children":[]},"t":{"type":"Text","props":{},"children":[]}}}"""
        val kids = ev(dropDuplicatePanelTitle(headed, "香港天气")).o("elements")!!.o("root")!!.a("children")!!.map { it.str() }
        assertEquals(listOf("t"), kids)
        // 但遇到一张有别的标题的 Card 就停，不再往里找
        val walled = """{"root":"root","elements":{"root":{"type":"Card","props":{"title":"概览"},"children":["s"]},"s":{"type":"Stack","props":{},"children":["h"]},"h":{"type":"Heading","props":{"text":"香港天气"},"children":[]}}}"""
        assertEquals(walled, dropDuplicatePanelTitle(walled, "香港天气"))
    }

    @Test fun tableEscapedPipe() {
        // \| 是字面竖线不当分隔符；首尾的分界 | 照旧去掉
        val t = Markdown.parse("| a \\| b | c |\n|---|---|\n| 1 \\| 2 | 3 |\n")[0] as Block.Table
        assertEquals(listOf("a | b", "c"), t.header)
        assertEquals(listOf("1 | 2", "3"), t.rows[0])
    }

    // ---------- AI 输出语法覆盖（同网页 bot-bubbles，DESIGN §48/§53/§69） ----------

    @Test fun actionPillParsesStandaloneRelativeLink() {
        // 独立一行的站内操作是胶囊（无论前面隔空行还是单换行）；GitHub 深链由界面层换成令牌对话框
        val p = Markdown.parse("先连上你的 GitHub：\n\n[连接 GitHub](/settings/connected-accounts/github)\n")
        assertEquals(2, p.size)
        assertTrue(p[0] is Block.Paragraph)
        val pill = p[1] as Block.ActionPill
        assertEquals("连接 GitHub", pill.label)
        assertEquals("/settings/connected-accounts/github", pill.href)
        val singleNewline = Markdown.parse("先连上你的 GitHub：\n[连接 GitHub](/settings/connected-accounts/github)")
        assertEquals(2, singleNewline.size)
        assertEquals("/settings/connected-accounts/github", (singleNewline[1] as Block.ActionPill).href)
        // 独立胶囊自己一段、不套气泡
        val b = Markdown.bubbles("[连接 GitHub](/settings/connected-accounts/github)")
        assertTrue(b.single().bare)
    }

    @Test fun labeledLinkBecomesLinkCard() {
        // [标签](http…) 独立成行也是链接卡（网页同款）；行内写法仍是普通段落
        val blocks = Markdown.parse("[发布说明](https://example.com/r)\n")
        val card = blocks.single() as Block.LinkCard
        assertEquals("https://example.com/r", card.url)
        assertEquals("发布说明", card.label)
        val inline = Markdown.parse("看 [发布说明](https://example.com/r) 这里\n")
        assertTrue(inline.single() is Block.Paragraph)
        // 长标签 / 非站内 href 的独立行是带标签链接卡，不是胶囊
        val long = Markdown.parse("[" + "这个标签实在太长太长太长太长太长太长太长太长太长太长太长太长太长太长太长太长" + "](/settings/x)\n")
        assertTrue(long.single() is Block.LinkCard)
    }

    @Test fun statusCardDirectives() {
        val src = "全景如下：\n\n:::group\n:::card{title=\"GitHub\" status=\"已连接\"}\n- 仓库 12 个\n:::card{title=\"邮箱\"}\n未连接\n:::\n:::\n\n接着说。\n"
        val blocks = Markdown.parse(src)
        val cards = blocks.filterIsInstance<Block.StatusCards>().single().cards
        assertEquals(2, cards.size)
        assertEquals("GitHub", cards[0].title)
        assertEquals("已连接", cards[0].status)
        assertEquals("- 仓库 12 个", cards[0].body)
        assertEquals("未连接", cards[1].body)
        // 指令记号不漏进正文段
        assertTrue(blocks.filterIsInstance<Block.Paragraph>().none { it.text.contains(":::") })
        // 单独 :::card（不在 :::group 里）也能解析；:::group 少写外层 ::: 时不吞掉后面的段落
        val solo = Markdown.parse(":::card{title=\"单卡\"}\n内容\n:::\n\n后续。")
        assertEquals("单卡", (solo[0] as Block.StatusCards).cards.single().title)
        assertEquals("后续。", (solo[1] as Block.Paragraph).text)
        val singleClose = Markdown.parse(":::group\n:::card{title=\"单收尾\"}\n内容\n:::\n\n后续。")
        assertEquals("单收尾", (singleClose[0] as Block.StatusCards).cards.single().title)
        assertEquals("后续。", (singleClose[1] as Block.Paragraph).text)
    }

    @Test fun cardsFenceParsesToo() {
        // ```cards = 指令块的围栏形态（网页 normalizeDirectiveCards 归一成这种）
        val blocks = Markdown.parse("```cards\n:::card{title=\"巡检\" status=\"3 条\"}\n正文\n:::\n```\n")
        val cards = (blocks.single() as Block.StatusCards).cards
        assertEquals("巡检", cards.single().title)
        assertEquals("3 条", cards.single().status)
        assertEquals("正文", cards.single().body)
    }

    @Test fun briefFenceParses() {
        val blocks = Markdown.parse("```brief\n标题：今日晨报\n日期：周一\n## 日程\n- 10:00 站会\n```\n")
        val brief = blocks.single() as Block.Brief
        assertEquals("今日晨报", brief.title)
        assertTrue(brief.body.contains("日程"))
        assertTrue(Markdown.bubbles("```brief\n正文\n```").single().bare)
    }

    @Test fun chatFilesFromToolResult() {
        val result = "画好了。\n⟦chisabot:files⟧[{\"id\":\"f1\",\"name\":\"cat.png\",\"mimeType\":\"image/png\",\"url\":\"/api/chat-files/f1\",\"prompt\":\"一只猫\",\"width\":800,\"height\":600},{\"id\":\"f2\",\"name\":\"r.pdf\",\"mimeType\":\"application/pdf\",\"url\":\"/api/chat-files/f2\"}]"
        val files = filesFromToolResult(result)
        assertEquals(2, files.size)
        assertEquals("cat.png", files[0].name)
        assertTrue(files[0].image)
        assertEquals(800, files[0].width)
        assertFalse(files[1].image)
        // AG-UI 再 JSON 包一层也能解（同网页 unwrap）
        val wrapped = "\"画好了。\\n⟦chisabot:files⟧[{\\\"id\\\":\\\"f1\\\",\\\"name\\\":\\\"a.png\\\",\\\"mimeType\\\":\\\"image/png\\\",\\\"url\\\":\\\"/api/chat-files/f1\\\"}]\""
        assertEquals(1, filesFromToolResult(wrapped).size)
        assertTrue(filesFromToolResult("没有文件").isEmpty())
        assertTrue(filesFromToolResult(null).isEmpty())
        // 指向别处的 url 不收（只认 /api/chat-files/）
        assertTrue(filesFromToolResult("⟦chisabot:files⟧[{\"id\":\"x\",\"url\":\"https://evil/x\"}]").isEmpty())
    }

    @Test fun fileCardRowEmittedForImageAndShareTools() {
        val fileCall = ToolCall("c1", "file_share", "{}", "好\n⟦chisabot:files⟧[{\"id\":\"f\",\"name\":\"a.pdf\",\"mimeType\":\"application/pdf\",\"url\":\"/api/chat-files/f\"}]", ended = true)
        val imgCall = ToolCall("c2", "image_generate", "{}", "⟦chisabot:files⟧[{\"id\":\"g\",\"name\":\"g.png\",\"mimeType\":\"image/png\",\"url\":\"/api/chat-files/g\"}]", ended = true)
        val other = ToolCall("c3", "web_search", "{}", "⟦chisabot:files⟧[{\"id\":\"h\",\"name\":\"h\",\"mimeType\":\"text/plain\",\"url\":\"/api/chat-files/h\"}]", ended = true)
        val rows = Turns.build(listOf(ChatMessage("u1", "user", "q"), ChatMessage("a1", "assistant", "", listOf(fileCall, imgCall, other))), running = false, error = null)
        val cards = rows.filterIsInstance<Row.FileCards>()
        assertEquals(2, cards.size)
        assertEquals("a.pdf", cards[0].files[0].name)
        assertEquals("g.png", cards[1].files[0].name)
    }
}
