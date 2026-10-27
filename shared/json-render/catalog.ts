import {
  compileSpecStream,
  defineCatalog,
  formatSpecIssues,
  type Spec,
  validateSpec,
} from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/**
 * 生成式界面（json-render）的组件目录，服务器与浏览器共用一份。
 *
 * 服务器用它生成提示词（`catalog.prompt()`）并在 `render_ui` 工具里校验机器人给出的规范；浏览器用同一份
 * 目录注册组件实现（app/src/lib/copilot/json-render）。两边读同一个文件，所以「模型被告知能用什么」和
 * 「界面实际能画什么」不会漂移。
 *
 * 取代原来的 A2UI（@copilotkit/a2ui-renderer basicCatalog）。开关仍是 DeploymentConfig.generativeUi
 * （CHISABOT_GENERATIVE_UI），关掉时既不给工具，也不注册渲染器。
 */

export const RENDER_UI_TOOL = "render_ui";

/**
 * 语义色。写成宽松的字符串而不是枚举：模型常写 good / bad / brand / info，枚举会让整个元素被跳过；
 * 浏览器用 normaliseTone 归一（good → success、bad → danger、brand → accent……），不认识的当 default。
 */
const tone = z
  .string()
  .max(16)
  .nullish()
  .describe("语义色：default / accent（品牌蓝）/ info / success（好、涨）/ warn / danger（坏、跌），默认 default");

export const TONES = ["default", "accent", "info", "success", "warn", "danger"] as const;
export type Tone = (typeof TONES)[number];
const TONE_ALIASES: Record<string, Tone> = {
  brand: "accent", primary: "accent", blue: "accent", sky: "accent",
  good: "success", ok: "success", positive: "success", green: "success", up: "success",
  warning: "warn", amber: "warn", yellow: "warn", orange: "warn", caution: "warn",
  bad: "danger", error: "danger", negative: "danger", red: "danger", down: "danger", critical: "danger",
  neutral: "default", muted: "default", gray: "default", grey: "default", none: "default",
  cyan: "info", teal: "info", purple: "info",
};
/** 任意写法 → 六种语义色之一。 */
export function normaliseTone(value: unknown): Tone {
  if (typeof value !== "string") return "default";
  const key = value.trim().toLowerCase();
  if ((TONES as readonly string[]).includes(key)) return key as Tone;
  return TONE_ALIASES[key] ?? "default";
}

/** 每一项（行、磁贴、链接）都可以带一个点击动作；三选一，优先 href。 */
const itemActions = {
  href: z.string().max(2000).nullish().describe("点击在新标签页打开的 http(s) 链接（会显示 ↗）"),
  ask: z.string().max(500).nullish().describe("点击后以用户身份发给你的一句话（例如「展开讲讲这条新闻」）"),
  copy: z.string().max(2000).nullish().describe("点击复制到剪贴板的文字"),
};

/** 图标名（Tabler 图标的子集），不认识的名字不画图标。 */
export const ICON_NAMES = [
  "trending-up", "trending-down", "chart-line", "chart-bar", "chart-pie", "activity", "gauge",
  "coin", "currency-dollar", "currency-yuan", "currency-bitcoin", "wallet", "building-bank", "receipt",
  "sun", "moon", "cloud", "cloud-rain", "cloud-storm", "snowflake", "wind", "droplet", "temperature", "umbrella", "sunrise", "sunset", "mist",
  "server", "cpu", "database", "cloud-computing", "wifi", "bolt", "battery", "device-desktop", "terminal", "code", "bug", "shield", "lock", "key",
  "brand-github", "git-fork", "git-pull-request", "git-commit", "star", "eye", "users", "user", "heart", "message", "mail", "bell",
  "news", "article", "link", "world", "rss", "book", "bookmark", "photo", "video", "music", "microphone",
  "clock", "calendar", "hourglass", "alarm", "timeline", "flag", "trophy", "target", "rocket", "flame", "sparkles",
  "map-pin", "plane", "car", "train", "bike", "walk", "home", "building", "package", "truck", "shopping-cart", "tag",
  "check", "x", "alert-triangle", "info-circle", "circle-check", "circle-x", "help", "refresh", "download", "upload", "external-link", "copy", "settings", "search", "list", "filter",
] as const;
const icon = z.string().max(40).nullish().describe(`图标名，可选：${ICON_NAMES.join(" ")}`);

/** 数列：数字（或能读成数字的字符串，如 "81,272"）；null 表示这一点缺数据。 */
const numbers = z.array(z.union([z.number(), z.string().max(24), z.null()])).max(400);
const gap = z.enum(["sm", "md", "lg"]).nullish().describe("间距，默认 md");

/** 单元格只接受纯文本 / 数字，不接受 HTML。 */
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const jsonRenderCatalog = defineCatalog(schema, {
  components: {
    Card: {
      props: z.object({
        title: z.string().nullish(),
        description: z.string().nullish(),
        tone,
        icon,
      }),
      slots: ["default"],
      description:
        "磨砂玻璃卡片，界面的最外层通常用它。title 为卡片标题，description 为一句说明。",
    },
    Stack: {
      props: z.object({
        direction: z.enum(["vertical", "horizontal"]).nullish(),
        gap,
        align: z.enum(["start", "center", "end", "stretch"]).nullish(),
        justify: z.enum(["start", "center", "end", "between"]).nullish(),
        wrap: z.boolean().nullish(),
      }),
      slots: ["default"],
      description: "纵向（默认）或横向排列子元素。按钮组用 horizontal。",
    },
    Grid: {
      props: z.object({
        columns: z.number().int().min(1).max(4).nullish().describe("列数 1–4，默认 2；窄屏自动变成一列"),
        gap,
      }),
      slots: ["default"],
      description: "等宽多列网格，适合放多个 Metric 或小卡片。",
    },
    Heading: {
      props: z.object({
        text: z.string(),
        level: z.number().int().min(1).max(3).nullish().describe("1 最大，默认 2"),
        icon,
      }),
      slots: [],
      description: "标题文字。",
    },
    Text: {
      props: z.object({
        text: z.string(),
        tone: z.enum(["default", "muted", "success", "warn", "danger"]).nullish(),
        size: z.enum(["sm", "md"]).nullish(),
        weight: z.enum(["normal", "medium", "bold"]).nullish(),
      }),
      slots: [],
      description: "一段纯文本（不支持 Markdown / HTML），换行用 \\n。",
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        delta: z.string().nullish().describe("对比说明，例如 “较昨日 +12%”"),
        trend: z.enum(["up", "down", "flat"]).nullish(),
        tone,
        icon,
        variant: z.enum(["plain", "tinted"]).nullish().describe("tinted = 按 tone 着色的磁贴（带图标、渐变底），plain = 平铺数字（默认）"),
        spark: numbers.nullish().describe("可选，最近一段的数列（如 24 小时价格），画成数字下方的迷你走势线"),
        caption: z.string().nullish().describe("数字下面一行很短的补充，如「体感 29°」"),
        ...itemActions,
      }),
      slots: [],
      description:
        "统计磁贴：label + 大数字 value（数字 + 单位）+ 可选 delta（配 trend up/down，显示 ▲▼ 着色胶囊）+ 可选 spark（数字数组，画成迷你走势线）+ icon。variant \"tinted\" = 按 tone 着色的渐变磁贴，用于 2–4 个并排的关键数。刷新时数字会平滑滚动到新值并闪一下。",
    },
    Table: {
      props: z.object({
        columns: z
          .array(
            z.object({
              key: z.string(),
              label: z.string(),
              align: z.enum(["left", "right", "center"]).nullish(),
            }),
          )
          .min(1),
        rows: z.array(z.record(z.string(), cell)),
        caption: z.string().nullish(),
      }),
      slots: [],
      description: "数据表格。rows 每一项是 { 列 key: 文本或数字 }。行数多于 20 时只放最重要的。",
    },
    List: {
      props: z.object({
        items: z.array(
          z.object({
            title: z.string(),
            description: z.string().nullish(),
            meta: z.string().nullish().describe("右侧的短信息，例如时间、数量"),
            image: z.string().nullish().describe("左侧缩略图，真实的 https 图片地址（新闻配图、商品图）"),
            icon,
            tone,
            badge: z.string().nullish().describe("标题后的小标签，如「新」「热」"),
            time: z.string().nullish().describe("ISO 时间（2026-10-13T08:00:00+08:00），显示成会自己走的「3 分钟前」"),
            ...itemActions,
          }),
        ),
        ordered: z.boolean().nullish(),
      }),
      slots: [],
      description:
        "列表行：可选缩略图 / 图标 + 标题 + 说明 + 右侧元信息。每一行可带 href（新标签页打开，显示 ↗）、ask 或 copy，整行可点。新闻、搜索结果、待办都用它。",
    },
    Badge: {
      props: z.object({
        text: z.string(),
        tone,
        icon,
        dot: z.boolean().nullish().describe("前面加一个状态圆点"),
        pulse: z.boolean().nullish().describe("圆点呼吸闪烁（表示「正在进行 / 在线」）"),
        ...itemActions,
      }),
      slots: [],
      description: "胶囊徽标 / 标签 / 链接胶囊（带 href 时可点）。多个放进 horizontal Stack。",
    },
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["primary", "secondary", "ghost", "danger"]).nullish(),
        disabled: z.boolean().nullish(),
        choice: z
          .boolean()
          .nullish()
          .describe("true = 互斥选项（配合 ask）：同一张界面里所有 choice 按钮只能选一个，选完其余变灰"),
        icon,
        ...itemActions,
      }),
      slots: [],
      description:
        "胶囊按钮。最简单是写 href（打开链接）/ ask（替用户发一句话）/ copy（复制）；也可用 on.press 绑定动作：send_message、open_link、copy_text、refresh_panel 或内置的 setState。让用户从几个互斥方案里选一个时，每个按钮写 ask + choice: true。",
    },
    Input: {
      props: z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]).nullish().describe("用 { \"$bindState\": \"/form/xxx\" } 双向绑定"),
        placeholder: z.string().nullish(),
        type: z.enum(["text", "number", "email", "date", "time", "url"]).nullish(),
        multiline: z.boolean().nullish().describe("true 时为多行文本框"),
        helper: z.string().nullish(),
      }),
      slots: [],
      description: "表单输入框。value 必须用 $bindState 绑定到 state 里的路径。",
    },
    Select: {
      props: z.object({
        label: z.string(),
        value: z.string().nullish().describe("用 $bindState 绑定"),
        options: z.array(
          z.union([z.string(), z.object({ label: z.string(), value: z.string() })]),
        ),
        placeholder: z.string().nullish(),
      }),
      slots: [],
      description: "下拉选择。value 用 $bindState 绑定。",
    },
    Checkbox: {
      props: z.object({
        label: z.string(),
        checked: z.boolean().nullish().describe("用 $bindState 绑定"),
        description: z.string().nullish(),
      }),
      slots: [],
      description: "勾选框。checked 用 $bindState 绑定。",
    },
    Alert: {
      props: z.object({
        title: z.string().nullish(),
        message: z.string(),
        tone: z.string().max(16).nullish().describe("info（默认）/ success / warn / danger"),
        icon,
        actionLabel: z.string().nullish().describe("右侧小按钮的文字（配合 href / ask）"),
        ...itemActions,
      }),
      slots: [],
      description: "提示条 / 标注：信息 / 成功 / 警告 / 错误，渐变底色 + 图标，可带一个动作。",
    },
    Progress: {
      props: z.object({
        value: z.number().min(0).max(100),
        label: z.string().nullish(),
        tone,
        valueText: z.string().nullish().describe("右侧显示的文字，默认是百分比（例如写「3/5」）"),
      }),
      slots: [],
      description: "进度条，value 为 0–100。",
    },
    Image: {
      props: z.object({
        src: z.string().describe("必须是 https:// 开头的图片地址"),
        alt: z.string(),
        caption: z.string().nullish(),
        aspect: z.enum(["16:9", "4:3", "1:1", "auto"]).nullish(),
        href: itemActions.href,
      }),
      slots: [],
      description: "图片。只用你确实拿到的真实 https 图片地址，不要编造链接。",
    },
    Separator: {
      props: z.object({ label: z.string().nullish().describe("可选，线中间的小字") }),
      slots: [],
      description: "1px 分隔线，可带中间小字（「今天」「更早」）。",
    },
    Sparkline: {
      props: z.object({
        data: numbers.describe("按时间先后的数列，至少 2 个点"),
        tone,
        label: z.string().nullish(),
        value: z.union([z.string(), z.number()]).nullish().describe("右侧显示的当前值"),
        height: z.number().int().min(16).max(80).nullish().describe("高度 px，默认 32"),
      }),
      slots: [],
      description: "迷你走势线（渐变填充），一行：可选 label + 线（data 数列）+ 当前 value。tone 不写时按首尾涨跌自动绿 / 红。",
    },
    Chart: {
      props: z.object({
        kind: z.enum(["line", "area", "bar"]).nullish().describe("默认 area"),
        labels: z.array(z.string()).max(400).nullish().describe("横轴标签，与数据一一对应（如 10/09、10/10…）"),
        data: numbers.nullish().describe("单条数据；多条用 series"),
        series: z
          .array(z.object({ name: z.string(), data: numbers, tone }))
          .max(3)
          .nullish()
          .describe("最多 3 条数据，每条 { name, data, tone }"),
        unit: z.string().nullish().describe("数值单位，悬停提示里显示，如 $、℃、%"),
        height: z.number().int().min(60).max(320).nullish().describe("高度 px，默认 140"),
        tone,
        caption: z.string().nullish(),
      }),
      slots: [],
      description:
        "折线 / 面积 / 柱状图（SVG，渐变填充，鼠标悬停或手指按住显示数值）。用于价格走势、气温、流量等。数据点 ≤ 60 个最好。",
    },
    Ring: {
      props: z.object({
        value: z.number().min(0).max(100).nullish().describe("单值进度环 0–100"),
        segments: z
          .array(z.object({ label: z.string(), value: z.number().min(0), tone }))
          .max(6)
          .nullish()
          .describe("甜甜圈图：几段占比（按 value 比例），不写 value 时用"),
        label: z.string().nullish(),
        center: z.string().nullish().describe("圆心的大字，默认是百分比"),
        caption: z.string().nullish(),
        tone,
        size: z.enum(["sm", "md", "lg"]).nullish(),
      }),
      slots: [],
      description: "环形进度（value 0–100）或甜甜圈图（segments: [{label, value, tone}]，按比例，带图例）。CPU、磁盘、预算、占比。center 是圆心大字。",
    },
    Gauge: {
      props: z.object({
        value: z.number(),
        min: z.number().nullish(),
        max: z.number().nullish().describe("默认 100"),
        label: z.string().nullish(),
        unit: z.string().nullish(),
        tone,
        warnAt: z.number().nullish().describe("到这个值变黄"),
        dangerAt: z.number().nullish().describe("到这个值变红"),
      }),
      slots: [],
      description: "半圆仪表：空气质量、负载、速度等有上下限的单个数值。",
    },
    HeatStrip: {
      props: z.object({
        values: numbers.describe("每一格的数值（如每天的提交数 / 每小时是否正常 1/0）"),
        labels: z.array(z.string()).max(400).nullish().describe("每一格的说明（悬停显示），与 values 对应"),
        rows: z.number().int().min(1).max(7).nullish().describe("1 = 一条（默认，如在线率），7 = 日历格（按周排列，如 GitHub 贡献）"),
        tone,
        label: z.string().nullish(),
        caption: z.string().nullish().describe("右侧短说明，如「99.9% 在线」"),
      }),
      slots: [],
      description: "热力条 / 日历点：一串小方格按数值深浅着色。rows 1 = 一条（在线率，1 正常 0 故障），rows 7 = 按周排的日历格（GitHub 贡献）。caption 写右侧短结论。",
    },
    Hero: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().nullish(),
        eyebrow: z.string().nullish().describe("标题上方的小字，如「今日头条」「香港 · 现在」"),
        image: z.string().nullish().describe("真实的 https 封面图；没有就用 tone 渐变"),
        icon,
        tone,
        value: z.union([z.string(), z.number()]).nullish().describe("可选，大号数字（如气温 26℃）"),
        ...itemActions,
      }),
      slots: [],
      description: "封面横幅：封面图（或语义色渐变）+ 渐变遮罩 + 标题 / 副标题 / 可选大数字，可点击打开链接。一张界面最多一个。",
    },
    Avatar: {
      props: z.object({
        name: z.string(),
        src: z.string().nullish().describe("真实的 https 头像 / logo 地址；没有就显示名字首字"),
        subtitle: z.string().nullish(),
        size: z.enum(["sm", "md", "lg"]).nullish(),
        shape: z.enum(["circle", "square"]).nullish().describe("人用 circle，组织 / 项目 logo 用 square"),
        status: tone.describe("右下角状态点颜色（success 在线、warn 忙、danger 离线）"),
        ...itemActions,
      }),
      slots: [],
      description: "头像 / logo + 名字 + 一行副标题（身份行）。src 是真实 https 头像（没有就显示首字），人用 shape circle、组织 / 仓库用 square；status 是右下角状态点的 tone。",
    },
    Link: {
      props: z.object({
        url: z.string().describe("http(s) 链接"),
        title: z.string(),
        description: z.string().nullish(),
        image: z.string().nullish().describe("可选缩略图（https）"),
        meta: z.string().nullish().describe("如「2 小时前」「GitHub」"),
      }),
      slots: [],
      description: "链接卡：网站图标 + 域名 + 标题 + 可选摘要 / 缩略图，点击在新标签页打开（↗）。",
    },
    Icon: {
      props: z.object({ name: z.string().max(40).describe(`图标名：${ICON_NAMES.join(" ")}`), tone, size: z.enum(["sm", "md", "lg"]).nullish(), label: z.string().nullish() }),
      slots: [],
      description: "带语义色底的图标块，可带一个短标签。",
    },
    Status: {
      props: z.object({
        label: z.string(),
        tone: tone.describe("success 正常 / warn 降级 / danger 故障 / default 未知"),
        detail: z.string().nullish().describe("右侧短信息，如「200 · 85ms」"),
        pulse: z.boolean().nullish().describe("圆点呼吸（正常运行中 / 正在进行）"),
        ...itemActions,
      }),
      slots: [],
      description: "状态行：彩色状态圆点（可呼吸）+ 名称 + 右侧细节。服务、设备、订单状态。",
    },
    Delta: {
      props: z.object({
        value: z.union([z.string(), z.number()]).describe("变化量，如 +3.2% 或 -120"),
        trend: z.enum(["up", "down", "flat"]).nullish().describe("不写时按正负号判断"),
        invert: z.boolean().nullish().describe("true = 涨是坏事（如延迟、价格对买家），颜色反过来"),
        label: z.string().nullish().describe("如「24h」「较昨日」"),
      }),
      slots: [],
      description: "涨跌小胶囊：▲ 绿 / ▼ 红（invert 反转）。",
    },
    Tabs: {
      props: z.object({
        tabs: z.array(z.string()).min(1).max(6).describe("每个标签的文字；children 按顺序一个标签一个"),
        variant: z.enum(["tabs", "segmented"]).nullish().describe("segmented = 分段开关（默认），tabs = 下划线标签"),
      }),
      slots: ["default"],
      description: "标签页 / 分段切换：一次显示一个子元素（children 与 tabs 一一对应）。用来在同一块地方切换「今天 / 本周」「价格 / 成交量」。",
    },
    Products: {
      props: z.object({
        items: z
          .array(
            z.object({
              name: z.string().describe("商品 / 地点名，短"),
              price: z.string().nullish().describe("现价，带货币，如「¥1,899」「约 ¥1,500 起」；没查到就不写"),
              note: z.string().nullish().describe("一句卖点 / 理由，≤ 20 字"),
              badge: z.string().nullish().describe("可选角标：首选 / 最划算 / 降噪最强"),
              url: z.string().nullish().describe("商品自己的页面（官网 / 店铺页）http(s)；没有 image 时用这个网页上的图"),
              image: z.string().nullish().describe("商品图 https，只用工具结果里真实出现过的地址；不写就从 url 那个网页取图"),
              source: z.string().nullish().describe("价格来源站点，如「京东」「官网」"),
            }),
          )
          .min(1)
          .max(8),
        columns: z.number().int().min(2).max(4).nullish().describe("列数，默认 3（2 个商品时 2）；窄屏 2 列"),
      }),
      slots: [],
      description: "带图的商品 / 地点卡片网格：每张 = 图 + 名字 + 价格 + 一句卖点 + 角标，整张点开商品页。图由服务器从 image 或商品页转存，不直连第三方。推荐商品、比价、餐厅 / 酒店 / 景点推荐用它。",
    },
    Carousel: {
      props: z.object({ itemWidth: z.enum(["sm", "md", "lg"]).nullish().describe("每一项宽度，默认 md") }),
      slots: ["default"],
      description: "横向滑动列表（可拖动 / 滚动，吸附对齐）：一排 Link / Metric / Hero / Image 卡片。",
    },
    Timeline: {
      props: z.object({
        items: z
          .array(
            z.object({
              title: z.string(),
              time: z.string().nullish().describe("时间文字（10/13 09:00）或 ISO 时间"),
              description: z.string().nullish(),
              tone,
              icon,
              ...itemActions,
            }),
          )
          .max(20),
      }),
      slots: [],
      description: "时间线：竖线 + 节点 + 标题 / 时间 / 说明。行程、发布记录、快递轨迹、事件进展。",
    },
    KeyValue: {
      props: z.object({
        items: z
          .array(
            z.object({
              label: z.string(),
              value: z.union([z.string(), z.number()]),
              tone,
              icon,
              mono: z.boolean().nullish().describe("等宽字体（IP、哈希、版本号）"),
              ...itemActions,
            }),
          )
          .max(24),
        columns: z.number().int().min(1).max(2).nullish().describe("1 或 2 列，默认 1"),
      }),
      slots: [],
      description: "键值清单：左标签、右数值（可着色、可复制、可点链接）。规格、配置、服务器信息。",
    },
    Accordion: {
      props: z.object({
        title: z.string(),
        summary: z.string().nullish().describe("收起时标题右侧的短摘要"),
        open: z.boolean().nullish().describe("默认展开"),
        icon,
      }),
      slots: ["default"],
      description: "可折叠的小节：点标题展开 / 收起 children。放次要细节。",
    },
    Countdown: {
      props: z.object({
        target: z.string().describe("目标时间，ISO 格式带时区，如 2026-10-25T09:00:00+08:00"),
        label: z.string().nullish(),
        doneText: z.string().nullish().describe("到点后显示的文字，默认「已到时间」"),
        showSeconds: z.boolean().nullish().describe("显示秒（默认：不足 1 天时显示）"),
        caption: z.string().nullish(),
      }),
      slots: [],
      description: "倒计时：在浏览器里每秒走动（天 时 分 秒），不需要刷新。",
    },
    Clock: {
      props: z.object({
        timezone: z.string().nullish().describe("IANA 时区，如 Asia/Shanghai、America/New_York；默认用户本地"),
        label: z.string().nullish().describe("如「纽约」"),
        showSeconds: z.boolean().nullish(),
        showDate: z.boolean().nullish(),
      }),
      slots: [],
      description: "会走的时钟（浏览器本地计时）。世界时钟用 Grid 放几个。",
    },
    RelativeTime: {
      props: z.object({
        time: z.string().describe("ISO 时间"),
        prefix: z.string().nullish().describe("前缀，如「更新于」「发布于」"),
      }),
      slots: [],
      description: "会自己更新的相对时间（「3 分钟前」「2 小时后」），一行淡色小字。",
    },
  },
  actions: {
    send_message: {
      params: z.object({
        text: z.string().describe("要以用户身份发送的消息"),
        includeState: z
          .string()
          .nullish()
          .describe("可选，一个 state 路径（如 /form）；该路径下的值会以 JSON 附在消息后面，用于提交表单"),
      }),
      description:
        "以用户身份在当前对话里发送一条消息给你（用户能看到这条消息），用于“确认 / 选这个 / 提交表单”等按钮。之后的任何实际操作仍要走你的工具和正常的审批。",
    },
    open_link: {
      params: z.object({ url: z.string().describe("http(s) 链接") }),
      description: "在新标签页打开一个 http(s) 链接。",
    },
    copy_text: {
      params: z.object({ text: z.string().describe("要复制的文字") }),
      description: "把一段文字复制到用户的剪贴板（按钮上会短暂显示「已复制」）。",
    },
    refresh_panel: {
      params: z.object({}),
      description: "只在右栏面板里有效：让这张面板立刻重新取数据。对话里的界面不要用。",
    },
  },
});

export type JsonRenderComponentName = keyof typeof jsonRenderCatalog.data.components;

/** 提示词里不适合机器人代用户回答的条目：json-render 默认要求「编造示例数据」，这里必须用真实数据。 */
const DROPPED_PROMPT_LINE = /sample data|realistic|Never leave data empty|Never leave arrays empty/i;

const CUSTOM_RULES = [
  "界面里的所有文字一律使用简体中文。",
  "type 只能是上面 AVAILABLE COMPONENTS 列出的组件名；不要使用其他工具里的组件名（例如 Record、Kanban、Markdown）。",
  "只展示你真实拥有的信息（来自对话、工具结果或你确定的知识），绝不编造数据、链接或图片；没有数据就不要画这一块。图片 / 头像 / 缩略图只用工具结果里真实出现过的 https 地址。",
  "最外层通常是一个 Card（可带 icon）；多个 Metric 放进 Grid；按钮组放进 horizontal Stack。保持简洁，一般不超过 30 个元素。",
  "选对组件，让界面一眼能看懂：有一串按时间的数 → Chart（大）或 Metric 的 spark / Sparkline（小）；占比 → Ring；有上下限的单值 → Gauge；每天 / 每小时的记录 → HeatStrip；有网址的条目 → List 每行带 href（有配图就带 image）或 Link；一个主角 → Hero；目标时间 → Countdown（会自己走）；时区 → Clock；状态 → Status / Badge dot；涨跌 → Delta 或 Metric 的 delta + trend；规格参数 → KeyValue；事件经过 → Timeline；同一处要切换的两三组内容 → Tabs；一排卡片 → Carousel；次要细节 → Accordion。",
  "推荐 / 比较商品（耳机、手机、家电…）或地点（餐厅、酒店、景点）时用 Products：先搜索查到现价和每个商品自己的页面（官网 / 店铺页），每项写 name、price、note、url（有真实商品图地址就写 image）；不要用纯文字 List。price 写搜索 / 网页里看到的价格（官网价、京东价都行，可写「约 ¥1,899」「¥2,299 起」），整轮都没看到价格才不写，不要编。",
  "能点就让它能点：新闻、仓库、文章、商品这类有网址的行 / 卡片都写 href（新标签页打开，自动显示 ↗）；想让用户追问的写 ask；IP、命令、地址写 copy。",
  "要用户从 2–5 个互斥方案里选一个（用哪种格式、先做哪一步、选哪个方案）时，画一个 Card：一句问题 + horizontal Stack 里每个方案一个 Button（label 写方案，ask 写选中后替用户说的话，choice: true）；不要在文字里写「回复 1/2/3」。选项只是替用户回答，付款、对外发消息、删除这类事选完仍要照常确认。",
  "颜色有含义才用：tone 只能写 default / accent（品牌蓝）/ info / success（好、涨）/ warn / danger（坏、跌），只给涨跌、好坏、预警、品牌重点；一张界面里有颜色的地方不超过 3–4 处。",
  `icon 只能写这些名字（Tabler 图标）：${ICON_NAMES.join(" ")}。`,
  "每一项都能带动作：组件或 List / Timeline / KeyValue 的每一行可写 href（http(s) 链接，新标签页打开）、ask（替用户发一句话）、copy（复制的文字）。时间字段（List.items[].time、Timeline.items[].time、RelativeTime.time、Countdown.target）写 ISO 带时区，如 2026-10-13T09:00:00+08:00。",
  "数列（Chart.data / series[].data、Sparkline.data、Metric.spark、HeatStrip.values）写数字数组，按时间先后；Chart.labels 与数据一一对应，写短（10/13、09:00）。",
  "只是要用户点开一到三个网页（下载页、入口、文档）时不要用 render_ui：在回复里把链接单独放一行（或一行 `[标签](网址)`），聊天界面会自动画成链接卡。",
  "按钮只用 send_message、open_link、copy_text、refresh_panel 或内置的 setState / pushState / removeState / validateForm；不要使用 confirm 字段。",
  "用户要的是「面板」（放在右侧面板栏、长期保留的小工具）时不要用 render_ui：有 proposePanelDraft 工具就用它保存；没有就请用户点右栏面板的「新建」后再说一遍。",
  "send_message 只是替用户发一条消息给你，真正的操作（发送邮件、付款、删除等）仍由你在下一轮用工具完成，并照常经过审批。",
  "表单：输入组件用 $bindState 绑定到 /form/... 并在 /state 里给出初始值；提交按钮用 send_message 并设置 includeState 为 \"/form\"。",
] as const;

/**
 * 机器人看到的 `render_ui` 说明：json-render 的目录提示词（SpecStream / JSONL 格式），外加本部署的规则。
 * 格式不改：JSONL 正是 json-render 的流式协议，所以浏览器能边生成边画。
 */
export function renderUiPrompt(): string {
  const generated = jsonRenderCatalog
    .prompt({
      system:
        `你可以调用 ${RENDER_UI_TOOL} 工具，在对话里画出一个可交互的界面（卡片、统计、表格、列表、表单、按钮等）。` +
        "当结构化展示比纯文字更清楚时使用它（对比、汇总、数据、选项、表单）；简单回答直接用文字。" +
        "把下面格式的 JSONL 写进 spec 参数（一个字符串，每行一个 JSON Patch），不要在聊天正文里输出 JSONL 或代码块。" +
        "调用之后用一两句话补充说明即可，不要用文字重复界面里的内容。",
      customRules: [...CUSTOM_RULES],
    })
    .split("\n")
    .filter((line) => !DROPPED_PROMPT_LINE.test(line))
    .join("\n");
  return generated;
}

const DYNAMIC_KEYS = new Set([
  "$state",
  "$bindState",
  "$bindItem",
  "$item",
  "$index",
  "$cond",
  "$template",
  "$computed",
]);

/** `{ "$state": "/x" }` 之类的动态表达式在渲染时才解析，不能按静态类型校验。 */
function isDynamic(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => DYNAMIC_KEYS.has(key))
  );
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? (fenced[1] ?? "") : trimmed;
}

/**
 * 把工具参数变成 Spec。接受两种写法：JSONL（json-render SpecStream，推荐，可流式）或一个完整的
 * `{ root, elements, state? }` JSON 对象（有些模型会这样给）。
 *
 * `partial` 为 true 时用于流式渲染：只编译已经完整的行，最后一行可能还没写完。
 */
export function parseRenderUiSpec(input: unknown, partial = false): Spec | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Spec;
  }
  if (typeof input !== "string") return null;
  const text = stripFence(input);
  if (!text) return null;
  if (text.startsWith("{") && !partial) {
    try {
      const whole = JSON.parse(text) as Record<string, unknown>;
      if (whole && typeof whole === "object" && "root" in whole && "elements" in whole) {
        return whole as unknown as Spec;
      }
    } catch {
      // 不是单个 JSON 对象，按 JSONL 处理。
    }
  }
  const lines = text.split("\n");
  // 流式时最后一行可能没写完；结束后的最后一行也可能没有换行符，但它是完整的。
  const complete = partial && !text.endsWith("\n") ? lines.slice(0, -1) : lines;
  const usable = complete.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return false;
    if (!partial) return true;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  });
  if (usable.length === 0) return null;
  try {
    const spec = compileSpecStream<Record<string, unknown>>(usable.join("\n"));
    return spec && typeof spec === "object" ? (spec as unknown as Spec) : null;
  } catch {
    return null;
  }
}

const BUILT_IN_ACTIONS = new Set(["setState", "pushState", "removeState", "validateForm"]);

/** 只认 https 的图片类属性（封面、头像、缩略图）；不是 https 的地址在宽容处理时直接去掉这一项。 */
const IMAGE_PROPS: Record<string, string[]> = { Hero: ["image"], Avatar: ["src"], Link: ["image"] };
const isHttps = (value: unknown) => typeof value === "string" && /^https:\/\//i.test(value.trim());

/** `on` 里的动作：名字必须存在；本部署的动作（send_message / open_link）按目录校验参数。 */
function actionIssues(key: string, on: unknown): string[] {
  if (on === undefined || on === null) return [];
  if (typeof on !== "object" || Array.isArray(on)) return [`elements.${key}.on 必须是 { 事件名: 动作 } 对象。`];
  const actions = jsonRenderCatalog.data.actions as Record<string, { params: z.ZodObject<z.ZodRawShape> }>;
  const found: string[] = [];
  for (const [event, value] of Object.entries(on as Record<string, unknown>)) {
    for (const binding of Array.isArray(value) ? value : [value]) {
      const { action, params } = (binding ?? {}) as { action?: unknown; params?: unknown };
      if (typeof action !== "string") {
        found.push(`elements.${key}.on.${event} 缺少 action。`);
        continue;
      }
      if (BUILT_IN_ACTIONS.has(action)) continue;
      const definition = actions[action];
      if (!definition) {
        found.push(
          `elements.${key}.on.${event}: 未知动作 "${action}"，只能用 ${[...Object.keys(actions), ...BUILT_IN_ACTIONS].join(" / ")}。`,
        );
        continue;
      }
      const given = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
      for (const [name, field] of Object.entries(definition.params.shape)) {
        if (isDynamic(given[name])) continue;
        if (!(field as z.ZodType).safeParse(given[name]).success) {
          found.push(`elements.${key}.on.${event}: 动作 ${action} 的参数 params.${name} 缺失或无效。`);
        }
      }
    }
  }
  return found;
}

export type RenderUiValidation =
  | { ok: true; spec: Spec; elementCount: number; warnings?: string[] }
  | { ok: false; issues: string[] };

const MAX_ELEMENTS = 200;

/** 结构（root / children / visible / repeat）+ 目录（组件名）+ 各组件的静态属性。 */
export function validateRenderUiSpec(spec: Spec | null): RenderUiValidation {
  if (!spec || typeof spec !== "object") {
    return { ok: false, issues: ["spec 为空或无法解析。请按 JSONL（每行一个 JSON Patch）格式给出。"] };
  }
  const issues: string[] = [];
  if (typeof spec.root !== "string" || !spec.root) issues.push("缺少 /root。");
  const elements = (spec.elements ?? {}) as Record<string, unknown>;
  const count = Object.keys(elements).length;
  if (count === 0) issues.push("没有任何元素（/elements 为空）。");
  if (count > MAX_ELEMENTS) issues.push(`元素太多（${count} 个，最多 ${MAX_ELEMENTS} 个）。`);
  if (spec.root && !(spec.root in elements)) issues.push(`root 指向的元素 "${spec.root}" 不存在。`);

  const catalogResult = jsonRenderCatalog.validate(spec);
  if (!catalogResult.success) {
    for (const issue of catalogResult.error?.issues ?? []) {
      // 组件名错误在下面逐个元素报告，带上可用组件列表，这里不重复。
      if (issue.path.at(-1) === "type") continue;
      issues.push(`${issue.path.join(".")}: ${issue.message}`);
    }
  }

  const structural = validateSpec(spec);
  if (!structural.valid) {
    for (const line of formatSpecIssues(structural.issues.filter((i) => i.severity === "error"))
      .split("\n")
      .slice(1)) {
      if (line.trim()) issues.push(line.replace(/^-\s*/, ""));
    }
  }

  const components = jsonRenderCatalog.data.components as Record<
    string,
    { props: z.ZodObject<z.ZodRawShape> }
  >;
  for (const [key, raw] of Object.entries(elements)) {
    const element = raw as { type?: unknown; props?: unknown };
    const definition = typeof element?.type === "string" ? components[element.type] : undefined;
    if (!definition) {
      issues.push(
        `elements.${key}: 未知组件 "${String(element?.type)}"，只能用 ${jsonRenderCatalog.componentNames.join(" / ")}。`,
      );
      continue;
    }
    const props = (element.props ?? {}) as Record<string, unknown>;
    if (typeof props !== "object" || Array.isArray(props)) {
      issues.push(`elements.${key}.props 必须是对象。`);
      continue;
    }
    const shape = definition.props.shape;
    for (const [name, field] of Object.entries(shape)) {
      const value = props[name];
      if (isDynamic(value)) continue;
      const result = (field as z.ZodType).safeParse(value);
      if (!result.success) {
        const first = result.error.issues[0];
        issues.push(
          `elements.${key}（${String(element.type)}）.props.${name}${first?.path.length ? `.${first.path.join(".")}` : ""}: ${first?.message ?? "无效"}`,
        );
      }
    }
    issues.push(...actionIssues(key, (element as { on?: unknown }).on));
    if (element.type === "Image" && typeof props.src === "string" && !/^https:\/\//i.test(props.src)) {
      issues.push(`elements.${key}.props.src 必须是 https:// 开头的地址。`);
    }
  }

  if (issues.length > 0) return { ok: false, issues: [...new Set(issues)].slice(0, 20) };
  return { ok: true, spec, elementCount: count };
}

/**
 * 宽容处理：把「一个坏节点」限制在那个节点里，而不是整张界面都被拒绝。
 *
 * 线上数据里 render_ui 失败的调用几乎都是这几种（2026-10-11/12，FRA 库里 9 次调用 4 次被拒）：
 *   - send_message 的参数写成 `message` / `content`（目录里叫 `text`）——每个模型都这么写；
 *   - 用了目录里没有的组件（例如 Record）；
 *   - children 引用了不存在的元素（多半是那一行 JSONL 写坏了，被跳过）。
 * 以前任意一条都会让整个界面「无效，没有显示」，模型要再调一次，用户看到的是一行失败或者红色错误卡。
 *
 * 现在：参数别名改成 `text`；未知组件、属性不合法的元素、悬空的 children 引用直接跳过并记成警告；
 * 只有根元素本身不可用时才算失败。服务器和浏览器都先过这一步，所以两边画的是同一份。
 */
export type RenderUiSanitized = { spec: Spec; skipped: string[] };

const ACTION_TEXT_ALIASES = ["message", "content", "prompt", "query"] as const;

function normaliseBinding(binding: unknown): unknown {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return binding;
  const value = binding as { action?: unknown; params?: unknown };
  if (value.action !== "send_message") return binding;
  const params = (value.params && typeof value.params === "object" ? { ...(value.params as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (typeof params.text !== "string" || !params.text.trim()) {
    const alias = ACTION_TEXT_ALIASES.map((key) => params[key]).find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
    );
    if (alias) params.text = alias;
  }
  return { ...value, params };
}

function normaliseOn(on: unknown): unknown {
  if (!on || typeof on !== "object" || Array.isArray(on)) return on;
  return Object.fromEntries(
    Object.entries(on as Record<string, unknown>).map(([event, value]) => [
      event,
      Array.isArray(value) ? value.map(normaliseBinding) : normaliseBinding(value),
    ]),
  );
}

export function sanitizeRenderUiSpec(spec: Spec | null): RenderUiSanitized | null {
  if (!spec || typeof spec !== "object") return null;
  const components = jsonRenderCatalog.data.components as Record<string, { props: z.ZodObject<z.ZodRawShape> }>;
  const input = (spec.elements ?? {}) as Record<string, unknown>;
  const skipped: string[] = [];
  const kept: Record<string, Record<string, unknown>> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      skipped.push(`${key}（不是对象）`);
      continue;
    }
    const element = { ...(raw as Record<string, unknown>) };
    const type = element.type;
    const definition = typeof type === "string" ? components[type] : undefined;
    if (!definition) {
      skipped.push(`${key}（未知组件 ${String(type)}）`);
      continue;
    }
    const props = element.props && typeof element.props === "object" && !Array.isArray(element.props)
      ? { ...(element.props as Record<string, unknown>) }
      : {};
    const bad = Object.entries(definition.props.shape).find(([name, field]) => {
      const value = props[name];
      return !isDynamic(value) && !(field as z.ZodType).safeParse(value).success;
    });
    if (bad) {
      skipped.push(`${key}（${String(type)} 的 ${bad[0]} 无效）`);
      continue;
    }
    if (type === "Image" && typeof props.src === "string" && !/^https:\/\//i.test(props.src)) {
      skipped.push(`${key}（图片地址不是 https）`);
      continue;
    }
    for (const name of IMAGE_PROPS[type as string] ?? []) {
      if (props[name] !== undefined && props[name] !== null && !isDynamic(props[name]) && !isHttps(props[name])) {
        props[name] = null;
        skipped.push(`${key}.${name}（图片地址不是 https，已去掉）`);
      }
    }
    if (type === "Products" && Array.isArray(props.items)) {
      props.items = (props.items as Record<string, unknown>[]).map((item) =>
        item && typeof item === "object" && item.image && !isHttps(item.image) ? { ...item, image: null } : item,
      );
    }
    if (type === "List" && Array.isArray(props.items)) {
      props.items = (props.items as Record<string, unknown>[]).map((item) =>
        item && typeof item === "object" && item.image && !isHttps(item.image) ? { ...item, image: null } : item,
      );
    }
    element.props = props;
    if (element.on !== undefined) element.on = normaliseOn(element.on);
    kept[key] = element;
  }
  for (const [key, element] of Object.entries(kept)) {
    const children = Array.isArray(element.children) ? element.children : [];
    const present = children.filter((child): child is string => typeof child === "string" && child in kept);
    if (present.length !== children.length) {
      for (const child of children) {
        if (typeof child !== "string" || !(child in kept)) {
          if (!(typeof child === "string" && child in input)) skipped.push(`${key} → ${String(child)}（不存在）`);
        }
      }
    }
    element.children = present;
  }
  return { spec: { ...spec, elements: kept } as unknown as Spec, skipped: [...new Set(skipped)] };
}

/**
 * 一次完整的检查：先找出写坏的 JSONL 行（compileSpecStream 会静默跳过它们，结果就是「引用了不存在的
 * 子元素」这种让模型摸不着头脑的报错），再做结构 / 目录 / 属性校验。服务器的 `render_ui` 与浏览器
 * 都用它，所以两边对同一个调用的结论一致。
 */
export function inspectRenderUiSpec(input: unknown): RenderUiValidation {
  const lineIssues: string[] = [];
  if (typeof input === "string") {
    const text = stripFence(input);
    const looksWhole = text.startsWith("{") && (() => {
      try {
        const whole = JSON.parse(text) as Record<string, unknown>;
        return Boolean(whole && "root" in whole && "elements" in whole);
      } catch {
        return false;
      }
    })();
    if (!looksWhole) {
      text.split("\n").forEach((raw, index) => {
        const line = raw.trim();
        if (!line) return;
        try {
          const patch = JSON.parse(line) as { op?: unknown; path?: unknown };
          if (typeof patch?.op !== "string" || typeof patch?.path !== "string")
            lineIssues.push(`第 ${index + 1} 行不是 JSON Patch（缺少 op 或 path）。`);
        } catch {
          lineIssues.push(`第 ${index + 1} 行不是合法 JSON（括号或引号不匹配）：${line.slice(0, 80)}`);
        }
      });
    }
  }
  const sanitized = sanitizeRenderUiSpec(parseRenderUiSpec(input));
  const result = validateRenderUiSpec(sanitized?.spec ?? null);
  /*
   * 写坏的行只是被跳过的那几个元素；只要剩下的界面能画，就画，坏行记成警告。
   * 根元素都没了（或者整段没有一行能用）才算失败。
   */
  if (result.ok) {
    const warnings = [...lineIssues, ...(sanitized?.skipped.map((item) => `已跳过 ${item}`) ?? [])].slice(0, 20);
    return warnings.length ? { ...result, warnings } : result;
  }
  return {
    ok: false,
    issues: [...lineIssues, ...result.issues].slice(0, 20),
  };
}

/** 工具结果的固定开头，浏览器据此区分「已显示」与「被拒绝」。 */
export const RENDER_UI_SHOWN = "UI shown.";
