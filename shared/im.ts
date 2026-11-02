/**
 * IM 接入（DESIGN.md §49，docs/im.md）：把机器人接到 QQ、微信、飞书、企业微信、钉钉、Telegram。
 *
 * 平台清单、每个平台要填的字段、风险提示，服务器和网页共用这一份。字段 `secret: true` 的值加密存库、
 * 接口只回「已保存」，不回原文。
 *
 * 平台的选法和协议细节参考了这些开源项目（只借鉴设计和公开协议，没有拷贝 GPL / AGPL 代码）：
 * - LangBot（Apache-2.0，github.com/langbot-app/LangBot）：平台清单、每个平台的配置项、飞书长连接、
 *   QQ 官方机器人 WebSocket、企业微信智能机器人长连接、个人微信（微信官方 ClawBot / iLink 协议）的消息格式。
 * - 飞书官方 Node SDK（MIT，github.com/larksuite/node-sdk）：长连接的 pbbp2 帧格式和握手流程。
 * - OneBot 11 标准（github.com/botuniverse/onebot-11）、NapCat / LLOneBot 的正向 / 反向 WebSocket。
 * - AstrBot（AGPL-3.0）、cc-connect：只参考了产品形态（一个连接对一个机器人、群里 @ 才回、/new 换话题），
 *   没有用它们的代码。
 */

export type ImPlatform =
  | "feishu"
  | "qq_official"
  | "onebot"
  | "wecom_bot"
  | "weixin"
  | "dingtalk"
  | "telegram";

export type ImFieldType = "text" | "secret" | "select" | "url";

export type ImField = {
  key: string;
  label: string;
  type: ImFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string;
  /** 只在某个字段等于某个值时显示（例如 OneBot 的「连接方式」）。 */
  showIf?: { key: string; equals: string };
};

export type ImPlatformInfo = {
  id: ImPlatform;
  name: string;
  /** 一句话：这是什么、需不需要公网地址。 */
  summary: string;
  /** 「官方」= 平台官方开放接口；「非官方」= 第三方协议端（有封号风险）。 */
  official: boolean;
  /** 支持直接扫码授权绑定（自动创建/绑定机器人并填入凭据）。 */
  qrAuth?: boolean;
  /** 扫码绑定说明文案。 */
  qrHint?: string;
  /** 显示在表单顶部的风险提示（非官方协议才有）。 */
  risk?: string;
  /** 获取凭据的步骤，按顺序。 */
  steps: string[];
  fields: ImField[];
  /** 群聊里怎么触发。 */
  groupNote: string;
  /** 文档锚点（docs/im.md）。 */
  docAnchor: string;
};

export const IM_PLATFORMS: ImPlatformInfo[] = [
  {
    id: "feishu",
    name: "飞书 / Lark",
    summary: "飞书开放平台的机器人，长连接收消息，支持手机飞书直接扫码一键创建并绑定，不需要公网回调地址。",
    official: true,
    qrAuth: true,
    qrHint: "使用手机飞书 / Lark 扫码，一键注册个人助手应用并自动拉取 App ID 与 App Secret。",
    steps: [
      "推荐：直接点下方「扫码绑定」，用手机飞书扫码确认即可自动创建并填入 App ID 与 App Secret。",
      "若需手动配置自建应用：打开 open.feishu.cn（国际版 open.larksuite.com）→ 开发者后台 → 创建企业自建应用，添加「机器人」能力。",
      "「权限管理」开通：im:message、im:message.group_at_msg:readonly、im:message.p2p_msg:readonly。",
      "「事件与回调」→ 订阅方式选「使用长连接接收事件」→ 添加事件「接收消息 im.message.receive_v1」，发布版本。",
    ],
    fields: [
      { key: "appId", label: "App ID", type: "text", required: true, placeholder: "cli_xxxxxxxxxxxx" },
      { key: "appSecret", label: "App Secret", type: "secret", required: true },
      {
        key: "domain",
        label: "版本",
        type: "select",
        default: "feishu",
        options: [
          { value: "feishu", label: "飞书（中国）" },
          { value: "lark", label: "Lark（国际）" },
        ],
      },
    ],
    groupNote: "群里 @ 机器人才回复；私聊直接回复。",
    docAnchor: "飞书",
  },
  {
    id: "qq_official",
    name: "QQ 官方机器人",
    summary: "QQ 开放平台的官方机器人，WebSocket 网关收消息，支持手机 QQ 直接扫码绑定，支持 QQ 私聊、QQ 群 @ 和频道 @。",
    official: true,
    qrAuth: true,
    qrHint: "使用手机 QQ 扫码，在官方页面选择或创建 QQ 机器人，自动解密并填入 AppID 与 AppSecret。",
    steps: [
      "推荐：直接点下方「扫码绑定」，用手机 QQ 扫码选择或一键创建机器人，自动填入 AppID 和 AppSecret。",
      "若手动填写：打开 q.qq.com（QQ 开放平台）→「开发设置」复制 AppID 和 AppSecret 填入下方。",
      "在 QQ 里私聊机器人，或把它拉进群 / 频道里 @ 它即可直接和绑定的 Bot 对话。",
    ],
    fields: [
      { key: "appId", label: "AppID", type: "text", required: true, placeholder: "102xxxxxx" },
      { key: "appSecret", label: "AppSecret", type: "secret", required: true },
      {
        key: "scope",
        label: "接收范围",
        type: "select",
        default: "qq",
        options: [
          { value: "qq", label: "QQ 私聊和 QQ 群" },
          { value: "all", label: "QQ 私聊、QQ 群和频道" },
        ],
      },
      {
        key: "sandbox",
        label: "环境",
        type: "select",
        default: "prod",
        options: [
          { value: "prod", label: "正式环境" },
          { value: "sandbox", label: "沙箱环境（频道调试）" },
        ],
      },
    ],
    groupNote: "QQ 群和频道只会收到 @ 机器人的消息；私聊直接回复。被动回复有时限（群 5 分钟、私聊 60 分钟），太久的任务回复可能发不出去。",
    docAnchor: "qq-官方机器人",
  },
  {
    id: "onebot",
    name: "QQ 个人号（OneBot 11）",
    summary: "通过 NapCat、LLOneBot 等 OneBot 11 协议端，把一个 QQ 个人号接成机器人。",
    official: false,
    risk: "这不是 QQ 官方接口：协议端模拟 QQ 客户端登录，腾讯可能限制或封禁这个号。请用小号，不要用常用号；不要在大群里刷屏。",
    steps: [
      "在一台能常开的电脑或服务器上安装 NapCat（github.com/NapNeko/NapCatQQ）或 LLOneBot，用要当机器人的 QQ 号扫码登录。",
      "在协议端的网络配置里二选一：",
      "· 正向 WebSocket（协议端当服务器）：新建「WebSocket 服务端」，监听 0.0.0.0:3001，设置 token；下面填 ws://协议端的地址:3001 和这个 token。协议端在本机 / 内网 / Docker 兄弟容器时，需要管理员给这个连接打开「允许内网地址」开关才连得上（开关只对这个地址生效，云元数据地址照样拦）；没有管理员时改用反向。",
      "· 反向 WebSocket（推荐，ChisaBot 当服务器，适合协议端在家里内网）：先保存这个连接，复制它显示的「反向连接地址」和 token，在协议端新建「WebSocket 客户端」填进去。",
      "消息格式选 array（数组）或 string 都可以。",
    ],
    fields: [
      {
        key: "mode",
        label: "连接方式",
        type: "select",
        default: "forward",
        options: [
          { value: "forward", label: "正向（ChisaBot 连协议端）" },
          { value: "reverse", label: "反向（协议端连 ChisaBot）" },
        ],
      },
      { key: "url", label: "协议端 WebSocket 地址", type: "url", placeholder: "ws://192.168.1.10:3001", help: "公网地址直接填；本机 / 内网地址要管理员先打开「允许内网地址」，否则请用反向连接。", showIf: { key: "mode", equals: "forward" } },
      { key: "accessToken", label: "Access Token", type: "secret", help: "协议端里设置的 token；反向连接时不填会自动生成。" },
    ],
    groupNote: "群里 @ 这个 QQ 号才回复；私聊直接回复。",
    docAnchor: "qq-个人号onebot-11",
  },
  {
    id: "wecom_bot",
    name: "企业微信智能机器人",
    summary: "企业微信官方「智能机器人」API 模式，长连接收消息，支持企业微信直接扫码创建绑定，不需要公网回调地址。",
    official: true,
    qrAuth: true,
    qrHint: "使用企业微信扫码确认，自动创建智能机器人并获取 Bot ID 与 Secret。",
    steps: [
      "推荐：直接点下方「扫码绑定」，用手机企业微信扫码确认即可自动获取 Bot ID 和 Secret。",
      "若手动填写：企业微信管理后台（work.weixin.qq.com）→ 应用管理 → 智能机器人 → 创建机器人 → 选「API 模式」→「长连接」，复制 Bot ID 和 Secret。",
      "在企业微信里找到这个机器人私聊，或把它加进群里 @ 它。",
    ],
    fields: [
      { key: "botId", label: "Bot ID", type: "text", required: true },
      { key: "secret", label: "Secret", type: "secret", required: true },
    ],
    groupNote: "群里只会收到 @ 机器人的消息；私聊直接回复。",
    docAnchor: "企业微信智能机器人",
  },
  {
    id: "weixin",
    name: "个人微信（微信 ClawBot）",
    summary: "微信官方的个人助手插件（iLink 接口），用自己的微信扫码授权，机器人在微信里以「ClawBot」私聊回复。",
    official: true,
    qrAuth: true,
    qrHint: "使用手机微信扫码并在手机上确认，即可绑定微信 ClawBot。",
    risk: "这是微信官方开放给 AI 助手的接口，但仍在灰度：需要较新版本的微信，授权可能过期（过期后重新扫码即可）。目前只支持私聊。",
    steps: [
      "手机微信更新到最新版本。",
      "点下面「扫码绑定」，用要接入的微信扫码并确认。",
      "授权后在微信里找到 ClawBot（微信助手）给它发消息，就会由你选的机器人回复。",
    ],
    fields: [
      { key: "token", label: "授权令牌", type: "secret", help: "扫码授权后自动填好，一般不用手填。" },
      { key: "baseUrl", label: "接口地址", type: "url", default: "https://ilinkai.weixin.qq.com", help: "一般不用改。" },
    ],
    groupNote: "目前只支持私聊。",
    docAnchor: "个人微信微信-clawbot",
  },
  {
    id: "dingtalk",
    name: "钉钉机器人",
    summary: "钉钉开放平台企业内部应用机器人，Stream 模式收消息，支持手机钉钉扫码一键创建绑定，不需要公网回调地址。",
    official: true,
    qrAuth: true,
    qrHint: "使用手机钉钉扫码确认，自动注册钉钉机器人应用并填入 Client ID 与 Client Secret。",
    steps: [
      "推荐：直接点下方「扫码绑定」，用手机钉钉扫码确认即可自动创建机器人并填入凭据。",
      "若手动填写：open-dev.dingtalk.com → 应用开发 → 企业内部应用 → 创建应用，添加「机器人」能力，消息接收模式选「Stream 模式」并发布，复制 Client ID 和 Client Secret。",
      "在钉钉里私聊机器人，或把它加进群里 @ 它。",
    ],
    fields: [
      { key: "clientId", label: "Client ID（AppKey）", type: "text", required: true },
      { key: "clientSecret", label: "Client Secret（AppSecret）", type: "secret", required: true },
    ],
    groupNote: "群里只会收到 @ 机器人的消息；私聊直接回复。",
    docAnchor: "钉钉",
  },
  {
    id: "telegram",
    name: "Telegram",
    summary: "Telegram Bot API，长轮询收消息，不需要公网回调地址。",
    official: true,
    steps: [
      "在 Telegram 里找 @BotFather，发送 /newbot 创建机器人，复制它给的 Bot Token。",
      "要在群里用：对 @BotFather 发送 /setprivacy 选这个机器人，保持开启即可（群里 @ 它才回）。",
      "把 Token 填到下面；ChisaBot 服务器要能访问 api.telegram.org。",
    ],
    fields: [
      { key: "token", label: "Bot Token", type: "secret", required: true, placeholder: "123456:ABC-DEF…" },
      { key: "apiBase", label: "API 地址", type: "url", default: "https://api.telegram.org", help: "用反向代理时才改。" },
    ],
    groupNote: "群里 @ 机器人、或回复机器人的消息才回复；私聊直接回复。",
    docAnchor: "telegram",
  },
];

export function imPlatform(id: string): ImPlatformInfo | undefined {
  return IM_PLATFORMS.find((platform) => platform.id === id);
}

export type ImStatus = "connected" | "connecting" | "error" | "disabled" | "waiting";

export type ImConnectionView = {
  id: string;
  platform: ImPlatform;
  name: string;
  agentId: string;
  enabled: boolean;
  /** 非密钥字段的原值；密钥字段只回 true（已保存）/ false。 */
  config: Record<string, string>;
  secrets: Record<string, boolean>;
  /** 除主人外还能用的人（平台用户 id）。主人 id + 白名单都空 = 机器人不理任何人。 */
  allowUsers: string[];
  /** 主人本人的平台用户 id：只有这些人能用，也只有他们能在私聊里回「允许 / 拒绝」审批。 */
  ownerUsers: string[];
  /** 允许机器人在 IM 里用电脑 / 设备等高权限工具（默认关）。 */
  allowDevices: boolean;
  /** 「允许内网地址」（仅管理员可改）：这个连接自己配置的协议端主机可以指向本机 / 内网；云元数据地址照样拦。 */
  allowPrivate?: boolean;
  status: ImStatus;
  statusDetail: string | null;
  /** 机器人登录后平台给的身份（QQ 号、机器人名字……）。 */
  account: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  /** OneBot 反向连接：协议端要填的地址（相对路径，网页拼上当前域名）。 */
  reversePath?: string;
  /** OneBot 反向连接：协议端要填的 token（只回给连接的主人）。 */
  reverseToken?: string;
};

export type ImLogEntry = { at: string; level: "info" | "warn" | "error"; text: string };

export const IM_STATUS_LABEL: Record<ImStatus, string> = {
  connected: "已连接",
  connecting: "连接中",
  error: "出错",
  disabled: "已停用",
  waiting: "等待协议端连入",
};
