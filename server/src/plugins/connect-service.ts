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

export type ConnectServiceOptions = {
  store: PluginStore;
  /** Whose accounts are being asked about. */
  ownerUserId: string;
  /** Which Bot's grants are being asked about. */
  botId: string;
  /** Injected so tests never reach the network. */
  search: (query: string, count?: number) => Promise<ConnectSearchHit[]>;
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
  gmail: ["gmail", "谷歌邮箱", "谷歌邮件"],
  notion: ["notion"],
  "google-drive": ["googledrive", "谷歌云盘", "谷歌drive", "drive"],
  腾讯文档: ["腾讯文档", "docsqq"],
};

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

function report(
  service: string,
  options: ConnectServiceOptions,
  servers: readonly ServerRecord[],
  connections: ReadonlySet<string>,
  hits: readonly ConnectSearchHit[],
  searchError: string | null,
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

  if (matched.length > 0) {
    sections.push(
      "这个部署里已经启用：",
      matched
        .map((server) => serverSection(server, options.botId, connections))
        .join("\n"),
    );
  } else if (catalogue) {
    sections.push("这个部署里没有启用的连接器，但目录里有：", catalogue);
  } else {
    sections.push("这个部署里没有这个服务的连接器，目录里也没有。");
  }

  sections.push(
    "官方接入方式：",
    searchError
      ? `联网搜索失败：${searchError}。可以直接给我官网地址，我用 web_fetch 读。`
      : officialSection(hits),
  );

  if (matched.length === 0) {
    sections.push("怎么接进来：", CUSTOM_MCP_NOTE);
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
        "查一个外部服务（Gmail、Notion、腾讯 ima……）在这个部署里怎么接：已经启用的连接器、给这个机器人授予了哪些工具、你的账号有没有连上，以及官方 API / MCP 的接入方式。用户让你连接、接入、同步某个服务，或者问某个服务能不能接时，先用它。",
      parameters: z.object({
        service: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe(
            "服务名，例如 腾讯ima、Notion、Gmail。用用户说的那个名字就行。",
          ),
      }),
      execute: async (args) => {
        const parsed = z
          .object({ service: z.string().trim().min(1).max(120) })
          .safeParse(args);
        if (!parsed.success)
          return "connect_service 需要一个服务名，例如「腾讯ima」。";
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

        let hits: ConnectSearchHit[] = [];
        let searchError: string | null = null;
        // Only search when the deployment does not already have a matching connector. Otherwise the
        // answer is "you already have it", and a web search would bury that under links.
        const names = namesFor(service);
        const hasMatch = servers.some((server) =>
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
        );
      },
    },
  ];
}
