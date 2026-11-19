import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createExecutionNodeStore,
  createMemoryExecutionNodeStorage,
  ExecutionNodeError,
} from "../src/computer/execution-node-store";
import {
  createDynamicExecutionNodeProvider,
  createSharedComputerProvider,
} from "../src/computer/provider";
import {
  emitToolImage,
  withToolImageCollector,
} from "../src/conversations/tool-images";
import {
  callTool as mcpCallTool,
  listTools as mcpListTools,
  pinnedMcpFetch,
} from "../src/plugins/mcp";
import {
  createMcpEnhancementRoutes,
  createMcpEnhancementStore,
  createMemoryMcpEnhancementStorage,
  extractValidatedMcpImages,
  formatConnectorCustomInstructions,
  formatMcpCallFailure,
  isMcpTimeoutOrNetworkError,
  listAllMcpTools,
  MCP_NO_AUTO_RETRY_NOTICE,
} from "../src/plugins/mcp-enhancements";

const TEST_KEY = randomBytes(32).toString("base64");

const openServers: Server[] = [];

async function startHttpServer(
  handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>,
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  openServers.push(server);
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, server };
}

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

/** 构造合法的 1×1 PNG（带真实 IHDR 与魔数）。 */
function makePngBase64(width = 1, height = 1): string {
  const buf = Buffer.alloc(24);
  // PNG signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  // IHDR length = 13
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

function makeGifBase64(width = 2, height = 2): string {
  const buf = Buffer.alloc(12);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf.toString("base64");
}

describe("Wave 8 远端 MCP 增强（分页 / SSE / 图像透传 / 防重放 / 降级保护）", () => {
  test("listTools nextCursor 完整多页拉取、环游标拦截与页数上限保护", async () => {
    const pages: Record<string, { tools: Array<{ name: string }>; nextCursor?: string }> = {
      "": { tools: [{ name: "tool_1" }, { name: "tool_2" }], nextCursor: "p2" },
      p2: { tools: [{ name: "tool_3" }], nextCursor: "p3" },
      p3: { tools: [{ name: "tool_4" }] },
    };
    const all = await listAllMcpTools(async (cursor) => {
      const page = pages[cursor ?? ""];
      if (!page) throw new Error("unexpected cursor");
      return page;
    });
    expect(all.map((t) => t.name)).toEqual([
      "tool_1",
      "tool_2",
      "tool_3",
      "tool_4",
    ]);

    // 循环游标防死循环
    await expect(
      listAllMcpTools(async (cursor) => ({
        tools: [{ name: `t_${cursor ?? "0"}` }],
        nextCursor: "same-cursor",
      })),
    ).rejects.toThrow("循环重复");

    // 超过最大页数防无限翻页
    let counter = 0;
    await expect(
      listAllMcpTools(
        async () => {
          counter += 1;
          return {
            tools: [{ name: `t_${counter}` }],
            nextCursor: `cursor-${counter}`,
          };
        },
        { maxPages: 3 },
      ),
    ).rejects.toThrow("安全上限");
  });

  test("单工具开关、customInstructions、加密 Header、跨源 OAuth 保护与 mcp-last-good 降级保护", async () => {
    const store = createMcpEnhancementStore({
      storage: createMemoryMcpEnhancementStorage(),
      encryptionKey: TEST_KEY,
    });
    await store.ensure();

    const updated = await store.update(
      "acme",
      {
        transport: "sse",
        customInstructions: "查询工单时优先传 limit=20。",
        disabledTools: ["delete_everything", "drop_db"],
        customHeaders: { "X-Tenant-Secret": "tenant-secret-42" },
        oauth: {
          authorizationUrl: "https://auth.acme.example/authorize",
          tokenUrl: "https://auth.acme.example/token",
          scopes: ["tickets:read"],
          clientId: "cid-1",
          clientSecret: "csec-1",
          accessToken: "oauth-token-1",
        },
      },
      "admin@example.com",
    );

    // 公开视图不回显 Header 明文值与 OAuth 密钥/令牌
    expect(updated.transport).toBe("sse");
    expect(updated.customHeaderKeys).toEqual(["X-Tenant-Secret"]);
    expect(JSON.stringify(updated)).not.toContain("tenant-secret-42");
    expect(JSON.stringify(updated)).not.toContain("csec-1");
    expect(JSON.stringify(updated)).not.toContain("oauth-token-1");
    expect(updated.oauth?.hasClientSecret).toBe(true);
    expect(updated.oauth?.hasToken).toBe(true);

    // 单工具禁用查询
    expect(await store.isToolDisabled("acme", "delete_everything")).toBe(true);
    expect(await store.isToolDisabled("acme", "list_tickets")).toBe(false);

    // 自定义指引格式化
    const guidance = formatConnectorCustomInstructions(
      await store.customInstructionsForServers(["acme"]),
    );
    expect(guidance).toContain("[acme]");
    expect(guidance).toContain("limit=20");

    // 运行时叠加层解密 Header 与 OAuth Bearer
    const overlay = await store.resolveConnectionOverlay("acme");
    expect(overlay.transport).toBe("sse");
    expect(overlay.extraHeaders["X-Tenant-Secret"]).toBe("tenant-secret-42");
    expect(overlay.extraHeaders.Authorization).toBe("Bearer oauth-token-1");

    // 跨源修改 tokenUrl 时自动清除旧令牌防跨源外泄
    const crossOrigin = await store.update(
      "acme",
      {
        oauth: {
          authorizationUrl: "https://other.vendor.example/authorize",
          tokenUrl: "https://other.vendor.example/token",
        },
      },
      "admin@example.com",
    );
    expect(crossOrigin.oauth?.hasToken).toBe(false);
    expect(crossOrigin.oauth?.hasClientSecret).toBe(false);

    // mcp-last-good：先成功快照，再模拟远端探测失败 → 保留快照且标 degraded=true
    await store.recordProbeSuccess("acme", [
      { name: "list_tickets", description: "List tickets", inputSchema: {} },
      { name: "get_ticket", description: "Get ticket", inputSchema: {} },
    ]);
    const failure = await store.recordProbeFailure(
      "acme",
      "upstream 503 service unavailable",
    );
    expect(failure.preserved).toBe(true);
    expect(failure.snapshot?.degraded).toBe(true);
    expect(failure.snapshot?.tools.map((t) => t.name)).toEqual([
      "list_tickets",
      "get_ticket",
    ]);
    expect(failure.snapshot?.lastProbeError).toContain("503");

    const viewAfterFail = await store.getView("acme");
    expect(viewAfterFail.lastGood?.degraded).toBe(true);
    expect(viewAfterFail.lastGood?.tools).toHaveLength(2);
    expect(viewAfterFail.customHeaderKeys).toEqual(["X-Tenant-Secret"]);

    // 路由鉴权检查
    const app = new Hono<{ Variables: AppVariables }>();
    const requireAdminActor: MiddlewareHandler<{ Variables: AppVariables }> =
      async (c, next) => {
        c.set("actor", {
          id: "u-admin",
          email: "admin@example.com",
          role: "admin",
          name: "Admin",
        });
        await next();
      };
    app.route(
      "/api/mcp-enhancements",
      createMcpEnhancementRoutes({ store, requireUser: requireAdminActor }),
    );
    const routeRes = await app.request("/api/mcp-enhancements/acme");
    expect(routeRes.status).toBe(200);
    expect(routeRes.headers.get("cache-control")).toBe("no-store");
  });

  test("MCP image content block 二进制魔数/像素炸弹/字节上限校验与视觉模型透传", async () => {
    const validPng = makePngBase64(32, 32);
    const validGif = makeGifBase64(16, 16);
    const pixelBombPng = makePngBase64(10_000, 10_000);
    const forgedSvg = Buffer.from("<svg><script>alert(1)</script></svg>").toString(
      "base64",
    );
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 64).toString("base64");

    const extracted = extractValidatedMcpImages([
      { type: "image", data: validPng, mimeType: "image/png" },
      { type: "image", data: validGif, mimeType: "image/gif" },
      { type: "image", data: pixelBombPng, mimeType: "image/png" },
      { type: "image", data: forgedSvg, mimeType: "image/png" },
      { type: "image", data: oversized, mimeType: "image/png" },
    ]);

    expect(extracted.images).toHaveLength(2);
    expect(extracted.images[0]?.mediaType).toBe("image/png");
    expect(extracted.images[1]?.mediaType).toBe("image/gif");
    expect(extracted.rejected).toHaveLength(3);

    // 透传到视觉模型 collector
    const collected = await withToolImageCollector(
      { supportsImages: true },
      async () => {
        for (const img of extracted.images) {
          emitToolImage(img);
        }
        return "done";
      },
    );
    expect(collected.images).toHaveLength(2);
    expect(collected.images?.[0]?.mediaType).toBe("image/png");
  });

  test("超时与网络中断返回明确防自动重试警示，且不误伤用户主动 AbortError", () => {
    const timeoutErr = new Error("Request timed out");
    timeoutErr.name = "TimeoutError";
    expect(isMcpTimeoutOrNetworkError(timeoutErr)).toBe(true);
    expect(formatMcpCallFailure(timeoutErr)).toContain(
      MCP_NO_AUTO_RETRY_NOTICE,
    );
    expect(formatMcpCallFailure(timeoutErr)).toContain("不要自动重试");

    const resetErr = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    expect(isMcpTimeoutOrNetworkError(resetErr)).toBe(true);
    expect(formatMcpCallFailure(resetErr)).toContain("核查外部状态");

    const userAbort = new Error("The operation was aborted");
    userAbort.name = "AbortError";
    expect(isMcpTimeoutOrNetworkError(userAbort)).toBe(false);
  });

  test("SSE 传输走 pinnedMcpFetch 同源 DNS 钉死链路，拒跨域与重定向", async () => {
    let sseStreamRes: import("node:http").ServerResponse | null = null;
    const seenCustomHeaders: string[] = [];

    const { url } = await startHttpServer((req, res) => {
      const customHeader = req.headers["x-custom-mcp"];
      if (typeof customHeader === "string") {
        seenCustomHeaders.push(customHeader);
      }
      if (req.method === "GET" && req.url === "/sse") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        sseStreamRes = res;
        res.write("event: endpoint\ndata: /messages?sessionId=s1\n\n");
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/messages?sessionId=s1")) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id?: unknown;
            method?: string;
            params?: { cursor?: string; name?: string };
          };
          res.writeHead(202).end();
          if (!sseStreamRes) return;
          if (msg.method === "initialize") {
            sseStreamRes.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: { name: "sse-mock", version: "1.0.0" },
                },
              })}\n\n`,
            );
          } else if (msg.method === "tools/list") {
            const page1 = !msg.params?.cursor;
            sseStreamRes.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: page1
                  ? {
                      tools: [
                        {
                          name: "sse_snap",
                          description: "Return PNG",
                          inputSchema: { type: "object", properties: {} },
                        },
                      ],
                      nextCursor: "page2",
                    }
                  : {
                      tools: [
                        {
                          name: "sse_second",
                          description: "Second page tool",
                          inputSchema: { type: "object", properties: {} },
                        },
                      ],
                    },
              })}\n\n`,
            );
          } else if (msg.method === "tools/call") {
            sseStreamRes.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    { type: "text", text: "captured" },
                    {
                      type: "image",
                      data: makePngBase64(8, 8),
                      mimeType: "image/png",
                    },
                  ],
                },
              })}\n\n`,
            );
          }
        });
        return;
      }
      res.writeHead(404).end();
    });

    // SSE 模式下通过 pinnedMcpFetch 完成两页 tools/list 分页 + tools/call 图片透传
    const tools = await mcpListTools({
      url: `${url}/sse`,
      transport: "sse",
      extraHeaders: { "X-Custom-Mcp": "secret-hdr" },
      allowPrivateHost: true,
    });
    expect(tools.map((t) => t.name)).toEqual(["sse_snap", "sse_second"]);
    expect(seenCustomHeaders).toContain("secret-hdr");

    const callRes = await mcpCallTool(
      {
        url: `${url}/sse`,
        transport: "sse",
        extraHeaders: { "X-Custom-Mcp": "secret-hdr" },
        allowPrivateHost: true,
      },
      "sse_snap",
      {},
    );
    expect(callRes.isError).toBe(false);
    expect(callRes.images).toHaveLength(1);
    expect(callRes.images?.[0]?.mediaType).toBe("image/png");

    // pinnedMcpFetch 在 SSE 模式下依然硬拒绝跨域请求
    const sseFetcher = pinnedMcpFetch(
      new URL("https://mcp.example.com/sse"),
      { address: "93.184.216.34", family: 4 },
      { allowSameOriginPath: true },
    );
    await expect(
      sseFetcher("https://evil.example.com/messages"),
    ).rejects.toThrow("cross-origin");
  });
});

describe("Wave 8 远程执行节点热配置、健康探活与零重启热切换", () => {
  test("多节点 AES-256-GCM 封存、跨源清令牌、云元数据拦截、探活与热切换/回退", async () => {
    const tokensSeenAtA: string[] = [];
    const tokensSeenAtB: string[] = [];

    const nodeA = await startHttpServer((req, res) => {
      const token = req.headers["x-chisabot-computer-token"];
      if (typeof token === "string") tokensSeenAtA.push(token);
      if (req.url === "/health") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              ok: true,
              ready: true,
              protocol: "chisabot-computer/v1",
              services: { browser: "ok" },
            }),
          );
        return;
      }
      if (req.url === "/computers") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ computers: [{ botId: "bot-a", running: true }] }));
        return;
      }
      res.writeHead(404).end();
    });

    const nodeB = await startHttpServer((req, res) => {
      const token = req.headers["x-chisabot-computer-token"];
      if (typeof token === "string") tokensSeenAtB.push(token);
      if (req.url === "/health") {
        res
          .writeHead(503, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false }));
        return;
      }
      if (req.url === "/computers") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ computers: [{ botId: "bot-b", running: true }] }));
        return;
      }
      res.writeHead(404).end();
    });

    const store = createExecutionNodeStore({
      storage: createMemoryExecutionNodeStorage(),
      encryptionKey: TEST_KEY,
      staticFallbackProvider: "shared",
    });
    await store.ensure();

    // 即使勾选允许私网，也严禁连接云元数据地址
    await expect(
      store.create(
        {
          name: "Metadata Evil",
          baseUrl: "http://169.254.169.254",
          allowPrivateNetwork: true,
        },
        "admin",
      ),
    ).rejects.toThrow(ExecutionNodeError);

    // 创建节点 A 与节点 B
    const createdA = await store.create(
      {
        id: "node-a",
        name: "执行节点 A",
        baseUrl: nodeA.url,
        token: "token-node-a-secret",
        allowPrivateNetwork: true,
      },
      "admin",
    );
    expect(createdA.hasToken).toBe(true);
    expect(JSON.stringify(createdA)).not.toContain("token-node-a-secret");

    await store.create(
      {
        id: "node-b",
        name: "执行节点 B",
        baseUrl: nodeB.url,
        token: "token-node-b-secret",
        allowPrivateNetwork: true,
      },
      "admin",
    );

    // 探活节点 A（健康）与节点 B（503 异常）
    const probeA = await store.probeById("node-a");
    expect(probeA.health.ok).toBe(true);
    expect(probeA.node.lastHealthStatus).toBe("healthy");

    const probeB = await store.probeById("node-b");
    expect(probeB.health.ok).toBe(false);
    expect(probeB.node.lastHealthStatus).toBe("unhealthy");

    // 构建支持热切换的动态 provider（含静态环境变量回退）
    const fallback = createSharedComputerProvider({
      baseUrl: "http://127.0.0.1:19999",
      token: "static-fallback-token",
    });
    const dynamicProvider = createDynamicExecutionNodeProvider({
      resolveActiveNode: () => store.getActive(),
      fallback,
    });

    // 1. 未激活任何远程节点 → 无缝回退静态环境变量地址
    expect(await dynamicProvider.locate("bot-1")).toBe("http://127.0.0.1:19999");

    // 2. 热切换激活节点 A → 无需重启立即切到节点 A 与其解密令牌
    await store.activate("node-a", "admin");
    expect(await dynamicProvider.locate("bot-1")).toBe(nodeA.url);
    const listA = await dynamicProvider.list();
    expect(listA.map((c) => c.botId)).toEqual(["bot-a"]);
    expect(tokensSeenAtA).toContain("token-node-a-secret");

    // 3. 热切换激活节点 B → 立即切到节点 B 与其解密令牌
    await store.activate("node-b", "admin");
    expect(await dynamicProvider.locate("bot-1")).toBe(nodeB.url);
    const listB = await dynamicProvider.list();
    expect(listB.map((c) => c.botId)).toEqual(["bot-b"]);
    expect(tokensSeenAtB).toContain("token-node-b-secret");

    // 4. 变更节点 B 的 origin 且未重填令牌 → 自动清空旧令牌防跨源外泄
    const movedB = await store.update(
      "node-b",
      { baseUrl: nodeA.url, allowPrivateNetwork: true },
      "admin",
    );
    expect(movedB.hasToken).toBe(false);

    // 5. 停用所有动态节点 → 无缝回到静态环境变量模式
    await store.deactivateAll("admin");
    expect(await dynamicProvider.locate("bot-1")).toBe("http://127.0.0.1:19999");

    // 6. 管理员路由测试（非管理员 403，管理员可列表/探活/切换）
    let role: "admin" | "user" = "user";
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", {
        id: "u-1",
        email: "ops@example.com",
        role,
        name: "Ops",
      });
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/admin/execution-nodes", store.routes(requireUser));

    const denied = await app.request("/api/admin/execution-nodes");
    expect(denied.status).toBe(403);

    role = "admin";
    const okList = await app.request("/api/admin/execution-nodes");
    expect(okList.status).toBe(200);
    expect(okList.headers.get("cache-control")).toBe("no-store");
  });
});
