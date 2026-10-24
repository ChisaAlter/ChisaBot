import type { ConfirmCategory, ConfirmDetail, ConfirmMode } from "../../../shared/confirmations";

/**
 * 哪些工具调用算「有后果的事」、算哪一类，以及按偏好 + 规则该不该问。纯函数，单测直接驱动。
 *
 * - 设备（device_*）不在这里：由设备 hub 在「询问」能力上问（DESIGN.md §45），这里只决定问不问。
 * - ChisaBot 自己的读写工具（记忆、技能、保险箱、联网、面板更新、聊天文件卡 / 画图、确认本身）不拦：它们要么只读，要么
 *   本身就是用户要求的记录类操作，删除也有撤销。
 * - 其余工具（内置任务工具、连接器 / MCP 工具）按名字判断：删除类、付款类、发消息类；读类动词开头的不算。
 */
const SKIP_REF = /^(memory|vault|skills|lifecycle|web|workflows|devices|host-access|confirmations|github|chat-files)\//;
const READ_VERB = /^(list|get|search|find|read|fetch|query|describe|count|check|lookup|preview|view|show|download)(_|$)/i;
const DELETE = /(^|[_\-/])(delete|remove|trash|destroy|purge|erase|wipe|drop)([_\-/]|$)/i;
const PURCHASE = /(^|[_\-/])(pay|payment|purchase|checkout|buy|place_order|create_order|order_create|transfer|send_money|charge|subscribe)([_\-/]|$)/i;
const MESSAGE = /(^|[_\-/])(send|reply|post|publish|tweet|comment|forward|invite|share|message|email|mail|dm)([_\-/]|$)/i;

/** 自带的群聊发言（机器人在群里说话就是这样说的），不是代用户对外发消息。 */
/** page_publish：页面建好就是公开的，发布 / 下线只是开关（页面本身见 §页面），不再问。 */
const NOT_OUTBOUND = new Set([
  "post_to_group",
  "page_publish",
  "email_connect",
  "calendar_connect",
  "notify_push",
  "notify_webhook_connect",
  "webhook_trigger_info",
  "personal_check_updates",
]);

export function categoryOfTool(name: string, ref?: string): ConfirmCategory | null {
  const id = ref ?? name;
  if (SKIP_REF.test(id)) return null;
  if (name === "panel_remove") return "delete";
  if (id.startsWith("live-panels/")) return null;
  const last = name.split(/[/]/).pop() ?? name;
  if (READ_VERB.test(last)) return null;
  if (PURCHASE.test(last)) return "purchase";
  if (DELETE.test(last)) return "delete";
  if (NOT_OUTBOUND.has(last)) return null;
  if (MESSAGE.test(last)) return "message";
  return null;
}

/** 规则和偏好匹配用的文字：工具名、目标、所有参数值摊平。 */
export function flattenForMatch(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((entry) => flattenForMatch(entry, depth + 1)).join(" ");
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key} ${flattenForMatch(entry, depth + 1)}`)
      .join(" ");
  return "";
}

export type RuleLike = { id: string; category: ConfirmCategory; mode: ConfirmMode; keywords: string[] };

/**
 * 这一次要不要问：付款一律问（安全底线）；带关键词的规则全部命中才算数，「先问我」压过「直接做」；
 * 没有规则命中就按这一类的偏好（没设过 = 先问我）。
 */
export function decideMode(input: {
  category: ConfirmCategory;
  text: string;
  pref: ConfirmMode | undefined;
  rules: readonly RuleLike[];
}): { mode: ConfirmMode; source: "safety" | "rule" | "preference" | "default"; ruleId?: string } {
  if (input.category === "purchase") return { mode: "ask", source: "safety" };
  const text = input.text.toLowerCase();
  const hits = input.rules.filter(
    (rule) =>
      rule.category === input.category &&
      rule.keywords.length > 0 &&
      rule.keywords.every((keyword) => keyword.trim() && text.includes(keyword.trim().toLowerCase())),
  );
  const ask = hits.find((rule) => rule.mode === "ask");
  if (ask) return { mode: "ask", source: "rule", ruleId: ask.id };
  const auto = hits.find((rule) => rule.mode === "auto");
  if (auto) return { mode: "auto", source: "rule", ruleId: auto.id };
  if (input.pref) return { mode: input.pref, source: "preference" };
  return { mode: "ask", source: "default" };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** 卡片上的细节行：参数里的前几个字段（长文本截断，命令 / 路径等宽）。 */
export function detailsFromArgs(args: unknown, max = 6): ConfirmDetail[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const out: ConfirmDetail[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (out.length >= max) break;
    if (value === null || value === undefined || value === "") continue;
    if (/secret|token|password|passwd|api_?key/i.test(key)) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    out.push({ label: ARG_LABEL[key] ?? key, value: clip(text, 600), ...(/command|cmd|path|script|code|url/i.test(key) ? { code: true } : {}) });
  }
  return out;
}

const ARG_LABEL: Record<string, string> = {
  to: "发给",
  recipient: "发给",
  recipients: "发给",
  subject: "主题",
  body: "内容",
  text: "内容",
  message: "内容",
  content: "内容",
  command: "命令",
  path: "路径",
  url: "网址",
  name: "名称",
  id: "ID",
  amount: "金额",
  routineId: "任务",
  triggerId: "触发器",
  panelId: "面板",
  page: "页面",
};

/** 一个工具调用在卡片上的标题（没有专门写的就用工具名）。 */
export function titleForTool(name: string, category: ConfirmCategory): string {
  const known: Record<string, string> = {
    delete_trigger: "删除一个触发器",
    panel_remove: "删除右栏的一张面板",
    page_delete: "删除一个页面（链接立刻失效，素材一起删）",
    email_send: "通过已连接邮箱发送一封邮件",
  };
  if (known[name]) return known[name];
  const verb = { message: "发送", delete: "删除", purchase: "付款 / 下单", device: "电脑操作" }[category];
  return `${verb}（${name}）`;
}

/**
 * 云端浏览器里点的那个按钮算不算「有后果」（服务器自己判断，不靠机器人记得先调用 confirm_action）。
 * 只看按钮 / 链接上显示的字，短标签整段匹配（「发送」「Send」「删除」「Move to trash」…）；
 * 付款下单不在这里：上游的付款安全规则已经拦（DESIGN.md §58.5）。
 */
const PAGE_MESSAGE = /^(发送|发 送|立即发送|发送邮件|发送消息|发布|发表|发帖|发微博|回复|发表回复|发表评论|评论|提交评论|转发|send|send now|send email|send message|post|publish|tweet|post reply|reply|comment|submit comment|share)$/i;
const PAGE_DELETE = /^(删除|永久删除|彻底删除|确认删除|删除文件|删除邮件|移除|清空|清空回收站|移到回收站|移至废纸篓|delete|delete forever|delete permanently|permanently delete|remove|move to trash|move to bin|empty trash|empty bin)$/i;
export function categoryOfPageAction(element: { role?: string; name?: string } | null | undefined): Exclude<ConfirmCategory, "purchase" | "device"> | null {
  const raw = element?.name?.replace(/\s+/g, " ").trim() ?? "";
  if (!raw || raw.length > 24) return null;
  // 输入框、标题、正文里的同样几个字不算按钮。
  if (element?.role && /^(textbox|searchbox|combobox|heading|paragraph|statictext|text|label|checkbox|radio|switch|cell|row|listitem|article)$/i.test(element.role)) return null;
  // 去掉快捷键提示和箭头之类的尾巴：「发送(S)」「Send ➤」「删除 (Del)」
  const name = raw.replace(/\s*[（(][^)）]{0,12}[)）]\s*$/, "").replace(/[\s➤›>→✓✔·•…]+$/u, "").trim();
  if (PAGE_MESSAGE.test(name)) return "message";
  if (PAGE_DELETE.test(name)) return "delete";
  return null;
}
