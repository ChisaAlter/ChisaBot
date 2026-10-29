/**
 * 回复来源（结构化，2026-10-29，向 Hark 看齐：来源画成回复下方一组叠起来的链接卡，不再是正文里的「来源：」行）。
 *
 * 不新增存储、不新增事件：来源就是这一轮里成功的 `web_fetch` 调用。它们本来就随这一轮的消息一起流式下发
 * （TOOL_CALL_START / ARGS / RESULT），也本来就在会话历史里（助手消息的 toolCalls + 对应的 tool 消息），
 * 所以实时和翻历史读到的是同一份东西，旧消息也能算出来源。这里只定义「怎么从消息里读出来源」，服务器
 * 和浏览器共用这一个函数，两边不会各写一套。
 *
 * 一轮 = 一条用户消息之后、下一条用户消息之前的所有消息；来源挂在这一轮最后一条有文字的助手消息上。
 *
 * 安全：标题来自外部网页，是不可信文本。界面只能当纯文字显示（不当 Markdown / HTML），网址只放行 http(s)。
 */

export const REPLY_SOURCES_VERSION = 1;
/** 一条回复最多列几个来源。 */
export const REPLY_SOURCES_MAX = 5;
/** 产生来源的工具。 */
export const REPLY_SOURCE_TOOLS = ["web_fetch"] as const;

export type ReplySource = {
  /** 读到的最终网址（跟随重定向后），只会是 http(s)。 */
  url: string;
  /** 网页标题；没有就用站点名。不可信文本，只能当纯文字显示。 */
  title: string;
  /** 站点（主机名，去掉 www.），例如 en.wikipedia.org。 */
  site: string;
  /** 产生它的工具调用，界面想把来源和干活卡里那一步对上时用。 */
  toolCallId: string;
};

export type ReplySources = {
  v: typeof REPLY_SOURCES_VERSION;
  /** 来源挂在哪条助手消息上（这一轮最后一条有文字的助手消息）。 */
  messageId: string;
  sources: ReplySource[];
};

/** 读历史 / 流式消息时只用到的字段（AG-UI Message 的子集）。 */
export type ReplySourceMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: readonly {
    id: string;
    function?: { name?: string; arguments?: string };
  }[];
};

const REFUSED = "Refused.";

function httpUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

/**
 * 从一条 web_fetch 的结果里读出来源。结果的开头是服务器自己写的（server/src/web/tools.ts）：
 * 「网址：…」「状态：…」「标题：…」，网页正文在后面的不可信信封里，这里不读正文。
 * 被拒绝、出错、状态不是 2xx 的都不算来源。
 */
export function sourceFromFetchResult(
  content: unknown,
  argumentsJson: string | undefined,
  toolCallId: string,
): ReplySource | null {
  if (
    typeof content !== "string" ||
    content.startsWith(REFUSED) ||
    content.startsWith("Error:")
  )
    return null;
  const head = content.slice(0, 2000);
  const status = Number(/^状态：(\d{3})/m.exec(head)?.[1]);
  if (!(status >= 200 && status < 300)) return null;
  let argUrl: unknown;
  try {
    argUrl = argumentsJson
      ? (JSON.parse(argumentsJson) as { url?: unknown }).url
      : undefined;
  } catch {
    argUrl = undefined;
  }
  const url = httpUrl(/^网址：(\S+)/m.exec(head)?.[1]) ?? httpUrl(argUrl);
  if (!url) return null;
  const site = url.hostname.replace(/^www\./, "");
  const title = (/^标题：(.*)$/m.exec(head)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return { url: url.toString(), title: title || site, site, toolCallId };
}

/**
 * 每一轮的来源，按挂载的助手消息 id 返回。没有来源的轮次不出现在结果里。
 */
export function replySourcesByMessage(
  messages: readonly ReplySourceMessage[],
): Map<string, ReplySources> {
  const out = new Map<string, ReplySources>();
  let calls = new Map<string, { name?: string; arguments?: string }>();
  let sources: ReplySource[] = [];
  let anchor: string | null = null;
  const flush = () => {
    if (anchor && sources.length)
      out.set(anchor, { v: REPLY_SOURCES_VERSION, messageId: anchor, sources });
    calls = new Map();
    sources = [];
    anchor = null;
  };
  for (const message of messages) {
    if (message.role === "user") {
      flush();
      continue;
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? [])
        calls.set(call.id, call.function ?? {});
      if (typeof message.content === "string" && message.content.trim())
        anchor = message.id;
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (
        !call ||
        !(REPLY_SOURCE_TOOLS as readonly string[]).includes(call.name ?? "")
      )
        continue;
      const source = sourceFromFetchResult(
        message.content,
        call.arguments,
        message.toolCallId,
      );
      if (
        !source ||
        sources.length >= REPLY_SOURCES_MAX ||
        sources.some((s) => s.url === source.url)
      )
        continue;
      sources.push(source);
    }
  }
  flush();
  return out;
}

/**
 * 打开结构化来源（部署开关 CHISABOT_REPLY_SOURCES，且是网页聊天）时随工具带进提示词的一段话，
 * 覆盖通用说话规则里「最后一行写来源：[站点](网址)」的做法。
 */
export const REPLY_SOURCES_GUIDANCE =
  "来源（这条优先于上面关于「来源：」行的说法）：你用 web_fetch 读过的网页，界面会自动在回复下方列成一组来源卡片。正文里不要再写「来源：…」行，也不要把读过的网址再贴一遍；需要说明出处时在句子里点一下站点名即可（例如「据维基百科」）。";
