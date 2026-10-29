package cn.ayase.chisabot.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.net.URI

/**
 * 干活卡的说法（和网页 shared/work-step.ts describeWorkerStep、app/src/lib/chat/work-steps.ts 同一份规则，DESIGN §70 / §75）。
 */
object WorkSteps {
    private val PREP = setOf("skill_list", "skill_load")
    private val NOT_WORK = setOf("render_ui", "worker_plan", "skill_load", "skill_list")
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun isWorkCall(name: String) = name !in NOT_WORK

    /** 网页 app/src/lib/chat/work-steps.ts 的 NOT_WORK（比上面多 message_bot、file_share、image_generate、image_edit）。 */
    private val NOT_WORK_WEB = NOT_WORK + setOf("message_bot", "file_share", "image_generate", "image_edit")
    /** 记忆写入（Memory Pill）：挂在回复下面，不算干活。 */
    private val MEMORY_WRITES = setOf("memory_save", "memory_update", "memory_log")

    /**
     * 回答和过程话的分界（同网页 compactTurns 的 doesWork）：真的在干活的一步，
     * 不含 render_ui 这类和记忆写入。最后一个这样的步骤之后的全部文字都是回答。
     */
    fun splitsReply(name: String) = name !in NOT_WORK_WEB && name !in MEMORY_WRITES

    private fun clip(text: String, limit: Int) = if (text.length > limit) text.take(limit - 1) + "…" else text

    private fun hostOf(url: String?): String {
        if (url.isNullOrBlank()) return "网页"
        return runCatching {
            val host = URI(url).host ?: return clip(url, 40)
            if (host == "workspace.local") "工作区里的页面" else host.removePrefix("www.")
        }.getOrElse { clip(url, 40) }
    }

    /** 参数还在流式写（不是完整 JSON）时按没有参数描述，不报错。 */
    fun parseArgs(raw: String): JsonObject =
        runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())

    fun describe(name: String, args: JsonObject): String? {
        fun t(key: String, limit: Int = 24): String {
            val v = (args[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim().orEmpty()
            return if (v.isEmpty()) "" else clip(v, limit)
        }
        val num = (args["number"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull()
        return when (name) {
            "worker_plan" -> null
            "web_search" -> if (t("query").isNotEmpty()) "正在搜索「${t("query")}」" else "正在搜索"
            "web_fetch" -> "正在读取 ${hostOf(t("url", 400))}"
            "computer_navigate" -> "正在打开 ${hostOf(t("url", 400))}"
            "computer_snapshot" -> "正在查看页面上的按钮和输入框"
            "computer_read" -> "正在阅读页面"
            "computer_screenshot" -> "正在看页面"
            "computer_click" -> "正在点击"
            "computer_type" -> "正在填写"
            "computer_key" -> "正在按键"
            "computer_scroll" -> "正在滚动页面"
            "computer_write_file" -> if (t("path").isNotEmpty()) "正在写文件 ${t("path")}" else "正在写文件"
            "computer_read_file" -> "正在读文件"
            "computer_list_files" -> "正在查看工作区"
            "computer_run_command" -> "正在运行命令"
            "computer_request_help", "computer_handoff" -> "正在请你帮忙"
            "render_ui" -> "正在整理成卡片"
            "memory_search" -> if (t("query").isNotEmpty()) "正在翻记忆「${t("query")}」" else "正在翻记忆"
            "memory_save", "memory_log" -> "正在记下来"
            "memory_update" -> "正在更新记忆"
            "memory_forget" -> "正在删一条记忆"
            "github_list_repos" -> "正在看 GitHub 仓库列表"
            "github_list_issues" -> if (t("repo", 40).isNotEmpty()) "正在看 ${t("repo", 40)} 的 Issue" else "正在看 Issue 列表"
            "github_list_pulls" -> if (t("repo", 40).isNotEmpty()) "正在看 ${t("repo", 40)} 的 PR" else "正在看 PR 列表"
            "github_get_issue" -> if (t("repo", 40).isNotEmpty() && num != null) "正在读 ${t("repo", 40)}#$num" else "正在读 Issue"
            "github_read_file" -> if (t("path", 32).isNotEmpty()) "正在读仓库里的 ${t("path", 32)}" else "正在看仓库文件"
            "page_list" -> "正在看你的页面"
            "page_get" -> "正在读页面"
            "schedule_list" -> "正在看定时任务"
            "skill_list" -> "正在看有哪些技能"
            "chat_files_recent", "list_recent_files" -> "正在找最近的文件"
            "panel_list" -> "正在看面板"
            "worker_status" -> "正在看后台任务进度"
            "device_list" -> "正在看你的设备"
            "device_list_files" -> "正在看设备上的文件"
            "device_read_file" -> if (t("path", 32).isNotEmpty()) "正在读设备上的 ${t("path", 32)}" else "正在读设备上的文件"
            "device_search" -> if (t("pattern").isNotEmpty()) "正在设备上搜「${t("pattern")}」" else "正在设备上找文件"
            "device_system_info" -> "正在看设备信息"
            "device_agent_list", "device_agent_status" -> "正在看设备上的编程助手"
            else -> when {
                name.startsWith("panel_") -> "正在更新面板"
                name.startsWith("device_") -> "正在操作你的设备"
                name.startsWith("memory") -> "正在查记忆"
                else -> "正在使用 $name"
            }
        }
    }

    /** 干活卡上的当前步骤：最后一个说得出来的（准备动作不算）；都没有 → 「正在处理」；只有准备动作 → 「正在准备」。 */
    fun current(calls: List<ToolCall>): String {
        val counted = calls.filter { it.name !in PREP }
        if (counted.isEmpty()) return "正在准备"
        for (call in counted.asReversed()) {
            val line = describe(call.name, parseArgs(call.args)) ?: continue
            if (line.startsWith("正在使用 ")) continue
            return line
        }
        return "正在处理"
    }

    /** 第几步（准备动作不算）。 */
    fun stepCount(calls: List<ToolCall>) = calls.count { it.name !in PREP }

    /** 每一步一句（去掉「正在」，相同的连着只记一次，说不出来的不列）。 */
    fun lines(calls: List<ToolCall>): List<String> {
        val steps = mutableListOf<String>()
        for (call in calls) {
            if (call.name in NOT_WORK) continue
            val line = describe(call.name, parseArgs(call.args)) ?: continue
            if (line.startsWith("正在使用 ")) continue
            val past = line.removePrefix("正在")
            if (steps.lastOrNull() != past) steps += past
        }
        return steps
    }

    /** 收成的一行：「搜索 2 次 · 看了 3 个网页」或「做了 N 步」；没有真正干活的工具 → null。 */
    fun doneLabel(calls: List<ToolCall>): String? {
        val work = calls.filter { it.name !in NOT_WORK }
        if (work.isEmpty()) return null
        var searches = 0
        var pages = 0
        for (c in work) {
            if (c.name == "web_search") searches++
            else if (c.name == "web_fetch" || c.name == "computer_navigate") pages++
        }
        return if (searches + pages == work.size) {
            listOfNotNull(if (searches > 0) "搜索 $searches 次" else null, if (pages > 0) "看了 $pages 个网页" else null).joinToString(" · ")
        } else "做了 ${work.size} 步"
    }
}
