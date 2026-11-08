import { z } from "zod";
import { currentToolAbort, TOOL_STOPPED_ZH } from "../confirmations/context";
import { markUntrusted } from "../untrusted-content";
import { CATALOGUE, customUrlRefusal } from "./catalogue";
import { CHINA_DIRECTORY, type DirectoryEntry, pathwayLines } from "./directory";
import { listTools } from "./mcp";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  isDeploymentFault,
  type PluginStore,
  type ServerRecord,
} from "./store";
import { type GrantedTool, REFUSAL_MARKER } from "./tools";

/**
 * 「把这个服务接进来」——先查这个部署里有什么，再查外面怎么接。
 *
 * 2026-10-21 的现场：用户让星灵去连腾讯 ima，它连查都没查，回了三遍「没有连接器 / 需要管理员开通」。
 * 用同一个模型（Magpie 的 codex/gpt-6-luna）和同一条真实提示词复现，问题不在模型不会用工具，而在它的
 * 工具列表里没有一个动作和「连接一个服务」对得上：26 个工具时它去调 device_list / connector_call，
 * 只有把这样一个工具放进列表，它才 4/4 选中。见 server/tests/connect-service.test.ts 和
 * .local-run/magpie-* 探针。
 *
 * 它做三件事：
 * 1. 这个部署里已经启用的连接器：有没有这个服务、机器人被授予了哪些工具、账号连没连；
 * 2. 目录里有但没启用的：告诉用户/管理员从哪一步开始；
 * 3. 完全没有的：联网查官方接法（OpenAPI / MCP / 开放平台），再说明这个部署只能接 Streamable HTTP
 *    的 MCP，以及哪一步不是机器人能做的。
 *
 * 它不写任何东西。加 MCP 服务器是管理员页面的动作，把它做成模型可调用的写操作会把「一句聊天」变成
 * 「往部署里装一个任意网络端点」，审批和 SSRF 边界都不该由一个工具调用绕过。
 */

/** One result of the official-docs search, as much of it as the report needs. */
export type ConnectSearchHit = { title: string; url: string; snippet: string };

export type BuiltinSourcesSnapshot = {
  email?: {
    connected: boolean;
    email?: string | null;
    imapHost?: string | null;
  };
  calendar?: {
    connected: boolean;
    label?: string | null;
    eventCount?: number;
  };
  github?: {
    connected: boolean;
    login?: string | null;
  };
};

export type ConnectServiceOptions = {
  store: PluginStore;
  /** Whose accounts are being asked about. */
  ownerUserId: string;
  /** Which Bot's grants are being asked about. */
  botId: string;
  /** Injected so tests never reach the network. */
  search: (query: string, count?: number) => Promise<ConnectSearchHit[]>;
  /** Optional: built-in personal & dev sources status (Email IMAP, Calendar ICS, GitHub). */
  builtinSources?: () => Promise<BuiltinSourcesSnapshot>;
  /**
   * Optional: when true, an admin asking to connect/enable a catalogue connector or an ungranted
   * server proactively enables the server and grants its non-destructive tools to `botId`.
   */
  canAutoEnable?: () => Promise<{ allowed: boolean; by: string }>;
  /**
   * When the asker is an admin on an interactive surface, offer `mcp_add`: a custom MCP endpoint
   * is added in-chat behind a confirmation card. False for non-admins and IM / panel turns, so the
   * tool is never advertised where it cannot be decided.
   */
  offerMcpAdd?: boolean;
  /**
   * The tools/list probe `mcp_add`'s confirm card runs against the URL it is about to add.
   * Injected so tests never reach the network; production leaves it unset and gets `listTools`.
   */
  probeMcp?: (url: string) => Promise<{ name: string }[]>;
};

/** Lower-cased, with the punctuation a person types between words removed. */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\-_/\\，。,.!?！？:：；;、()（）[\]【】"']+/g, "");
}

/** The words a service can be named by. "ima" and "腾讯ima" are the same request. */
const ALIASES: Record<string, readonly string[]> = {
  ima: ["ima", "腾讯ima", "ima知识库", "imaknowledgebase"],
  gmail: [
    "gmail",
    "谷歌邮箱",
    "谷歌邮件",
    "邮箱",
    "email",
    "imap",
    "qq邮箱",
    "foxmail",
    "163邮箱",
    "126邮箱",
    "outlook",
    "hotmail",
    "icloud邮箱",
    "收件箱",
    "邮件",
  ],
  calendar: [
    "calendar",
    "日历",
    "日程",
    "googlecalendar",
    "谷歌日历",
    "飞书日历",
    "icloud日历",
    "apple日历",
    "ical",
    "ics",
    "webcal",
  ],
  github: ["github", "gh"],
  webhook: ["webhook", "通知", "推送", "bark", "server酱", "飞书通知", "钉钉通知", "企业微信通知"],
  notion: ["notion"],
  "google-drive": ["googledrive", "谷歌云盘", "谷歌drive", "drive"],
  parallel: ["parallel", "parallelsearch"],
  腾讯文档: ["腾讯文档", "docsqq"],
  /*
   * 国内服务目录的常用叫法。key 是 directory.ts 里的条目 key（normalized 后必然落在该条目的
   * 检索文本里），aliases 是用户嘴里会说的名字——例如「我要连高德」里的「高德」就是靠
   * 下面这组别名展开成名字集，再去撞目录条目的 title/vendor/summary。
   */
  amap: ["amap", "高德", "高德地图", "gaode"],
  "baidu-map": ["baidumap", "百度地图"],
  "tencent-map": ["tencentmap", "腾讯地图", "qqmap", "qq地图"],
  didi: ["didi", "滴滴", "滴滴出行", "打车", "叫车"],
  "12306-mcp": ["12306", "火车票", "高铁票", "动车票", "train"],
  xiaohongshu: ["xiaohongshu", "xhs", "小红书", "rednote", "红薯"],
  weibo: ["weibo", "微博"],
  zhihu: ["zhihu", "知乎"],
  bilibili: ["bilibili", "b站", "哔哩哔哩"],
  douyin: ["douyin", "抖音"],
  meituan: ["meituan", "美团"],
  "taobao-xianyu": ["taobao", "淘宝", "xianyu", "闲鱼"],
  "jd-deals": ["jd", "京东", "jingdong"],
  weread: ["weread", "微信读书"],
  "lark-openapi": ["lark", "feishu", "飞书"],
  yuque: ["yuque", "语雀"],
  "dingtalk-doc": ["dingtalk", "钉钉"],
  wemeet: ["wemeet", "腾讯会议"],
  wps: ["wps", "金山文档", "wps365"],
  dida365: ["dida365", "ticktick", "滴答清单", "dida"],
  "baidu-netdisk": ["baidunetdisk", "百度网盘", "bdpan", "网盘"],
  "wecom-bot": ["wecom", "企业微信", "企微"],
  luckin: ["luckin", "瑞幸", "瑞幸咖啡", "luckincoffee"],
  mcd: ["mcd", "麦当劳", "mcdonald", "mcdonalds", "金拱门"],
  tuniu: ["tuniu", "途牛"],
  variflight: ["variflight", "飞常准", "航班查询"],
  "netease-music": ["netease", "网易云", "网易云音乐", "neteasemusic"],
  meting: ["meting", "qq音乐", "酷狗", "酷我"],
  caiyun: ["caiyun", "彩云天气", "彩云"],
  seniverse: ["seniverse", "心知天气"],
  "gap-qweather": ["qweather", "和风天气", "和风"],
  mijia: ["mijia", "米家", "小米智能家居", "小米"],
  minimax: ["minimax", "海螺"],
  zhipu: ["zhipu", "智谱", "glm", "bigmodel", "智谱清言"],
  modelscope: ["modelscope", "魔搭"],
  qcc: ["qcc", "企查查"],
  tianyancha: ["tianyancha", "天眼查"],
  chineselaw: ["chineselaw", "华宇元典", "元典"],
  kuaidi100: ["kuaidi", "kuaidi100", "快递100", "查快递", "物流查询"],
  cnki: ["cnki", "知网"],
  metaso: ["metaso", "秘塔", "秘塔搜索"],
  bocha: ["bocha", "博查"],
  niutrans: ["niutrans", "小牛翻译"],
  "alipay-global": ["alipay", "支付宝"],
  "huawei-cloud": ["huawei", "华为云", "huaweicloud"],
  cloudbase: ["cloudbase", "云开发", "tcb", "腾讯云开发"],
  volcengine: ["volcengine", "火山引擎", "火山"],
  qiniu: ["qiniu", "七牛", "七牛云"],
  gitee: ["gitee", "码云"],
  tapd: ["tapd"],
  jinshuju: ["jinshuju", "金数据"],
  modao: ["modao", "墨刀"],
  pixso: ["pixso"],
  mastergo: ["mastergo"],
  weiyun: ["weiyun", "微云", "腾讯微云"],
  lexiang: ["lexiang", "乐享", "腾讯乐享"],
  h3yun: ["h3yun", "氚云"],
  shimo: ["shimo", "石墨", "石墨文档"],
  flomo: ["flomo", "浮墨"],
  wolai: ["wolai", "我来"],
  yinxiang: ["yinxiang", "印象笔记", "evernote"],
  sealos: ["sealos"],
  apifox: ["apifox"],
  rongcloud: ["rongcloud", "融云"],
  "antv-chart": ["antv", "图表生成", "antvchart"],
  textin: ["textin", "合合", "合合信息"],
  patsnap: ["patsnap", "智慧芽"],
  mineru: ["mineru", "文档解析"],
  doc2x: ["doc2x"],
  "gap-sf": ["sfexpress", "顺丰", "sf快递"],
  "gap-youdao": ["youdao", "有道", "有道翻译"],
  "gap-pgyer": ["pgyer", "蒲公英"],
  "gap-esign": ["esign", "e签宝"],
  "gap-fadada": ["fadada", "法大大"],
  "gap-essign": ["essign", "腾讯电子签", "电子签"],
  "gap-jianguoyun": ["jianguoyun", "坚果云"],
  "gap-quark": ["quark", "夸克", "夸克网盘"],
  "gap-tuya": ["tuya", "涂鸦", "涂鸦智能"],
  "gap-ys7": ["ys7", "萤石", "萤石云"],
  "gap-vika": ["vika", "维格表"],
  "gap-mingdao": ["mingdao", "明道云"],
  "gap-worktile": ["worktile"],
  "gap-pingcode": ["pingcode"],
  "gap-teambition": ["teambition"],
  "gap-jushuitan": ["jushuitan", "聚水潭"],
  "gap-yonyou": ["yonyou", "用友", "u8"],
  "gap-xiaoetong": ["xiaoetong", "小鹅通"],
  "gap-fxiaoke": ["fxiaoke", "纷享销客"],
  "gap-moka": ["moka"],
  "gap-udesk": ["udesk"],
  "gap-meiqia": ["meiqia", "美洽"],
  "gap-yunpian": ["yunpian", "云片", "云片短信"],
  "gap-jpush": ["jpush", "极光推送", "极光"],
  "gap-agora": ["agora", "声网"],
  "gap-easemob": ["easemob", "环信"],
  "gap-yunxin": ["yunxin", "网易云信", "云信"],
  "gap-onenet": ["onenet"],
  "gap-ctrip-wendao": ["ctrip", "携程", "携程问道", "wendao"],
  "gap-dnspod": ["dnspod", "域名解析", "dns解析"],
  "gap-ucloud": ["ucloud"],
  "gap-jdcloud": ["jdcloud", "京东云"],
  "gap-ksyun": ["ksyun", "金山云"],
  "gap-guance": ["guance", "观测云"],
  "gap-qingcloud": ["qingcloud", "青云"],
  "gap-upyun": ["upyun", "又拍云"],
  "gap-guosen": ["guosen", "国信证券"],
  "gap-tiger": ["tiger", "老虎证券", "老虎"],
  "gap-alltick": ["alltick"],
  "gap-mairui": ["mairui", "麦蕊"],
  "gap-juhe": ["juhe", "聚合数据"],
  "gap-tianapi": ["tianapi", "天行数据"],
  "gap-baidu-ocr": ["baiduocr", "百度ocr"],
  "gap-163mail": ["163邮箱"],
  "gap-126mail": ["126邮箱"],
  "gap-sinamail": ["sina邮箱", "新浪邮箱", "sinamail"],
  "gap-mp": ["微信小程序", "小程序"],
  "gap-kdniao": ["kdniao", "快递鸟"],
  "gap-pushdeer": ["pushdeer"],
  "gap-wxpusher": ["wxpusher"],
  "gap-sendcloud": ["sendcloud"],
  "gap-getui": ["getui", "个推"],
  "gap-oppopush": ["oppo推送", "oppopush"],
  "gap-vivopush": ["vivo推送", "vivopush"],
  "gap-honorpush": ["honor推送", "荣耀推送", "honorpush"],
  "gap-mipush": ["mipush", "小米推送"],
};

const OVERVIEW_KEYWORDS = new Set([
  "全部",
  "all",
  "列表",
  "list",
  "overview",
  "连接器",
  "有什么连接器",
  "所有连接器",
  "全部连接器",
  "connectors",
  "plugins",
  "插件",
  "插件列表",
  "能连什么",
  "支持什么连接器",
]);

function isOverviewRequest(service: string): boolean {
  return OVERVIEW_KEYWORDS.has(normalized(service));
}

/** Every name this deployment might know a service by, normalized. */
function namesFor(service: string): string[] {
  const base = normalized(service);
  const names = new Set([base]);
  for (const [key, aliases] of Object.entries(ALIASES)) {
    if (
      base.includes(normalized(key)) ||
      aliases.some((alias) => base.includes(normalized(alias)))
    ) {
      names.add(normalized(key));
      for (const alias of aliases) names.add(normalized(alias));
    }
  }
  return [...names].filter(Boolean);
}

function mentions(haystack: string, names: readonly string[]): boolean {
  const text = normalized(haystack);
  return names.some((name) => name.length >= 2 && text.includes(name));
}

/** The first sentence of a vendor's own summary, so a long blurb does not become the answer. */
function firstSentence(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf(". "),
    cut.lastIndexOf("；"),
  );
  return stop > 40 ? cut.slice(0, stop + 1) : `${cut}…`;
}

function toolNames(server: ServerRecord, botId: string): string[] {
  return server.tools
    .filter((tool) => tool.grantedTo.includes(botId))
    .map((tool) => tool.name);
}

function accountConnected(
  serverId: string,
  connections: ReadonlySet<string>,
): boolean {
  return connections.has(serverId);
}

/** What a deployment can do with a server it already has, in the order a person would do it. */
function nextStepFor(
  server: ServerRecord,
  botId: string,
  connections: ReadonlySet<string>,
): string {
  const held = toolNames(server, botId);
  const needsAccount =
    server.authScheme !== null && server.authScheme.toUpperCase() !== "NO_AUTH";
  if (server.lastError) {
    return `先修好这个连接器：最近一次同步报错「${server.lastError}」。管理员在 设置 → 插件 → ${server.title} 里刷新或重填凭证。`;
  }
  if (!needsAccount && held.length === 0) {
    return `管理员在 设置 → 插件 → ${server.title} → 机器人 里把这个连接器的工具勾给这个机器人；勾上之前它一个都调不了。`;
  }
  if (needsAccount && !accountConnected(server.id, connections)) {
    return `先在 设置 → 账号连接 → ${server.title} 连上你自己的账号；连上之后再在 设置 → 插件 → ${server.title} → 机器人 里把工具勾给这个机器人。`;
  }
  if (held.length === 0) {
    return `管理员在 设置 → 插件 → ${server.title} → 机器人 里把工具勾给这个机器人；账号已经连好，只差这一步。`;
  }
  return `已经可用：${held.slice(0, 8).join("、")}${held.length > 8 ? "…" : ""}。直接调用这些工具就行。`;
}

function serverSection(
  server: ServerRecord,
  botId: string,
  connections: ReadonlySet<string>,
): string {
  const held = toolNames(server, botId);
  const needsAccount =
    server.authScheme !== null && server.authScheme.toUpperCase() !== "NO_AUTH";
  const lines = [
    `- ${server.title}（${server.url}）`,
    `  已启用；共 ${server.tools.length} 个工具${
      held.length > 0
        ? `，这个机器人有 ${held.length} 个：${held.slice(0, 6).join("、")}${held.length > 6 ? "…" : ""}`
        : "，这个机器人一个都没授权"
    }`,
  ];
  if (server.summary) lines.push(`  ${firstSentence(server.summary)}`);
  if (needsAccount) {
    lines.push(
      `  账号：${accountConnected(server.id, connections) ? "已连接" : "未连接"}`,
    );
  }
  if (server.lastError) lines.push(`  最近错误：${server.lastError}`);
  lines.push(`  下一步：${nextStepFor(server, botId, connections)}`);
  if (server.docsUrl) lines.push(`  文档：${server.docsUrl}`);
  return lines.join("\n");
}

function catalogueSection(names: readonly string[]): string | null {
  const entries = CATALOGUE.filter((entry) =>
    mentions(
      `${entry.key} ${entry.title} ${entry.vendor} ${entry.summary}`,
      names,
    ),
  );
  if (entries.length === 0) return null;
  return entries
    .slice(0, 3)
    .map(
      (entry) =>
        `- ${entry.title}：目录里有，但这个部署还没启用。管理员在 设置 → 插件 → 探索插件 里添加；${
          entry.summary ? firstSentence(entry.summary) : ""
        }`,
    )
    .join("\n");
}

/**
 * The China-app directory entries this request might be naming.
 *
 * Bounded to the first five by file order (roughly the README's own official-first ordering),
 * with the caller told how many more matched — a name like 「腾讯」 correctly hits dozens of
 * entries and the useful answer is a pointer to the full browse page, not a wall.
 */
function directoryMatches(names: readonly string[]): DirectoryEntry[] {
  return CHINA_DIRECTORY.filter((entry) =>
    mentions(
      `${entry.key} ${entry.title} ${entry.vendor} ${entry.summary}`,
      names,
    ),
  );
}

function directorySection(entries: readonly DirectoryEntry[]): string {
  const shown = entries.slice(0, 5).map((entry) =>
    [
      `- ${entry.title}${entry.official ? "（官方）" : "（社区）"}：${firstSentence(entry.summary)}`,
      ...pathwayLines(entry).map((line) => `  ${line}`),
      ...(entry.note ? [`  ⚠️ ${entry.note}`] : []),
    ].join("\n"),
  );
  if (entries.length > shown.length) {
    shown.push(
      `……另外 ${entries.length - shown.length} 条相关条目，用更具体的名字再问，或到 设置 → 插件 → 国内应用目录 浏览全表。`,
    );
  }
  return shown.join("\n");
}

function officialSection(hits: readonly ConnectSearchHit[]): string {
  if (hits.length === 0) {
    return "联网搜索没有找到可读的官方资料。换一个更完整的服务名（例如「腾讯 ima 知识库」）再查一次，或者直接给我官网地址。";
  }
  const body = hits
    .slice(0, 5)
    .map(
      (hit, index) =>
        `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`,
    )
    .join("\n");
  return markUntrusted(body, "web search results");
}

function customMcpNote(offerMcpAdd: boolean): string {
  const tail = offerMcpAdd
    ? [
        "3. 拿到公网地址后，管理员在对话里把地址发给我让我接上——我调用 mcp_add 出确认卡片，确认后自动完成添加并把非 destructive 工具授给当前机器人；也可以在 设置 → 插件 → 添加 MCP 服务器 手动填。",
        "第 1、2 步我能替你查、替你把配置写好；第 3 步你如果是管理员，直接把地址发我就能办。",
      ]
    : [
        "3. 管理员在 设置 → 插件 → 添加 MCP 服务器，填标题和地址，刷新工具。",
        "4. 在插件页把工具勾给这个机器人。",
        "第 1 步我能替你查、替你把配置写好；第 3 步是管理员页面的动作，我的工具里没有安装入口。",
      ];
  return [
    "这个部署接一个没有现成连接器的服务，只有一条路：Streamable HTTP 的 MCP 服务器。",
    "1. 在该服务的开放平台拿凭证（Client ID / API Key / OAuth）。",
    "2. 把它的 MCP 桥跑在一个能访问公网的地址上；stdio 的 MCP 进程这个部署跑不了。",
    ...tail,
  ].join("\n");
}

function builtinMatchSection(
  names: readonly string[],
  builtin: BuiltinSourcesSnapshot | null,
): string | null {
  const blocks: string[] = [];

  if (names.includes("gmail")) {
    const emailState = builtin?.email;
    const statusText = emailState?.connected
      ? `已连接（${emailState.email ?? "已绑定邮箱"}${emailState.imapHost ? ` · ${emailState.imapHost}` : ""}）`
      : "未连接";
    blocks.push(
      [
        "✅ 【内置电子邮箱连接器（IMAP 收信 + SMTP 审批发信）】已经内置就绪，支持 Gmail、QQ 邮箱、163 邮箱、Outlook、iCloud 等：",
        `  - 当前账号状态：${statusText}`,
        "  - 当前机器人已持有工具：`email_list_recent`（查看最近邮件与未读摘要）、`email_connect`（打开邮箱安全设置）、`email_send`（通过已连接邮箱发信/回信，发信前自动弹确认卡片）、`morning_brief_generate`（生成含未读邮件的每日晨报卡片）",
        "  - 怎么立即连上：",
        "    1. 用 email_connect 打开安全设置。应用专用密码或授权码仅在设置表单中输入，不要让用户发到聊天里。",
        "    2. 【设置页一键预设】引导用户点开下方链接卡进入「设置 → 账号连接」，在「个人日程与收件箱」点「连接邮箱」，一键选 Gmail / QQ / 163 / Outlook 预设填入即可。",
        "  - 回复末尾请附上独立一行的链接卡：",
        "    [打开账号连接](/settings/connected-accounts)",
      ].join("\n"),
    );
  }

  if (names.includes("webhook")) {
    blocks.push(
      [
        "✅ 【内置随身通知推送 & 外部 Webhook 触发器】已经内置就绪，支持飞书群机器人、钉钉群机器人、企业微信机器人、Bark (iOS)、Server酱及自定义 Webhook：",
        "  - 当前机器人已持有工具：`notify_webhook_connect`（打开通知安全设置）、`notify_push`（向手机/IM 即时推送提醒）、`webhook_trigger_info`（打开入站地址安全设置）",
        "  - 怎么立即连上：用 notify_webhook_connect 打开账号连接设置，在安全表单输入 Webhook 地址，不要让用户把带密钥的链接发到聊天里。",
        "  - 回复末尾请附上独立一行的链接卡：",
        "    [打开账号连接](/settings/connected-accounts)",
      ].join("\n"),
    );
  }

  if (names.includes("calendar")) {
    const calState = builtin?.calendar;
    const statusText = calState?.connected
      ? `已连接（${calState.label ?? "我的日历"}，共 ${calState.eventCount ?? 0} 个日程）`
      : "未连接";
    blocks.push(
      [
        "✅ 【内置个人日历连接器（iCal / ICS 订阅）】已经内置就绪，支持 Google Calendar、Apple iCloud、Outlook、飞书日历：",
        `  - 当前账号状态：${statusText}`,
        "  - 当前机器人已持有工具：`calendar_list_events`（查看近期日程）、`calendar_connect`（打开日历安全设置）、`morning_brief_generate`（每日晨报卡片）",
        "  - 怎么立即连上：",
        "    1. 用 calendar_connect 打开安全设置，私密 ICS 地址仅在设置表单中输入。",
        "    2. 【设置页配置】或者点开下方链接卡在「设置 → 账号连接 → 个人日程与收件箱」里粘贴订阅地址。",
        "  - 回复末尾请附上独立一行的链接卡：",
        "    [打开账号连接](/settings/connected-accounts)",
      ].join("\n"),
    );
  }

  if (names.includes("github")) {
    const ghState = builtin?.github;
    const statusText = ghState?.connected
      ? `已连接（@${ghState.login ?? "github"}）`
      : "未连接";
    blocks.push(
      [
        "✅ 【内置 GitHub 连接器】已经内置就绪：",
        `  - 当前账号状态：${statusText}`,
        "  - 支持能力：查看仓库、Issue、Pull Request、读取代码文件、创建 Issue / PR（连接后自动挂载 `github_*` 工具）",
        "  - 怎么连接：用户在对话里点开连接卡，就地填入 Personal Access Token 即可（令牌只发往服务器，不进对话）。",
        "  - 回复末尾请附上独立一行的链接卡：",
        "    [连接 GitHub](/settings/connected-accounts/github)",
      ].join("\n"),
    );
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function overviewReport(
  options: ConnectServiceOptions,
  servers: readonly ServerRecord[],
  connections: ReadonlySet<string>,
  builtin: BuiltinSourcesSnapshot | null,
): string {
  const emailStatus = builtin?.email?.connected
    ? `已连接（${builtin.email.email ?? "邮箱"}）`
    : "未连接（调用 email_connect 打开「设置 → 账号连接」，在安全表单输入授权码）";
  const calStatus = builtin?.calendar?.connected
    ? `已连接（${builtin.calendar.label ?? "我的日历"}，${builtin.calendar.eventCount ?? 0} 个日程）`
    : "未连接（调用 calendar_connect 打开「设置 → 账号连接」，在安全表单输入私密地址）";
  const ghStatus = builtin?.github?.connected
    ? `已连接（@${builtin.github.login ?? "github"}）`
    : "未连接（对话里点 [连接 GitHub](/settings/connected-accounts/github) 链接卡就地填令牌；也可在「设置 → 账号连接」填）";

  const addedIds = new Set(servers.map((s) => s.id));
  const unaddedCatalogue = CATALOGUE.filter((entry) => !addedIds.has(entry.key));

  const sections: string[] = [
    "【当前部署连接器全景】",
    [
      "一、内置直连数据源（已就绪，免装插件）：",
      `- 电子邮箱（Gmail / QQ邮箱 / 163 / Outlook / iCloud IMAP 收信 + SMTP 确认发信）：${emailStatus}｜工具：email_list_recent、email_connect、email_send、morning_brief_generate`,
      `- 个人日历（Google Calendar / iCloud / Outlook / 飞书 iCal/ICS）：${calStatus}｜工具：calendar_list_events、calendar_connect、morning_brief_generate`,
      `- 随身通知推送 & 入站 Webhook（飞书 / 钉钉 / 企业微信 / Bark / Server酱）：已内置｜工具：notify_webhook_connect、notify_push、webhook_trigger_info、personal_check_updates`,
      `- GitHub：${ghStatus}｜工具：github_repos、github_issues、github_pulls 等`,
    ].join("\n"),
  ];

  if (servers.length > 0) {
    sections.push(
      "二、已启用的 MCP / 第三方连接器：",
      servers
        .map((server) => serverSection(server, options.botId, connections))
        .join("\n"),
    );
  } else {
    sections.push("二、已启用的 MCP / 第三方连接器：\n- 当前暂未启用额外的 MCP 连接器。");
  }

  if (unaddedCatalogue.length > 0) {
    sections.push(
      "三、官方内置 MCP 连接器目录（用户说一声「帮我开启 Notion / Google Drive」，再次调用 connect_service 即可自动启用并授权）：",
      unaddedCatalogue
        .map(
          (entry) =>
            `- ${entry.title}（${entry.key}）：${firstSentence(entry.summary)}`,
        )
        .join("\n"),
    );
  }

  sections.push(
    [
      "四、国内应用目录（高德 / 百度地图 / 滴滴 / 12306 / 小红书 / 飞书 / 语雀 / A股 等 200+ 条目）：",
      "想连哪个直接说「连 <服务名>」，我再调用 connect_service 会给出对应的接入途径——已收录的一键添加、官方端点管理员加自定义 MCP、stdio 包在配对电脑上由我调 device_mcp_call 拉起、暂无 MCP 的给官方 API 文档。",
      "[浏览国内应用目录](/admin/plugins/directory)",
    ].join("\n"),
    [
      "五、快捷操作入口（请在回复末尾原样附上下方独立成行的链接卡，方便用户一键点击）：",
      "[打开账号连接](/settings/connected-accounts)",
      "[管理插件与 MCP](/admin/plugins)",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

function report(
  service: string,
  options: ConnectServiceOptions,
  servers: readonly ServerRecord[],
  connections: ReadonlySet<string>,
  hits: readonly ConnectSearchHit[],
  searchError: string | null,
  builtinSection: string | null = null,
  autoActions: readonly string[] = [],
  dirEntries: readonly DirectoryEntry[] = [],
): string {
  const names = namesFor(service);
  const matched = servers.filter((server) =>
    mentions(
      `${server.id} ${server.title} ${server.vendor} ${server.url} ${server.summary}`,
      names,
    ),
  );
  const catalogue = matched.length === 0 ? catalogueSection(names) : null;
  /*
   * The directory answers only where the two nearer answers did not: an enabled connector wins,
   * then a reviewed catalogue row, then the directory's own pathway. A directory entry whose
   * catalogueKey was promoted already answered through `catalogue` — showing its pathway too
   * would restate the same vendor's docs one layer down.
   */
  const directory =
    matched.length === 0 && !catalogue && dirEntries.length > 0
      ? directorySection(dirEntries)
      : null;
  const sections: string[] = [`【${service}】`];

  if (autoActions.length > 0) {
    sections.push(autoActions.join("\n"));
  }

  if (builtinSection) {
    sections.push(builtinSection);
  }

  if (matched.length > 0) {
    sections.push(
      "这个部署里已经启用：",
      matched
        .map((server) => serverSection(server, options.botId, connections))
        .join("\n"),
    );
    const first = matched[0];
    if (autoActions.length > 0 && first) {
      sections.push(
        [
          "快捷操作入口（请在回复末尾原样附上下方独立成行的链接卡）：",
          `[去连接 ${first.title} 账号](/settings/connected-accounts/${first.id})`,
          `[管理 ${first.title} 插件设置](/admin/plugins/${first.id})`,
        ].join("\n"),
      );
    }
  } else if (catalogue) {
    sections.push("这个部署里没有启用的连接器，但目录里有：", catalogue);
  } else if (directory) {
    sections.push(
      "这个部署里没有这个服务的连接器；国内应用目录收录了它的接法：",
      directory,
    );
  } else if (!builtinSection) {
    sections.push("这个部署里没有这个服务的连接器，目录里也没有。");
  }

  /*
   * A directory hit ends the question: the pathway lines already name the vendor's docs and the
   * route (one-click add, custom endpoint, paired-PC stdio, or external link), so the generic
   * web search and the Streamable-HTTP-only note would only restate it — and for a stdio or
   * login-session entry, restate it wrongly.
   */
  if (!builtinSection && !directory) {
    sections.push(
      "官方接入方式：",
      searchError
        ? `联网搜索失败：${searchError}。可以直接给我官网地址，我用 web_fetch 读。`
        : officialSection(hits),
    );

    if (matched.length === 0) {
      sections.push("怎么接进来：", customMcpNote(options.offerMcpAdd === true));
    }
  }

  return sections.join("\n\n");
}

/**
 * `mcp_add`：管理员在对话里把一个自定义 MCP 端点接进来。
 *
 * 确认卡片（category "admin"，locked 恒问）代替了管理页的那次点击——prepareConfirm 先把
 * {@link customUrlRefusal} 的静态检查和一次无凭据 tools/list 探测跑掉，让卡片上写的是端点
 * 实际提供了什么，而不是一段地址。确认后 execute 走的是和管理页同一个 `addCustomServer`：
 * SSRF、命名、凭据类型的检查原样生效，审计行的 `by` 记的是管理员本人。
 *
 * 不接受明文 token 参数——进了模型上下文就会落进聊天记录。需要凭证的服务器先添加，
 * 再去插件页填；或者传一个部署里已存在的 credentialId。
 */
const mcpAddInput = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe("服务器标识：小写字母、数字、连字符，例如 ima-knowledge"),
  title: z.string().trim().min(1).max(60).describe("显示名，例如「腾讯 ima 知识库」"),
  url: z.string().trim().min(1).max(500).describe("Streamable HTTP 端点地址，必须 https"),
  credentialId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("部署里已存在的凭证 id；一般留空，用户稍后在插件页填 token 更稳妥"),
});

function mcpAddTool(options: ConnectServiceOptions): GrantedTool {
  return {
    name: "mcp_add",
    ref: "plugins/mcp_add",
    description:
      "管理员专用：把一个自定义 MCP 服务器（Streamable HTTP 端点）接进这个部署，并把它的工具授权给当前机器人。当管理员在对话里给出 MCP 地址要求「接上 / 添加 / 安装」时调用；调用会先出一张确认卡片（显示地址和实际探测到的工具清单），用户点「确认」才真正写入，不要先在文字里再问一遍。目录里已有的官方连接器（Notion / Google Drive / Parallel / 高德 / 滴滴 / 秘塔等）不要用这个——connect_service 会自动启用或指路。",
    parameters: mcpAddInput,
    prepareConfirm: async (input) => {
      const parsed = mcpAddInput.safeParse(input);
      if (!parsed.success) {
        return { skip: `mcp_add 需要 id、title、url 参数：${parsed.error.issues[0]?.message ?? ""}` };
      }
      const { id, title, url, credentialId } = parsed.data;
      const refusal = customUrlRefusal(url);
      if (refusal) return { skip: `这个地址不能接：${refusal}` };
      let probe: string;
      try {
        const tools = options.probeMcp
          ? await options.probeMcp(url)
          : await listTools({ url });
        probe = tools.length
          ? `已连上，发现 ${tools.length} 个工具：${tools
              .slice(0, 12)
              .map((tool) => tool.name)
              .join("、")}${tools.length > 12 ? " …" : ""}`
          : "已连上，但服务器没有列出任何工具";
      } catch (error) {
        probe = `暂时无法列出工具：${error instanceof Error ? error.message : String(error)}（需要凭证的服务器可以先添加，再去插件页填 token 后刷新）`;
      }
      return {
        args: { id, title, url, ...(credentialId ? { credentialId } : {}) },
        title: `添加 MCP 服务器「${title}」`,
        details: [
          { label: "网址", value: url, code: true },
          { label: "标识", value: id, code: true },
          { label: "探测", value: probe },
          {
            label: "说明",
            value:
              "这个端点未经官方目录审查：它的每个工具都会按写操作对待，之后每次调用仍会按审批规则单独确认。",
          },
        ],
      };
    },
    execute: async (input, ctx) => {
      if (ctx?.signal?.aborted || currentToolAbort()?.aborted) {
        return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
      }
      // 工具列表是构建时的快照；真正写入前按当时身份再问一次。
      const permission = options.canAutoEnable
        ? await options.canAutoEnable().catch(() => ({ allowed: false, by: "" }))
        : { allowed: false, by: "" };
      if (!permission.allowed) {
        return `${REFUSAL_MARKER} 只有管理员能在对话里添加 MCP 服务器。`;
      }
      const parsed = mcpAddInput.safeParse(input);
      if (!parsed.success) {
        return `${REFUSAL_MARKER} 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
      }
      const { id, title, url, credentialId } = parsed.data;
      try {
        const server = await options.store.addCustomServer({
          id,
          title,
          url,
          ...(credentialId ? { credentialId } : {}),
          by: permission.by,
        });
        const held = new Set<string>();
        for (const tool of server.tools.filter((t) => !t.destructive)) {
          if (tool.grantedTo.includes(options.botId)) {
            held.add(tool.name);
            continue;
          }
          try {
            await options.store.grant("mcp", tool.ref, options.botId, permission.by);
            held.add(tool.name);
          } catch {
            // 单个授权失败不撤销已完成的添加；结果里如实报数量。
          }
        }
        const blocked = server.tools.filter((tool) => tool.destructive).map((tool) => tool.name);
        return [
          `已添加 MCP 服务器「${server.title}」（${server.url}）。`,
          server.tools.length === 0
            ? `服务器目前没有列出工具${server.lastError ? `：${server.lastError}` : "。"}`
            : held.size > 0
              ? `已授权给当前机器人 ${held.size} 个工具：${markUntrusted([...held].slice(0, 20).join("、"), "connector tools")}${held.size > 20 ? " …" : ""}`
              : "没有可自动授权的工具。",
          blocked.length > 0
            ? `以下工具被服务器自己标记为 destructive，未自动授权——确认要用时在插件页手动勾选：${markUntrusted(blocked.join("、"), "connector tools")}`
            : null,
          !server.hasCredential
            ? "如果这个服务器要求凭证：到插件页填好 token 后刷新工具。"
            : null,
          `[管理 ${server.title} 插件设置](/admin/plugins/${server.id})`,
        ]
          .filter(Boolean)
          .join("\n");
      } catch (error) {
        if (error instanceof CustomServerRefusedError || error instanceof CatalogueEntryUnknownError) {
          return `${REFUSAL_MARKER} ${error.message}`;
        }
        if (isDeploymentFault(error)) {
          return "这次添加没有完成：部署内部的连接器状态不一致，请在插件页查看刷新报错。";
        }
        return `添加失败：${error instanceof Error ? error.message : "未知错误"}`;
      }
    },
  };
}

export function connectServiceTools(
  options: ConnectServiceOptions,
): GrantedTool[] {
  return [
    {
      name: "connect_service",
      ref: "web/connect_service",
      description:
        "查看或主动开启外部服务连接器（填「全部」可列出当前所有内置连接器、已启用 MCP 插件、官方目录与账号状态；或填具体服务名如 Gmail、日历、GitHub、Notion、Google Drive、腾讯 ima、高德、滴滴、12306、小红书、飞书、语雀 等）。当用户问「你现在有什么连接器」「能连什么」「有 X 连接器吗」或让你连接/接入/开启某个服务时，第一步就调用它。用户指了一个你不认识的服务名也把名字原样传进来：国内应用它会查内置目录直接给出接法（一键添加 / 自定义端点 / 配对电脑 stdio / 官方 API 文档），查不到的再联网搜官方接法，比反问用户「X 是什么」有用。",
      parameters: z.object({
        service: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe(
            "服务名（例如 Gmail、日历、Notion、Google Drive、GitHub、腾讯ima），或填「全部」查看所有可用连接器清单。",
          ),
      }),
      execute: async (args) => {
        const parsed = z
          .object({ service: z.string().trim().min(1).max(120) })
          .safeParse(args);
        if (!parsed.success)
          return "connect_service 需要一个服务名，例如「腾讯ima」，或填「全部」列出所有连接器。";
        const service = parsed.data.service;

        let servers: ServerRecord[] = [];
        let connections = new Set<string>();
        try {
          servers = await options.store.listServers();
        } catch {
          return `我读不到这个部署的连接器列表（数据库没有回答）。这不是「没有连接器」，是这次读取失败了；让用户重试或让管理员看服务端日志。服务：${service}。`;
        }
        try {
          const [userOauth, brokered] = await Promise.all([
            options.store.connectionsFor(options.ownerUserId),
            options.store.brokeredConnectionsFor(options.ownerUserId),
          ]);
          connections = new Set([
            ...userOauth.map((row) => row.serverId),
            ...brokered.map((row) => row.serverId),
          ]);
        } catch {
          // A failed read is not "not connected"; the report says unknown rather than claiming a
          // connection state it never saw. The inventory is still worth returning.
          connections = new Set();
        }

        const builtin = options.builtinSources
          ? await options.builtinSources().catch(() => null)
          : null;

        if (isOverviewRequest(service)) {
          return overviewReport(options, servers, connections, builtin);
        }

        const names = namesFor(service);
        const builtinSection = builtinMatchSection(names, builtin);
        const autoActions: string[] = [];

        // Proactive auto-enable & self-grant when an admin asks about a catalogue or ungranted connector.
        if (options.canAutoEnable) {
          const permission = await options
            .canAutoEnable()
            .catch(() => ({ allowed: false, by: "unknown" }));
          if (permission.allowed) {
            const addedIds = new Set(servers.map((s) => s.id));
            const catalogueHits = CATALOGUE.filter(
              (entry) =>
                !addedIds.has(entry.key) &&
                entry.host !== null &&
                entry.auth.kind === "user-oauth" &&
                mentions(
                  `${entry.key} ${entry.title} ${entry.vendor} ${entry.summary}`,
                  names,
                ),
            );
            for (const entry of catalogueHits) {
              if (typeof options.store.addServer === "function") {
                try {
                  await options.store.addServer({
                    key: entry.key,
                    by: permission.by,
                  });
                  autoActions.push(
                    `✅ 已主动为你启用官方连接器「${entry.title}」！`,
                  );
                } catch {
                  // Ignore if dynamic registration or network refresh failed in offline/test env;
                  // the row may still have been inserted or will be reported from catalogue.
                }
              }
            }
            if (catalogueHits.length > 0) {
              servers = await options.store.listServers().catch(() => servers);
            }

            // Proactively grant non-destructive tools to this Bot if it currently holds 0 tools on a matched server.
            const matchedServers = servers.filter((server) =>
              mentions(
                `${server.id} ${server.title} ${server.vendor} ${server.url} ${server.summary}`,
                names,
              ),
            );
            let grantedAny = false;
            for (const srv of matchedServers) {
              const held = toolNames(srv, options.botId);
              if (
                held.length === 0 &&
                srv.tools.length > 0 &&
                typeof options.store.grant === "function"
              ) {
                const safeTools = srv.tools.filter((t) => !t.destructive);
                let count = 0;
                for (const tool of safeTools) {
                  try {
                    await options.store.grant(
                      "mcp",
                      tool.ref,
                      options.botId,
                      permission.by,
                    );
                    count += 1;
                  } catch {
                    // ignore
                  }
                }
                if (count > 0) {
                  grantedAny = true;
                  autoActions.push(
                    `✅ 已主动将「${srv.title}」的 ${count} 个工具授权给当前机器人！`,
                  );
                }
              }
            }
            if (grantedAny) {
              servers = await options.store.listServers().catch(() => servers);
            }
          }
        }

        let hits: ConnectSearchHit[] = [];
        let searchError: string | null = null;
        /*
         * A directory match counts as a match too: its pathway lines already carry the vendor's
         * own docs and the route, so spending a web search only restates them — and for a stdio
         * or login-session entry, restates them wrongly.
         */
        const dirEntries = directoryMatches(names);
        const hasMatch =
          Boolean(builtinSection) ||
          servers.some((server) =>
            mentions(
              `${server.id} ${server.title} ${server.vendor} ${server.url} ${server.summary}`,
              names,
            ),
          ) ||
          dirEntries.length > 0;
        if (!hasMatch) {
          const query = /[\u3400-\u9fff]/.test(service)
            ? `${service} 官方 API MCP 开放平台 接入`
            : `${service} official API MCP integration`;
          try {
            hits = await options.search(query, 5);
          } catch (error) {
            searchError = error instanceof Error ? error.message : "未知原因";
          }
        }

        return report(
          service,
          options,
          servers,
          connections,
          hits,
          searchError,
          builtinSection,
          autoActions,
          dirEntries,
        );
      },
    },
    ...(options.offerMcpAdd ? [mcpAddTool(options)] : []),
  ];
}
