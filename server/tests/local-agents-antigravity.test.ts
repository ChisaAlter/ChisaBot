/**
 * Antigravity 托管运行时安装、状态查询、OOB 登录与退出编排测试。
 *
 * 全程 DB-free（按 SQL 特征分派的内存假库，不 mock 模块），覆盖：
 * - 权限与校验（非管理员写 server 403、普通成员只读 server 200、非 antigravity 400、离线 409、zod 400）
 * - runtime 状态查询与超时/错误降级，以及 agent_probe 携带 instance.id/slug/name
 * - install 互斥幂等、进度流转、成功自动重探同宿主 antigravity 实例、cancel、跨设备防伪造
 * - OOB login 完整闭环（start → awaiting_auth/authUrl → submit(code) → result(succeeded) → 自动重探）与零敏感日志
 * - logout 闭环（清理登录会话 + 刷新 probe）与失败/超时兜底
 * - server-host 全 6 条新上行消息直转链路（绕过 task 表直达 handleNodeMessage）
 * - forgetDevice 清理 pending 请求与内存态
 */
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import {
  type AntigravityRuntimeStatus,
  SERVER_ENVIRONMENT_ID,
} from "../../shared/agent-providers";
import { defaultCapabilities } from "../../shared/devices";
import { LOCAL_AGENT_MESSAGE_TYPES } from "../../shared/local-agents";
import type { AppVariables } from "../src/auth/guards";
import type { ChisaBotRole } from "../src/auth/roles";
import type { DeviceRecord } from "../src/devices/store";
import { createLocalAgentService } from "../src/local-agents/service";

type Row = Record<string, unknown>;
type Json = string | number | boolean | null | undefined;
type SentMsg = { envId: string; message: Record<string, unknown> };

const ADMIN = "u_admin";
const MEMBER = "u_member";
const OTHER = "u_other";
const PC_DEV_ID = "dev_pc_1";
const PC_DEV_2_ID = "dev_pc_2";

function makeDevice(over: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: PC_DEV_ID,
    ownerUserId: MEMBER,
    name: "我的笔记本",
    platform: "win32",
    osVersion: "10.0.22631",
    hostname: "laptop",
    arch: "x64",
    clientVersion: "0.2.0",
    capabilities: {
      ...defaultCapabilities(),
      shell: "allow",
      files_read: "allow",
      files_write: "allow",
    },
    allowedRoots: ["C:\\Work"],
    paused: false,
    revoked: false,
    lastSeenAt: new Date().toISOString(),
    lastIp: "127.0.0.1",
    createdAt: new Date(0).toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "tok",
    ...over,
  };
}

function makeSettingsRow(deviceId: string, memberAccess = false): Row {
  return {
    device_id: deviceId,
    owner_user_id: deviceId === SERVER_ENVIRONMENT_ID ? "system" : MEMBER,
    profile: "workspace",
    workspace_roots: [],
    network: true,
    isolation: "worktree",
    default_agent: "builtin",
    builtin_model: null,
    container_image: null,
    detected: null,
    member_access: memberAccess,
    updated_at: new Date().toISOString(),
  };
}

function makeInstanceRow(over: Row = {}): Row {
  return {
    id: `agi_${Math.random().toString(36).slice(2, 10)}`,
    owner_user_id: MEMBER,
    environment_id: PC_DEV_ID,
    slug: "antigravity",
    driver: "antigravity",
    name: "Antigravity",
    description: "",
    enabled: true,
    expose_as_tool: true,
    is_default_seed: false,
    sort_order: 0,
    config: {},
    env_vars: [],
    probe: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function sampleRuntimeStatus(
  over: Partial<AntigravityRuntimeStatus> = {},
): AntigravityRuntimeStatus {
  return {
    installed: true,
    source: "managed",
    managedInstalled: true,
    managedVersion: "1.5.16",
    managedBinaryPath:
      "/data/.chisabot/tools/antigravity/win32-x64/versions/1.5.16/agy.exe",
    systemBinaryPath: null,
    activeBinaryPath:
      "/data/.chisabot/tools/antigravity/win32-x64/versions/1.5.16/agy.exe",
    activeVersion: "1.5.16",
    platformKey: "win32-x64",
    toolsDir: "/data/.chisabot/tools/antigravity/win32-x64",
    latestVersion: "1.5.16",
    updateAvailable: false,
    supported: true,
    unsupportedReason: null,
    ...over,
  };
}

function createFakeDb(seed: { settings?: Row[]; instances?: Row[] }) {
  const tables = {
    settings: [...(seed.settings ?? [])],
    instances: [...(seed.instances ?? [])],
  };
  const queries: string[] = [];

  const unsafe = async (
    query: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    const q = String(query).replace(/\s+/g, " ").trim();
    queries.push(q);
    const p = params as Json[];

    if (q.startsWith("SELECT * FROM chisabot_device_agent_settings")) {
      return tables.settings.filter((r) => r.device_id === p[0]);
    }
    if (
      q.startsWith(
        "SELECT id, owner_user_id FROM chisabot_agent_instances WHERE environment_id = $1 AND driver = $2",
      )
    ) {
      return tables.instances
        .filter((r) => r.environment_id === p[0] && r.driver === p[1])
        .map((r) => ({ id: r.id, owner_user_id: r.owner_user_id }));
    }
    if (q.startsWith("SELECT * FROM chisabot_agent_instances WHERE id =")) {
      return tables.instances.filter(
        (r) => r.id === p[0] && r.owner_user_id === p[1],
      );
    }
    if (q.startsWith("SELECT * FROM chisabot_agent_instances")) {
      return tables.instances.filter(
        (r) =>
          r.owner_user_id === p[0] &&
          (p[1] === undefined || r.environment_id === p[1]),
      );
    }
    if (
      q.startsWith("UPDATE chisabot_agent_instances") &&
      q.includes("probe =")
    ) {
      const idx = tables.instances.findIndex(
        (r) => r.id === p[0] && r.owner_user_id === p[1],
      );
      if (idx < 0) return [];
      const row = tables.instances[idx];
      if (!row) return [];
      row.probe = p[2] ? JSON.parse(String(p[2])) : null;
      row.updated_at = new Date().toISOString();
      return [row];
    }
    if (
      q.startsWith(
        "DELETE FROM chisabot_device_agent_settings WHERE device_id = $1",
      )
    ) {
      tables.settings = tables.settings.filter((r) => r.device_id !== p[0]);
      return [];
    }
    if (
      q.startsWith(
        "DELETE FROM chisabot_agent_instances WHERE environment_id = $1",
      )
    ) {
      tables.instances = tables.instances.filter(
        (r) => r.environment_id !== p[0],
      );
      return [];
    }
    if (q.startsWith("DELETE FROM chisabot_agent_instances WHERE id = $1")) {
      const idx = tables.instances.findIndex(
        (r) => r.id === p[0] && r.owner_user_id === p[1],
      );
      if (idx < 0) return [];
      tables.instances.splice(idx, 1);
      return [{ id: p[0] }];
    }
    return [];
  };

  return {
    tables,
    queries,
    database: { $client: { unsafe } } as never,
  };
}

function setupHarness(opts: {
  devices?: DeviceRecord[];
  onlineDevices?: string[];
  memberAccess?: boolean;
  instances?: Row[];
  useServerHostFactory?: boolean;
  runtimeStatusTimeoutMs?: number;
  runtimeLogoutTimeoutMs?: number;
  onSend?: (
    envId: string,
    message: Record<string, unknown>,
    emitServerMessage: (
      msg: { type: string } & Record<string, unknown>,
    ) => void,
  ) => void;
}) {
  const devices = new Map<string, DeviceRecord>(
    (opts.devices ?? [makeDevice()]).map((d) => [d.id, d]),
  );
  const onlineSet = new Set<string>(opts.onlineDevices ?? [PC_DEV_ID]);
  const sent: SentMsg[] = [];
  let serverEmit:
    | ((msg: { type: string } & Record<string, unknown>) => void)
    | null = null;

  const db = createFakeDb({
    settings: [
      makeSettingsRow(SERVER_ENVIRONMENT_ID, opts.memberAccess ?? false),
      ...[...devices.keys()].map((id) => makeSettingsRow(id, false)),
    ],
    instances: opts.instances ?? [],
  });

  const hub = {
    isOnline: (id: string) => onlineSet.has(id),
    sendRaw: (id: string, message: Record<string, unknown>) => {
      if (!onlineSet.has(id)) return false;
      sent.push({ envId: id, message });
      opts.onSend?.(id, message, (m) => serverEmit?.(m));
      return true;
    },
  };

  const deviceStore = {
    get: async (id: string) => devices.get(id) ?? null,
    forOwner: async (ownerUserId: string) =>
      [...devices.values()].filter((d) => d.ownerUserId === ownerUserId),
    audit: async () => {},
  };

  const roles: Record<string, ChisaBotRole> = {
    [ADMIN]: "admin",
    [MEMBER]: "user",
    [OTHER]: "user",
  };

  const service = createLocalAgentService({
    database: db.database,
    hub: hub as never,
    deviceStore: deviceStore as never,
    roleForUser: async (uid) => roles[uid] ?? null,
    runtimeStatusTimeoutMs: opts.runtimeStatusTimeoutMs ?? 200,
    runtimeLogoutTimeoutMs: opts.runtimeLogoutTimeoutMs ?? 200,
    ...(opts.useServerHostFactory
      ? {
          serverHostFactory: ({ onMessage }) => {
            serverEmit = onMessage;
            return {
              id: SERVER_ENVIRONMENT_ID,
              sendRaw: (message) => {
                sent.push({ envId: SERVER_ENVIRONMENT_ID, message });
                opts.onSend?.(SERVER_ENVIRONMENT_ID, message, onMessage);
                return true;
              },
              detect: async () => {},
              setPaused: () => {},
              stopAll: () => {},
              running: 0,
            };
          },
        }
      : {
          serverHost: {
            id: SERVER_ENVIRONMENT_ID,
            sendRaw: (message) => {
              sent.push({ envId: SERVER_ENVIRONMENT_ID, message });
              opts.onSend?.(SERVER_ENVIRONMENT_ID, message, () => {});
              return true;
            },
            detect: async () => {},
            setPaused: () => {},
            stopAll: () => {},
            running: 0,
          },
        }),
  });

  function appFor(actorId: string, role: ChisaBotRole) {
    const auth: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", {
        id: actorId,
        role,
        email: `${actorId}@example.com`,
        name: actorId,
      } as AppVariables["actor"]);
      await next();
    };
    const app = new Hono();
    app.route("/api/local-agents", service.routes(auth));
    return app;
  }

  return {
    service,
    db,
    sent,
    devices,
    onlineSet,
    appFor,
    emitServerMessage: (msg: { type: string } & Record<string, unknown>) => {
      if (!serverEmit) {
        throw new Error("serverHostFactory not enabled");
      }
      serverEmit(msg);
    },
  };
}

async function waitMicrotasks(turns = 5) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Antigravity 托管协议与 HTTP 编排", () => {
  test("权限与参数拦截：非 admin 写 server 返 403、非 antigravity 返 400、离线环境返 409", async () => {
    const serverAg = makeInstanceRow({
      id: "agi_srv_ag",
      owner_user_id: MEMBER,
      environment_id: SERVER_ENVIRONMENT_ID,
      driver: "antigravity",
      slug: "antigravity",
    });
    const pcCodex = makeInstanceRow({
      id: "agi_pc_codex",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "codex",
      slug: "codex",
    });
    const offlineAg = makeInstanceRow({
      id: "agi_pc_offline",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_2_ID,
      driver: "antigravity",
      slug: "ag-off",
    });

    const h = setupHarness({
      devices: [
        makeDevice({ id: PC_DEV_ID, ownerUserId: MEMBER }),
        makeDevice({ id: PC_DEV_2_ID, ownerUserId: MEMBER, name: "离线电脑" }),
      ],
      onlineDevices: [PC_DEV_ID],
      memberAccess: true,
      instances: [serverAg, pcCodex, offlineAg],
      onSend: (envId, msg) => {
        if (msg.type === "agent_runtime_status") {
          queueMicrotask(() => {
            void h.service.handleNodeMessage(
              makeDevice({ id: envId, ownerUserId: "system" }),
              {
                type: "agent_runtime_status_result",
                reqId: msg.reqId,
                ok: true,
                status: sampleRuntimeStatus(),
              },
            );
          });
        }
      },
    });

    const memberApp = h.appFor(MEMBER, "user");
    const otherApp = h.appFor(OTHER, "user");

    // 普通成员在 memberAccess=true 时可只读看 server runtime
    const readServer = await memberApp.request(
      "/api/local-agents/environments/server/antigravity/runtime",
    );
    expect(readServer.status).toBe(200);
    const readServerJson = (await readServer.json()) as {
      online: boolean;
      runtime: AntigravityRuntimeStatus | null;
    };
    expect(readServerJson.online).toBe(true);
    expect(readServerJson.runtime?.managedVersion).toBe("1.5.16");

    // 普通成员对 server 写接口全部 403
    for (const [path, body] of [
      ["/api/local-agents/environments/server/antigravity/install", {}],
      ["/api/local-agents/environments/server/antigravity/install/cancel", {}],
      ["/api/local-agents/instances/agi_srv_ag/antigravity/login", {}],
      [
        "/api/local-agents/instances/agi_srv_ag/antigravity/login/submit",
        { code: "abc" },
      ],
      ["/api/local-agents/instances/agi_srv_ag/antigravity/login/cancel", {}],
      ["/api/local-agents/instances/agi_srv_ag/antigravity/logout", {}],
    ] as const) {
      const res = await memberApp.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }

    // 非 antigravity 实例返回 400
    expect(
      (
        await memberApp.request(
          "/api/local-agents/instances/agi_pc_codex/antigravity/login",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await memberApp.request(
          "/api/local-agents/instances/agi_pc_codex/antigravity/login",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await memberApp.request(
          "/api/local-agents/instances/agi_pc_codex/antigravity/logout",
          { method: "POST" },
        )
      ).status,
    ).toBe(400);

    // 其他用户无权查看他人实例登录会话（404）
    expect(
      (
        await otherApp.request(
          "/api/local-agents/instances/agi_pc_offline/antigravity/login",
        )
      ).status,
    ).toBe(404);

    // 离线设备：GET runtime 返回 online=false，写接口全部 409
    const offRuntime = await memberApp.request(
      `/api/local-agents/environments/${PC_DEV_2_ID}/antigravity/runtime`,
    );
    expect(offRuntime.status).toBe(200);
    expect(await offRuntime.json()).toEqual({
      online: false,
      runtime: null,
      installJob: null,
    });

    expect(
      (
        await memberApp.request(
          `/api/local-agents/environments/${PC_DEV_2_ID}/antigravity/install`,
          { method: "POST" },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await memberApp.request(
          "/api/local-agents/instances/agi_pc_offline/antigravity/login",
          { method: "POST" },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await memberApp.request(
          "/api/local-agents/instances/agi_pc_offline/antigravity/logout",
          { method: "POST" },
        )
      ).status,
    ).toBe(409);
  });

  test("runtime 状态查询支持 checkLatest=1、超时降级不 500，且 probe 携带 id/slug/name", async () => {
    const agInst = makeInstanceRow({
      id: "agi_probe_id_1",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "antigravity",
      slug: "ag-work",
      name: "工作 Antigravity",
    });
    let shouldReplyStatus = true;
    const pcRecord = makeDevice();
    const h = setupHarness({
      devices: [pcRecord],
      onlineDevices: [PC_DEV_ID],
      instances: [agInst],
      runtimeStatusTimeoutMs: 40,
      onSend: (_envId, msg) => {
        if (msg.type === "agent_runtime_status" && shouldReplyStatus) {
          queueMicrotask(() => {
            void h.service.handleNodeMessage(pcRecord, {
              type: "agent_runtime_status_result",
              reqId: msg.reqId,
              ok: true,
              status: sampleRuntimeStatus({
                latestVersion: "1.6.0",
                updateAvailable: true,
              }),
            });
          });
        }
        if (msg.type === "agent_probe") {
          queueMicrotask(() => {
            void h.service.handleNodeMessage(pcRecord, {
              type: "agent_probe_result",
              reqId: msg.reqId,
              probe: {
                status: "available",
                version: "1.5.16",
                resolvedPath: "/tools/agy.exe",
                authenticated: true,
                authLabel: "dev@example.com",
                runtimeSource: "managed",
                homePath: "/data/agent-homes/antigravity/agi_probe_id_1",
                message: "可用",
              },
            });
          });
        }
      },
    });

    const app = h.appFor(MEMBER, "user");
    const r1 = await app.request(
      `/api/local-agents/environments/${PC_DEV_ID}/antigravity/runtime?checkLatest=1`,
    );
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as {
      online: boolean;
      runtime: AntigravityRuntimeStatus | null;
    };
    expect(j1.online).toBe(true);
    expect(j1.runtime?.updateAvailable).toBe(true);
    const statusMsg = h.sent.find(
      (s) => s.message.type === "agent_runtime_status",
    );
    expect(statusMsg?.message.checkLatest).toBe(true);

    // 超时降级不 500
    shouldReplyStatus = false;
    const r2 = await app.request(
      `/api/local-agents/environments/${PC_DEV_ID}/antigravity/runtime`,
    );
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as {
      online: boolean;
      runtime: AntigravityRuntimeStatus | null;
      error?: string;
    };
    expect(j2.online).toBe(true);
    expect(j2.runtime).toBeNull();
    expect(typeof j2.error).toBe("string");

    // probeInstance 下发 agent_probe 必须带 id / slug / name，并落库 runtimeSource / homePath
    const probed = await h.service.probeInstance(MEMBER, "agi_probe_id_1");
    const probeMsg = h.sent.find((s) => s.message.type === "agent_probe");
    const sentInst = probeMsg?.message.instance as Record<string, unknown>;
    expect(sentInst.id).toBe("agi_probe_id_1");
    expect(sentInst.slug).toBe("ag-work");
    expect(sentInst.name).toBe("工作 Antigravity");
    expect(probed.probe?.runtimeSource).toBe("managed");
    expect(probed.probe?.homePath).toBe(
      "/data/agent-homes/antigravity/agi_probe_id_1",
    );
  });

  test("install 互斥幂等 + 进度流转 + 跨设备隔离 + 完成后自动重探 + cancel", async () => {
    const pcRecord = makeDevice();
    const otherRecord = makeDevice({ id: PC_DEV_2_ID, ownerUserId: OTHER });
    const ag1 = makeInstanceRow({
      id: "agi_ag_1",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "antigravity",
      slug: "ag-1",
    });
    const ag2 = makeInstanceRow({
      id: "agi_ag_2",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "antigravity",
      slug: "ag-2",
    });
    const codex1 = makeInstanceRow({
      id: "agi_codex_1",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "codex",
      slug: "codex-1",
    });

    const probedIds: string[] = [];
    const h = setupHarness({
      devices: [pcRecord, otherRecord],
      onlineDevices: [PC_DEV_ID, PC_DEV_2_ID],
      instances: [ag1, ag2, codex1],
      onSend: (_envId, msg) => {
        if (msg.type === "agent_probe") {
          const inst = msg.instance as { id?: string };
          if (inst.id) probedIds.push(inst.id);
          queueMicrotask(() => {
            void h.service.handleNodeMessage(pcRecord, {
              type: "agent_probe_result",
              reqId: msg.reqId,
              probe: {
                status: "unauthenticated",
                version: "1.5.16",
                resolvedPath: "/tools/agy.exe",
                authenticated: false,
                authLabel: null,
                runtimeSource: "managed",
                homePath: `/homes/${inst.id ?? "x"}`,
                message: "尚未登录",
              },
            });
          });
        }
        if (msg.type === "agent_runtime_status") {
          queueMicrotask(() => {
            void h.service.handleNodeMessage(pcRecord, {
              type: "agent_runtime_status_result",
              reqId: msg.reqId,
              ok: true,
              status: sampleRuntimeStatus(),
            });
          });
        }
      },
    });

    const app = h.appFor(MEMBER, "user");

    // 首次安装启动
    const start1 = await app.request(
      `/api/local-agents/environments/${PC_DEV_ID}/antigravity/install`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      },
    );
    expect(start1.status).toBe(200);
    const job1 = (
      (await start1.json()) as { installJob: { jobId: string; status: string } }
    ).installJob;
    expect(job1.status).toBe("running");

    // 并发/重复安装幂等返回同一个 jobId，且只下发一次 agent_runtime_install
    const start2 = await app.request(
      `/api/local-agents/environments/${PC_DEV_ID}/antigravity/install`,
      { method: "POST" },
    );
    expect(start2.status).toBe(200);
    const job2 = ((await start2.json()) as { installJob: { jobId: string } })
      .installJob;
    expect(job2.jobId).toBe(job1.jobId);
    expect(
      h.sent.filter((s) => s.message.type === "agent_runtime_install").length,
    ).toBe(1);

    // 其他设备伪造进度必须被忽略
    await h.service.handleNodeMessage(otherRecord, {
      type: "agent_runtime_install_progress",
      jobId: job1.jobId,
      stage: "downloading",
      percent: 99,
      downloadedBytes: 999,
      totalBytes: 1000,
    });

    // 本设备正常进度上报
    await h.service.handleNodeMessage(pcRecord, {
      type: "agent_runtime_install_progress",
      jobId: job1.jobId,
      stage: "downloading",
      percent: 42,
      downloadedBytes: 4200,
      totalBytes: 10000,
      message: "正在下载 Antigravity CLI…",
    });

    const mid = (await (
      await app.request(
        `/api/local-agents/environments/${PC_DEV_ID}/antigravity/runtime`,
      )
    ).json()) as {
      installJob: {
        stage: string;
        percent: number;
        downloadedBytes: number;
        totalBytes: number;
      };
    };
    expect(mid.installJob.stage).toBe("downloading");
    expect(mid.installJob.percent).toBe(42);
    expect(mid.installJob.downloadedBytes).toBe(4200);
    expect(mid.installJob.totalBytes).toBe(10000);

    // 安装完成 → 状态 succeeded + 自动重探该宿主下全部 antigravity 实例（不探 codex）
    await h.service.handleNodeMessage(pcRecord, {
      type: "agent_runtime_install_result",
      jobId: job1.jobId,
      ok: true,
      version: "1.5.16",
      binaryPath: "/tools/agy.exe",
    });
    await waitMicrotasks(10);

    expect(probedIds.sort()).toEqual(["agi_ag_1", "agi_ag_2"]);
    const updatedRow1 = h.db.tables.instances.find((r) => r.id === "agi_ag_1");
    expect((updatedRow1?.probe as { version?: string })?.version).toBe(
      "1.5.16",
    );

    // 启动第二次安装并取消
    const start3 = await app.request(
      `/api/local-agents/environments/${PC_DEV_ID}/antigravity/install`,
      { method: "POST" },
    );
    const job3 = ((await start3.json()) as { installJob: { jobId: string } })
      .installJob;
    expect(job3.jobId).not.toBe(job1.jobId);

    const cancelRes = await app.request(
      `/api/local-agents/environments/${PC_DEV_ID}/antigravity/install/cancel`,
      { method: "POST" },
    );
    expect(cancelRes.status).toBe(200);
    const cancelledJob = (
      (await cancelRes.json()) as {
        installJob: {
          jobId: string;
          status: string;
          finishedAt: string | null;
        };
      }
    ).installJob;
    expect(cancelledJob.jobId).toBe(job3.jobId);
    expect(cancelledJob.status).toBe("cancelled");
    expect(cancelledJob.finishedAt).not.toBeNull();
    expect(
      h.sent.some(
        (s) =>
          s.message.type === "agent_runtime_install_cancel" &&
          s.message.jobId === job3.jobId,
      ),
    ).toBe(true);
  });

  test("OOB login 完整闭环（start → awaiting_auth → submit → succeeded → 重探）与零敏感日志", async () => {
    const pcRecord = makeDevice();
    const agInst = makeInstanceRow({
      id: "agi_login_1",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "antigravity",
      slug: "ag-personal",
      name: "个人 Antigravity",
      config: { homePath: "/custom/ag-home" },
    });

    const h = setupHarness({
      devices: [pcRecord],
      onlineDevices: [PC_DEV_ID],
      instances: [agInst],
      onSend: (_envId, msg) => {
        if (msg.type === "agent_probe") {
          queueMicrotask(() => {
            void h.service.handleNodeMessage(pcRecord, {
              type: "agent_probe_result",
              reqId: msg.reqId,
              probe: {
                status: "available",
                version: "1.5.16",
                resolvedPath: "/tools/agy.exe",
                authenticated: true,
                authLabel: "alice@example.com",
                runtimeSource: "managed",
                homePath: "/custom/ag-home",
                message: "已认证",
              },
            });
          });
        }
      },
    });

    const app = h.appFor(MEMBER, "user");
    const secretAuthUrl =
      "https://accounts.google.com/o/oauth2/auth?state=SECRET_STATE_999&code_challenge=PKCE_XYZ";
    const secretCode = "4/0A_SECRET_AUTH_CODE_777";

    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) =>
      logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) =>
      logs.push(args.map(String).join(" "));

    try {
      // 1. 发起登录
      const startRes = await app.request(
        "/api/local-agents/instances/agi_login_1/antigravity/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ authMethodId: "oauth-personal" }),
        },
      );
      expect(startRes.status).toBe(200);
      const s1 = (
        (await startRes.json()) as {
          session: { sessionId: string; status: string; stage: string };
        }
      ).session;
      expect(s1.status).toBe("running");
      expect(s1.stage).toBe("starting");

      const loginStartMsg = h.sent.find(
        (s) => s.message.type === "agent_runtime_login_start",
      );
      expect(loginStartMsg?.message.authMethodId).toBe("oauth-personal");
      const sentInst = loginStartMsg?.message.instance as Record<
        string,
        unknown
      >;
      expect(sentInst.id).toBe("agi_login_1");
      expect(sentInst.slug).toBe("ag-personal");

      // 幂等重入返回相同 sessionId
      const startAgain = await app.request(
        "/api/local-agents/instances/agi_login_1/antigravity/login",
        { method: "POST" },
      );
      expect(
        ((await startAgain.json()) as { session: { sessionId: string } })
          .session.sessionId,
      ).toBe(s1.sessionId);

      // 2. 节点推送 awaiting_auth + authUrl
      await h.service.handleNodeMessage(pcRecord, {
        type: "agent_runtime_login_event",
        sessionId: s1.sessionId,
        stage: "awaiting_auth",
        authUrl: secretAuthUrl,
        userCode: "ABCD-1234",
        message: "请在浏览器完成授权并粘贴授权码",
      });

      const poll1 = (await (
        await app.request(
          "/api/local-agents/instances/agi_login_1/antigravity/login",
        )
      ).json()) as {
        session: {
          status: string;
          stage: string;
          authUrl: string | null;
          userCode: string | null;
        };
      };
      expect(poll1.session.status).toBe("awaiting_auth");
      expect(poll1.session.stage).toBe("awaiting_auth");
      expect(poll1.session.authUrl).toBe(secretAuthUrl);
      expect(poll1.session.userCode).toBe("ABCD-1234");

      // 校验 zod 拦空 code 与不匹配 sessionId
      expect(
        (
          await app.request(
            "/api/local-agents/instances/agi_login_1/antigravity/login/submit",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code: "   " }),
            },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await app.request(
            "/api/local-agents/instances/agi_login_1/antigravity/login/submit",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code: secretCode, sessionId: "wrong_id" }),
            },
          )
        ).status,
      ).toBe(409);

      // 3. 提交授权码
      const submitRes = await app.request(
        "/api/local-agents/instances/agi_login_1/antigravity/login/submit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: secretCode, sessionId: s1.sessionId }),
        },
      );
      expect(submitRes.status).toBe(200);
      const afterSubmit = (
        (await submitRes.json()) as {
          session: { status: string; stage: string };
        }
      ).session;
      expect(afterSubmit.stage).toBe("submitting");
      expect(afterSubmit.status).toBe("running");

      const submitMsg = h.sent.find(
        (s) => s.message.type === "agent_runtime_login_submit",
      );
      expect(submitMsg?.message.sessionId).toBe(s1.sessionId);
      expect(submitMsg?.message.code).toBe(secretCode);

      // 4. 节点回传登录成功 → 清除 authUrl、落终态、异步重探更新 DB probe
      await h.service.handleNodeMessage(pcRecord, {
        type: "agent_runtime_login_result",
        sessionId: s1.sessionId,
        ok: true,
        authenticated: true,
        email: "alice@example.com",
        authLabel: "alice@example.com",
        homePath: "/custom/ag-home",
      });
      await waitMicrotasks(10);

      const pollDone = (await (
        await app.request(
          "/api/local-agents/instances/agi_login_1/antigravity/login",
        )
      ).json()) as {
        session: {
          status: string;
          authenticated: boolean;
          email: string | null;
          authUrl: string | null;
          finishedAt: string | null;
        };
      };
      expect(pollDone.session.status).toBe("succeeded");
      expect(pollDone.session.authenticated).toBe(true);
      expect(pollDone.session.email).toBe("alice@example.com");
      expect(pollDone.session.authUrl).toBeNull();
      expect(pollDone.session.finishedAt).not.toBeNull();

      const refreshedRow = h.db.tables.instances.find(
        (r) => r.id === "agi_login_1",
      );
      expect(
        (refreshedRow?.probe as { authenticated?: boolean })?.authenticated,
      ).toBe(true);

      // 5. restart=true 与 cancel 流程
      const rStart = await app.request(
        "/api/local-agents/instances/agi_login_1/antigravity/login",
        { method: "POST" },
      );
      const s2 = ((await rStart.json()) as { session: { sessionId: string } })
        .session;
      const rRestart = await app.request(
        "/api/local-agents/instances/agi_login_1/antigravity/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ restart: true }),
        },
      );
      const s3 = ((await rRestart.json()) as { session: { sessionId: string } })
        .session;
      expect(s3.sessionId).not.toBe(s2.sessionId);
      expect(
        h.sent.some(
          (s) =>
            s.message.type === "agent_runtime_login_cancel" &&
            s.message.sessionId === s2.sessionId,
        ),
      ).toBe(true);

      const cancelLogin = await app.request(
        "/api/local-agents/instances/agi_login_1/antigravity/login/cancel",
        { method: "POST" },
      );
      expect(cancelLogin.status).toBe(200);
      expect(
        ((await cancelLogin.json()) as { session: { status: string } }).session
          .status,
      ).toBe("cancelled");
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    // 确认整个过程中绝未把 authUrl 或 code 写进日志
    const joinedLogs = logs.join("\n");
    expect(joinedLogs).not.toContain("SECRET_STATE_999");
    expect(joinedLogs).not.toContain("SECRET_AUTH_CODE_777");
  });

  test("logout 闭环（清内存登录态 + 刷新 DB probe）与失败/超时兜底", async () => {
    const pcRecord = makeDevice();
    const agInst = makeInstanceRow({
      id: "agi_logout_1",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "antigravity",
      slug: "ag-logout",
      probe: {
        status: "available",
        version: "1.5.16",
        resolvedPath: "/tools/agy.exe",
        authenticated: true,
        authLabel: "alice@example.com",
        homePath: "/homes/agi_logout_1",
        message: "可用",
        checkedAt: new Date().toISOString(),
      },
    });

    let logoutMode: "ok" | "fail" | "timeout" = "ok";
    const h = setupHarness({
      devices: [pcRecord],
      onlineDevices: [PC_DEV_ID],
      instances: [agInst],
      runtimeLogoutTimeoutMs: 40,
      onSend: (_envId, msg) => {
        if (msg.type === "agent_runtime_logout") {
          if (logoutMode === "timeout") return;
          queueMicrotask(() => {
            void h.service.handleNodeMessage(pcRecord, {
              type: "agent_runtime_logout_result",
              reqId: msg.reqId,
              ok: logoutMode === "ok",
              homePath: "/homes/agi_logout_1",
              error: logoutMode === "fail" ? "凭据文件被占用" : null,
            });
          });
        }
        if (msg.type === "agent_probe") {
          queueMicrotask(() => {
            void h.service.handleNodeMessage(pcRecord, {
              type: "agent_probe_result",
              reqId: msg.reqId,
              probe: {
                status: "unauthenticated",
                version: "1.5.16",
                resolvedPath: "/tools/agy.exe",
                authenticated: false,
                authLabel: null,
                runtimeSource: "managed",
                homePath: "/homes/agi_logout_1",
                message: "未登录",
              },
            });
          });
        }
      },
    });

    const app = h.appFor(MEMBER, "user");

    // 先建立一个活跃登录会话，确认 logout 成功后会清空它
    await app.request(
      "/api/local-agents/instances/agi_logout_1/antigravity/login",
      { method: "POST" },
    );

    const okRes = await app.request(
      "/api/local-agents/instances/agi_logout_1/antigravity/logout",
      { method: "POST" },
    );
    expect(okRes.status).toBe(200);
    const okJson = (await okRes.json()) as {
      ok: boolean;
      homePath: string | null;
      probe: { status: string; authenticated: boolean } | null;
    };
    expect(okJson.ok).toBe(true);
    expect(okJson.homePath).toBe("/homes/agi_logout_1");
    expect(okJson.probe?.status).toBe("unauthenticated");
    expect(okJson.probe?.authenticated).toBe(false);

    // 内存登录会话已清空
    const afterLogin = (await (
      await app.request(
        "/api/local-agents/instances/agi_logout_1/antigravity/login",
      )
    ).json()) as { session: unknown };
    expect(afterLogin.session).toBeNull();

    // 节点报错兜底
    logoutMode = "fail";
    const failRes = await app.request(
      "/api/local-agents/instances/agi_logout_1/antigravity/logout",
      { method: "POST" },
    );
    expect(failRes.status).toBe(200);
    const failJson = (await failRes.json()) as {
      ok: boolean;
      error?: string;
    };
    expect(failJson.ok).toBe(false);
    expect(failJson.error).toContain("凭据文件被占用");

    // 超时兜底不 500
    logoutMode = "timeout";
    const timeoutRes = await app.request(
      "/api/local-agents/instances/agi_logout_1/antigravity/logout",
      { method: "POST" },
    );
    expect(timeoutRes.status).toBe(200);
    const timeoutJson = (await timeoutRes.json()) as {
      ok: boolean;
      error?: string;
    };
    expect(timeoutJson.ok).toBe(false);
    expect(timeoutJson.error).toContain("超时");
  });

  test("server-host 全部 6 条新上行消息直转 handleNodeMessage（不查 task 表）", async () => {
    const serverAg = makeInstanceRow({
      id: "agi_srv_direct",
      owner_user_id: ADMIN,
      environment_id: SERVER_ENVIRONMENT_ID,
      driver: "antigravity",
      slug: "srv-ag",
    });

    const h = setupHarness({
      devices: [],
      onlineDevices: [],
      instances: [serverAg],
      useServerHostFactory: true,
      onSend: (_envId, msg, emit) => {
        if (msg.type === "agent_runtime_status") {
          queueMicrotask(() =>
            emit({
              type: "agent_runtime_status_result",
              reqId: msg.reqId,
              ok: true,
              status: sampleRuntimeStatus({ managedVersion: "1.5.16" }),
            }),
          );
        } else if (msg.type === "agent_runtime_install") {
          queueMicrotask(() => {
            emit({
              type: "agent_runtime_install_progress",
              jobId: msg.jobId,
              stage: "extracting",
              percent: 80,
              downloadedBytes: 8000,
              totalBytes: 10000,
            });
            emit({
              type: "agent_runtime_install_result",
              jobId: msg.jobId,
              ok: true,
              version: "1.5.16",
              binaryPath: "/srv/agy",
            });
          });
        } else if (msg.type === "agent_runtime_login_start") {
          queueMicrotask(() =>
            emit({
              type: "agent_runtime_login_event",
              sessionId: msg.sessionId,
              stage: "awaiting_auth",
              authUrl: "https://accounts.google.com/o/oauth2/auth?state=srv1",
            }),
          );
        } else if (msg.type === "agent_runtime_login_submit") {
          queueMicrotask(() =>
            emit({
              type: "agent_runtime_login_result",
              sessionId: msg.sessionId,
              ok: true,
              authenticated: true,
              email: "admin@example.com",
              homePath: "/srv/agent-homes/antigravity/agi_srv_direct",
            }),
          );
        } else if (msg.type === "agent_runtime_logout") {
          queueMicrotask(() =>
            emit({
              type: "agent_runtime_logout_result",
              reqId: msg.reqId,
              ok: true,
              homePath: "/srv/agent-homes/antigravity/agi_srv_direct",
            }),
          );
        } else if (msg.type === "agent_probe") {
          queueMicrotask(() =>
            emit({
              type: "agent_probe_result",
              reqId: msg.reqId,
              probe: {
                status: "available",
                version: "1.5.16",
                resolvedPath: "/srv/agy",
                authenticated: true,
                authLabel: "admin@example.com",
                runtimeSource: "managed",
                homePath: "/srv/agent-homes/antigravity/agi_srv_direct",
                message: "可用",
              },
            }),
          );
        }
      },
    });

    // 确认协议白名单包含全部 6 条新消息
    for (const t of [
      "agent_runtime_status_result",
      "agent_runtime_install_progress",
      "agent_runtime_install_result",
      "agent_runtime_login_event",
      "agent_runtime_login_result",
      "agent_runtime_logout_result",
    ]) {
      expect(LOCAL_AGENT_MESSAGE_TYPES.has(t)).toBe(true);
    }

    const adminApp = h.appFor(ADMIN, "admin");

    // 1. status
    const rt = await adminApp.request(
      "/api/local-agents/environments/server/antigravity/runtime",
    );
    expect(rt.status).toBe(200);
    expect(
      ((await rt.json()) as { runtime: { managedVersion: string } }).runtime
        .managedVersion,
    ).toBe("1.5.16");

    // 2. install (progress + result)
    const inst = await adminApp.request(
      "/api/local-agents/environments/server/antigravity/install",
      { method: "POST" },
    );
    expect(inst.status).toBe(200);
    await waitMicrotasks(10);
    const rtAfter = (await (
      await adminApp.request(
        "/api/local-agents/environments/server/antigravity/runtime",
      )
    ).json()) as { installJob: { status: string; version: string } };
    expect(rtAfter.installJob.status).toBe("succeeded");
    expect(rtAfter.installJob.version).toBe("1.5.16");

    // 3. login (event + submit + result)
    const loginStart = await adminApp.request(
      "/api/local-agents/instances/agi_srv_direct/antigravity/login",
      { method: "POST" },
    );
    expect(loginStart.status).toBe(200);
    await waitMicrotasks(5);
    const loginMid = (await (
      await adminApp.request(
        "/api/local-agents/instances/agi_srv_direct/antigravity/login",
      )
    ).json()) as { session: { status: string; authUrl: string | null } };
    expect(loginMid.session.status).toBe("awaiting_auth");
    expect(loginMid.session.authUrl).toContain("accounts.google.com");

    const submit = await adminApp.request(
      "/api/local-agents/instances/agi_srv_direct/antigravity/login/submit",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "srv-code-123" }),
      },
    );
    expect(submit.status).toBe(200);
    await waitMicrotasks(10);
    const loginDone = (await (
      await adminApp.request(
        "/api/local-agents/instances/agi_srv_direct/antigravity/login",
      )
    ).json()) as { session: { status: string; email: string | null } };
    expect(loginDone.session.status).toBe("succeeded");
    expect(loginDone.session.email).toBe("admin@example.com");

    // 4. logout
    const logout = await adminApp.request(
      "/api/local-agents/instances/agi_srv_direct/antigravity/logout",
      { method: "POST" },
    );
    expect(logout.status).toBe(200);
    expect(((await logout.json()) as { ok: boolean }).ok).toBe(true);

    // 验证上述全部 6 条直转消息从未查询过 chisabot_local_agent_tasks
    expect(
      h.db.queries.some((q) => q.includes("chisabot_local_agent_tasks")),
    ).toBe(false);
  });

  test("forgetDevice 立即释放 pending runtime RPC 与内存作业/登录会话", async () => {
    const pcRecord = makeDevice();
    const agInst = makeInstanceRow({
      id: "agi_forget_1",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "antigravity",
    });
    const h = setupHarness({
      devices: [pcRecord],
      onlineDevices: [PC_DEV_ID],
      instances: [agInst],
      runtimeStatusTimeoutMs: 5_000,
    });
    const app = h.appFor(MEMBER, "user");

    // 发起一个不会回复的 runtime status 查询
    const pendingPromise = app.request(
      `/api/local-agents/environments/${PC_DEV_ID}/antigravity/runtime`,
    );
    await waitMicrotasks(3);
    // 移除设备应当立刻唤醒 pending 请求而非干等 5s
    await h.service.forgetDevice(PC_DEV_ID);
    const res = await pendingPromise;
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      runtime: unknown;
      error?: string;
    };
    expect(json.runtime).toBeNull();
    expect(json.error).toContain("已移除或离线");
  });

  test("回归：install/login 成功时先保持 running，等异步重探写库完毕再切 succeeded（防竞态与死锁）", async () => {
    const pcRecord = makeDevice();
    const agInst = makeInstanceRow({
      id: "agi_race_1",
      owner_user_id: MEMBER,
      environment_id: PC_DEV_ID,
      driver: "antigravity",
      slug: "ag-race",
      probe: {
        status: "missing",
        version: null,
        resolvedPath: null,
        authenticated: null,
        authLabel: null,
        message: "未安装",
        checkedAt: new Date(0).toISOString(),
      },
    });

    const pendingProbes: Array<{ reqId: string }> = [];
    const h = setupHarness({
      devices: [pcRecord],
      onlineDevices: [PC_DEV_ID],
      instances: [agInst],
      onSend: (_envId, msg) => {
        if (msg.type === "agent_probe") {
          pendingProbes.push({ reqId: String(msg.reqId ?? "") });
        } else if (msg.type === "agent_runtime_status") {
          queueMicrotask(() => {
            void h.service.handleNodeMessage(pcRecord, {
              type: "agent_runtime_status_result",
              reqId: msg.reqId,
              ok: true,
              status: sampleRuntimeStatus(),
            });
          });
        }
      },
    });
    const app = h.appFor(MEMBER, "user");

    // 1. 安装完成但 agent_probe 尚未返回时，handleNodeMessage 必须立即返回且 status 保持 running
    const instStart = await app.request(
      `/api/local-agents/environments/${PC_DEV_ID}/antigravity/install`,
      { method: "POST" },
    );
    const job = ((await instStart.json()) as { installJob: { jobId: string } })
      .installJob;

    await h.service.handleNodeMessage(pcRecord, {
      type: "agent_runtime_install_result",
      jobId: job.jobId,
      ok: true,
      version: "1.5.16",
      binaryPath: "/tools/agy.exe",
    });
    await waitMicrotasks(4);

    expect(pendingProbes.length).toBe(1);
    const beforeInstallProbe = (await (
      await app.request(
        `/api/local-agents/environments/${PC_DEV_ID}/antigravity/runtime`,
      )
    ).json()) as {
      installJob: {
        status: string;
        stage: string;
        finishedAt: string | null;
      };
    };
    expect(beforeInstallProbe.installJob.status).toBe("running");
    expect(beforeInstallProbe.installJob.stage).toBe("activating");
    expect(beforeInstallProbe.installJob.finishedAt).toBeNull();

    // 迟到的进度消息不得覆写收尾状态
    await h.service.handleNodeMessage(pcRecord, {
      type: "agent_runtime_install_progress",
      jobId: job.jobId,
      stage: "downloading",
      percent: 50,
    });

    // 节点返回 probe 结果 → 写库完毕后状态才切换为 succeeded
    const firstProbe = pendingProbes.shift();
    expect(firstProbe).toBeDefined();
    await h.service.handleNodeMessage(pcRecord, {
      type: "agent_probe_result",
      reqId: firstProbe?.reqId,
      probe: {
        status: "unauthenticated",
        version: "1.5.16",
        resolvedPath: "/tools/agy.exe",
        authenticated: false,
        authLabel: null,
        runtimeSource: "managed",
        homePath: "/homes/agi_race_1",
        message: "尚未登录",
      },
    });
    await waitMicrotasks(6);

    const afterInstallProbe = (await (
      await app.request(
        `/api/local-agents/environments/${PC_DEV_ID}/antigravity/runtime`,
      )
    ).json()) as {
      installJob: { status: string; finishedAt: string | null };
    };
    expect(afterInstallProbe.installJob.status).toBe("succeeded");
    expect(afterInstallProbe.installJob.finishedAt).not.toBeNull();
    const rowAfterInstall = h.db.tables.instances.find(
      (r) => r.id === "agi_race_1",
    );
    expect(
      (rowAfterInstall?.probe as { status?: string; runtimeSource?: string })
        ?.status,
    ).toBe("unauthenticated");
    expect(
      (rowAfterInstall?.probe as { runtimeSource?: string })?.runtimeSource,
    ).toBe("managed");

    // 2. 登录成功但 agent_probe 尚未返回时，status 保持 running 且 authUrl 已清空、禁止二次提交
    const loginStart = await app.request(
      "/api/local-agents/instances/agi_race_1/antigravity/login",
      { method: "POST" },
    );
    const sess = (
      (await loginStart.json()) as { session: { sessionId: string } }
    ).session;
    await h.service.handleNodeMessage(pcRecord, {
      type: "agent_runtime_login_event",
      sessionId: sess.sessionId,
      stage: "awaiting_auth",
      authUrl: "https://accounts.google.com/o/oauth2/auth?state=race",
    });

    await h.service.handleNodeMessage(pcRecord, {
      type: "agent_runtime_login_result",
      sessionId: sess.sessionId,
      ok: true,
      authenticated: true,
      email: "race@example.com",
      homePath: "/homes/agi_race_1",
    });
    await waitMicrotasks(4);

    expect(pendingProbes.length).toBe(1);
    const beforeLoginProbe = (await (
      await app.request(
        "/api/local-agents/instances/agi_race_1/antigravity/login",
      )
    ).json()) as {
      session: {
        status: string;
        stage: string;
        authUrl: string | null;
        finishedAt: string | null;
      };
    };
    expect(beforeLoginProbe.session.status).toBe("running");
    expect(beforeLoginProbe.session.stage).toBe("verifying");
    expect(beforeLoginProbe.session.authUrl).toBeNull();
    expect(beforeLoginProbe.session.finishedAt).toBeNull();

    // 收尾确认期间禁止再 submit
    expect(
      (
        await app.request(
          "/api/local-agents/instances/agi_race_1/antigravity/login/submit",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: "late-code" }),
          },
        )
      ).status,
    ).toBe(409);

    // 节点返回登录后的 probe → DB 写完后 session 变为 succeeded
    const secondProbe = pendingProbes.shift();
    expect(secondProbe).toBeDefined();
    await h.service.handleNodeMessage(pcRecord, {
      type: "agent_probe_result",
      reqId: secondProbe?.reqId,
      probe: {
        status: "available",
        version: "1.5.16",
        resolvedPath: "/tools/agy.exe",
        authenticated: true,
        authLabel: "Google · race@example.com",
        runtimeSource: "managed",
        homePath: "/homes/agi_race_1",
        message: "已认证",
      },
    });
    await waitMicrotasks(6);

    const afterLoginProbe = (await (
      await app.request(
        "/api/local-agents/instances/agi_race_1/antigravity/login",
      )
    ).json()) as {
      session: { status: string; finishedAt: string | null };
    };
    expect(afterLoginProbe.session.status).toBe("succeeded");
    expect(afterLoginProbe.session.finishedAt).not.toBeNull();
    const rowAfterLogin = h.db.tables.instances.find(
      (r) => r.id === "agi_race_1",
    );
    expect(
      (rowAfterLogin?.probe as { authenticated?: boolean })?.authenticated,
    ).toBe(true);
    expect((rowAfterLogin?.probe as { authLabel?: string })?.authLabel).toBe(
      "Google · race@example.com",
    );
  });
});
