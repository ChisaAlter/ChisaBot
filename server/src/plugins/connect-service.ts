import { z } from "zod";
import { markUntrusted } from "../untrusted-content";
import { CATALOGUE } from "./catalogue";
import type { PluginStore, ServerRecord } from "./store";
import type { GrantedTool } from "./tools";

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
  notion: ["notion"],
  "google-drive": ["googledrive", "谷歌云盘", "谷歌drive", "drive"],
  parallel: ["parallel", "parallelsearch"],
  腾讯文档: ["腾讯文档", "docsqq"],
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

const CUSTOM_MCP_NOTE = [
  "这个部署接一个没有现成连接器的服务，只有一条路：Streamable HTTP 的 MCP 服务器。",
  "1. 在该服务的开放平台拿凭证（Client ID / API Key / OAuth）。",
  "2. 把它的 MCP 桥跑在一个能访问公网的地址上；stdio 的 MCP 进程这个部署跑不了。",
  "3. 管理员在 设置 → 插件 → 添加 MCP 服务器，填标题和地址，刷新工具。",
  "4. 在插件页把工具勾给这个机器人。",
  "第 1 步我能替你查、替你把配置写好；第 3 步是管理员页面的动作，我的工具里没有安装入口。",
].join("\n");

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
        "✅ 【内置电子邮箱连接器（IMAP 只读收件箱）】已经内置就绪，支持 Gmail、QQ 邮箱、163 邮箱、Outlook、iCloud 等：",
        `  - 当前账号状态：${statusText}`,
        "  - 当前机器人已持有工具：`email_list_recent`（查看最近邮件与未读摘要）、`email_connect`（在对话中直接绑定连接邮箱）、`morning_brief_generate`（生成含未读邮件的每日晨报卡片）",
        "  - 怎么立即连上：",
        "    1. 【对话内直接代连（最快）】用户只要把邮箱地址和「应用专用密码 / IMAP 授权码」发到对话里（Gmail 在 Google 账号「安全性 → 两步验证 → 应用专用密码」生成 16 位密码；QQ/163 在邮箱设置开启 IMAP 生成授权码），你就可以直接调用 `email_connect` 自动填好 `imap.gmail.com:993` 等服务器并完成绑定；",
        "    2. 【设置页一键预设】引导用户点开下方链接卡进入「设置 → 账号连接」，在「个人日程与收件箱」点「连接邮箱」，一键选 Gmail / QQ / 163 / Outlook 预设填入即可。",
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
        "  - 当前机器人已持有工具：`calendar_list_events`（查看近期日程）、`calendar_connect`（在对话中直接绑定日历订阅链接）、`morning_brief_generate`（每日晨报卡片）",
        "  - 怎么立即连上：",
        "    1. 【对话内直接代连（最快）】让用户把日历的 iCal / ICS 私密订阅地址（`https://...` 或 `webcal://...`）发到对话里，你直接调用 `calendar_connect` 当场连上；",
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
        "  - 怎么连接：在「设置 → 账号连接」顶部的 GitHub 卡片里填入 Personal Access Token 即可一键连接。",
        "  - 回复末尾请附上独立一行的链接卡：",
        "    [打开账号连接](/settings/connected-accounts)",
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
    : "未连接（支持对话内直接发邮箱+授权码由我调用 `email_connect` 代连，或在「设置 → 账号连接」连接）";
  const calStatus = builtin?.calendar?.connected
    ? `已连接（${builtin.calendar.label ?? "我的日历"}，${builtin.calendar.eventCount ?? 0} 个日程）`
    : "未连接（支持直接发 iCal/ICS 链接由我调用 `calendar_connect` 代连，或在「设置 → 账号连接」连接）";
  const ghStatus = builtin?.github?.connected
    ? `已连接（@${builtin.github.login ?? "github"}）`
    : "未连接（在「设置 → 账号连接」填入 GitHub 令牌即可）";

  const addedIds = new Set(servers.map((s) => s.id));
  const unaddedCatalogue = CATALOGUE.filter((entry) => !addedIds.has(entry.key));

  const sections: string[] = [
    "【当前部署连接器全景】",
    [
      "一、内置直连数据源（已就绪，免装插件）：",
      `- 电子邮箱（Gmail / QQ邮箱 / 163 / Outlook / iCloud IMAP 只读）：${emailStatus}｜工具：email_list_recent、email_connect、morning_brief_generate`,
      `- 个人日历（Google Calendar / iCloud / Outlook / 飞书 iCal/ICS）：${calStatus}｜工具：calendar_list_events、calendar_connect、morning_brief_generate`,
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
      "四、快捷操作入口（请在回复末尾原样附上下方独立成行的链接卡，方便用户一键点击）：",
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
): string {
  const names = namesFor(service);
  const matched = servers.filter((server) =>
    mentions(
      `${server.id} ${server.title} ${server.vendor} ${server.url} ${server.summary}`,
      names,
    ),
  );
  const catalogue = matched.length === 0 ? catalogueSection(names) : null;
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
    if (autoActions.length > 0) {
      sections.push(
        [
          "快捷操作入口（请在回复末尾原样附上下方独立成行的链接卡）：",
          `[去连接 ${matched[0]!.title} 账号](/settings/connected-accounts/${matched[0]!.id})`,
          `[管理 ${matched[0]!.title} 插件设置](/admin/plugins/${matched[0]!.id})`,
        ].join("\n"),
      );
    }
  } else if (catalogue) {
    sections.push("这个部署里没有启用的连接器，但目录里有：", catalogue);
  } else if (!builtinSection) {
    sections.push("这个部署里没有这个服务的连接器，目录里也没有。");
  }

  if (!builtinSection) {
    sections.push(
      "官方接入方式：",
      searchError
        ? `联网搜索失败：${searchError}。可以直接给我官网地址，我用 web_fetch 读。`
        : officialSection(hits),
    );

    if (matched.length === 0) {
      sections.push("怎么接进来：", CUSTOM_MCP_NOTE);
    }
  }

  return sections.join("\n\n");
}

export function connectServiceTools(
  options: ConnectServiceOptions,
): GrantedTool[] {
  return [
    {
      name: "connect_service",
      ref: "web/connect_service",
      description:
        "查看或主动开启外部服务连接器（填「全部」可列出当前所有内置连接器、已启用 MCP 插件、官方目录与账号状态；或填具体服务名如 Gmail、日历、GitHub、Notion、Google Drive、腾讯 ima 等）。当用户问「你现在有什么连接器」「能连什么」「有 Gmail / Notion 连接器吗」或让你连接/接入/开启某个服务时，第一步就调用它。",
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
        // Only search when the deployment does not already have a matching connector or built-in source.
        const hasMatch =
          Boolean(builtinSection) ||
          servers.some((server) =>
            mentions(
              `${server.id} ${server.title} ${server.vendor} ${server.url} ${server.summary}`,
              names,
            ),
          );
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
        );
      },
    },
  ];
}
