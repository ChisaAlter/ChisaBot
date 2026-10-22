/**
 * 面板设计规范 + 制作流程 + 服务器检查（2026-10-13，用户：「得给 bot 一个规范，让它制作面板好看一些……
 * 把这套提示词工作流都给 bot」）。
 *
 * 右栏面板是机器人自己做的，什么主题都有可能（天气、行情、待办、倒计时、服务器状态……）。渲染端已经兜底
 * （一层外壳、数字不折行、窄表格换简表，DESIGN.md §29），但兜底只能让坏规范「不难看」，好看要靠机器人
 * 一开始就按同一套规矩做：
 *  - {@link PANEL_DESIGN_GUIDE}：给机器人的规范和流程（系统提示词里，有面板工具时才加）；
 *  - {@link lintPanelSpec}：panel_update 保存前逐条检查，不合格就退回，并写清楚每一处怎么改。
 *
 * 规范和检查是一套东西：规范里写的每条硬限制都在检查里，改一处要两处一起改（数字都来自 {@link PANEL_LIMITS}）。
 */
import { parseRenderUiSpec, sanitizeRenderUiSpec } from "../../../shared/json-render/catalog";
import { sameTitle } from "../../../shared/json-render/panel-title";

export const PANEL_LIMITS = {
  /** 面板里的大块（表格、列表、图表、封面、时间线、键值、横滑、仪表、日历热力……）最多几块。Tabs 里只算最大的那一页。Hark：一屏最多两块（DESIGN.md §77.4）。 */
  bigParts: 2,
  /** 磁贴最多几个：Metric（着色磁贴也算）+ 单值 Ring。Hark：一屏最多两个磁贴（DESIGN.md §77.4）。 */
  metrics: 2,
  /** 并排的格子（Grid 2 列以上）里一段 Text 的宽度上限：再长就在窄格子里折成两三行（DESIGN.md §77.3）。 */
  cellText: 12,
  /** 列表 / 表格 / 时间线默认最多几行。 */
  rows: 5,
  /** 用户明确要更多行时的硬上限（检查按这个数退回）。 */
  rowsMax: 7,
  /** 表格单元格（第一列除外）宽度上限。 */
  cell: 8,
  /** 表格最多几列。 */
  columns: 4,
  /** 标签宽度上限（汉字算 1，拉丁字母和数字算 0.5：6 个汉字或 12 个字母）。 */
  label: 6,
  /** 大数字（含单位）宽度上限。 */
  value: 9,
  /** 一段 Text 的宽度上限（超过就是段落了）。 */
  text: 32,
  /** 从根算起最多几层（根 Stack → Tabs → Stack → Grid → Metric 是 5 层）。 */
  depth: 5,
  /** 元素总数上限。 */
  elements: 30,
  /** 图表每条线最多几个点（窄卡里再多就挤成一团）。 */
  chartPoints: 60,
  /** 键值清单最多几行。 */
  keyValues: 8,
  /** 横滑最多几张。 */
  carousel: 8,
  /** 标签页最多几页（窄卡）。 */
  tabs: 3,
} as const;

/** 宽度：汉字 / 全角算 1，其余（字母、数字、半角符号）算 0.5。 */
export function textWidth(value: unknown): number {
  let width = 0;
  for (const ch of String(value ?? "")) width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/u.test(ch) ? 1 : 0.5;
  return width;
}

const example = (spec: unknown) => JSON.stringify(spec);
const M = (props: Record<string, unknown>) => ({ type: "Metric", props, children: [] });

const PATTERNS = [
  [
    "A 行情（价格、汇率、指数）",
    "主数字带涨跌 + 迷你走势（spark）和 24h 区间两个磁贴并排；下面一张面积图（近 7–30 个点）。",
    example({
      root: "r",
      elements: {
        r: { type: "Stack", props: { gap: "md" }, children: ["g", "c"] },
        g: { type: "Grid", props: { columns: 2 }, children: ["m", "a"] },
        m: M({ label: "现价", value: "$81,272", delta: "24h -3.1%", trend: "down", icon: "currency-bitcoin", spark: [83950, 83100, 82400, 82900, 81800, 81272] }),
        a: M({ label: "24h 区间", value: "80.9k–84k" }),
        c: { type: "Chart", props: { kind: "area", labels: ["10/07", "10/08", "10/09", "10/10", "10/11", "10/12", "10/13"], data: [78210, 79950, 80400, 82100, 83600, 82900, 81272], unit: "$", height: 120 }, children: [] },
      },
    }),
  ],
  [
    "B 新闻 / 文章 / 搜索结果（可点）",
    "一行淡色说明 + List（≤5 行）：每行 title + 缩略图 image（有真实配图才写）+ 原文链接 href + 发布时间 time（ISO，会显示成「3 分钟前」并自己走）。",
    example({
      root: "r",
      elements: {
        r: { type: "Stack", props: { gap: "sm" }, children: ["t", "l"] },
        t: { type: "Text", props: { text: "10/13 09:00 · 路透社、BBC", tone: "muted", size: "sm" }, children: [] },
        l: {
          type: "List",
          props: {
            items: [
              { title: "（真实标题）", description: "（来源）", image: "https://example.com/cover-1.jpg", href: "https://example.com/news/1", time: "2026-10-13T08:40:00+08:00" },
              { title: "（真实标题）", description: "（来源）", href: "https://example.com/news/2", time: "2026-10-13T07:55:00+08:00" },
            ],
          },
          children: [],
        },
      },
    }),
  ],
  [
    "C 对比（几个城市 / 币种 / 方案放一起看）",
    "一张 ≤4 列、≤5 行的 Table，第一列是对象名，其余列是同一单位的数字；需要时上面放 1–2 个 Metric 给结论。",
    example({
      root: "r",
      elements: {
        r: { type: "Stack", props: { gap: "md" }, children: ["h", "tb"] },
        h: { type: "Heading", props: { text: "今日最高温", level: 3 }, children: [] },
        tb: {
          type: "Table",
          props: {
            columns: [{ key: "c", label: "城市" }, { key: "t", label: "最高/最低", align: "right" }, { key: "p", label: "降水", align: "right" }],
            rows: [{ c: "香港", t: "31°/24°", p: "16%" }, { c: "台北", t: "29°/23°", p: "40%" }],
          },
          children: [],
        },
      },
    }),
  ],
  [
    "D 倒计时（考试、发布、假期）",
    "Countdown（目标时间写 ISO 带时区，浏览器里每秒自己走，不用刷新）+ 算得准的进度条。",
    example({
      root: "r",
      elements: {
        r: { type: "Stack", props: { gap: "md" }, children: ["c", "p"] },
        c: { type: "Countdown", props: { label: "距离考试", target: "2026-10-25T09:00:00+08:00" }, children: [] },
        p: { type: "Progress", props: { value: 60, label: "备考进度", valueText: "6/10 章" }, children: [] },
      },
    }),
  ],
  [
    "E 服务状态（网站、接口、快递、订单）",
    "总状态 Badge（dot + pulse，正常 success，出问题 warn / danger）+ 每项一行 Status（detail 写结果）+ 可选 HeatStrip 画最近 24 小时在线（1 正常 / 0 故障）。",
    example({
      root: "r",
      elements: {
        r: { type: "Stack", props: { gap: "sm" }, children: ["b", "s1", "s2", "h"] },
        b: { type: "Badge", props: { text: "全部正常", tone: "success", dot: true, pulse: true }, children: [] },
        s1: { type: "Status", props: { label: "官网", tone: "success", detail: "200 · 120ms" }, children: [] },
        s2: { type: "Status", props: { label: "接口", tone: "success", detail: "200 · 85ms" }, children: [] },
        h: { type: "HeatStrip", props: { label: "24 小时", values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], caption: "100% 在线", tone: "success" }, children: [] },
      },
    }),
  ],
  [
    "F 天气",
    "Hero（无图时用 tone 渐变）放地点 + 天气 + 大号气温；2 个着色磁贴（湿度、降水，带图标）；最高 / 最低两条线的未来几天走势。",
    example({
      root: "r",
      elements: {
        r: { type: "Stack", props: { gap: "md" }, children: ["h", "g", "c"] },
        h: { type: "Hero", props: { eyebrow: "香港 · 现在", title: "多云", subtitle: "体感 29° · 东风 3 级", value: "26.9℃", icon: "cloud", tone: "info" }, children: [] },
        g: { type: "Grid", props: { columns: 2 }, children: ["a", "b"] },
        a: M({ label: "湿度", value: "73%", icon: "droplet", variant: "tinted", tone: "info" }),
        b: M({ label: "降水", value: "16%", icon: "umbrella", variant: "tinted", tone: "accent" }),
        c: {
          type: "Chart",
          props: {
            kind: "line",
            labels: ["10/13", "10/14", "10/15", "10/16", "10/17"],
            series: [{ name: "最高", data: [31, 30, 29, 30, 31], tone: "warn" }, { name: "最低", data: [24, 23, 23, 24, 24], tone: "info" }],
            unit: "°",
            height: 110,
          },
          children: [],
        },
      },
    }),
  ],
  [
    "G 项目 / 账号（GitHub 仓库、频道、店铺）",
    "Avatar 身份行（logo 用 square，href 指向主页）+ 2 个着色磁贴 + 活跃度 HeatStrip（每天一个数）。",
    example({
      root: "r",
      elements: {
        r: { type: "Stack", props: { gap: "md" }, children: ["a", "g", "h"] },
        a: { type: "Avatar", props: { name: "owner/repo", subtitle: "（一句简介）", shape: "square", href: "https://github.com/owner/repo" }, children: [] },
        g: { type: "Grid", props: { columns: 2 }, children: ["s", "f"] },
        s: M({ label: "Star", value: "128k", icon: "star", variant: "tinted", tone: "warn", delta: "本周 +1.2k", trend: "up" }),
        f: M({ label: "Fork", value: "27.1k", icon: "git-fork", variant: "tinted", tone: "accent" }),
        h: { type: "HeatStrip", props: { label: "近 14 天提交", values: [3, 5, 0, 8, 12, 4, 6, 9, 2, 0, 7, 11, 5, 6], caption: "78 次", tone: "success" }, children: [] },
      },
    }),
  ],
  [
    "H 资源 / 用量（服务器、电脑、预算、配额）",
    "2 个 Ring（单值百分比，超阈值用 warn / danger）+ KeyValue 列规格（IP、版本用 mono，可 copy）。",
    example({
      root: "r",
      elements: {
        r: { type: "Stack", props: { gap: "md" }, children: ["g", "kv"] },
        g: { type: "Grid", props: { columns: 2 }, children: ["c", "m"] },
        c: { type: "Ring", props: { value: 42, label: "CPU" }, children: [] },
        m: { type: "Ring", props: { value: 81, label: "内存", tone: "warn" }, children: [] },
        kv: {
          type: "KeyValue",
          props: {
            items: [
              { label: "磁盘", value: "61%" },
              { label: "负载", value: "0.42" },
              { label: "已运行", value: "12 天" },
              { label: "地址", value: "10.0.0.8", mono: true, copy: "10.0.0.8" },
            ],
          },
          children: [],
        },
      },
    }),
  ],
] as const;

const L = PANEL_LIMITS;

/** 给机器人的面板设计规范 + 制作流程（系统提示词）。 */
export const PANEL_DESIGN_GUIDE = [
  "【面板设计规范】右栏面板是一张窄卡片（先按 300px 宽设计，手机和宽屏会自动适配）。用户扫一眼就要看懂，而且要好看：用图表、环、着色磁贴、封面、状态点把数据「画」出来，而不是一堆文字。",
  "制作流程（每次 panel_update 之前都走一遍）：",
  "1. 一句话问题：先想清楚这张面板回答用户的哪一个问题（例如「比特币现在多少钱、这周涨还是跌」「香港这几天会不会下雨」），和这个问题无关的数据一律不放。",
  "2. 选版式：从下面 A–H 里选一个（最多拼两个），照着示例的结构写；示例里的数字、标题、example.com 链接都是占位，必须换成这一轮取到的真实值。",
  "3. 填真实数据：只用这一轮刚取到的数据；取不到的项整项删掉，不要写「暂无」「--」占位，更不能编。走势图 / 热力条需要一串真实的历史数（接口一般能给，例如 CoinGecko market_chart、Open-Meteo daily、GitHub commit_activity）；拿不到历史就不要画图。",
  "4. 让它能点：有网址的条目（新闻、文章、仓库、商品）写 href（新标签页打开，自动显示 ↗）；想让用户继续问的写 ask（例如「展开讲讲这条」）；IP、地址、命令写 copy。",
  "5. 控量 + 自查：照下面的硬限制删减，宁少勿多；交之前逐条检查。服务器也会检查，不合格会退回并写明哪一处怎么改——照着改完重新 panel_update，不要换个面板重做。",
  "硬限制：",
  `- 只有一层外壳：卡片本身就是外壳，规范里不用 Card。最外层用 Stack（gap md），小节标题用 Heading level 3（可带 icon）。从根算起最多 ${L.depth} 层，全部元素不超过 ${L.elements} 个。`,
  "- 不重复标题：卡片头已经显示面板标题，规范里不要再写一遍；需要时间 / 地点说明就用一行 Text（tone muted，size sm），例如「10/13 09:00 · 香港」；时间一律写用户当地时间（不知道就用北京时间），不写 UTC。卡片底部会自己显示「x 分钟前更新」，不要自己写更新时间。",
  `- 一张面板最多 ${L.metrics} 个磁贴 + ${L.bigParts} 个大块（像 Hark 一样一眼看完）。大块最多 ${L.bigParts} 个（Table、List、Chart、Hero、Timeline、KeyValue、Carousel、Products、Gauge、Image、日历 HeatStrip、多段 Ring 各算一块；Tabs 只算最大的那一页）。Hero 最多 1 个。`,
  `- 磁贴（Metric 和单值 Ring 合计）最多 ${L.metrics} 个（2 个一排放进 Grid columns 2）。更多的数放进一张 KeyValue 或 Table（算一块大块），不要排成一墙磁贴。着色磁贴（variant tinted + icon + tone）适合 2 个并排的关键数；平铺 Metric 的 tone 只给涨跌 / 预警。`,
  `- 并排的格子里（Grid 2 列以上）一段 Text 不超过 ${L.cellText} 个汉字宽，一格一件事；「降水 0 mm · 风速 5 km/h」这种多项说明放到 Grid 外面单独一行，或只留一项。`,
  `- 标签要短：Metric 的 label、表头、Badge、Heading、Tabs 的标签不超过 ${L.label} 个汉字（或 ${L.label * 2} 个字母）。`,
  `- 数字带单位：Metric 的 value 写成「数字 + 单位」的短串（26.9℃、73%、2.9 km/h、$81,272、12 天），不超过 ${L.value} 个汉字宽，不要写句子；单位会自动缩小变淡，刷新时数字会从旧值平滑滚到新值。delta + trend 只写「和过去比」的变化（较昨日 +1.2%、24h -3.1%）。`,
  `- 图表：每条线 ≤ ${L.chartPoints} 个点，labels 写短（10/13、09:00），最多 3 条线；height 默认即可（窄卡 100–140）。迷你走势用 Metric 的 spark 或 Sparkline（6–30 个点）。`,
  `- 列表、表格、时间线默认最多 ${L.rows} 行（用户明确要更多时最多 ${L.rowsMax} 行）；KeyValue ≤ ${L.keyValues} 行；Carousel ≤ ${L.carousel} 张；Products ≤ 4 个（窄卡固定 2 列）；Tabs ≤ ${L.tabs} 页。表格最多 ${L.columns} 列，每格不超过 ${L.cell} 个汉字宽，日期写短，相关的数合并成一列（31°/24°）。`,
  `- 不写段落：Text 只用来写一行说明（不超过 ${L.text} 个汉字宽），解释、建议说在对话里，不放进面板。`,
  "- 会自己走的时间：倒计时用 Countdown、世界时间用 Clock、发布时间用 List 的 time 或 RelativeTime（都写 ISO 带时区），浏览器里自己更新，不用为它们刷新面板。",
  "- 图片只用工具结果里真实出现过的 https 地址（新闻配图、头像、logo）；没有就不放，Hero 会用 tone 渐变。",
  "- 进度条 / Ring 只放算得准的比例（已完成 1/3 = 33%），算不准就不放。",
  "- 只读：面板里不放 Input / Select / Checkbox；要操作就用 ask 让用户在对话里继续。",
  "- 中文为先：所有文字用简体中文，专有名词（BTC、USD、API）照原样。",
  "- 刷新时保持每个元素的 key 和布局不变，只换数据（这样数字会平滑滚动、变化处会闪一下）。",
  "版式示例（{root, elements} 完整 JSON，panel_update 的 spec 直接交这种格式）：",
  ...PATTERNS.map(([name, how, spec]) => `${name}：${how}\n${spec}`),
].join("\n");

type El = { type?: string; props?: Record<string, unknown>; children?: unknown[]; repeat?: unknown };

/** 算「大块」的组件（HeatStrip 只有日历形态算，Ring 只有多段甜甜圈算，见 isBig）。 */
const BIG_PARTS = new Set(["Table", "List", "Image", "Chart", "Hero", "Timeline", "KeyValue", "Carousel", "Gauge", "Products"]);

/** 链接 / 图片地址：必须是 http(s)（图片 https），且不是示例里的占位地址。 */
function badUrl(value: unknown, httpsOnly: boolean): string | null {
  if (value === undefined || value === null || value === "" || typeof value === "object") return null;
  const text = String(value).trim();
  if (/^https?:\/\/([^/]*\.)?example\.(com|org|net)\b/i.test(text)) return "是示例里的占位地址，换成真实地址或删掉";
  if (!(httpsOnly ? /^https:\/\//i : /^https?:\/\//i).test(text)) return httpsOnly ? "不是 https 图片地址" : "不是 http(s) 链接";
  return null;
}

export type PanelLintOptions = {
  /**
   * 面板挂了直连数据源：值在运行时才由 `/live/<id>` 填进来，检查时还没解析出来。
   * 这里只放行这类绑定，其余规则一条不动（没有数据源时仍然按静态值检查）。
   */
  liveSources?: boolean;
};

/** `{"$state": "/live/..."}`：运行时才有的直连数据源绑定。 */
function isLiveBinding(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const path = (value as { $state?: unknown }).$state;
  return typeof path === "string" && path.startsWith("/live/");
}

/**
 * panel_update 保存前的检查。返回给机器人看的修改意见（每条都说清楚哪一处、怎么改）；空数组 = 通过。
 * 只查规范里写明的硬限制，宁可放过也不误伤：拿不准的（动态值、$state 绑定）不算。
 */
export function lintPanelSpec(source: string, panelTitle: string, options: PanelLintOptions = {}): string[] {
  const spec = sanitizeRenderUiSpec(parseRenderUiSpec(source, false))?.spec as
    | { root?: string; elements?: Record<string, El> }
    | undefined;
  if (!spec?.root || !spec.elements?.[spec.root]) return [];
  const elements = spec.elements;
  const issues: string[] = [];
  const name = (key: string, el: El) => {
    const p = el.props ?? {};
    const label = p.label ?? p.title ?? p.text;
    return typeof label === "string" && label ? `${el.type}「${label.slice(0, 16)}」` : `${el.type}（${key}）`;
  };

  // 层数 + 只数从根能走到的元素
  const reachable: [string, El, number][] = [];
  const seen = new Set<string>();
  const walk = (key: string, depth: number) => {
    const el = elements[key];
    if (!el || seen.has(key)) return;
    seen.add(key);
    reachable.push([key, el, depth]);
    for (const child of Array.isArray(el.children) ? el.children : []) if (typeof child === "string") walk(child, depth + 1);
  };
  walk(spec.root, 1);

  const maxDepth = Math.max(...reachable.map(([, , d]) => d));
  if (maxDepth > L.depth) issues.push(`层数太深（${maxDepth} 层，最多 ${L.depth} 层）：去掉中间多余的 Stack / Card，同级内容直接放在最外层 Stack 里。`);

  const cards = reachable.filter(([, el]) => el.type === "Card");
  if (cards.length) {
    issues.push(
      `不要用 Card（发现 ${cards.length} 个）：面板卡片本身就是外壳。最外层的 Card 换成 Stack（gap md）；里面的 Card 去掉，它的 title 改成一个 Heading level 3，内容直接跟在后面。`,
    );
  }

  for (const [key, el] of reachable) {
    const p = el.props ?? {};
    const dup =
      (el.type === "Heading" && sameTitle(p.text, panelTitle)) ||
      (el.type === "Card" && sameTitle(p.title, panelTitle)) ||
      (el.type === "Text" && sameTitle(p.text, panelTitle));
    if (dup) issues.push(`${name(key, el)} 重复了面板标题「${panelTitle}」：卡片头已经显示标题，删掉它；要写时间或地点就用一行 Text（tone muted）。`);
  }

  /*
   * 「看得见的」数量：Tabs 一次只显示一页，取最大的那页；Carousel 是横滑，里面的卡片不算进外面的限额。
   * 大块本身也不往里数（一张时间线算一块，不管它里面有几行）。
   */
  const isBig = (el: El) => {
    const type = el.type ?? "";
    if (BIG_PARTS.has(type)) return true;
    if (type === "HeatStrip") return Number(el.props?.rows) > 1;
    if (type === "Ring") return Array.isArray(el.props?.segments) && (el.props?.value === undefined || el.props?.value === null);
    return false;
  };
  const visible = (key: string, hit: (el: El) => boolean, stack = new Set<string>()): string[] => {
    const el = elements[key];
    if (!el || stack.has(key)) return [];
    stack.add(key);
    const children = (Array.isArray(el.children) ? el.children : []).filter((c): c is string => typeof c === "string");
    let found: string[] = hit(el) ? [key] : [];
    if (!isBig(el)) {
      const per = children.map((child) => visible(child, hit, stack));
      found = found.concat(el.type === "Tabs" ? per.reduce((a, b) => (b.length > a.length ? b : a), [] as string[]) : per.flat());
    }
    stack.delete(key);
    return found;
  };
  const big = visible(spec.root, isBig);
  if (big.length > L.bigParts) {
    issues.push(`大块太多（${big.map((k) => name(k, elements[k] ?? {})).join("、")}，最多 ${L.bigParts} 个）：只留回答核心问题的那 ${L.bigParts} 个，其余删掉或在对话里说。`);
  }
  const heroes = reachable.filter(([, el]) => el.type === "Hero");
  if (heroes.length > 1) issues.push(`Hero 只能有 1 个（现在 ${heroes.length} 个）：留最重要的那个，其余改成 Metric 或删掉。`);
  const metricKeys = visible(spec.root, (el) => el.type === "Metric");
  const metrics = metricKeys.map((k) => [k, elements[k] ?? ({} as El)] as const);
  const singleRings = visible(spec.root, (el) => el.type === "Ring" && !isBig(el)).length;
  if (metrics.length + singleRings > L.metrics) {
    issues.push(
      `${singleRings ? "磁贴" : "Metric"} 太多（${metrics.length + singleRings} 个，最多 ${L.metrics} 个）：只留最重要的 ${L.metrics} 个磁贴，其余的数放进一张 KeyValue（算一块大块）或删掉。`,
    );
  }
  // 并排格子里的长说明（§77.3）：Grid 2 列以上的直接子元素 / 孙元素里的 Text。
  const cellTexts = new Set<string>();
  for (const [, el] of reachable) {
    if (el.type !== "Grid" || !(Number(el.props?.columns ?? 2) >= 2)) continue;
    const stack = (Array.isArray(el.children) ? el.children : []).filter((c): c is string => typeof c === "string");
    for (let depth = 0; depth < 2; depth++) {
      const next: string[] = [];
      for (const key of stack.splice(0)) {
        const child = elements[key];
        if (!child) continue;
        if (child.type === "Text" && typeof child.props?.text === "string" && textWidth(child.props.text) > L.cellText) cellTexts.add(child.props.text);
        if (child.type === "Stack") next.push(...(Array.isArray(child.children) ? child.children : []).filter((c): c is string => typeof c === "string"));
      }
      stack.push(...next);
    }
  }
  if (cellTexts.size) {
    issues.push(
      `并排格子里的说明太长（${[...cellTexts].slice(0, 2).map((t) => `「${t.slice(0, 16)}」`).join("、")}）：窄格子里会折成两三行。每段不超过 ${L.cellText} 个汉字宽、一格一件事；多项说明放到 Grid 外面单独一行，或只留最重要的一项。`,
    );
  }
  if (reachable.length > L.elements) issues.push(`元素太多（${reachable.length} 个，最多 ${L.elements} 个）：删掉次要内容。`);

  const colored = metrics.filter(([, el]) => el.props?.variant !== "tinted" && el.props?.tone && el.props.tone !== "default").length;
  if (colored > 2) issues.push(`有颜色的数字太多（${colored} 个）：tone 只留给涨跌、预警这类有含义的 1–2 个，其余去掉 tone。`);

  for (const [key, el] of reachable) {
    const p = el.props ?? {};
    const tooLong = (value: unknown, limit: number) =>
      !(options.liveSources && isLiveBinding(value)) && typeof value === "string" && textWidth(value) > limit;
    switch (el.type) {
      case "Metric": {
        if (tooLong(p.label, L.label)) issues.push(`Metric 的 label「${p.label}」太长：不超过 ${L.label} 个汉字，例如「体感」「24h 最高」。`);
        if (tooLong(p.value, L.value)) issues.push(`Metric「${p.label}」的 value「${String(p.value).slice(0, 20)}」太长：只写数字 + 单位（如 26.9℃、$81,272、12 天），说明文字放 delta 或删掉。`);
        break;
      }
      case "Heading":
      case "Badge":
        if (tooLong(p.text, L.label + 2)) issues.push(`${el.type}「${p.text}」太长：不超过 ${L.label} 个汉字左右。`);
        break;
      case "Text":
        if (tooLong(p.text, L.text)) issues.push(`Text「${String(p.text).slice(0, 14)}…」是一段话：面板里只放一行短说明（不超过 ${L.text} 个汉字宽），解释和建议在对话里说。`);
        break;
      case "Alert":
        if (tooLong(p.message, L.text)) issues.push(`Alert「${String(p.message).slice(0, 14)}…」太长：只写一句话的结论。`);
        break;
      case "Table": {
        const columns = Array.isArray(p.columns) ? (p.columns as { label?: unknown }[]) : [];
        const rows = Array.isArray(p.rows) ? p.rows : [];
        if (columns.length > L.columns) issues.push(`表格列太多（${columns.length} 列，最多 ${L.columns} 列）：相关的合成一列（如「最高/最低」写 31°/24°），次要的列删掉。`);
        if (rows.length > L.rowsMax) issues.push(`表格行太多（${rows.length} 行，最多 ${L.rowsMax} 行）：只留最近 / 最重要的 ${L.rows} 行。`);
        const restKeys = columns.slice(1).map((c) => (c as { key?: unknown }).key).filter((k): k is string => typeof k === "string");
        const longCells = rows
          .flatMap((row) => restKeys.map((k) => (row as Record<string, unknown>)?.[k]))
          .filter((v) => tooLong(v, L.cell))
          .slice(0, 3)
          .map((v) => `「${String(v).slice(0, 16)}」`);
        if (longCells.length) issues.push(`表格单元格 ${longCells.join("、")} 太长：每格不超过 ${L.cell} 个汉字宽，一格只放一个数；次要的数据删掉。`);
        const longHeads = columns.filter((c) => tooLong(c.label, L.label)).map((c) => `「${c.label}」`);
        if (longHeads.length) issues.push(`表头 ${longHeads.join("、")} 太长：不超过 ${L.label} 个汉字。`);
        break;
      }
      case "List": {
        const items = Array.isArray(p.items) ? (p.items as { title?: unknown; meta?: unknown }[]) : [];
        if (items.length > L.rowsMax) issues.push(`列表行太多（${items.length} 行，最多 ${L.rowsMax} 行）：只留最重要的 ${L.rows} 行。`);
        if (items.some((item) => tooLong(item.meta, L.value + 3))) issues.push("列表右侧的 meta 太长：只写时间、数量、状态这类短信息，长内容放 description。");
        break;
      }
      case "Grid":
        if (Number(p.columns) > 3) issues.push(`Grid 的 columns ${p.columns} 太多：窄卡里用 2（最多 3）。`);
        break;
      case "Chart": {
        const lines = Array.isArray(p.series) && p.series.length ? (p.series as { data?: unknown }[]).map((s) => s?.data) : [p.data];
        const longest = Math.max(0, ...lines.map((d) => (Array.isArray(d) ? d.length : 0)));
        if (longest > L.chartPoints) issues.push(`图表点太多（${longest} 个，最多 ${L.chartPoints} 个）：按天 / 按小时抽样，或只画最近一段。`);
        if (longest > 0 && longest < 2 && p.kind !== "bar") issues.push("折线图至少要 2 个点：只有一个数就用 Metric。");
        break;
      }
      case "Hero":
        if (tooLong(p.title, 18)) issues.push(`Hero 的标题「${String(p.title).slice(0, 14)}…」太长：一行能放下的短句（不超过 18 个汉字）。`);
        if (tooLong(p.value, L.value)) issues.push(`Hero 的 value「${String(p.value).slice(0, 16)}」太长：只写数字 + 单位。`);
        break;
      case "Tabs": {
        const tabs = Array.isArray(p.tabs) ? p.tabs : [];
        if (tabs.length > L.tabs) issues.push(`标签页太多（${tabs.length} 页，最多 ${L.tabs} 页）：窄卡里只留最常看的 ${L.tabs} 页。`);
        if (tabs.some((t) => tooLong(t, 4))) issues.push("标签页的文字太长：每个不超过 4 个汉字（今天 / 本周 / 本月）。");
        const panes = (Array.isArray(el.children) ? el.children : []).length;
        if (panes !== tabs.length) issues.push(`Tabs 有 ${tabs.length} 个标签但有 ${panes} 个子元素：children 要和 tabs 一一对应（每页一个 Stack）。`);
        break;
      }
      case "Carousel":
        if ((Array.isArray(el.children) ? el.children.length : 0) > L.carousel) issues.push(`横滑卡片太多（最多 ${L.carousel} 张）：只留最重要的几张。`);
        break;
      case "Products": {
        const items = Array.isArray(p.items) ? p.items : [];
        if (items.length > 4) issues.push(`商品网格太多（${items.length} 个，最多 4 个）：窄卡里只留最值得看的 4 个。`);
        break;
      }
      case "Timeline": {
        const items = Array.isArray(p.items) ? p.items : [];
        if (items.length > L.rowsMax) issues.push(`时间线太长（${items.length} 条，最多 ${L.rowsMax} 条）：只留最近的 ${L.rows} 条。`);
        break;
      }
      case "KeyValue": {
        const items = Array.isArray(p.items) ? (p.items as { label?: unknown; value?: unknown }[]) : [];
        if (items.length > L.keyValues) issues.push(`键值清单太长（${items.length} 行，最多 ${L.keyValues} 行）：只留最重要的。`);
        if (items.some((item) => tooLong(item.label, L.label))) issues.push(`键值清单的标签太长：不超过 ${L.label} 个汉字。`);
        if (items.some((item) => tooLong(item.value, 14))) issues.push("键值清单的值太长：每个值一行短文字（不超过 14 个汉字宽）。");
        break;
      }
      case "Ring":
        if (Array.isArray(p.segments) && p.segments.length > 5) issues.push("甜甜圈图段数太多（最多 5 段）：小的几项合并成「其他」。");
        break;
      case "Countdown":
        if (typeof p.target === "string" && !Number.isFinite(Date.parse(p.target))) issues.push(`Countdown 的 target「${p.target}」不是合法时间：写 ISO 格式带时区，如 2026-10-25T09:00:00+08:00。`);
        break;
      case "Clock":
        if (typeof p.timezone === "string" && p.timezone) {
          try {
            new Intl.DateTimeFormat("zh-CN", { timeZone: p.timezone });
          } catch {
            issues.push(`Clock 的 timezone「${p.timezone}」不是 IANA 时区：写成 Asia/Shanghai、America/New_York 这种。`);
          }
        }
        break;
      case "Input":
      case "Select":
      case "Checkbox":
        issues.push(`${name(key, el)}：面板是只读的，不放输入控件；需要用户操作就在对话里说。`);
        break;
    }
  }
  // 链接 / 图片：每个元素的 href / url / image / src，以及 List / Timeline / KeyValue 每一行的 href / image。
  const urlIssues: string[] = [];
  for (const [key, el] of reachable) {
    const p = el.props ?? {};
    const check = (value: unknown, field: string, httpsOnly: boolean) => {
      if (options.liveSources && isLiveBinding(value)) return;
      const why = badUrl(value, httpsOnly);
      if (why) urlIssues.push(`${name(key, el)} 的 ${field}「${String(value).slice(0, 40)}」${why}。`);
    };
    check(p.href, "href", false);
    if (el.type === "Link") check(p.url, "url", false);
    check(p.image, "image", true);
    if (el.type === "Avatar" || el.type === "Image") check(p.src, "src", true);
    for (const item of Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : []) {
      if (!item || typeof item !== "object") continue;
      check(item.href, "href", false);
      if (el.type === "Products") check(item.url, "url", false);
      check(item.image, "image", true);
    }
  }
  issues.push(...urlIssues.slice(0, 4));
  return [...new Set(issues)];
}
