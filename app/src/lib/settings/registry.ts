import {
  IconAdjustmentsHorizontal,
  IconAlarm,
  IconBookmark,
  IconBrain,
  IconCloudDownload,
  IconDeviceDesktop,
  IconListDetails,
  IconLock,
  IconMessageChatbot,
  IconPhoto,
  IconPlug,
  IconPuzzle,
  IconRoute,
  IconShieldCheck,
  IconShieldLock,
  IconSparkles,
  IconUserPlus,
  IconUsers,
  IconWorld,
  IconWorldWww,
} from "@tabler/icons-react";
import type * as React from "react";

/**
 * 设置的唯一登记表（DESIGN.md §97）：左栏导航和设置搜索都从这里来，加一页 / 一项只改这里。
 *
 * - 组（GROUPS）按常用程度排；组里的页也按常用程度排。
 * - 每一页有标题、一句话说明（左栏第二行）、同义词（中文 / 拼音首字母 / 英文）、以及页里能搜到的「项」。
 * - 项的 `find` 是页面上那一块的标题文字（区块标题、设置行标题、卡片标题），搜索跳过去时按它找到、滚进来、闪一下。
 * - 路由一个没改：旧地址照常能打开，导航只是换了分组和顺序。
 */
export type SettingsGroupId = "general" | "bots" | "devices" | "accounts" | "models" | "system" | "advanced";

export type SettingsGroup = { id: SettingsGroupId; label: string | null };

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: "general", label: null },
  { id: "bots", label: "机器人" },
  { id: "devices", label: "电脑与设备" },
  { id: "accounts", label: "账号与连接" },
  { id: "models", label: "模型" },
  { id: "system", label: "系统" },
  { id: "advanced", label: "高级" },
];

export type SettingsItem = {
  id: string;
  title: string;
  description: string;
  /** 页面上那一块的标题文字；没有就只跳到页面。 */
  find?: string;
  keywords?: readonly string[];
  /** 同分时往前排（同一个词在别处也有、但这一项才是大家要找的）。 */
  weight?: number;
};

export type SettingsPage = {
  id: string;
  group: SettingsGroupId;
  title: string;
  /** 左栏第二行，也是搜索结果里的说明。 */
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
  to: string;
  /** `/settings` 是别的页的前缀，只在自己这一页亮。 */
  exact?: boolean;
  /** 只有管理员看得到。 */
  admin?: boolean;
  /** 默认隐藏，部署的 CHISABOT_EXTRAS 里有这个名字才出现（DESIGN.md §74）。 */
  extra?: string;
  /** 默认隐藏，部署打开多用户界面（CHISABOT_ACCOUNTS_UI=1）才出现。 */
  accountsUi?: boolean;
  keywords: readonly string[];
  items: readonly SettingsItem[];
};

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  // ── 通用 ──────────────────────────────────────────────
  {
    id: "general",
    group: "general",
    title: "通用",
    sub: "外观、常驻指令、快捷键",
    icon: IconAdjustmentsHorizontal,
    to: "/settings",
    exact: true,
    keywords: ["ty", "tongyong", "general", "preferences", "偏好"],
    items: [
      { id: "theme", title: "主题", description: "浅色或深色外观", find: "主题", keywords: ["深色", "浅色", "暗色", "夜间", "黑色", "dark", "light", "theme", "zt", "外观"] },
      { id: "palette", title: "主题配色", description: "晴空蓝、极光紫、翡翠森、樱花粉、深海蓝、暮光金等 8 款主题风格", find: "主题配色", keywords: ["配色", "主题色", "极光", "樱花", "翡翠", "深海", "暮光", "曜石", "palette", "color"] },
      { id: "glass", title: "面板玻璃材质（液态玻璃）", description: "调整左栏、输入框、对话气泡与面板栏的液态玻璃折射通透度", find: "面板玻璃材质", keywords: ["液态玻璃", "毛玻璃", "透明", "高透", "磨砂", "liquid glass", "ytbl"] },
      { id: "wallpaper", title: "背景壁纸", description: "选择内置流光壁纸或上传自定义图片壁纸", find: "背景壁纸", keywords: ["壁纸", "背景图", "自定义壁纸", "上传图片", "wallpaper", "bz", "bjt"] },
      { id: "sky", title: "背景随时间变化", description: "背景按一天里的时间换颜色", find: "背景随时间变化", keywords: ["天空", "背景", "sky", "颜色", "时间", "tk"] },
      { id: "instructions", title: "常驻指令", description: "每次对话都带上的要求", find: "常驻指令", keywords: ["指令", "系统提示", "prompt", "instructions", "要求", "czzl"] },
      { id: "hotkeys", title: "键盘快捷键", description: "全部快捷键一览", find: "键盘快捷键", keywords: ["快捷键", "热键", "hotkey", "shortcut", "keyboard", "kjj"] },
    ],
  },

  // ── 机器人 ────────────────────────────────────────────
  {
    id: "permissions",
    group: "bots",
    title: "权限与审批",
    sub: "每个机器人的权限、哪些事先问你",
    icon: IconShieldCheck,
    to: "/settings/approvals",
    keywords: ["qx", "spyh", "权限", "审批", "审批偏好", "批准", "确认", "approval", "permission", "确认卡片", "先问我", "直接做"],
    items: [
      { id: "bot-permission", title: "机器人权限（请求批准 / 完全访问）", description: "每个机器人能不能不问你就操作电脑", find: "每个机器人的权限", weight: 15, keywords: ["完全访问", "请求批准", "full access", "wqfw", "qqpz", "自动批准", "auto approve", "输入框权限"] },
      { id: "confirm-prefs", title: "哪些事先问我", description: "对外发消息、删除、付款、操作电脑：先问还是直接做", find: "哪些事先问我", keywords: ["发消息", "删除", "付款", "购买", "电脑"] },
      { id: "confirm-rules", title: "自己写的审批规则", description: "用你自己的话写一条，比如「给张三发微信不用问我」", find: "用你自己的话写一条规则", keywords: ["规则", "rule", "关键词"] },
      { id: "confirm-recent", title: "最近的确认", description: "机器人最近问过你的事和结果", find: "最近的确认", keywords: ["记录", "历史", "确认卡片"] },
    ],
  },
  {
    id: "memory",
    group: "bots",
    title: "记忆",
    sub: "机器人记住的关于你的事",
    icon: IconBookmark,
    to: "/settings/memory",
    keywords: ["jy", "jiyi", "memory", "记住", "备忘"],
    items: [
      { id: "memory-bots", title: "哪些机器人用记忆", description: "按机器人打开或关闭记忆", find: "哪些机器人用记忆", keywords: ["开关"] },
      { id: "memory-dream", title: "自动整理记忆（Memory Dreaming）", description: "一键合并重复与碎片记忆，提炼长期偏好", find: "我记住的事", keywords: ["整理记忆", "dream", "去重", "合并"] },
      { id: "knowledge-base", title: "个人与公共知识库（文章 / 笔记 / 摘录）", description: "录入个人或全员共享的文档摘录供语义检索", find: "我记住的事", keywords: ["知识库", "公共知识库", "共享知识库", "kb", "knowledge", "录入知识库", "笔记"] },
    ],
  },
  {
    id: "skills",
    group: "bots",
    title: "技能",
    sub: "机器人照着做的方法",
    icon: IconSparkles,
    to: "/settings/skills",
    keywords: ["jn", "jineng", "skill", "skills", "做法", "方法", "共享技能", "全局共享技能"],
    items: [
      { id: "curated-hub", title: "精选个人助理技能库", description: "一键安装每日晨报、收件箱管家、知识库归档等 8 款精选技能（支持全员共享安装）", find: "精选个人助理技能库", keywords: ["精选技能", "精选", "模板", "一键安装", "hub", "全员共享"] },
      { id: "import-skill", title: "导入 SKILL.md 技能", description: "通过 GitHub URL 或粘贴 Markdown 批量导入技能", find: "技能", keywords: ["skill.md", "导入", "github", "markdown"] },
    ],
  },
  {
    id: "schedules",
    group: "bots",
    title: "定时任务",
    sub: "提醒和按时间自动做的事",
    icon: IconAlarm,
    to: "/settings/schedules",
    keywords: ["dsrw", "定时", "提醒", "闹钟", "计划", "schedule", "reminder", "cron", "routine"],
    items: [],
  },
  {
    id: "pages",
    group: "bots",
    title: "页面",
    sub: "机器人做的网页，链接可分享",
    icon: IconWorldWww,
    to: "/settings/pages",
    keywords: ["ym", "网页", "page", "pages", "分享", "链接", "发布"],
    items: [],
  },

  // ── 电脑与设备 ────────────────────────────────────────
  {
    id: "devices",
    group: "devices",
    title: "设备",
    sub: "电脑、手机、服务器：能力、文件夹、审批",
    icon: IconDeviceDesktop,
    to: "/settings/devices",
    keywords: ["sb", "shebei", "device", "电脑", "手机", "pc", "android", "安卓", "服务器", "配对", "添加电脑", "紧急停止", "允许的文件夹"],
    items: [
      { id: "add-pc", title: "添加一台电脑", description: "装 ChisaBot PC 客户端并配对", find: "添加一台电脑", keywords: ["配对", "pair", "pc 客户端", "下载"] },
      { id: "add-phone", title: "添加一台手机", description: "安卓客户端扫码配对", find: "添加一台手机", keywords: ["安卓", "android", "扫码"] },
      { id: "add-server", title: "添加一台服务器", description: "服务器节点安装命令", find: "添加一台服务器", keywords: ["节点", "node", "linux"] },
      { id: "device-full-access", title: "设备的完全访问", description: "在某台设备上临时放开所有能力（设备详情 → 权限）", keywords: ["完全访问", "管理员身份", "elevated"] },
    ],
  },
  {
    id: "computers",
    group: "devices",
    title: "云端浏览器",
    sub: "机器人的浏览器与登录状态",
    icon: IconWorld,
    to: "/admin/computers",
    admin: true,
    keywords: ["llq", "浏览器", "browser", "computer", "云端电脑", "登录状态", "cookie"],
    items: [],
  },

  // ── 账号与连接 ────────────────────────────────────────
  {
    id: "connected-accounts",
    group: "accounts",
    title: "账号连接",
    sub: "GitHub、邮箱日历、已连接的应用、保存的登录",
    icon: IconPlug,
    to: "/settings/connected-accounts",
    keywords: ["zhlj", "连接", "连接器", "github", "gmail", "google", "notion", "日历", "邮箱", "应用", "授权", "保存的登录", "密码", "oauth", "connector", "integrations", "晨报", "随手推", "webhook", "bark"],
    items: [
      { id: "personal-calendar", title: "个人日历（ICS / WebCal 只读）", description: "接入 Apple iCloud、Google、Outlook、飞书日历订阅", find: "个人助理数据源与晨报", keywords: ["日历", "ics", "webcal", "日程", "calendar"] },
      { id: "personal-email", title: "个人邮箱（IMAP 收件 + SMTP 发件）", description: "连接 QQ、163、Gmail、Outlook 收件箱并支持审批代发", find: "个人助理数据源与晨报", keywords: ["邮箱", "邮件", "imap", "smtp", "收件箱"] },
      { id: "notify-webhook", title: "随手推通知与入站事件 Webhook", description: "配置 Bark / 钉钉 / 飞书 / Server酱推送与外部事件触发器", find: "个人助理数据源与晨报", keywords: ["随手推", "bark", "server酱", "ntfy", "webhook", "推送", "巡检"] },
      { id: "morning-brief", title: "每日晨报卡片与天气城市", description: "一键预览今日晨报卡片或主动巡检今日动态", find: "个人助理数据源与晨报", keywords: ["晨报", "天气", "morning brief", "巡检动态"] },
      { id: "saved-logins", title: "网站登录信息", description: "管理保存的网站账号与登录凭据", find: "保存的网站登录", keywords: ["登录信息", "网站登录", "saved logins", "账号密码"] },
    ],
  },
  {
    id: "plugins",
    group: "accounts",
    title: "插件与 MCP",
    sub: "接入外部服务、官方连接器与 MCP 服务器",
    icon: IconPuzzle,
    to: "/admin/plugins",
    admin: true,
    keywords: ["cj", "ljq", "mcp", "plugin", "plugins", "connector", "插件", "连接器", "composio", "notion", "drive", "parallel", "stdio"],
    items: [
      { id: "custom-mcp", title: "添加自定义 HTTP MCP 服务器", description: "接入任意遵循 Streamable HTTP 协议的远程 MCP 服务器（支持全员默认开启）", find: "已连接", keywords: ["自定义 mcp", "custom mcp", "http mcp", "全员默认开启"] },
      { id: "local-stdio-mcp", title: "本地电脑 stdio MCP 桥接", description: "免公网端口，直接通过已配对电脑调用 npx / uvx 本地 MCP 工具", find: "本地电脑 stdio MCP 桥接", keywords: ["stdio", "npx", "uvx", "本地 mcp", "device_mcp_call"] },
    ],
  },
  {
    id: "vault",
    group: "accounts",
    title: "密钥",
    sub: "API 密钥和令牌，机器人用但看不到",
    icon: IconLock,
    to: "/settings/vault",
    keywords: ["my", "miyao", "保险箱", "api key", "token", "令牌", "secret", "vault", "密码"],
    items: [],
  },
  {
    id: "im",
    group: "accounts",
    title: "IM 接入",
    sub: "QQ、微信、飞书等接到机器人",
    icon: IconMessageChatbot,
    to: "/settings/im",
    keywords: ["im", "qq", "微信", "wechat", "飞书", "lark", "onebot", "telegram", "聊天软件"],
    items: [{ id: "im-connections", title: "我的 IM 连接", description: "已接入的 QQ / 微信 / 飞书", find: "我的连接" }],
  },
  {
    id: "accounts",
    group: "accounts",
    title: "账号",
    sub: "新建账号、邀请成员、角色权限与密码管理",
    icon: IconUsers,
    to: "/admin/accounts",
    admin: true,
    accountsUi: true,
    keywords: ["zh", "多用户", "朋友", "邀请", "用户", "管理员", "新建账号", "accounts", "users", "invite", "admin"],
    items: [
      { id: "create-account", title: "新建账号与设置管理员", description: "直接新建成员或管理员账号、生成邀请链接、修改角色与密码", find: "账号", keywords: ["新建账号", "管理员", "角色", "修改密码", "邀请链接"] },
    ],
  },
  {
    id: "share",
    group: "accounts",
    title: "分享给朋友",
    sub: "邀请进实例，或一键 compose 自托管",
    icon: IconUserPlus,
    to: "/settings/share",
    admin: true,
    keywords: ["fx", "分享", "朋友", "邀请", "部署", "compose", "friend", "share", "install"],
    items: [
      { id: "share-invite", title: "邀请进你的实例", description: "多账号邀请链接", find: "路径一" },
      { id: "share-pack", title: "一键 compose 自托管", description: "friend-up.sh 好友可装包", find: "路径二" },
    ],
  },

  // ── 模型 ──────────────────────────────────────────────
  {
    id: "models",
    group: "models",
    title: "模型",
    sub: "接口、默认模型、备用模型、模型密钥",
    icon: IconBrain,
    to: "/admin/models",
    admin: true,
    keywords: ["mx", "moxing", "model", "llm", "magpie", "默认模型", "接口", "api", "openai", "anthropic", "provider", "提供方"],
    items: [
      { id: "chat-model", title: "聊天模型", description: "接口地址、协议、部署默认模型", find: "聊天模型", keywords: ["默认模型", "接口地址", "base url"] },
      { id: "fallback-models", title: "备用模型", description: "默认模型连不上时依次换用", find: "备用模型", keywords: ["fallback", "回退", "限流", "bymx"] },
      { id: "image-model", title: "生图模型（部署）", description: "整个部署默认用的画图模型", find: "生图模型", keywords: ["画图", "图片生成", "image"] },
      { id: "vision-model", title: "识图模型（部署）", description: "整个部署默认用的看图模型", find: "识图模型", keywords: ["看图", "vision", "图片理解"] },
    ],
  },
  {
    id: "media",
    group: "models",
    title: "我的生图与识图",
    sub: "自己的画图、看图模型（可选）",
    icon: IconPhoto,
    to: "/settings/media",
    keywords: ["stst", "生图", "识图", "画图", "看图", "image", "vision", "图片"],
    items: [
      { id: "my-image-model", title: "我的生图模型", description: "用自己的画图模型和密钥", find: "生图模型" },
      { id: "my-vision-model", title: "我的识图模型", description: "用自己的看图模型和密钥", find: "识图模型" },
    ],
  },

  // ── 系统 ──────────────────────────────────────────────
  {
    id: "system-update",
    group: "system",
    title: "系统更新",
    sub: "版本、升级、回滚与自检",
    icon: IconCloudDownload,
    to: "/admin/system-update",
    admin: true,
    keywords: ["xtgx", "更新", "升级", "版本", "update", "upgrade", "version", "关于", "about"],
    items: [
      { id: "runtime-kernel", title: "执行内核", description: "Hermes 是否接入、桥接是否在线", find: "执行内核", keywords: ["hermes", "内核", "kernel", "执行循环", "运行循环"] },
      { id: "rollback", title: "回滚到上一版", description: "更新出问题时退回上一个版本", find: "回滚", keywords: ["rollback", "退回", "hg"] },
      { id: "selftest", title: "自检", description: "模型往返自检", find: "自检", keywords: ["smoke", "测试", "健康检查"] },
      { id: "debug-tools", title: "调试：显示工具调用", description: "聊天里显示每一步工具调用", find: "调试", keywords: ["debug", "工具调用"] },
    ],
  },
  {
    id: "audit",
    group: "system",
    title: "活动记录",
    sub: "所有操作记录",
    icon: IconListDetails,
    to: "/admin/audit",
    admin: true,
    keywords: ["hdjl", "审计", "日志", "audit", "log", "记录", "操作记录"],
    items: [],
  },
  {
    id: "boundaries",
    group: "system",
    title: "权限规则",
    sub: "机器人永远不能做的事",
    icon: IconShieldLock,
    to: "/admin/boundaries",
    admin: true,
    extra: "boundaries",
    keywords: ["qxgz", "禁止", "cel", "boundaries", "policy"],
    items: [],
  },

  // ── 高级（默认隐藏）──────────────────────────────────
  {
    id: "workflows",
    group: "advanced",
    title: "工作流",
    sub: "多步骤的固定流程",
    icon: IconRoute,
    to: "/workflows",
    admin: true,
    extra: "workflows",
    keywords: ["gzl", "workflow", "流程"],
    items: [],
  },
];

export type SettingsViewer = { admin: boolean; extras: readonly string[]; accountsUi: boolean };

/** 这个人能看到的页（管理员 / 部署开关过滤后），按登记顺序。 */
export function visiblePages(viewer: SettingsViewer): SettingsPage[] {
  return SETTINGS_PAGES.filter(
    (page) =>
      (!page.admin || viewer.admin) &&
      (!page.extra || viewer.extras.includes(page.extra)) &&
      (!page.accountsUi || viewer.accountsUi),
  );
}

/** 左栏用：按组分好、去掉空组。 */
export function visibleGroups(viewer: SettingsViewer): { group: SettingsGroup; pages: SettingsPage[] }[] {
  const pages = visiblePages(viewer);
  return SETTINGS_GROUPS.map((group) => ({ group, pages: pages.filter((page) => page.group === group.id) })).filter((entry) => entry.pages.length > 0);
}

export function groupLabel(id: SettingsGroupId): string | null {
  return SETTINGS_GROUPS.find((group) => group.id === id)?.label ?? null;
}

export function findEntry(id: string): { page: SettingsPage; item?: SettingsItem } | null {
  for (const page of SETTINGS_PAGES) {
    if (page.id === id) return { page };
    const item = page.items.find((candidate) => `${page.id}.${candidate.id}` === id);
    if (item) return { page, item };
  }
  return null;
}
