/**
 * AI 输出契约：模型能发出的每一种输出形态，以及它在每个界面上的归宿。
 *
 * 这是「提示词承诺了什么 ↔ 各端实际渲染什么」的唯一清单。新增一种输出形态时：
 *   1. 在这里加一行，并为每个界面明确写出 native（原生渲染）/ degraded（显式降级，用户知道发生了什么）/
 *      none（不会出现，由服务端拦住）。
 *   2. `web` 写 native/degraded 的，必须在 bot-bubbles / chat-transcript / tool-renderers 里有对应实现；
 *      `app` 同理对应 Android 的 Markdown/JsonRender/Turns，`im` 对应 IM 文本面。
 *   3. shared/output-contract.test.ts 会校验清单本身的完整性；两端的解析测试（chat-bubbles.test.ts /
 *      NativeLogicTest.kt）按这里的 id 逐条命名，方便对照缺了谁。
 *
 * 判据（设计目标不变量）：任何形态在任何界面上都不允许「静默丢弃」或「语法原文漏进气泡」；
 * 交互类形态（要人填/批的）在无法作答的界面上必须由服务端 surface 闸门挡住，而不是发卡等人。
 */

export type Surface = "web" | "app" | "im";
export type Disposition = "native" | "degraded" | "none";

export interface OutputForm {
  /** 稳定标识，测试用例按它命名（如 `status-cards`）。 */
  id: string;
  /** 模型写出来的语法示例（一行）。 */
  syntax: string;
  /** 谁产生它：prompt（模型按提示词直接写）/ tool（工具结果里的记号）/ server（服务端行）。 */
  origin: "prompt" | "tool" | "server";
  web: Disposition;
  app: Disposition;
  im: Disposition;
  /** 非 native 的界面说明降级形态（为什么/去哪）。 */
  note?: string;
}

export const OUTPUT_FORMS: readonly OutputForm[] = [
  {
    id: "text-bubble",
    syntax: "普通 Markdown 段落",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "native",
  },
  {
    id: "quote",
    syntax: "> 引用块",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "table",
    syntax: "| a | b | 表格",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "code-block",
    syntax: "```lang 围栏代码",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "draft-doc",
    syntax: "```draft / ```doc 文稿卡",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "brief",
    syntax: "```brief / ```morning-brief 晨报卡",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "status-cards",
    syntax:
      ":::group / :::card{title,status} 指令块（或归一后的 ```cards 围栏）",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "link-card-bare",
    syntax: "独立成行的裸 URL",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "link-card-labeled",
    syntax: "独立成行的 [标签](https://…)",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "action-pill",
    syntax:
      "独立成行的 [短标签](/站内路径)，如 /settings/connected-accounts/github",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "github 深链两端都就地弹令牌对话框；其它站内路径 app 走壳内网页",
  },
  {
    id: "rich-preview",
    syntax: "```mermaid / ```svg / ```html 预览块",
    origin: "prompt",
    web: "native",
    app: "degraded",
    im: "degraded",
    note: "app 画代码卡 + 「在网页中打开可预览」，不做原生渲染（成本不成比例）",
  },
  {
    id: "inline-image",
    syntax: "![alt](url) 独立行图片",
    origin: "prompt",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "json-render",
    syntax:
      "render_ui 工具产出 spec → 卡片（37 组件见 shared/json-render/catalog.ts）",
    origin: "tool",
    web: "native",
    app: "native",
    im: "none",
    note: "app 的表单组件/on.press/refresh_panel 走 FallbackRow「在网页中打开」；Icon 画 label/名字不静默丢",
  },
  {
    id: "tool-files",
    syntax:
      "⟦chisabot:files⟧[{id,name,mimeType,url,…}]（image_generate/image_edit/file_share）",
    origin: "tool",
    web: "native",
    app: "native",
    im: "none",
  },
  {
    id: "confirm-card",
    syntax: "服务端确认行（⟦confirm:…⟧/⟦approval:…⟧）",
    origin: "server",
    web: "native",
    app: "native",
    im: "native",
    note: "三端都能批；vault/github 的「等人填」卡由 surface 闸门限制在 web",
  },
  {
    id: "github-action",
    syntax: "⟦github:id⟧ 写操作确认卡（等 10 分钟）",
    origin: "tool",
    web: "native",
    app: "none",
    im: "none",
    note: "P0：app/im 的 person 被 canConfirm 拦住，干净指路网页而不是挂死",
  },
  {
    id: "vault-request",
    syntax: "⟦vault:id⟧ 安全输入卡（等 10 分钟）",
    origin: "tool",
    web: "native",
    app: "none",
    im: "none",
    note: "同上：interactive() 只认 web person",
  },
  {
    id: "page-card",
    syntax: "⟦page:id⟧ 已存页面卡",
    origin: "tool",
    web: "native",
    app: "degraded",
    im: "none",
    note: "app 端打开网页",
  },
  {
    id: "server-rows",
    syntax: "⟦rows⟧/⟦steps⟧ 等服务端注入行",
    origin: "server",
    web: "native",
    app: "native",
    im: "degraded",
    note: "im 按纯文本",
  },
  {
    id: "work-steps",
    syntax: "工具调用进行中的「正在…」说法行",
    origin: "server",
    web: "native",
    app: "native",
    im: "degraded",
    note: "说法表见 WORK_STEP_TOOLS，两端用词漂移会被契约测试抓住",
  },
];

/**
 * work-step 说法表必须认识的工具名（两端的 describe/workStepText 表都要覆盖，
 * 缺一个就会落到「正在使用 xxx」的通用说法——这就是漂移探测器）。
 */
export const WORK_STEP_TOOLS: readonly string[] = [
  "web_search",
  "web_fetch",
  "skill_list",
  "worker_status",
  "render_ui",
  "chat_files_recent",
  "list_recent_files",
  "delegate_task",
  "ask_person",
  "note",
  "computer_navigate",
  "computer_screenshot",
  "computer_snapshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_run_command",
  "computer_read_file",
  "computer_write_file",
  "computer_list_files",
  "computer_read",
  "computer_handoff",
  "computer_request_help",
  "device_list",
  "device_search",
  "device_read_file",
  "device_list_files",
  "device_system_info",
  "device_agent_list",
  "device_agent_status",
  "memory",
  "memory_search",
  "memory_save",
  "memory_update",
  "memory_log",
  "memory_forget",
  "page_list",
  "page_get",
  "panel_list",
  "schedule_list",
  "schedule_create",
  "github_list_repos",
  "github_read_file",
  "github_list_issues",
  "github_get_issue",
  "github_list_pulls",
  "bot_factory",
];
