import { describe, expect, test } from "bun:test";
import { connectServiceTools } from "../src/plugins/connect-service";
import type {
  PluginStore,
  ServerRecord,
  ToolRecord,
} from "../src/plugins/store";

/**
 * 「把这个服务接进来」的第一层：这个部署里有什么、机器人能不能用、没有的话官方怎么接。
 *
 * 2026-10-21 的生产现场是星灵对腾讯 ima 连回三遍「没有连接器 / 需要管理员开通」，一次 web_search 都
 * 没调。同一模型、同一提示词的探针显示：26 个工具时它能挑中 device_list / connector_call，而把
 * connect_service 放进列表后 4/4 都选它。所以这个工具的名字和描述本身就是能力的一部分，测试要同时
 * 钉住「它查到了什么」和「它不会假装自己能装」。
 */

const botId = "agent_xingling";

function toolRecord(overrides: Partial<ToolRecord> = {}): ToolRecord {
  return {
    serverId: "notion",
    name: "search_pages",
    description: "Search pages.",
    inputSchema: {},
    ref: "notion/search_pages",
    effect: "read",
    destructive: false,
    grantedTo: [],
    ...overrides,
  };
}

function server(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: "notion",
    title: "Notion",
    logo: null,
    vendor: "Notion",
    url: "https://mcp.notion.com/mcp",
    summary: "Read and write Notion pages.",
    docsUrl: "https://developers.notion.com/guides/mcp",
    provenance: "first-party",
    hasCredential: true,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    authScheme: "OAUTH2",
    tools: [],
    withdrawn: [],
    ...overrides,
  };
}

function storeWith(
  servers: ServerRecord[],
  connections: string[] = [],
  brokered: string[] = [],
): PluginStore {
  return {
    listServers: async () => servers,
    connectionsFor: async () =>
      connections.map((serverId) => ({ serverId, scope: "", connectedAt: "" })),
    brokeredConnectionsFor: async () =>
      brokered.map((serverId) => ({
        serverId,
        scope: "",
        connectedAt: "",
        verified: true,
        verifiedAt: "",
      })),
  } as unknown as PluginStore;
}

function connectTool(options: {
  servers: ServerRecord[];
  connections?: string[];
  brokered?: string[];
  search?: (
    query: string,
    count?: number,
  ) => Promise<{ title: string; url: string; snippet: string }[]>;
}) {
  const calls: string[] = [];
  const built = connectServiceTools({
    store: storeWith(options.servers, options.connections, options.brokered),
    ownerUserId: "owner",
    botId,
    search:
      options.search ??
      (async (query) => {
        calls.push(query);
        return [];
      }),
  })[0];
  if (!built) throw new Error("connect_service was not built");
  return { tool: built, calls };
}

async function run(
  tool: ReturnType<typeof connectTool>["tool"],
  service: string,
): Promise<string> {
  return (await tool.execute({ service })) as string;
}

describe("connect_service", () => {
  test("is a tool whose name and description match the request, not a generic search", () => {
    const { tool } = connectTool({ servers: [] });
    expect(tool.name).toBe("connect_service");
    expect(tool.ref).toBe("web/connect_service");
    expect(tool.description).toContain("连接");
    expect(tool.description).toContain("接入");
  });

  test("reports a connector the Bot already holds and can use", async () => {
    const { tool, calls } = connectTool({
      servers: [
        server({
          tools: [
            toolRecord({ name: "search_pages", grantedTo: [botId] }),
            toolRecord({ name: "fetch_page", grantedTo: [] }),
          ],
        }),
      ],
      connections: ["notion"],
    });

    const answer = await run(tool, "Notion");

    expect(answer).toContain("Notion");
    expect(answer).toContain("这个机器人有 1 个");
    expect(answer).toContain("账号：已连接");
    expect(answer).toContain("已经可用");
    // Already connected and granted: no web search, no "install an MCP" lecture.
    expect(calls).toEqual([]);
    expect(answer).not.toContain("Streamable HTTP");
  });

  test("reports the missing grant and the missing account, in the order to fix them", async () => {
    const { tool } = connectTool({
      servers: [server({ tools: [toolRecord({ grantedTo: [] })] })],
    });

    const answer = await run(tool, "Notion");

    expect(answer).toContain("一个都没授权");
    expect(answer).toContain("账号：未连接");
    expect(answer).toContain("设置 → 账号连接");
    expect(answer).toContain("设置 → 插件");
  });

  test("searches the official integration path when the deployment has nothing", async () => {
    const searched: string[] = [];
    const { tool } = connectTool({
      servers: [],
      search: async (query) => {
        searched.push(query);
        return [
          {
            title: "ima OpenAPI",
            url: "https://ima.qq.com/agent-interface",
            snippet: "Client ID and API key for the ima OpenAPI.",
          },
        ];
      },
    });

    const answer = await run(tool, "腾讯ima");

    expect(searched).toHaveLength(1);
    expect(searched[0]).toContain("腾讯ima");
    expect(searched[0]).toContain("API");
    expect(answer).toContain("没有这个服务的连接器");
    expect(answer).toContain("https://ima.qq.com/agent-interface");
    expect(answer).toContain("Streamable HTTP");
    // The boundary has to be explicit: collecting the docs is not installing the server.
    expect(answer).toContain("我的工具里没有安装入口");
  });

  test("names a catalogue connector that exists but was never enabled", async () => {
    const { tool } = connectTool({ servers: [] });

    const answer = await run(tool, "Google Drive");

    expect(answer).toContain("目录里有");
    expect(answer).toContain("还没启用");
    expect(answer).toContain("设置 → 插件");
  });

  test("a search failure is reported as a failed search, not as 'no such integration'", async () => {
    const { tool } = connectTool({
      servers: [],
      search: async () => {
        throw new Error("搜索超时");
      },
    });

    const answer = await run(tool, "腾讯ima");

    expect(answer).toContain("联网搜索失败");
    expect(answer).toContain("搜索超时");
    // Still says how this deployment would take a custom MCP, so the turn is not wasted.
    expect(answer).toContain("Streamable HTTP");
  });

  test("a database failure is not turned into 'there are no connectors'", async () => {
    const broken = {
      listServers: async () => {
        throw new Error("db down");
      },
    } as unknown as PluginStore;
    const tool = connectServiceTools({
      store: broken,
      ownerUserId: "owner",
      botId,
      search: async () => [],
    })[0];
    if (!tool) throw new Error("connect_service was not built");

    const answer = (await tool.execute({ service: "Notion" })) as string;

    expect(answer).toContain("读不到这个部署的连接器列表");
    expect(answer).not.toContain("没有这个服务的连接器");
  });

  test("refuses an empty service name instead of searching for nothing", async () => {
    const { tool, calls } = connectTool({ servers: [] });

    const answer = await run(tool, "   ");

    expect(answer).toContain("需要一个服务名");
    expect(calls).toEqual([]);
  });
});
