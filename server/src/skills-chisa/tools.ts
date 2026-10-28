import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { BlockedUrlError, type GuardedResponse, guardedFetch } from "../../../shared/net/guarded-fetch";
import type { AppVariables } from "../auth/guards";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { PluginRefusedError, type PluginStore } from "../plugins/store";
import { score } from "../memory-notes/search";

/**
 * 技能（DESIGN.md §51，docs/skills.md）：用户自己写的「做某类事的方法」，机器人按需加载。
 *
 * 和上游 ChisaBot 的技能是同一张表（skills）：同一份技能既能在聊天框里用「/名字」调用，也能被机器人自己加载。
 * ChisaBot 不再要求先把技能「授权」给某个机器人——技能只是说明文字，不增加任何能力（机器人能调用的工具不变，
 * 每次调用照样过审批和审计），所以一个人的所有机器人都能看到他自己的技能和部署共享的技能。
 *
 * 每轮开头给机器人一份目录（名字 + 一句话），具体内容用 skill_load 拿；机器人可以 skill_save 新建 / 改写
 * 用户自己的技能（只能动用户自己的；部署共享的只读）。
 */
export const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
type Actor = { id: string; isAdmin: boolean };
type Skill = { slug: string; title: string; summary: string; instructions: string; ownerUserId: string | null };

export type SkillHubPreset = {
  slug: string;
  title: string;
  category: string;
  summary: string;
  instructions: string;
};

/**
 * 精选技能库（借鉴 OpenClaw ClawHub / Claude Code / Khoj 个人助理核心技能包）：
 * 支持用户在「设置 → 技能」一键安装，或让机器人直接调用 skill_install_hub 安装。
 */
export const SKILL_HUB_CATALOG: readonly SkillHubPreset[] = [
  {
    slug: "morning-brief",
    title: "早安管家与每日简报",
    category: "日常管家",
    summary: "每天早上或用户询问今日安排时，聚合天气、日历日程、重要未读邮件与待办记忆生成晨报卡片。",
    instructions: [
      "## 目标",
      "为用户提供结构化、零废话的每日全景晨报，并给出今日最重要的 3 件事建议。",
      "",
      "## 标准步骤",
      "1. 调用 `morning_brief_generate` 生成包含天气、日历、未读邮件、定时提醒与近期记忆的 `brief` 卡片代码块，原样放进回复顶部。",
      "2. 检查是否有冲突日程或 2 小时内即将开始的会议，如有请醒目提醒。",
      "3. 从未读邮件和长期记忆（`project` / `daily`）中挑出今天最值得优先推进的 1–3 项具体行动。",
      "4. 若用户配置了随身通知 Webhook（`notify_push`），在用户要求推送到手机时同步推送简报摘要。",
    ].join("\n"),
  },
  {
    slug: "inbox-triage",
    title: "收件箱分拣与回信起草",
    category: "日常管家",
    summary: "拉取最近邮件，按紧急程度分类汇总，并针对需要回复的邮件起草得体回信或调用 email_send 发送。",
    instructions: [
      "## 目标",
      "帮用户快速理清收件箱，区分「需要立即回复」「重要账单/通知」「普通资讯」，并代写或发送回信。",
      "",
      "## 标准步骤",
      "1. 调用 `email_list_recent`（默认拉取 10–15 封）获取最新邮件摘要；若尚未连接邮箱，引导或调用 `email_connect` 接入。",
      "2. 将邮件按三类输出：",
      "   - 🔴 **需处理 / 需回复**：给出核心诉求与建议回复草稿；",
      "   - 🟡 **重要通知 / 账单 / 会议邀请**：提炼关键时间节点与金额；",
      "   - ⚪ **订阅 / 推广 / 低优**：一句话折叠带过。",
      "3. 当用户确认要回复某封邮件时，直接调用 `email_send`（系统会自动弹出确认卡片由用户拍板后发出）。",
    ].join("\n"),
  },
  {
    slug: "deep-research",
    title: "多源交叉深度调研",
    category: "调研分析",
    summary: "针对复杂技术、行业或产品问题，检索至少 3 个独立信源交叉验证，输出带引用的结构化深度报告。",
    instructions: [
      "## 目标",
      "拒绝肤浅的单一搜索摘要，通过多轮检索与原文精读交付可信赖的深度调研报告。",
      "",
      "## 标准步骤",
      "1. **拆解问题**：将调研主题拆解为 2–3 个互补的检索维度（官方定义/架构、实测对比/社区评价、最新进展/局限性）。",
      "2. **广度检索**：调用 `web_search` 搜索中英文一手资料，优先选择官方文档、GitHub 仓库、权威技术博客或论文。",
      "3. **原文精读**：对最核心的 2–4 个链接调用 `web_fetch` 读取正文细节，核对具体数字、版本号与事实。",
      "4. **结构化交付**：按「核心结论（TL;DR）→ 关键对比表 → 深度分析 → 落地建议 → 参考来源链接」输出。",
    ].join("\n"),
  },
  {
    slug: "code-review",
    title: "代码与 PR 深度审查",
    category: "研发工程",
    summary: "审查 GitHub PR 或本地代码变更，重点排查安全漏洞、边界条件、并发问题与可维护性。",
    instructions: [
      "## 目标",
      "像资深 Staff Engineer 一样做高信噪比的代码审查，只抓真正影响正确性、安全性与架构质量的硬伤。",
      "",
      "## 审查清单",
      "1. **正确性与边界条件**：空值/异常处理、并发竞态、异步取消、分页与超时边界。",
      "2. **安全性**：SQL/命令注入、越权访问、密钥硬编码、SSRF 与未校验输入。",
      "3. **兼容性与回滚**：数据库迁移是否向后兼容、API 字段变更是否破坏旧客户端。",
      "4. **输出格式**：按 `[Blocker 必改]`、`[Major 建议改]`、`[Nit 细节优化]` 分级列出文件名、行号与可直接替换的修复代码。",
    ].join("\n"),
  },
  {
    slug: "server-doctor",
    title: "服务器与容器健康巡检",
    category: "研发工程",
    summary: "检查电脑/服务器的 CPU、内存、磁盘水位、Docker 容器状态与错误日志，定位故障根因。",
    instructions: [
      "## 目标",
      "快速诊断本机或服务器节点的运行健康度，发现异常进程、磁盘告警或挂掉的容器并给出修复方案。",
      "",
      "## 标准步骤",
      "1. 先只读检查：查看系统负载、内存余量、磁盘占用（`df -h`）、Docker 容器状态（`docker ps -a`）。",
      "2. 若发现容器重启或异常退出，读取最近 100 行日志定位首个报错堆栈。",
      "3. 输出「健康体检表（正常/告警/异常）」+「根因分析」+「修复命令建议（有副作用的重启/清理操作先经用户确认）」。",
    ].join("\n"),
  },
  {
    slug: "meeting-prep",
    title: "会前背景简报与议程准备",
    category: "日常管家",
    summary: "结合日历中的下一场会议、相关人物记忆与历史邮件，生成一页式会前背景卡片与讨论提纲。",
    instructions: [
      "## 目标",
      "在开会前 5 分钟帮用户快速进入状态，掌握参会人背景、上次遗留问题与本次核心议题。",
      "",
      "## 标准步骤",
      "1. 调用 `calendar_list_events` 找到目标会议的时间、主题与地点。",
      "2. 调用 `memory_search` 搜索与会人（`person`）和相关项目（`project`）的历史笔记与偏好。",
      "3. 输出一页式简报：**会议目标**、**关键背景与历史进展**、**建议讨论的 3 个核心问题**、**会后需要拍板的结论**。",
    ].join("\n"),
  },
  {
    slug: "travel-planner",
    title: "差旅与行程比价规划",
    category: "生活出行",
    summary: "结合目的地实时天气、日历空档与用户出行偏好，生成按天排布的差旅/旅行计划与预订清单。",
    instructions: [
      "## 目标",
      "生成可直接执行的行程单，兼顾时间动线合理性、天气状况与用户的饮食/住宿偏好。",
      "",
      "## 标准步骤",
      "1. 先调用 `memory_search` 查阅用户的出行、座位、酒店与饮食禁忌偏好，并检查日历日程冲突。",
      "2. 检索目的地近期天气、交通接驳耗时与必去地点营业时间。",
      "3. 按「每日上午 / 下午 / 晚间动线 + 交通方式 + 备选方案（雨天/满员）+ 行前准备清单」输出。",
    ].join("\n"),
  },
  {
    slug: "weekly-review",
    title: "周报汇总与记忆蒸馏",
    category: "日常管家",
    summary: "汇总本周日志、日历日程与完成事项，调用 memory_dream 整理碎片记忆，生成精炼周报与下周计划。",
    instructions: [
      "## 目标",
      "每周五或周末帮用户复盘本周产出、清理碎片化记忆笔记，并规划下周重点。",
      "",
      "## 标准步骤",
      "1. 调用 `memory_search`（重点看 `daily` 日志与 `project` 项目进展）和 `calendar_list_events` 回顾本周事项。",
      "2. 调用 `memory_dream` 自动去重、合并零散的长期记忆条目。",
      "3. 按「本周核心成果 → 进行中与风险项 → 下周 Top 3 计划」生成结构化周报，可直接复制发送。",
    ].join("\n"),
  },
];

function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (SKILL_SLUG.test(cleaned)) return cleaned;
  return `skill-${Date.now().toString(36).slice(-6)}`;
}

/**
 * 解析 GitHub / OpenClaw ClawHub / Claude Code 的 SKILL.md 文本（支持 YAML Frontmatter + Markdown 正文）。
 */
export function parseSkillMarkdown(
  raw: string,
  fallbackSlug?: string,
): { slug: string; title: string; summary: string; instructions: string } {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) throw new PluginRefusedError("skills", "技能内容不能为空。");

  let meta: Record<string, string> = {};
  let body = text;
  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (fmMatch) {
    const fmLines = fmMatch[1]!.split("\n");
    for (const line of fmLines) {
      const m = /^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
      if (m) {
        meta[m[1]!.toLowerCase()] = m[2]!.trim().replace(/^["']|["']$/g, "");
      }
    }
    body = fmMatch[2]!.trim() || text;
  }

  const headingMatch = /^#\s+(.+)$/m.exec(body);
  const rawTitle = meta.title || meta.name || (headingMatch ? headingMatch[1]!.trim() : "") || fallbackSlug || "导入技能";
  const title = rawTitle.slice(0, 60);

  const rawSlug = meta.slug || meta.name || fallbackSlug || rawTitle;
  const slug = sanitizeSlug(rawSlug);

  let summary = (meta.description || meta.summary || "").slice(0, 200);
  if (!summary) {
    const firstPara = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("```"));
    summary = (firstPara ?? "从外部 SKILL.md 导入的技能方法说明").slice(0, 200);
  }

  return {
    slug,
    title,
    summary,
    instructions: body.slice(0, 20000),
  };
}

export function normalizeSkillSourceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  // GitHub blob link -> raw.githubusercontent.com
  const ghBlob = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(trimmed);
  if (ghBlob) {
    return `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}/${ghBlob[4]}`;
  }
  return trimmed;
}

/**
 * 写一个技能时，这个 slug 写完归谁。
 * - 新技能：成员归自己；管理员勾了「共享」才归部署（null）。
 * - 已有技能：自己的，或（管理员）部署共享的才能写；其他人的技能、成员碰共享技能都不行。
 * - 归属只在管理员明确传了 `shared` 时才变，否则保持原样。
 * store 的重写默认保留原 owner，所以只有 `claim` 为真时才需要让它真正换 owner。
 */
export function resolveSkillOwner(input: {
  existing: string | null | undefined;
  userId: string;
  isAdmin: boolean;
  shared?: boolean;
}): { ok: true; owner: string | null; claim: boolean } | { ok: false } {
  const { existing, userId, isAdmin, shared } = input;
  if (existing === undefined) return { ok: true, owner: isAdmin && shared ? null : userId, claim: false };
  if (existing !== userId && !(isAdmin && existing === null)) return { ok: false };
  const owner = isAdmin && shared !== undefined ? (shared ? null : userId) : existing;
  return { ok: true, owner, claim: owner !== existing };
}

export function createChisaSkills(options: {
  store: PluginStore;
  actorFor: (userId: string) => Promise<Actor>;
  fetchFn?: typeof fetch;
}) {
  const fetchImpl = options.fetchFn ?? fetch;
  async function visible(userId: string): Promise<Skill[]> {
    const actor = await options.actorFor(userId);
    const rows = await options.store.listSkills(actor);
    // 管理员能在设置里看到所有人的技能，但机器人只用部署共享的和自己的。
    return rows.filter((skill) => skill.ownerUserId === null || skill.ownerUserId === userId);
  }

  async function catalog(userId: string): Promise<string> {
    const skills = await visible(userId).catch(() => [] as Skill[]);
    const lines = skills
      .slice(0, 40)
      .map((skill) => `- ${skill.slug}：${skill.title}${skill.summary ? `——${skill.summary.slice(0, 80)}` : ""}${skill.ownerUserId ? "" : "（共享）"}`);
    return [
      "# 技能",
      SKILL_GUIDANCE,
      lines.length ? `用户现在有这些技能（名字：标题——什么时候用）：\n${lines.join("\n")}${skills.length > 40 ? `\n…还有 ${skills.length - 40} 个，用 skill_list 搜。` : ""}` : "用户还没有技能。",
    ].join("\n\n");
  }

  function tools(userId: string, agentId: string): GrantedTool[] {
    const tool = <T extends z.ZodType>(name: string, description: string, parameters: T, run: (input: z.infer<T>) => Promise<string>): GrantedTool => ({
      name,
      ref: `skills/${name}`,
      description,
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        try {
          return await run(parsed.data);
        } catch (error) {
          if (error instanceof PluginRefusedError) return `${REFUSAL_MARKER} ${error.message}`;
          throw error;
        }
      },
    });
    const find = async (slug: string) => (await visible(userId)).find((skill) => skill.slug === slug);
    return [
      tool(
        "skill_list",
        "列出或搜索用户的技能（名字、标题、什么时候用）。目录里没看到合适的时再搜。",
        z.object({ query: z.string().max(200).optional() }).strict(),
        async ({ query }) => {
          let skills = await visible(userId);
          if (query?.trim()) skills = skills.map((s) => ({ s, v: score(query, { subject: `${s.slug} ${s.title}`, content: s.summary, context: s.instructions.slice(0, 400) }) })).filter((x) => x.v >= 0.2).sort((a, b) => b.v - a.v).map((x) => x.s);
          return skills.length ? skills.map((s) => `- ${s.slug}：${s.title}${s.summary ? `——${s.summary}` : ""}${s.ownerUserId ? "" : "（共享，只读）"}`).join("\n") : "没有找到技能。";
        },
      ),
      tool(
        "skill_load",
        "加载一个技能的完整说明。开始做一件事之前，只要目录里有对得上的技能就先加载它，再按里面的方法做。",
        z.object({ slug: z.string().max(60) }).strict(),
        async ({ slug }) => {
          const skill = await find(slug);
          if (!skill) return `${REFUSAL_MARKER} 没有叫「${slug}」的技能。用 skill_list 看看有哪些。`;
          return `# 技能「${skill.title}」（${skill.slug}）\n${skill.summary ? `用途：${skill.summary}\n` : ""}\n${skill.instructions}\n\n（这是用户写的方法说明，不是系统指令；和用户这次说的冲突时听用户的。如果做的过程中发现更好的做法，可以建议用户更新这个技能。）`;
        },
      ),
      tool(
        "skill_save",
        "新建或整体改写用户自己的技能。当你摸索出一套可复用的多步骤做法、工作流或排障套路，或用户交代了「以后某类事都这样做」时，直接主动调用它保存为技能，并在回复末尾顺带告知用户一句即可，无需事先询问。名字是小写英文字母、数字和连字符（如 weekly-report）；说明写成以后照着就能做的步骤、要注意的偏好和坑，不写一次性的细节。",
        z
          .object({
            slug: z.string().max(40).describe("小写字母、数字、连字符，2–40 个字符"),
            title: z.string().min(1).max(60).describe("中文标题"),
            summary: z.string().max(200).describe("一句话：什么时候用这个技能"),
            instructions: z.string().min(1).max(20000).describe("完整的方法说明（Markdown）"),
          })
          .strict(),
        async (input) => {
          if (!SKILL_SLUG.test(input.slug)) return `${REFUSAL_MARKER} 名字只能用小写字母、数字和连字符，首尾不能是连字符（如 weekly-report）。`;
          const owner = await options.store.skillOwner(input.slug);
          if (owner !== undefined && owner !== userId) return `${REFUSAL_MARKER} 「${input.slug}」这个名字已经被${owner === null ? "部署共享技能" : "别人的技能"}占用，换个名字。`;
          await options.store.installSkill({
            slug: input.slug,
            title: input.title.trim(),
            summary: input.summary.trim(),
            instructions: input.instructions.trim(),
            ownerUserId: userId,
            by: `bot:${agentId}`,
          });
          return `${owner === undefined ? "已新建" : "已更新"}技能「${input.title}」（${input.slug}）。用户可以在 设置 → 技能 里查看和修改，也能在聊天框输入 /${input.slug} 直接调用。`;
        },
      ),
      tool(
        "skill_edit",
        "局部修改用户自己的一个技能：把说明里的一段原文换成新文字（原文必须一字不差且只出现一次）。小改用它，大改用 skill_save。执行技能过程中发现更优做法或过时步骤时，可直接主动调用更新并顺带告知用户。",
        z.object({ slug: z.string().max(60), find: z.string().min(1).max(4000), replace: z.string().max(8000) }).strict(),
        async ({ slug, find: needle, replace }) => {
          const skill = await find(slug);
          if (!skill) return `${REFUSAL_MARKER} 没有叫「${slug}」的技能。`;
          if (skill.ownerUserId !== userId) return `${REFUSAL_MARKER} 「${slug}」是部署共享的技能，只读。`;
          const count = skill.instructions.split(needle).length - 1;
          if (count !== 1) return `${REFUSAL_MARKER} 要替换的原文${count ? `出现了 ${count} 次，多带一点上下文` : "没找到，先 skill_load 看看现在的内容"}。`;
          await options.store.installSkill({ slug, title: skill.title, summary: skill.summary, instructions: skill.instructions.replace(needle, replace), ownerUserId: userId, by: `bot:${agentId}` });
          return `已修改技能「${skill.title}」。`;
        },
      ),
      tool(
        "skill_install_hub",
        "从内置「精选技能库」（借鉴 OpenClaw ClawHub / Claude Code / Khoj）一键安装常用技能包。slug 填具体技能名（如 morning-brief、inbox-triage、deep-research、code-review、server-doctor、meeting-prep、travel-planner、weekly-review），或填 all 一键安装全部精选技能。",
        z.object({ slug: z.string().min(1).max(40).describe("精选技能名，或填 all 安装全部精选技能") }).strict(),
        async ({ slug }) => {
          const target = slug.trim().toLowerCase();
          const presets =
            target === "all" || target === "全部"
              ? [...SKILL_HUB_CATALOG]
              : SKILL_HUB_CATALOG.filter((p) => p.slug === target || p.title.includes(target));
          if (!presets.length) {
            return `${REFUSAL_MARKER} 精选技能库中没有「${slug}」。可选：${SKILL_HUB_CATALOG.map((p) => `${p.slug}（${p.title}）`).join("、")}，或填 all 安装全部。`;
          }
          const installed: string[] = [];
          for (const preset of presets) {
            const owner = await options.store.skillOwner(preset.slug);
            if (owner !== undefined && owner !== userId) continue;
            await options.store.installSkill({
              slug: preset.slug,
              title: preset.title,
              summary: preset.summary,
              instructions: preset.instructions,
              ownerUserId: userId,
              by: `bot:${agentId}`,
            });
            installed.push(`/${preset.slug}（${preset.title}）`);
          }
          return installed.length
            ? `已从精选技能库安装 ${installed.length} 个技能：${installed.join("、")}。用户可在「设置 → 技能」查看，或在聊天框输入 /名字 直接调用。`
            : "所选精选技能已被其他共享技能占用。";
        },
      ),
      tool(
        "skill_import_url",
        "从 GitHub 链接（支持 github.com/.../blob/.../SKILL.md 或 raw 链接）或 SKILL.md 文本导入安装技能（兼容 OpenClaw ClawHub 与 Claude Code 的 YAML Frontmatter 格式）。",
        z
          .object({
            url: z.string().max(1000).optional().describe("GitHub SKILL.md 链接或 Raw URL"),
            markdown: z.string().max(20000).optional().describe("或直接粘贴带 YAML Frontmatter 的 SKILL.md 内容"),
            slug: z.string().max(40).optional().describe("自定义技能英文名（可选，不填自动从 Frontmatter 或 URL 提取）"),
          })
          .strict(),
        async ({ url, markdown, slug: customSlug }) => {
          let rawText = markdown?.trim() ?? "";
          let fallbackSlug = customSlug?.trim();
          if (url?.trim()) {
            const rawUrl = normalizeSkillSourceUrl(url);
            if (!/^https?:\/\//i.test(rawUrl)) return `${REFUSAL_MARKER} 请提供 http:// 或 https:// 开头的技能文件链接。`;
            if (!fallbackSlug) {
              try {
                const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
                const file = parts.at(-1)?.replace(/\.md$/i, "") ?? "";
                fallbackSlug = file.toLowerCase() === "skill" ? (parts.at(-2) ?? "imported-skill") : file;
              } catch {
                return `${REFUSAL_MARKER} 技能文件链接格式不正确。`;
              }
            }
            let res: GuardedResponse;
            try {
              res = await guardedFetch(rawUrl, { fetchImpl, timeoutMs: 8_000, maxBytes: 256 * 1024 });
            } catch (err) {
              return `${REFUSAL_MARKER} 拉取技能文件失败（${err instanceof Error ? err.message : "网络异常"}）。`;
            }
            if (res.status < 200 || res.status >= 300) return `${REFUSAL_MARKER} 拉取技能文件失败（HTTP ${res.status}）。`;
            rawText = res.body.toString("utf8");
          }
          if (!rawText) return `${REFUSAL_MARKER} 请提供 url 或 markdown 内容。`;
          const parsed = parseSkillMarkdown(rawText, fallbackSlug);
          const finalSlug = customSlug && SKILL_SLUG.test(customSlug.trim()) ? customSlug.trim() : parsed.slug;
          const owner = await options.store.skillOwner(finalSlug);
          if (owner !== undefined && owner !== userId) {
            return `${REFUSAL_MARKER} 「${finalSlug}」已被占用，请指定另一个 slug。`;
          }
          await options.store.installSkill({
            slug: finalSlug,
            title: parsed.title,
            summary: parsed.summary,
            instructions: parsed.instructions,
            ownerUserId: userId,
            by: `bot:${agentId}`,
          });
          return `已成功导入技能「${parsed.title}」（/${finalSlug}）：${parsed.summary}`;
        },
      ),
    ];
  }

  /** 设置 → 技能：自己的可改可删，共享的只读。 */
  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser, bodyLimit({ maxSize: 65_536 }));
    app.onError((error, c) => {
      if (error instanceof z.ZodError) return c.json({ error: "参数不对：标题和说明不能为空。" }, 400);
      if (error instanceof PluginRefusedError) return c.json({ error: error.message }, 400);
      console.error(JSON.stringify({ type: "chisa-skills-error", error: error.name, route: c.req.path }));
      return c.json({ error: "技能暂时不可用，请重试。" }, 503);
    });
    const view = (userId: string) => (skill: Skill) => ({
      slug: skill.slug,
      title: skill.title,
      summary: skill.summary,
      instructions: skill.instructions,
      mine: skill.ownerUserId === userId,
    });
    app.get("/", async (c) => c.json({ skills: (await visible(c.var.actor.id)).map(view(c.var.actor.id)) }));
    app.get("/hub", async (c) => {
      const current = new Set((await visible(c.var.actor.id)).map((s) => s.slug));
      return c.json({
        hub: SKILL_HUB_CATALOG.map((item) => ({
          ...item,
          installed: current.has(item.slug),
        })),
      });
    });
    app.post("/import", async (c) => {
      const body = z
        .object({
          hubSlug: z.string().max(40).optional(),
          url: z.string().max(1000).optional(),
          markdown: z.string().max(25000).optional(),
          slug: z.string().max(40).optional(),
          shared: z.boolean().optional(),
        })
        .parse(await c.req.json());
      const userId = c.var.actor.id;
      const isAdmin = c.var.actor.role === "admin";
      if (body.shared && !isAdmin) return c.json({ error: "只有管理员可以把技能设为全员共享。" }, 403);
      const wantShared = isAdmin ? body.shared : undefined;

      if (body.hubSlug) {
        const target = body.hubSlug.trim().toLowerCase();
        const presets =
          target === "all"
            ? [...SKILL_HUB_CATALOG]
            : SKILL_HUB_CATALOG.filter((p) => p.slug === target);
        if (!presets.length) return c.json({ error: "未找到该精选技能。" }, 404);
        let installedCount = 0;
        for (const preset of presets) {
          const plan = resolveSkillOwner({ existing: await options.store.skillOwner(preset.slug), userId, isAdmin, shared: wantShared });
          if (!plan.ok) continue;
          await options.store.installSkill({
            slug: preset.slug,
            title: preset.title,
            summary: preset.summary,
            instructions: preset.instructions,
            ownerUserId: plan.owner,
            claimOwner: plan.claim,
            by: userId,
          });
          installedCount++;
        }
        const skills = (await visible(userId)).map(view(userId));
        return c.json({ skills, installedCount, skippedCount: presets.length - installedCount });
      }

      let rawText = body.markdown?.trim() ?? "";
      let fallbackSlug = body.slug?.trim();
      if (body.url?.trim()) {
        const rawUrl = normalizeSkillSourceUrl(body.url);
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(rawUrl);
        } catch {
          return c.json({ error: "链接格式不正确，请填写 https:// 开头的 GitHub 或 Raw 链接。" }, 400);
        }
        if (!fallbackSlug) {
          const parts = parsedUrl.pathname.split("/").filter(Boolean);
          const file = parts.at(-1)?.replace(/\.md$/i, "") ?? "";
          fallbackSlug = file.toLowerCase() === "skill" ? (parts.at(-2) ?? "imported-skill") : file;
        }
        let res: GuardedResponse | null = null;
        try {
          res = await guardedFetch(parsedUrl.toString(), { fetchImpl, timeoutMs: 8_000, maxBytes: 256 * 1024 });
        } catch (err) {
          if (err instanceof BlockedUrlError) {
            return c.json({ error: `无法拉取该链接内容：${err.message}` }, 400);
          }
          res = null;
        }
        if (!res || res.status < 200 || res.status >= 300) {
          return c.json({ error: "无法拉取该链接内容，请检查链接是否公开可访问，或直接粘贴 SKILL.md 文本。" }, 400);
        }
        rawText = res.body.toString("utf8");
      }
      if (!rawText) return c.json({ error: "请提供 GitHub SKILL.md 链接或粘贴技能 Markdown 内容。" }, 400);

      const parsed = parseSkillMarkdown(rawText, fallbackSlug);
      const finalSlug = body.slug?.trim() && SKILL_SLUG.test(body.slug.trim()) ? body.slug.trim() : parsed.slug;
      const plan = resolveSkillOwner({ existing: await options.store.skillOwner(finalSlug), userId, isAdmin, shared: wantShared });
      if (!plan.ok) return c.json({ error: `「${finalSlug}」已被占用，请指定另一个英文名字。` }, 409);
      await options.store.installSkill({
        slug: finalSlug,
        title: parsed.title,
        summary: parsed.summary,
        instructions: parsed.instructions,
        ownerUserId: plan.owner,
        claimOwner: plan.claim,
        by: userId,
      });
      const saved = (await visible(userId)).find((skill) => skill.slug === finalSlug);
      return c.json({ skill: saved ? view(userId)(saved) : null, installedCount: 1 });
    });
    app.put("/:slug", async (c) => {
      const slug = c.req.param("slug");
      if (!SKILL_SLUG.test(slug)) return c.json({ error: "名字只能用小写字母、数字和连字符（2–40 个字符），首尾不能是连字符。" }, 400);
      const body = z
        .object({
          title: z.string().trim().min(1).max(60),
          summary: z.string().trim().max(200).default(""),
          instructions: z.string().trim().min(1).max(20000),
          create: z.boolean().optional(),
          shared: z.boolean().optional(),
        })
        .parse(await c.req.json());
      const isAdmin = c.var.actor.role === "admin";
      if (body.shared !== undefined && !isAdmin) return c.json({ error: "只有管理员可以把技能设为全员共享。" }, 403);
      const owner = await options.store.skillOwner(slug);
      const plan = resolveSkillOwner({ existing: owner, userId: c.var.actor.id, isAdmin, shared: body.shared });
      if (!plan.ok)
        return c.json({ error: `「${slug}」这个名字已经被${owner === null ? "共享技能" : "别人的技能"}占用，换个名字。` }, 409);
      if (body.create && owner !== undefined) return c.json({ error: `你已经有一个叫「${slug}」的技能了。` }, 409);
      await options.store.installSkill({
        slug,
        title: body.title,
        summary: body.summary,
        instructions: body.instructions,
        ownerUserId: plan.owner,
        claimOwner: plan.claim,
        by: c.var.actor.id,
      });
      const saved = (await visible(c.var.actor.id)).find((skill) => skill.slug === slug);
      return c.json({ skill: saved ? view(c.var.actor.id)(saved) : null });
    });
    app.delete("/:slug", async (c) => {
      const slug = c.req.param("slug");
      const isAdmin = c.var.actor.role === "admin";
      const owner = await options.store.skillOwner(slug);
      if (owner === undefined) return c.json({ error: "找不到这个技能。" }, 404);
      if (owner !== c.var.actor.id && !(isAdmin && owner === null))
        return c.json({ error: "共享技能只能由管理员删除。" }, 403);
      await options.store.uninstallSkill(slug, c.var.actor.id);
      return c.body(null, 204);
    });
    return app;
  }

  return { catalog, tools, visible, routes };
}
export type ChisaSkills = ReturnType<typeof createChisaSkills>;

/** 给机器人的技能用法（ChisaBot 自己的写法）。 */
export const SKILL_GUIDANCE = `技能是用户自己存下来的「某类事怎么做」的方法说明（工具 skill_list / skill_load / skill_save / skill_edit）。
- 开始做事前看一眼下面的目录：有对得上的就先 skill_load，按里面的方法和偏好做；技能和用户这次说的冲突时听用户的。
- 主动沉淀与自我进化：当你帮用户跑通了一套以后还用得上的复杂做法（多步调研/操作流程、特定网站的用法、格式规范、踩过的坑），或者用户反复让你做同一类事时，**做完正事后直接主动调用 skill_save 存成技能**，在回复末尾用半句话告诉用户（「已顺手把这套做法存为技能 /xxx，下次直接照做」），不要停下来问「要不要存成技能」。
- 做的过程中发现已有技能里有过时步骤或更好的做法，直接主动调用 skill_edit（小改）或 skill_save（整体改写）更新它，顺带告诉用户一声即可。
- 用户说「记住以后都这样做 X」这类关于做事方法的要求，直接主动存成技能；关于他本人的事实和偏好存进记忆。`;
