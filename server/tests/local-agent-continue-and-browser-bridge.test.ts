import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { DEFAULT_HARNESS_FLAGS } from "../../shared/admin-workbench";
import type { ChatFileView } from "../../shared/chat-files";
import { CHUNK_BYTES } from "../../shared/chunked-transfer";
import { defaultCapabilities } from "../../shared/devices";
import type { AppVariables } from "../src/auth/guards";
import { createChunkedUploadService } from "../src/chat-files/chunked-upload";
import {
  createDesktopBrowserBridge,
  DesktopBrowserBridgeError,
} from "../src/computer/desktop-browser-bridge";
import type { DeviceRecord } from "../src/devices/store";
import { createLocalAgentService } from "../src/local-agents/service";

const requireCjs = createRequire(import.meta.url);
const sandbox = requireCjs("../../pc/src/agent-runtime/sandbox.js") as {
  preflightSandboxCwd: (opts: {
    workdir: string;
    roots?: string[];
    profile?: string;
    isolation?: string;
    network?: boolean;
    timeoutMs?: number;
    platform?: string;
    probeFn?: (input: {
      workdir: string;
      isolation: string;
      network: boolean;
      timeoutMs: number;
    }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }) => Promise<{ ok: boolean; realPath: string; normalizedPath: string }>;
};
const { createAgentRuntime } = requireCjs(
  "../../pc/src/agent-runtime/index.js",
) as {
  createAgentRuntime: (opts: {
    send: (msg: Record<string, unknown>) => boolean;
    log?: (line: string) => void;
    isPaused?: () => boolean;
    preflightTimeoutMs?: number;
    preflightProbe?: (input: {
      workdir: string;
      isolation: string;
      network: boolean;
      timeoutMs: number;
    }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }) => {
    handle: (msg: Record<string, unknown>) => boolean;
    cleanupSessions: () => Promise<void>;
    stopAll: () => void;
  };
};
const { buildCommand, claudeParser, codexParser } = requireCjs(
  "../../pc/src/agent-runtime/cli-agents.js",
) as {
  buildCommand: (
    kind: string,
    opts: Record<string, unknown>,
  ) => { args: string[]; stdin: string | null };
  claudeParser: () => {
    line: (raw: string, emit: (...a: unknown[]) => void) => void;
    result: () => {
      summary: string;
      isError: boolean;
      sessionId: string | null;
    };
  };
  codexParser: () => {
    line: (raw: string, emit: (...a: unknown[]) => void) => void;
    result: () => {
      summary: string;
      isError: boolean;
      sessionId: string | null;
    };
  };
};
const browserBridgePc = requireCjs("../../pc/src/browser-bridge.js") as {
  createDesktopBrowserBridgeClient: (opts: Record<string, unknown>) => {
    handleCookieApprovalRequest: (
      req: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    handleWebAuthnRequest: (
      req: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
  discoverBrowserProfiles: (opts: {
    platform: string;
    homeDir: string;
    env: Record<string, string>;
  }) => Promise<
    Array<{ id: string; displayName: string; cookieDbPath: string | null }>
  >;
};

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

function makeDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: overrides.id ?? "dev_1",
    ownerUserId: overrides.ownerUserId ?? "user-a",
    name: overrides.name ?? "工作电脑",
    platform: overrides.platform ?? "win32",
    osVersion: "11",
    hostname: "host-a",
    arch: "x64",
    clientVersion: "0.1.169",
    capabilities: { ...defaultCapabilities(), shell: "allow" },
    allowedRoots: overrides.allowedRoots ?? [],
    paused: overrides.paused ?? false,
    revoked: overrides.revoked ?? false,
    lastSeenAt: new Date().toISOString(),
    lastIp: "127.0.0.1",
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    fullAccessUntil: null,
    tokenHash: overrides.tokenHash ?? "hash",
  };
}

function fakeRequireUser(
  actorId: string,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    c.set("actor", {
      id: actorId,
      email: `${actorId}@example.test`,
      name: actorId,
      role: "member",
    } as unknown as AppVariables["actor"]);
    await next();
  };
}

describe("Wave 9: Coding Agent 预检 / 多轮续接 / needs_input / status(waitMs)", () => {
  test("启动前 5s 沙盒目录 pwd -P 预检：放行合法目录、拦截越界目录、超时 fail-closed", async () => {
    const root = await makeTempDir("cb-preflight-root-");
    const inside = path.join(root, "project");
    const outside = await makeTempDir("cb-preflight-outside-");
    await fsp.mkdir(inside, { recursive: true });

    const ok = await sandbox.preflightSandboxCwd({
      workdir: inside,
      roots: [root],
      profile: "workspace",
      isolation: "none",
      timeoutMs: 5000,
    });
    expect(ok.ok).toBe(true);
    expect(ok.normalizedPath.includes("\\")).toBe(false);

    await expect(
      sandbox.preflightSandboxCwd({
        workdir: outside,
        roots: [root],
        profile: "workspace",
        isolation: "none",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/超出允许工作区范围/);

    // 模拟预检挂死超时，必须 fail-closed（额外挂一个定时器避免 Bun 定时器陷阱）
    const keepalive = setTimeout(() => {}, 2000);
    try {
      await expect(
        sandbox.preflightSandboxCwd({
          workdir: inside,
          roots: [root],
          profile: "workspace",
          isolation: "none",
          timeoutMs: 120,
          probeFn: () =>
            new Promise((resolve) => {
              setTimeout(
                () => resolve({ exitCode: 0, stdout: inside, stderr: "" }),
                1500,
              );
            }),
        }),
      ).rejects.toThrow(/预检超时/);
    } finally {
      clearTimeout(keepalive);
    }
  });

  test("CLI 驱动支持 --resume / exec resume 续接并解析 sessionId", () => {
    const claudeCmd = buildCommand("claude", {
      prompt: "补充单测",
      profile: "workspace",
      skipPermissions: false,
      network: true,
      workdir: "/repo",
      resumeSessionId: "claude-sess-42",
    });
    expect(claudeCmd.args).toContain("--resume");
    expect(claudeCmd.args).toContain("claude-sess-42");

    const cp = claudeParser();
    cp.line(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-sess-42",
      }),
      () => {},
    );
    cp.line(
      JSON.stringify({ type: "result", subtype: "success", result: "完成" }),
      () => {},
    );
    expect(cp.result().sessionId).toBe("claude-sess-42");

    const codexCmd = buildCommand("codex", {
      prompt: "继续优化",
      profile: "workspace",
      skipPermissions: false,
      network: true,
      workdir: "/repo",
      resumeSessionId: "thr_999",
    });
    expect(codexCmd.args.slice(0, 3)).toEqual(["exec", "resume", "thr_999"]);

    const xp = codexParser();
    xp.line(
      JSON.stringify({ type: "thread.started", thread_id: "thr_999" }),
      () => {},
    );
    xp.line(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "已修复" },
      }),
      () => {},
    );
    expect(xp.result().sessionId).toBe("thr_999");
  });

  test("本机运行时支持 needs_input 双向追问、保留人工审批转发，以及同上下文 agent_continue 续接", async () => {
    const workRoot = await makeTempDir("cb-runtime-ws-");
    const sent: Array<Record<string, unknown>> = [];
    let turn = 0;
    let sawApproval = false;
    let sawQuestion = false;
    let secondTurnHistoryCount = 0;

    let doneResolver: ((msg: Record<string, unknown>) => void) | null = null;
    const waitDone = () =>
      new Promise<Record<string, unknown>>((resolve) => {
        doneResolver = resolve;
      });

    const runtime = createAgentRuntime({
      send: (msg) => {
        sent.push(msg);
        if (msg.type === "agent_llm") {
          const messages = msg.messages as Array<{
            role: string;
            text?: string;
            output?: string;
          }>;
          const reqId = String(msg.reqId);
          queueMicrotask(() => {
            if (turn === 0) {
              // 第 1 步：触发 needs_input 追问用户
              turn = 1;
              runtime.handle({
                type: "agent_llm_result",
                reqId,
                ok: true,
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "tc_ask",
                    toolName: "ask_user",
                    input: JSON.stringify({
                      questions: [
                        {
                          id: "framework",
                          header: "测试框架",
                          question: "使用哪种断言风格？",
                          options: [
                            { label: "bun:test" },
                            { label: "node:assert" },
                          ],
                        },
                      ],
                    }),
                  },
                ],
              });
            } else if (turn === 1) {
              // 第 2 步：收到用户追问答复后，尝试越界写操作触发 ChisaBot 人工审批转发（验证绝不 decline）
              turn = 2;
              const toolMsg = messages[messages.length - 1];
              expect(toolMsg?.output).toContain("bun:test");
              runtime.handle({
                type: "agent_llm_result",
                reqId,
                ok: true,
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "tc_write",
                    toolName: "write_file",
                    input: JSON.stringify({
                      path: "notes.txt",
                      content: "round-1",
                    }),
                  },
                ],
              });
            } else if (turn === 2) {
              turn = 3;
              runtime.handle({
                type: "agent_llm_result",
                reqId,
                ok: true,
                content: [
                  { type: "text", text: "第一轮已完成并采纳 bun:test。" },
                ],
              });
            } else {
              // 第 2 轮 agent_continue：必须携带上一轮对话历史
              secondTurnHistoryCount = messages.length;
              runtime.handle({
                type: "agent_llm_result",
                reqId,
                ok: true,
                content: [
                  { type: "text", text: "第二轮续接完成，保留了上轮上下文。" },
                ],
              });
            }
          });
        } else if (msg.type === "agent_needs_input") {
          sawQuestion = true;
          queueMicrotask(() => {
            runtime.handle({
              type: "agent_user_input_result",
              taskId: msg.taskId,
              reqId: msg.reqId,
              answers: { framework: ["bun:test"] },
            });
          });
        } else if (msg.type === "agent_approval") {
          // 模拟人工审批放行（readonly 档位写文件会触发审批转发）
          sawApproval = true;
          queueMicrotask(() => {
            runtime.handle({
              type: "agent_approval_result",
              reqId: msg.reqId,
              approved: true,
            });
          });
        } else if (msg.type === "agent_done") {
          doneResolver?.(msg);
        }
        return true;
      },
    });

    try {
      const firstDonePromise = waitDone();
      runtime.handle({
        type: "agent_run",
        taskId: "task-wave9-1",
        agent: "builtin",
        prompt: "先问我测试框架，再写笔记",
        cwd: workRoot,
        profile: "readonly",
        isolation: "none",
        network: true,
        roots: [workRoot],
        skipPermissions: false,
        builtinModel: { kind: "server" },
        containerImage: "debian:bookworm-slim",
        timeoutMs: 30_000,
      });

      const firstDone = await firstDonePromise;
      expect(firstDone.ok).toBe(true);
      expect(firstDone.continuable).toBe(true);
      expect(sawQuestion).toBe(true);
      expect(sawApproval).toBe(true);
      const written = await fsp.readFile(
        path.join(workRoot, "notes.txt"),
        "utf8",
      );
      expect(written).toBe("round-1");

      // 同上下文续接第二轮
      const secondDonePromise = waitDone();
      runtime.handle({
        type: "agent_continue",
        taskId: "task-wave9-1",
        sessionId: firstDone.sessionId,
        agent: "builtin",
        prompt: "基于刚才的决定继续收尾",
        cwd: workRoot,
        profile: "readonly",
        isolation: "none",
        network: true,
        roots: [workRoot],
        skipPermissions: false,
        builtinModel: { kind: "server" },
        containerImage: "debian:bookworm-slim",
        timeoutMs: 30_000,
      });
      const secondDone = await secondDonePromise;
      expect(secondDone.ok).toBe(true);
      expect(secondDone.summary).toContain("第二轮续接完成");
      // 上一轮已有 user + assistant + tool + assistant + tool + assistant，续接后至少 7 条历史消息
      expect(secondTurnHistoryCount).toBeGreaterThanOrEqual(7);
    } finally {
      await runtime.cleanupSessions();
    }
  });

  test("服务端 status(waitMs) 阻塞长轮询与 needs_input 双向通道恢复", async () => {
    const taskId = "task-wait-1";
    const rowState: Record<string, unknown> = {
      id: taskId,
      owner_user_id: "user-a",
      device_id: "dev_1",
      device_name: "工作电脑",
      agent_id: "bot_1",
      bot_name: "编程助手",
      thread_id: "thread_1",
      agent: "codex",
      title: "长轮询测试",
      task: "检查代码",
      profile: "workspace",
      isolation: "none",
      network: true,
      cwd: "/repo",
      status: "running",
      step: "运行中",
      transcript: [],
      line_count: 0,
      summary: null,
      diff: null,
      error: null,
      llm_calls: 0,
      result_message_id: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      capacity_active: true,
      session_id: "sess-1",
      turn_count: 1,
      pending_input: null,
    };
    const outbound: Array<{
      deviceId: string;
      message: Record<string, unknown>;
    }> = [];
    const fakeSql = {
      unsafe: async <T>(query: string, params: unknown[] = []): Promise<T> => {
        if (
          query.startsWith(
            "SELECT * FROM chisabot_local_agent_tasks WHERE id = $1",
          )
        ) {
          return (params[0] === taskId
            ? [{ ...rowState }]
            : []) as unknown as T;
        }
        if (query.startsWith("UPDATE chisabot_local_agent_tasks SET ")) {
          if (params[1] && typeof params[1] === "string") {
            rowState.status = params[1];
          }
          if (query.includes("pending_input =")) {
            const rawPending = params.find(
              (p) => typeof p === "string" && p.includes("questions"),
            );
            rowState.pending_input = rawPending
              ? JSON.parse(String(rawPending))
              : null;
          }
          if (query.includes("step =")) {
            const stepVal = params.find(
              (p) => p === "等待你回答追问" || p === "已收到答复，继续执行",
            );
            if (stepVal) rowState.step = stepVal;
          }
          return [{ ...rowState }] as unknown as T;
        }
        return [] as unknown as T;
      },
    };
    const device = makeDevice({
      id: "dev_1",
      ownerUserId: "user-a",
      allowedRoots: ["/repo"],
    });
    const service = createLocalAgentService({
      database: { $client: fakeSql } as never,
      hub: {
        isOnline: () => true,
        sendRaw: (deviceId: string, message: Record<string, unknown>) => {
          outbound.push({ deviceId, message });
          return true;
        },
        requestUserApproval: async () => ({ approved: true, by: "user" }),
        decide: () => false,
      } as never,
      deviceStore: {
        get: async (id) => (id === device.id ? device : null),
        forOwner: async () => [device],
        audit: async () => "audit-id",
      },
    });

    // 发起长轮询等待状态变化（最长 5s）
    const startedAt = Date.now();
    const waitPromise = service.waitForStatusChange("user-a", taskId, 5000);

    // 60ms 后节点上报 needs_input 追问，长轮询应立即被唤醒返回，而非空等 5000ms
    setTimeout(() => {
      void service.handleNodeMessage(device, {
        type: "agent_needs_input",
        taskId,
        reqId: "req-ask-1",
        questions: [
          {
            id: "db_choice",
            header: "数据库选择",
            question: "采用 PostgreSQL 还是 SQLite？",
            options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
          },
        ],
      });
    }, 60);

    const viewAfterAsk = await waitPromise;
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(viewAfterAsk.status).toBe("needs_input");
    expect(viewAfterAsk.pendingInput?.reqId).toBe("req-ask-1");
    expect(viewAfterAsk.pendingInput?.questions[0]?.id).toBe("db_choice");

    // 缺少必填项答案时应拒绝
    await expect(
      service.answerPendingInput("user-a", taskId, {}),
    ).rejects.toThrow(/至少一项答复/);

    // 跨用户越权回答必须 404 拒绝
    await expect(
      service.answerPendingInput("user-b", taskId, {
        db_choice: ["PostgreSQL"],
      }),
    ).rejects.toThrow(/没有这个任务/);

    // 本人回答追问后立即向设备回传 agent_user_input_result 并切回 running
    const resumed = await service.answerPendingInput("user-a", taskId, {
      db_choice: ["PostgreSQL"],
    });
    expect(resumed.status).toBe("running");
    expect(resumed.pendingInput).toBeNull();
    expect(
      outbound.some((item) => item.message.type === "agent_user_input_result"),
    ).toBe(true);
  });
});

describe("Wave 9: 本机 Chrome Cookie 单域名审批导入 & WebAuthn/Passkey 跨端转发", () => {
  test("权限基于配对签发 scope（不信任自报 platform）、按 (ownerUserId, deviceId) 隔离、遵循 Harness 开关与超时过期", async () => {
    let clock = 1_700_000_000_000;
    let flags = { ...DEFAULT_HARNESS_FLAGS };
    const devA1 = makeDevice({
      id: "dev_a1",
      ownerUserId: "user-a",
      platform: "win32",
    });
    const devA2 = makeDevice({
      id: "dev_a2",
      ownerUserId: "user-a",
      platform: "darwin",
    });
    const devB1 = makeDevice({
      id: "dev_b1",
      ownerUserId: "user-b",
      platform: "win32",
    });
    const allDevices = new Map<string, DeviceRecord>([
      [devA1.id, devA1],
      [devA2.id, devA2],
      [devB1.id, devB1],
    ]);

    const bridge = createDesktopBrowserBridge({
      deviceStore: {
        get: async (id) => allDevices.get(id) ?? null,
        forOwner: async (owner) =>
          [...allDevices.values()].filter((d) => d.ownerUserId === owner),
        audit: async () => "audit-id",
      },
      getHarnessFlags: () => flags,
      now: () => clock,
      cookieApprovalTtlMs: 5000,
      webAuthnTtlMs: 5000,
    });

    try {
      // 1. 未签发 browser_bridge scope 时即使设备是桌面 platform 也必须 403 拒绝
      await expect(
        bridge.createCookieApproval({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          botId: "bot-1",
          origin: "https://github.com",
        }),
      ).rejects.toMatchObject({ status: 403 });

      // 显式签发 browser_bridge scope
      await bridge.setDeviceScopes("user-a", "dev_a1", ["browser_bridge"]);

      // 2. 拒绝通配符 / 多域名 / 非法协议
      await expect(
        bridge.createCookieApproval({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          botId: "bot-1",
          origin: "https://*.github.com",
        }),
      ).rejects.toThrow(/单一精确 origin/);

      // 3. Wave 4 Harness cookieImport 开关关闭时 409 拒绝
      flags = { ...DEFAULT_HARNESS_FLAGS, cookieImport: false };
      await expect(
        bridge.createCookieApproval({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          botId: "bot-1",
          origin: "https://github.com",
        }),
      ).rejects.toMatchObject({ status: 409 });
      flags = { ...DEFAULT_HARNESS_FLAGS, cookieImport: true };

      // 4. 正常发起审批，按 (ownerUserId, deviceId) 严格隔离
      const req = await bridge.createCookieApproval({
        ownerUserId: "user-a",
        deviceId: "dev_a1",
        botId: "bot-1",
        origin: "https://github.com",
      });
      expect(bridge.listCookieApprovals("user-b")).toHaveLength(0);
      expect(
        bridge.listCookieApprovals("user-a", { deviceId: "dev_a2" }),
      ).toHaveLength(0);
      expect(
        bridge.listCookieApprovals("user-a", { deviceId: "dev_a1" }),
      ).toHaveLength(1);

      // 其他用户或其他设备均不能响应
      await expect(
        bridge.respondCookieApproval({
          ownerUserId: "user-b",
          deviceId: "dev_b1",
          requestId: req.requestId,
          decision: { approved: false },
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        bridge.respondCookieApproval({
          ownerUserId: "user-a",
          deviceId: "dev_a2",
          requestId: req.requestId,
          decision: { approved: false },
        }),
      ).rejects.toMatchObject({ status: 403 });

      // 5. 夹带跨域 Cookie 必须被服务端二次校验拦截（400）
      await expect(
        bridge.respondCookieApproval({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          requestId: req.requestId,
          decision: {
            approved: true,
            cookies: [
              {
                name: "gh_sess",
                value: "ok",
                domain: "github.com",
                path: "/",
                httpOnly: true,
                secure: true,
              },
              {
                name: "stolen",
                value: "evil",
                domain: "evil-github.com",
                path: "/",
                httpOnly: true,
                secure: true,
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ status: 400 });

      // 合法单域名 Cookie 放行
      const waitRes = bridge.waitForCookieApproval("user-a", req.requestId);
      const approved = await bridge.respondCookieApproval({
        ownerUserId: "user-a",
        deviceId: "dev_a1",
        requestId: req.requestId,
        decision: {
          approved: true,
          cookies: [
            {
              name: "user_session",
              value: "secret-cookie-val",
              domain: ".github.com",
              path: "/",
              httpOnly: true,
              secure: true,
            },
          ],
        },
      });
      expect(approved.cookies).toHaveLength(1);
      expect((await waitRes).status).toBe("approved");

      // 6. 超时过期校验
      const req2 = await bridge.createCookieApproval({
        ownerUserId: "user-a",
        deviceId: "dev_a1",
        botId: "bot-1",
        origin: "https://gitlab.com",
        timeoutMs: 2000,
      });
      clock += 3000;
      await expect(
        bridge.respondCookieApproval({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          requestId: req2.requestId,
          decision: { approved: false },
        }),
      ).rejects.toBeInstanceOf(DesktopBrowserBridgeError);
      expect(
        bridge
          .listCookieApprovals("user-a", { deviceId: "dev_a1" })
          .find((item) => item.requestId === req2.requestId)?.status,
      ).toBe("expired");
    } finally {
      bridge.dispose();
    }
  });

  test("WebAuthn/Passkey 跨端转发：rpId 强校验、一次性 challenge 防重放与 Harness 开关拦截", async () => {
    let flags = { ...DEFAULT_HARNESS_FLAGS };
    const devA1 = makeDevice({
      id: "dev_a1",
      ownerUserId: "user-a",
      platform: "darwin",
    });
    const bridge = createDesktopBrowserBridge({
      deviceStore: {
        get: async (id) => (id === devA1.id ? devA1 : null),
        forOwner: async () => [devA1],
        audit: async () => "audit-id",
      },
      getHarnessFlags: () => flags,
    });

    try {
      await bridge.setDeviceScopes("user-a", "dev_a1", ["passkey_forward"]);

      // 1. rpId 与 origin 不匹配 -> 400 拒绝
      await expect(
        bridge.createWebAuthnRequest({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          botId: "bot-1",
          kind: "get",
          origin: "https://app.example.com",
          rpId: "other.com",
          challenge: "abcdefghijklmnop123456",
        }),
      ).rejects.toMatchObject({ status: 400 });

      // 2. 公共顶级后缀作为 rpId -> 400 拒绝
      await expect(
        bridge.createWebAuthnRequest({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          botId: "bot-1",
          kind: "get",
          origin: "https://app.co.uk",
          rpId: "co.uk",
          challenge: "abcdefghijklmnop123456",
        }),
      ).rejects.toMatchObject({ status: 400 });

      // 3. 合法子域 rpId 放行
      const challenge = "one-time-challenge-abcdef123456";
      const created = await bridge.createWebAuthnRequest({
        ownerUserId: "user-a",
        deviceId: "dev_a1",
        botId: "bot-1",
        kind: "get",
        origin: "https://login.example.com",
        rpId: "example.com",
        challenge,
      });
      expect(created.status).toBe("pending");

      // 4. 同一 challenge 二次提交必须触发防重放拦截（409）
      await expect(
        bridge.createWebAuthnRequest({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          botId: "bot-1",
          kind: "get",
          origin: "https://login.example.com",
          rpId: "example.com",
          challenge,
        }),
      ).rejects.toMatchObject({ status: 409 });

      // 5. 完成后再次重放同一 challenge 仍必须被拦截（409）
      const completed = await bridge.respondWebAuthn({
        ownerUserId: "user-a",
        deviceId: "dev_a1",
        requestId: created.requestId,
        response: {
          ok: true,
          credentialId: "cred-1",
          clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
          authenticatorData: "auth-data",
          signature: "sig-bytes",
        },
      });
      expect(completed.status).toBe("completed");
      await expect(
        bridge.createWebAuthnRequest({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          botId: "bot-1",
          kind: "get",
          origin: "https://login.example.com",
          rpId: "example.com",
          challenge,
        }),
      ).rejects.toMatchObject({ status: 409 });

      // 6. Harness passkeyForward 关闭时 409 拒绝
      flags = { ...DEFAULT_HARNESS_FLAGS, passkeyForward: false };
      await expect(
        bridge.createWebAuthnRequest({
          ownerUserId: "user-a",
          deviceId: "dev_a1",
          botId: "bot-1",
          kind: "create",
          origin: "https://login.example.com",
          rpId: "example.com",
          challenge: "fresh-challenge-zzzz999999",
        }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      bridge.dispose();
    }
  });

  test("PC 端 browser-bridge：Profile 发现、显式确认拦截与单域名 Cookie 过滤", async () => {
    const fakeHome = await makeTempDir("cb-browser-home-");
    const chromeUserData = path.join(
      fakeHome,
      "AppData",
      "Local",
      "Google",
      "Chrome",
      "User Data",
    );
    const defaultProfile = path.join(chromeUserData, "Default", "Network");
    await fsp.mkdir(defaultProfile, { recursive: true });
    await fsp.writeFile(path.join(defaultProfile, "Cookies"), "sqlite-stub");
    await fsp.writeFile(
      path.join(chromeUserData, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "个人账号" } } },
      }),
    );

    const profiles = await browserBridgePc.discoverBrowserProfiles({
      platform: "win32",
      homeDir: fakeHome,
      env: { LOCALAPPDATA: path.join(fakeHome, "AppData", "Local") },
    });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.displayName).toBe("个人账号");
    expect(profiles[0]?.cookieDbPath).not.toContain("\\");

    // 缺少 browser_bridge scope 时拒绝
    const deniedClient = browserBridgePc.createDesktopBrowserBridgeClient({
      getGrantedScopes: () => [],
      confirmApproval: async () => true,
    });
    const deniedRes = await deniedClient.handleCookieApprovalRequest({
      requestId: "r1",
      origin: "https://example.com",
    });
    expect(deniedRes.approved).toBe(false);

    // 正常审批只输出目标单域名 Cookie，自动过滤非目标域 Cookie
    const client = browserBridgePc.createDesktopBrowserBridgeClient({
      getGrantedScopes: () => ["browser_bridge"],
      listProfiles: async () => profiles,
      confirmApproval: async () => true,
      readCookies: async () => [
        {
          name: "sid",
          value: "abc",
          domain: ".example.com",
          path: "/",
          httpOnly: true,
          secure: true,
        },
        {
          name: "other",
          value: "xyz",
          domain: "attacker.com",
          path: "/",
          httpOnly: true,
          secure: true,
        },
      ],
    });
    const approved = await client.handleCookieApprovalRequest({
      requestId: "r2",
      origin: "https://app.example.com",
    });
    expect(approved.approved).toBe(true);
    const cookies = approved.cookies as Array<{ name: string }>;
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.name).toBe("sid");
  });
});

describe("Wave 9: 服务端 4 MiB 分块流式上传（重组、越权拦截、修改期变更拒绝、临时目录零泄漏）", () => {
  test("多块上传重组落入 chat_files、跨用户越权拦截、mtimeMs 变更拒绝与临时目录自动回收", async () => {
    const tempRoot = await makeTempDir("cb-chunked-srv-");
    const stored: Array<{
      owner: string;
      agentId: string;
      name: string;
      bytes: Buffer;
      mimeType: string;
    }> = [];
    const service = createChunkedUploadService({
      ownsBot: async (owner, agentId) =>
        owner === "user-a" && agentId === "bot-1",
      commitFile: async (owner, agentId, file) => {
        stored.push({ owner, agentId, ...file });
        const view: ChatFileView = {
          id: `cf_${randomUUID().slice(0, 8)}`,
          name: file.name,
          mimeType: file.mimeType,
          size: file.bytes.length,
          kind: "upload",
          url: "/api/chat-files/test",
          workspacePath: null,
          createdAt: new Date().toISOString(),
        };
        return view;
      },
      tempRoot,
    });

    const appUserA = new Hono<{ Variables: AppVariables }>();
    appUserA.route(
      "/api/chat-files/chunked",
      service.routes(fakeRequireUser("user-a")),
    );
    const appUserB = new Hono<{ Variables: AppVariables }>();
    appUserB.route(
      "/api/chat-files/chunked",
      service.routes(fakeRequireUser("user-b")),
    );

    try {
      // 1. 构造跨越多个分块的文件（使用 1024 字节分块便于快速单测，协议兼容 <= CHUNK_BYTES=4MiB）
      const payload = Buffer.concat([
        Buffer.from("%PDF-1.7\n"),
        Buffer.alloc(2500, 0x41),
      ]);
      const sha256 = createHash("sha256").update(payload).digest("hex");
      const mtimeMs = 1_700_000_123_456;

      const initRes = await appUserA.request("/api/chat-files/chunked/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "bot-1",
          filename: "report.pdf",
          mimeType: "application/pdf",
          totalSize: payload.length,
          mtimeMs,
          chunkSize: 1024,
          sha256,
        }),
      });
      expect(initRes.status).toBe(201);
      const initBody = (await initRes.json()) as {
        uploadId: string;
        totalChunks: number;
      };
      expect(initBody.totalChunks).toBe(3);
      expect(CHUNK_BYTES).toBe(4 * 1024 * 1024);

      // 2. 跨用户 user-b 尝试往 user-a 的 uploadId 写块或删除，一律 404 拦截
      const hijackPut = await appUserB.request(
        `/api/chat-files/chunked/${initBody.uploadId}/0`,
        {
          method: "PUT",
          body: payload.subarray(0, 1024),
        },
      );
      expect(hijackPut.status).toBe(404);
      const hijackDel = await appUserB.request(
        `/api/chat-files/chunked/${initBody.uploadId}`,
        { method: "DELETE" },
      );
      expect(hijackDel.status).toBe(404);

      // 3. 依次上传 3 个分块并提交重组
      for (let i = 0; i < initBody.totalChunks; i += 1) {
        const chunk = payload.subarray(
          i * 1024,
          Math.min(payload.length, (i + 1) * 1024),
        );
        const putRes = await appUserA.request(
          `/api/chat-files/chunked/${initBody.uploadId}/${i}`,
          {
            method: "PUT",
            headers: {
              "x-file-mtime-ms": String(mtimeMs),
              "x-file-size": String(payload.length),
            },
            body: chunk,
          },
        );
        expect(putRes.status).toBe(200);
      }

      const commitRes = await appUserA.request(
        `/api/chat-files/chunked/${initBody.uploadId}/commit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mtimeMs, size: payload.length, sha256 }),
        },
      );
      expect(commitRes.status).toBe(201);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.bytes.equals(payload)).toBe(true);
      expect(stored[0]?.mimeType).toBe("application/pdf");
      // commit 完成后任务专属临时目录必须已彻底清空
      expect(service.activeCount).toBe(0);
      expect(await fsp.readdir(tempRoot)).toEqual([]);

      // 4. 修改期指纹 mtimeMs 变更拒绝（防上传半截文件被修改）
      const init2 = await appUserA.request("/api/chat-files/chunked/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "bot-1",
          filename: "demo.mp4",
          mimeType: "video/mp4",
          totalSize: 2048,
          mtimeMs: 1000,
          chunkSize: 1024,
        }),
      });
      expect(init2.status).toBe(201);
      const { uploadId: up2 } = (await init2.json()) as { uploadId: string };
      const changedRes = await appUserA.request(
        `/api/chat-files/chunked/${up2}/0`,
        {
          method: "PUT",
          headers: {
            "x-file-mtime-ms": "2000",
            "x-file-size": "2048",
          },
          body: Buffer.alloc(1024, 0x55),
        },
      );
      expect(changedRes.status).toBe(409);
      expect(service.activeCount).toBe(0);
      expect(await fsp.readdir(tempRoot)).toEqual([]);
    } finally {
      await service.dispose();
    }
  });
});
