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
    // QA1102-13：不认识的服务名也原样传进来查，而不是反问用户。
    expect(tool.description).toContain("不认识");
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

    // 虚无存储 hits no alias and no directory entry, so the web-search path is what runs.
    const answer = await run(tool, "虚无存储");

    expect(searched).toHaveLength(1);
    expect(searched[0]).toContain("虚无存储");
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

    const answer = await run(tool, "虚无存储");

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

  test("returns the full 4-layer connector panorama when asked for '全部'", async () => {
    const { tool, calls } = connectTool({
      servers: [
        server({
          tools: [toolRecord({ name: "search_pages", grantedTo: [botId] })],
        }),
      ],
      connections: ["notion"],
    });

    const answer = await run(tool, "全部");

    expect(answer).toContain("当前部署连接器全景");
    expect(answer).toContain("电子邮箱（Gmail");
    expect(answer).toContain("个人日历（Google Calendar");
    expect(answer).toContain("GitHub");
    expect(answer).toContain("Notion");
    expect(answer).toContain("[打开账号连接](/settings/connected-accounts)");
    expect(answer).toContain("[管理插件与 MCP](/admin/plugins)");
    expect(calls).toEqual([]);
  });

  test("recognizes built-in Gmail / Email IMAP connector and provides direct connect guidance without web search", async () => {
    const calls: string[] = [];
    const tool = connectServiceTools({
      store: storeWith([]),
      ownerUserId: "owner",
      botId,
      search: async (q) => {
        calls.push(q);
        return [];
      },
      builtinSources: async () => ({
        email: {
          connected: true,
          email: "chisa@gmail.com",
          imapHost: "imap.gmail.com",
        },
      }),
    })[0]!;

    const answer = (await tool.execute({ service: "Gmail" })) as string;

    expect(answer).toContain("内置电子邮箱连接器");
    expect(answer).toContain("chisa@gmail.com");
    expect(answer).toContain("email_connect");
    expect(answer).toContain("[打开账号连接](/settings/connected-accounts)");
    expect(calls).toEqual([]);
  });

  test("a directory service is answered with its connect pathway, not a web search", async () => {
    const { tool, calls } = connectTool({ servers: [] });

    const answer = await run(tool, "小红书");

    expect(answer).toContain("国内应用目录收录了它的接法");
    expect(answer).toContain("小红书");
    // A stdio package's pathway is the paired-PC bridge, spelled out rather than implied.
    expect(answer).toContain("device_mcp_call");
    expect(answer).toContain("xpzouying/xiaohongshu-mcp");
    // The session-account warning travels with the pathway, not dropped on the way.
    expect(answer).toContain("⚠️");
    // A directory hit is an answer, not a reason to search the web anyway.
    expect(calls).toEqual([]);
    expect(answer).not.toContain("联网搜索");
    expect(answer).not.toContain("Streamable HTTP");
  });

  test("an official remote endpoint without a catalogue row points at the custom-MCP path", async () => {
    const { tool, calls } = connectTool({ servers: [] });

    const answer = await run(tool, "天眼查");

    expect(answer).toContain("国内应用目录收录了它的接法");
    expect(answer).toContain("mcp.tianyancha.com/mcp");
    expect(answer).toContain("添加自定义 MCP");
    expect(calls).toEqual([]);
  });

  test("a service the catalogue carries still answers through the catalogue, not the directory", async () => {
    const { tool } = connectTool({ servers: [] });

    const answer = await run(tool, "高德地图");

    // amap is BOTH a catalogue row and a directory entry: the reviewed one-click path
    // is the nearer answer, and the directory's version must not restate it below.
    expect(answer).toContain("目录里有");
    expect(answer).toContain("还没启用");
    expect(answer).not.toContain("device_mcp_call");
  });

  test("a directory link entry gives the official docs rather than claiming nothing exists", async () => {
    const { tool, calls } = connectTool({ servers: [] });

    const answer = await run(tool, "腾讯ima");

    expect(answer).toContain("国内应用目录收录了它的接法");
    expect(answer).toContain("ima.qq.com/agent-interface");
    expect(calls).toEqual([]);
  });

  test("proactively auto-enables a catalogue connector and grants its tools when canAutoEnable is allowed", async () => {
    const addedKeys: string[] = [];
    const grantedRefs: string[] = [];
    let currentServers: ServerRecord[] = [];
    const dynamicStore = {
      listServers: async () => currentServers,
      connectionsFor: async () => [],
      brokeredConnectionsFor: async () => [],
      addServer: async (input: { key: string; by: string }) => {
        addedKeys.push(input.key);
        const created = server({
          id: input.key,
          title: "Notion",
          tools: [
            toolRecord({
              name: "search_pages",
              ref: "notion/search_pages",
              grantedTo: [],
            }),
          ],
        });
        currentServers = [created];
        return created;
      },
      grant: async (_kind: string, ref: string, agentId: string) => {
        grantedRefs.push(`${ref}->${agentId}`);
        currentServers = currentServers.map((s) => ({
          ...s,
          tools: s.tools.map((t) =>
            t.ref === ref ? { ...t, grantedTo: [agentId] } : t,
          ),
        }));
      },
    } as unknown as PluginStore;

    const tool = connectServiceTools({
      store: dynamicStore,
      ownerUserId: "owner",
      botId,
      search: async () => [],
      canAutoEnable: async () => ({ allowed: true, by: "admin@example.com" }),
    })[0]!;

    const answer = (await tool.execute({ service: "Notion" })) as string;

    expect(addedKeys).toEqual(["notion"]);
    expect(grantedRefs).toEqual([`notion/search_pages->${botId}`]);
    expect(answer).toContain("已主动为你启用官方连接器「Notion」");
    expect(answer).toContain("已主动将「Notion」的 1 个工具授权给当前机器人");
    expect(answer).toContain("这个机器人有 1 个");
    expect(answer).toContain(
      "[去连接 Notion 账号](/settings/connected-accounts/notion)",
    );
  });
});

/**
 * mcp_add（CB-120）：管理员在对话里把自定义 MCP 端点接进来，确认卡片代替管理页那次点击。
 *
 * 要钉住的不是「能装」而是「谁能装、装之前人看到什么」：非管理员拿不到工具；确认卡片上
 * 写的是探测到的真实工具清单；写的时候 destructive 工具不被静默放行。
 */
describe("mcp_add", () => {
  const input = {
    id: "ima-knowledge",
    title: "腾讯 ima 知识库",
    url: "https://mcp.example.com/ima",
  };

  function mcpAddStore(overrides: {
    servers?: ServerRecord[];
    added?: { id: string; url: string; by: string }[];
    granted?: string[];
    tools?: ToolRecord[];
  }) {
    const added = overrides.added ?? [];
    const granted = overrides.granted ?? [];
    return {
      listServers: async () => overrides.servers ?? [],
      connectionsFor: async () => [],
      brokeredConnectionsFor: async () => [],
      addCustomServer: async (args: {
        id: string;
        title: string;
        url: string;
        by: string;
      }) => {
        added.push({ id: args.id, url: args.url, by: args.by });
        return server({
          id: args.id,
          title: args.title,
          url: args.url,
          provenance: "custom",
          hasCredential: false,
          authScheme: null,
          tools: overrides.tools ?? [
            toolRecord({
              serverId: args.id,
              name: "search_docs",
              ref: `${args.id}/search_docs`,
            }),
            toolRecord({
              serverId: args.id,
              name: "delete_all",
              ref: `${args.id}/delete_all`,
              effect: "write",
              destructive: true,
            }),
          ],
        });
      },
      grant: async (_kind: string, ref: string, agentId: string) => {
        granted.push(`${ref}->${agentId}`);
      },
    } as unknown as PluginStore;
  }

  function mcpAddTool(options: {
    offerMcpAdd?: boolean;
    canAutoEnable?: () => Promise<{ allowed: boolean; by: string }>;
    probeMcp?: (url: string) => Promise<{ name: string }[]>;
    store?: PluginStore;
  }) {
    const tools = connectServiceTools({
      store: options.store ?? storeWith([]),
      ownerUserId: "owner",
      botId,
      search: async () => [],
      ...(options.canAutoEnable
        ? { canAutoEnable: options.canAutoEnable }
        : {}),
      ...(options.probeMcp ? { probeMcp: options.probeMcp } : {}),
      ...(options.offerMcpAdd !== undefined
        ? { offerMcpAdd: options.offerMcpAdd }
        : {}),
    });
    return tools.find((tool) => tool.name === "mcp_add");
  }

  test("is only offered when offerMcpAdd says so", () => {
    expect(mcpAddTool({})).toBeUndefined();
    expect(mcpAddTool({ offerMcpAdd: false })).toBeUndefined();
    const tool = mcpAddTool({ offerMcpAdd: true });
    expect(tool?.ref).toBe("plugins/mcp_add");
    expect(tool?.description).toContain("管理员");
  });

  test("prepareConfirm refuses a non-https URL before any card", async () => {
    const tool = mcpAddTool({ offerMcpAdd: true });
    const plan = await tool!.prepareConfirm!({
      ...input,
      url: "http://mcp.example.com/ima",
    });
    expect("skip" in plan && plan.skip).toContain("https");
  });

  test("prepareConfirm shows the probed tool list on the card", async () => {
    const tool = mcpAddTool({
      offerMcpAdd: true,
      probeMcp: async (url) => {
        expect(url).toBe(input.url);
        return [{ name: "search_docs" }, { name: "delete_all" }];
      },
    });
    const plan = await tool!.prepareConfirm!(input);
    expect("skip" in plan).toBe(false);
    if ("skip" in plan) return;
    expect(plan.title).toContain(input.title);
    const probe = plan.details.find((d) => d.label === "探测");
    expect(probe?.value).toContain("2 个工具");
    expect(probe?.value).toContain("search_docs");
    expect(plan.details.find((d) => d.label === "网址")?.value).toBe(input.url);
  });

  test("execute adds the server, grants non-destructive tools, and names the blocked ones", async () => {
    const added: { id: string; url: string; by: string }[] = [];
    const granted: string[] = [];
    const tool = mcpAddTool({
      offerMcpAdd: true,
      canAutoEnable: async () => ({ allowed: true, by: "admin@example.com" }),
      store: mcpAddStore({ added, granted }),
    });

    const answer = (await tool!.execute(input)) as string;

    expect(added).toEqual([
      { id: input.id, url: input.url, by: "admin@example.com" },
    ]);
    expect(granted).toEqual([`ima-knowledge/search_docs->${botId}`]);
    expect(answer).toContain("已添加 MCP 服务器「腾讯 ima 知识库」");
    expect(answer).toContain("已授权给当前机器人 1 个工具");
    expect(answer).toContain("delete_all");
    expect(answer).toContain(`/admin/plugins/${input.id}`);
  });

  test("execute refuses when the asker is not an admin, whatever the card said", async () => {
    const added: { id: string; url: string; by: string }[] = [];
    const tool = mcpAddTool({
      offerMcpAdd: true,
      canAutoEnable: async () => ({ allowed: false, by: "u_1" }),
      store: mcpAddStore({ added }),
    });

    const answer = (await tool!.execute(input)) as string;

    expect(added).toEqual([]);
    expect(answer).toContain("Refused.");
    expect(answer).toContain("管理员");
  });
});
