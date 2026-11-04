/**
 * 车队模型审计（fleet_audit）：纯函数部分。service.ts 负责把数据读出来，
 * 这里只做「模型名猜档位」「职责文本猜负载」「把证据排成给机器人看的报告」，
 * 不碰库、不碰网络，单测直接驱动。
 *
 * 审计结论不是这里下的：档位和负载都标成「线索」，由调用这个工具的机器人
 * 对着证据自己判断——职责描述是自由文本，关键词永远猜不准全部。
 */

/** 模型档位（按模型 id 的名字线索猜的；strong 优先于 light）。 */
export type ModelTier = "light" | "standard" | "strong" | "unknown";
export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  light: "轻量",
  standard: "标准",
  strong: "强力 / 推理",
  unknown: "未知",
};

/**
 * 名字线索按「分隔段」匹配（. - _ / : 拆开），子串只在不易误伤时用：
 * minimax-m2 里段是 [minimax,m2] 不会中 mini；gpt-4o-mini 的段 mini 会中。
 * strong 优先：pro-mini 这类名字两可的按强的算，免得把贵模型当便宜货推荐降档。
 */
const STRONG_SEGMENTS = new Set([
  "opus",
  "ultra",
  "pro",
  "max",
  "high",
  "xhigh",
  "reasoner",
  "reasoning",
  "thinking",
  "think",
  "r1",
  "o1",
  "o3",
  "o4",
]);
const LIGHT_SEGMENTS = new Set([
  "haiku",
  "mini",
  "flash",
  "lite",
  "light",
  "lightning",
  "nano",
  "micro",
  "tiny",
  "small",
  "low",
  "instant",
  "air",
  "edge",
]);
const STRONG_SUBSTRING = /(?:deepseek[-_/]?r|gpt[-_/]?o[134]|gemini.*pro)/i;

export function modelTierOf(modelId: string | null | undefined): ModelTier {
  const id = (modelId ?? "").trim().toLowerCase();
  if (!id) return "unknown";
  const segments = id.split(/[^a-z0-9]+/).filter(Boolean);
  if (
    segments.some((segment) => STRONG_SEGMENTS.has(segment)) ||
    STRONG_SUBSTRING.test(id)
  )
    return "strong";
  if (segments.some((segment) => LIGHT_SEGMENTS.has(segment))) return "light";
  return "standard";
}

/** 职责 / 任务文本猜出的负载类别，可能同时中好几类。 */
export type WorkloadHint = { kind: string; label: string };
const WORKLOAD_HINTS: { kind: string; label: string; re: RegExp }[] = [
  {
    kind: "ops",
    label: "例行轻活（提醒 / 简报 / 巡检）",
    re: /提醒|简报|晨报|日报|周报|巡检|监控|值班|通知|心跳|打卡|remind|monitor|alert|digest|brief|heartbeat|standup|notification/i,
  },
  {
    kind: "code",
    label: "编码 / 工程",
    re: /代码|编码|编程|程序员|重构|架构|部署|运维|代码审查|code|coding|debug|bug\b|github|pull request|\bpr\b|devops|commit/i,
  },
  {
    kind: "research",
    label: "深度调研 / 分析",
    re: /调研|研究|分析|深挖|情报|竞品|研报|评估|research|analy|due diligence|report|deep ?dive/i,
  },
  {
    kind: "writing",
    label: "写作 / 内容",
    re: /写作|文案|撰稿|文章|博客|翻译|润色|排版|draft|writ|blog|copy|content|i18n/i,
  },
  {
    kind: "chat",
    label: "聊天陪伴",
    re: /闲聊|聊天|陪伴|唠嗑|问答助手|companion/i,
  },
];
export function workloadHintsOf(text: string): WorkloadHint[] {
  const value = text.trim();
  if (!value) return [];
  return WORKLOAD_HINTS.filter((hint) => hint.re.test(value)).map(
    ({ kind, label }) => ({ kind, label }),
  );
}

/** 一个 bot 在报告里的一行证据。 */
export type FleetAuditBotRow = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  /** 生效中的模型 id；远程 / 已删 bot 为 null。 */
  model: string | null;
  modelSource: "override" | "default" | "remote";
  /** 目录里查到的能力；catalog 不可用 / 没收录时为 null。 */
  capabilities: {
    contextWindow?: number;
    supportsImages?: boolean;
    supportsFiles?: boolean;
    supportsTools?: boolean;
  } | null;
  /** 目录读到了但没收录这个模型（下线 / 手填的），值得点出来。 */
  missingFromCatalog: boolean;
  canManage: boolean;
  schedules: {
    title: string;
    status: string;
    runCount: number;
    lastStatus: string | null;
    instruction: string;
  }[];
  channelCount: number;
  workloadHints: WorkloadHint[];
};

export type FleetAuditData = {
  defaultModel: string | null;
  /** null = 模型目录拿不到（网关没配 / 挂了），按 id 字面评。 */
  catalog:
    | {
        id: string;
        label: string;
        contextWindow?: number;
        supportsImages?: boolean;
        supportsFiles?: boolean;
        supportsTools?: boolean;
      }[]
    | null;
  catalogStale: boolean;
  bots: FleetAuditBotRow[];
  remote: { id: string; name: string }[];
  tombstones: { id: string; name: string }[];
};

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const ctx = (n?: number) =>
  n ? (n >= 10000 ? `${Math.round(n / 1024)}K` : `${n}`) : "?";
function caps(c: FleetAuditBotRow["capabilities"]): string {
  if (!c) return "能力：目录未登记";
  const list = [
    c.supportsImages === false ? "不看图" : null,
    c.supportsFiles === false ? "不收文件" : null,
    c.supportsTools === false ? "不调工具" : null,
  ].filter(Boolean);
  return `上下文 ${ctx(c.contextWindow)}${list.length ? `，${list.join("，")}` : "，能力未受限"}`;
}

/** 给模型的评估规则，跟在证据后面；结论是调用方自己下的。 */
export const FLEET_AUDIT_RUBRIC = `## 怎么下结论
- 按职责和定时任务把每个 bot 的活动分档：轻活（提醒、简报、巡检、分拣、闲聊）；中活（问答、写作、整理、常规检索）；重活（编码、架构、多步调研、长链路推理）。
- 每个 bot 给一句话结论：「合适」「屈才」（轻活配了贵模型，在烧钱）、「吃力」（重活配了弱模型，质量亏）、「缺能力」（职责要图 / 文件 / 工具，模型不支持或目录没登记它）。
- 上面的「档位」和「负载线索」都是按名字和关键词猜的，你来复核；目录里没有的模型按 id 字面估。
- 建议要落地：说清换哪个模型（只能用「可用模型目录」里的 id）、为什么；拿不准的标「待观察」，不要为凑建议硬编。
- 改模型在对应 bot 的资料页或 设置 → 模型；远程 bot 的模型在它自己的服务里配，只列出不评。`;

/** 把证据排成给机器人看的报告（模型读懂后向用户输出结论）。 */
export function formatAuditReport(
  data: FleetAuditData,
  onlyAgentId?: string,
): string {
  const bots = onlyAgentId
    ? data.bots.filter((bot) => bot.id === onlyAgentId)
    : data.bots;
  const catalogLine = data.catalog
    ? data.catalog
        .slice(0, 60)
        .map((m) => `- ${m.id}（${m.label}，上下文 ${ctx(m.contextWindow)}）`)
        .join("\n")
    : "（模型目录不可用：网关未配置或暂时读不到。下面的档位只能按模型名字猜。）";
  const botLines = bots.map((bot) => {
    const tier = modelTierOf(bot.model);
    const model = bot.model
      ? `${bot.model}（${bot.modelSource === "override" ? "这个 bot 单独指定" : "部署默认"}；档位猜测：${MODEL_TIER_LABELS[tier]}${bot.missingFromCatalog ? "，不在当前目录" : ""}）`
      : "（本地不可见）";
    const schedules = bot.schedules.length
      ? bot.schedules
          .slice(0, 8)
          .map(
            (s) =>
              `  - 「${clip(s.title, 30)}」${s.status === "active" ? "运行中" : s.status}，已跑 ${s.runCount} 次${s.lastStatus ? `，上次 ${s.lastStatus}` : ""}：${clip(s.instruction, 90)}`,
          )
          .join("\n")
      : "  （没有定时任务）";
    const hints = bot.workloadHints.length
      ? bot.workloadHints.map((hint) => hint.label).join("、")
      : "看不出明显倾向";
    return [
      `### ${bot.name} [${bot.id}]${bot.title ? `（${bot.title}）` : ""}`,
      `- 职责：${clip(bot.roleDescription, 200) || "（没写）"}`,
      `- 模型：${model}`,
      `- ${caps(bot.capabilities)}`,
      `- 活动：在 ${bot.channelCount} 个频道；定时任务 ${bot.schedules.length} 个`,
      schedules,
      `- 负载线索：${hints}${bot.canManage ? "" : "；⚠ 这个 bot 不归你管，模型你改不了"}`,
    ].join("\n");
  });
  const remote = onlyAgentId
    ? data.remote.filter((bot) => bot.id === onlyAgentId)
    : data.remote;
  const tombstones = data.tombstones;
  return [
    `# 车队模型审计`,
    `默认模型：${data.defaultModel ?? "（读不到）"}（档位猜测：${MODEL_TIER_LABELS[modelTierOf(data.defaultModel)]}）`,
    `\n## 可用模型目录（${data.catalog?.length ?? 0} 个${data.catalogStale ? "，缓存过期" : ""}）`,
    catalogLine,
    `\n## 内置 bot（${bots.length} 个）`,
    botLines.length ? botLines.join("\n\n") : "（没有内置 bot）",
    remote.length
      ? `\n## 远程 bot（${remote.length} 个，模型在各自服务里配置，这里只列不评）\n${remote.map((bot) => `- ${bot.name} [${bot.id}]`).join("\n")}`
      : "",
    tombstones.length && !onlyAgentId
      ? `\n## 已删 bot（${tombstones.length} 个，只剩历史对话）\n${tombstones.map((bot) => `- ${bot.name} [${bot.id}]`).join("\n")}`
      : "",
    `\n${FLEET_AUDIT_RUBRIC}`,
  ]
    .filter(Boolean)
    .join("\n");
}
