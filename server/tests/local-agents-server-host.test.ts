/**
 * 服务器本机智能体访问开关（DESIGN.md：canUseServerHost + 部署级 member_access）。
 *
 * 全程 DB-free：服务只碰 `database.$client`，这里用一个按 SQL 文本分派的内存假库
 * （settings / instances / grants / tasks 四张表 + user_roles），不 mock 模块。
 * 覆盖：统一判定、环境列表隐藏、不播种、实例可见性、授权写（含 botId 校验）、
 * 执行入口运行时再判（start / continueTask / recover 恢复队列）与设置写权限。
 */
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import {
  canUseServerHost,
  SERVER_ENVIRONMENT_ID,
} from "../../shared/agent-providers";
import type { AppVariables } from "../src/auth/guards";
import { buildServerDeviceRecord } from "../src/local-agents/server-host";
import { createLocalAgentService } from "../src/local-agents/service";

type Row = Record<string, unknown>;
type Json = string | number | boolean | null | undefined;

const MEMBER = "u_member";
const ADMIN = "u_admin";
const SERVER_INST_ID = "agi_server1";

function serverSettingsRow(memberAccess: boolean, over: Row = {}): Row {
  return {
    device_id: SERVER_ENVIRONMENT_ID,
    owner_user_id: "system",
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
    ...over,
  };
}

function instanceRow(over: Row = {}): Row {
  return {
    id: `agi_${Math.random().toString(36).slice(2, 10)}`,
    owner_user_id: MEMBER,
    environment_id: "dev_1",
    slug: "codex",
    driver: "codex",
    name: "Codex",
    description: "",
    enabled: true,
    expose_as_tool: true,
    is_default_seed: true,
    sort_order: 0,
    config: {},
    env_vars: [],
    probe: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function taskRow(over: Row = {}): Row {
  return {
    id: `lat_${Math.random().toString(36).slice(2, 10)}`,
    owner_user_id: MEMBER,
    device_id: SERVER_ENVIRONMENT_ID,
    device_name: "服务器本机",
    agent_id: "bot1",
    bot_name: "B",
    thread_id: "t1",
    agent: "codex",
    title: "任务",
    task: "做点什么",
    profile: "workspace",
    isolation: "worktree",
    network: true,
    cwd: "/srv/ws",
    status: "done",
    step: null,
    transcript: [],
    line_count: 0,
    summary: null,
    diff: null,
    error: null,
    llm_calls: 0,
    result_message_id: null,
    instance_id: null,
    instance_name: null,
    environment_id: SERVER_ENVIRONMENT_ID,
    parent_task_id: null,
    depth: 0,
    invocation_mode: "async",
    session_id: null,
    turn_count: 1,
    pending_input: null,
    capacity_active: false,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

/** 按 SQL 文本前缀/特征分派的内存假库（覆盖本测试用到的全部查询形态）。 */
function fakeDb(seed: {
  settings?: Row[];
  instances?: Row[];
  grants?: Row[];
  roles?: Record<string, string[]>;
  tasks?: Row[];
}) {
  const tables = {
    settings: [...(seed.settings ?? [])],
    instances: [...(seed.instances ?? [])],
    grants: [...(seed.grants ?? [])],
    tasks: [...(seed.tasks ?? [])],
  };
  const queries: string[] = [];

  const tasksWhere = (pred: (r: Row) => boolean) => tables.tasks.filter(pred);

  const unsafe = async (
    query: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    const q = String(query).replace(/\s+/g, " ").trim();
    queries.push(q);
    const p = params as Json[];

    // ── chisabot_device_agent_settings ──
    if (q.startsWith("SELECT * FROM chisabot_device_agent_settings")) {
      return tables.settings.filter((r) => r.device_id === p[0]);
    }
    if (q.startsWith("INSERT INTO chisabot_device_agent_settings")) {
      const row: Row = {
        device_id: p[0],
        owner_user_id: p[1],
        profile: p[2],
        workspace_roots: JSON.parse(String(p[3])),
        network: p[4],
        isolation: p[5],
        default_agent: p[6],
        builtin_model: p[7] ? JSON.parse(String(p[7])) : null,
        container_image: p[8],
        detected: p[9] ? JSON.parse(String(p[9])) : null,
        member_access: p[10],
        updated_at: new Date().toISOString(),
      };
      const i = tables.settings.findIndex((r) => r.device_id === row.device_id);
      if (i >= 0) tables.settings[i] = row;
      else tables.settings.push(row);
      return [];
    }

    // ── chisabot_agent_instances ──
    if (q.startsWith("SELECT id, slug FROM chisabot_agent_instances")) {
      return tables.instances
        .filter((r) => r.owner_user_id === p[0] && r.environment_id === p[1])
        .map((r) => ({ id: r.id, slug: r.slug }));
    }
    if (
      q.startsWith("SELECT count(*)::int AS n FROM chisabot_agent_instances")
    ) {
      return [
        {
          n: tables.instances.filter(
            (r) => r.owner_user_id === p[0] && r.environment_id === p[1],
          ).length,
        },
      ];
    }
    if (
      q.startsWith(
        "SELECT DISTINCT owner_user_id FROM chisabot_agent_instances",
      )
    ) {
      const owners = new Set(
        tables.instances
          .filter((r) => r.environment_id === p[0])
          .map((r) => String(r.owner_user_id)),
      );
      return [...owners].map((o) => ({ owner_user_id: o }));
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
    if (q.startsWith("INSERT INTO chisabot_agent_instances")) {
      const row: Row = {
        id: p[0],
        owner_user_id: p[1],
        environment_id: p[2],
        slug: p[3],
        driver: p[4],
        name: p[5],
        description: p[6],
        enabled: p[7],
        expose_as_tool: p[8],
        is_default_seed: p[9],
        sort_order: p[10],
        config: JSON.parse(String(p[11])),
        env_vars: JSON.parse(String(p[12])),
        probe: p[13] ? JSON.parse(String(p[13])) : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      tables.instances.push(row);
      return [row];
    }
    if (
      q.startsWith("UPDATE chisabot_agent_instances") &&
      q.includes("RETURNING")
    ) {
      const i = tables.instances.findIndex(
        (r) => r.id === p[0] && r.owner_user_id === p[1],
      );
      if (i < 0) return [];
      const r = tables.instances[i];
      if (q.includes("probe =")) {
        r.probe = p[2] ? JSON.parse(String(p[2])) : null;
      } else {
        r.slug = p[2];
        r.name = p[3];
        r.description = p[4];
        r.enabled = p[5];
        r.expose_as_tool = p[6];
        r.sort_order = p[7];
        r.config = JSON.parse(String(p[8]));
        r.env_vars = JSON.parse(String(p[9]));
      }
      return [r];
    }
    if (q.startsWith("DELETE FROM chisabot_agent_instances")) {
      const i = tables.instances.findIndex(
        (r) => r.id === p[0] && r.owner_user_id === p[1],
      );
      if (i < 0) return [];
      tables.instances.splice(i, 1);
      return [{ id: p[0] }];
    }

    // ── chisabot_bot_agent_grants ──
    if (q.startsWith("SELECT * FROM chisabot_bot_agent_grants")) {
      return tables.grants.filter(
        (r) => r.owner_user_id === p[0] && r.bot_id === p[1],
      );
    }
    if (q.startsWith("INSERT INTO chisabot_bot_agent_grants")) {
      const row: Row = {
        owner_user_id: p[0],
        bot_id: p[1],
        mode: p[2],
        instance_ids: JSON.parse(String(p[3])),
        expose_named_tools: p[4],
        allow_nested_subagents: p[5],
        max_depth: p[6],
        updated_at: new Date().toISOString(),
      };
      const i = tables.grants.findIndex(
        (r) => r.owner_user_id === p[0] && r.bot_id === p[1],
      );
      if (i >= 0) tables.grants[i] = row;
      else tables.grants.push(row);
      return [];
    }

    // ── user_roles（默认 roleForUser 读的表）──
    if (q.startsWith("SELECT role FROM user_roles")) {
      return (seed.roles?.[String(p[0])] ?? []).map((role) => ({ role }));
    }

    // ── chisabot_local_agent_tasks ──
    if (q.includes("chisabot_local_agent_tasks")) {
      if (
        q.startsWith("SELECT * FROM") &&
        q.includes("WHERE id = $1") &&
        !q.includes("FOR UPDATE")
      ) {
        return tasksWhere((r) => r.id === p[0]);
      }
      if (q.startsWith("SELECT status,capacity_active")) {
        return tasksWhere((r) => r.id === p[0]).map((r) => ({
          status: r.status,
          capacity_active: r.capacity_active,
        }));
      }
      if (q.includes("status='starting' AND NOT capacity_active")) {
        return tasksWhere((r) => r.status === "starting" && !r.capacity_active);
      }
      if (q.includes("capacity_active AND status='failed'")) {
        return tasksWhere((r) => r.capacity_active && r.status === "failed");
      }
      if (q.startsWith("SELECT * FROM") && q.includes("session_id")) {
        return tasksWhere(
          (r) => r.owner_user_id === p[0] && r.session_id === p[1],
        );
      }
      if (q.startsWith("SELECT * FROM") && q.includes("thread_id")) {
        return tasksWhere(
          (r) => r.thread_id === p[0] && r.owner_user_id === p[1],
        );
      }
      if (q.startsWith("SELECT * FROM") && q.includes("device_id")) {
        return tasksWhere(
          (r) => r.device_id === p[0] && r.owner_user_id === p[1],
        );
      }
      if (q.startsWith("SELECT * FROM")) return tasksWhere(() => true);

      if (q.startsWith("UPDATE") && q.includes("status = $2")) {
        // finish()：$1=id, $2=status, $3=summary, $4=error
        const hit = tables.tasks.filter(
          (r) =>
            r.id === p[0] &&
            ["pending_approval", "starting", "running", "needs_input"].includes(
              String(r.status),
            ),
        );
        for (const r of hit) {
          r.status = p[1];
          r.error = p[3];
          r.finished_at = new Date().toISOString();
        }
        return q.includes("RETURNING") ? hit : [];
      }
      if (q.startsWith("UPDATE") && q.includes("status = 'failed'")) {
        // recover() 首步：把活跃任务标 failed
        const hit = tasksWhere(
          (r) =>
            ["pending_approval", "running", "needs_input"].includes(
              String(r.status),
            ) ||
            (r.status === "starting" && r.capacity_active),
        );
        for (const r of hit) r.status = "failed";
        return hit.map((r) => ({ id: r.id }));
      }
      if (q.includes("SET capacity_active=true")) {
        const hit = tasksWhere((r) => r.id === p[0]);
        for (const r of hit) {
          r.capacity_active = true;
          if (p[1]) r.status = p[1];
        }
        return [];
      }
      if (q.includes("SET capacity_active=false")) {
        const hit = tasksWhere((r) => r.id === p[0]);
        for (const r of hit) r.capacity_active = false;
        return [];
      }
      return [];
    }

    return [];
  };

  const client = {
    unsafe,
    begin: async (fn: (tx: { unsafe: typeof unsafe }) => unknown) =>
      fn({ unsafe }),
  };
  return { client, tables, queries };
}

function makeService(options: {
  memberAccess?: boolean;
  roles?: Record<string, "admin" | "user">;
  instances?: Row[];
  grants?: Row[];
  tasks?: Row[];
  withHost?: boolean;
  useDefaultRoleForUser?: boolean;
  botAccessible?: (actorId: string, botId: string) => Promise<boolean>;
}) {
  const db = fakeDb({
    settings:
      options.memberAccess === undefined
        ? []
        : [serverSettingsRow(options.memberAccess)],
    instances: options.instances,
    grants: options.grants,
    roles: options.roles,
    tasks: options.tasks,
  });
  const sent: Row[] = [];
  const service = createLocalAgentService({
    database: { $client: db.client } as never,
    hub: {
      isOnline: () => false,
      sendRaw: () => true,
      requestUserApproval: async () => ({ approved: false, by: "web" }),
      decide: () => true,
    } as never,
    deviceStore: {
      get: async () => null,
      forOwner: async () => [],
      audit: async () => "a",
    } as never,
    serverHost:
      options.withHost === false
        ? null
        : ({
            sendRaw: (message: Row) => {
              sent.push(message);
              return true;
            },
            detect: async () => ({
              agents: [],
              sandboxes: {},
              platform: "linux",
              root: false,
              checkedAt: new Date().toISOString(),
            }),
          } as never),
    ...(options.useDefaultRoleForUser
      ? {}
      : {
          roleForUser: async (userId: string) =>
            options.roles?.[userId] ?? null,
        }),
    botAccessible: options.botAccessible,
  });
  return { service, db, sent };
}

function makeApp(
  service: ReturnType<typeof createLocalAgentService>,
  roles: Record<string, "admin" | "user">,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    const id = c.req.header("x-user-id") ?? MEMBER;
    c.set("actor", {
      id,
      email: `${id}@test.local`,
      role: roles[id] ?? "user",
    });
    await next();
  };
  app.route("/api/local-agents", service.routes(requireUser));
  return app;
}

const ROLES: Record<string, "admin" | "user"> = {
  [MEMBER]: "user",
  [ADMIN]: "admin",
};

describe("canUseServerHost（唯一判定真相源）", () => {
  test("管理员恒可；普通用户仅当 memberAccess 开", () => {
    expect(canUseServerHost({ role: "admin" }, false)).toBe(true);
    expect(canUseServerHost({ role: "admin" }, true)).toBe(true);
    expect(canUseServerHost({ role: "user" }, false)).toBe(false);
    expect(canUseServerHost({ role: "user" }, true)).toBe(true);
    expect(canUseServerHost({ role: null }, true)).toBe(true);
    expect(canUseServerHost(undefined, true)).toBe(true);
    expect(canUseServerHost(undefined, false)).toBe(false);
  });
});

describe("服务器本机环境：读与播种（DB-free 假库）", () => {
  test("memberAccess 关：普通用户环境列表无服务器本机；管理员有；开则普通用户也有", async () => {
    const { service } = makeService({ memberAccess: false, roles: ROLES });
    const memberEnvs = await service.listEnvironments(MEMBER);
    expect(
      memberEnvs.find((e) => e.id === SERVER_ENVIRONMENT_ID),
    ).toBeUndefined();
    const adminEnvs = await service.listEnvironments(ADMIN);
    expect(adminEnvs.find((e) => e.id === SERVER_ENVIRONMENT_ID)).toMatchObject(
      { kind: "server" },
    );

    const { service: onService } = makeService({
      memberAccess: true,
      roles: ROLES,
    });
    const onEnvs = await onService.listEnvironments(MEMBER);
    expect(onEnvs.find((e) => e.id === SERVER_ENVIRONMENT_ID)).toMatchObject({
      kind: "server",
    });
  });

  test("宿主整体未启用时：管理员也看不到服务器环境", async () => {
    const { service } = makeService({
      memberAccess: true,
      roles: ROLES,
      withHost: false,
    });
    const envs = await service.listEnvironments(ADMIN);
    expect(envs.find((e) => e.id === SERVER_ENVIRONMENT_ID)).toBeUndefined();
  });

  test("开关关时不给普通用户播种；开时按检测结果播种", async () => {
    const detected = {
      agents: [{ kind: "codex", version: "1.0", path: "/usr/bin/codex" }],
      sandboxes: {},
      platform: "linux",
      root: false,
      checkedAt: new Date().toISOString(),
    };
    const off = makeService({
      memberAccess: false,
      roles: ROLES,
      instances: [],
    });
    off.db.tables.settings[0]!.detected = detected;
    await off.service.listEnvironments(MEMBER);
    expect(
      off.db.queries.filter((q) =>
        q.startsWith("INSERT INTO chisabot_agent_instances"),
      ),
    ).toHaveLength(0);

    const on = makeService({
      memberAccess: true,
      roles: ROLES,
      instances: [],
    });
    on.db.tables.settings[0]!.detected = detected;
    await on.service.listEnvironments(MEMBER);
    expect(
      on.db.queries.filter((q) =>
        q.startsWith("INSERT INTO chisabot_agent_instances"),
      ).length,
    ).toBeGreaterThan(0);
  });

  test("agents_detected 回传只为仍有权限的属主刷新实例", async () => {
    const memberServerInst = instanceRow({
      id: SERVER_INST_ID,
      environment_id: SERVER_ENVIRONMENT_ID,
      is_default_seed: true,
    });
    const adminServerInst = instanceRow({
      id: "agi_admin1",
      owner_user_id: ADMIN,
      environment_id: SERVER_ENVIRONMENT_ID,
      slug: "codex",
      is_default_seed: true,
    });
    const { service, db } = makeService({
      memberAccess: false,
      roles: ROLES,
      instances: [memberServerInst, adminServerInst],
    });
    const record = buildServerDeviceRecord("system", []);
    await service.handleNodeMessage(record, {
      type: "agents_detected",
      detection: { agents: [{ kind: "codex", version: "2.0" }] },
    } as never);
    const probeUpdates = db.queries.filter(
      (q) =>
        q.startsWith("UPDATE chisabot_agent_instances") &&
        q.includes("probe ="),
    );
    expect(probeUpdates).toHaveLength(1); // 只管理员那条被刷新
  });
});

describe("服务器本机环境：执行入口运行时再判", () => {
  const serverInstance = () =>
    instanceRow({
      id: SERVER_INST_ID,
      environment_id: SERVER_ENVIRONMENT_ID,
      slug: "srv-codex",
      name: "服务器 Codex",
    });

  test("start：普通用户在开关关时被拒（即使有授权与实例）；管理员与开关开时可进入后续校验", async () => {
    const off = makeService({
      memberAccess: false,
      roles: ROLES,
      instances: [serverInstance()],
    });
    await expect(
      off.service.start({
        ownerUserId: MEMBER,
        botId: "bot1",
        botName: "B",
        threadId: "t1",
        instance: "srv-codex",
        task: "x",
      }),
    ).rejects.toThrow(/运行环境不可用|只对管理员开放/);

    const admin = makeService({
      memberAccess: false,
      roles: ROLES,
      instances: [
        serverInstance(),
        instanceRow({
          owner_user_id: ADMIN,
          environment_id: SERVER_ENVIRONMENT_ID,
          slug: "srv-codex",
        }),
      ],
    });
    await expect(
      admin.service.start({
        ownerUserId: ADMIN,
        botId: "bot1",
        botName: "B",
        threadId: "t1",
        instance: "srv-codex",
        task: "x",
      }),
    ).rejects.toThrow(/受控工作区/); // 过了访问闸，卡在没配工作区

    const on = makeService({
      memberAccess: true,
      roles: ROLES,
      instances: [serverInstance()],
    });
    await expect(
      on.service.start({
        ownerUserId: MEMBER,
        botId: "bot1",
        botName: "B",
        threadId: "t1",
        instance: "srv-codex",
        task: "x",
      }),
    ).rejects.toThrow(/受控工作区/);
  });

  test("continueTask：开关关时对服务器任务续接被拒", async () => {
    const task = taskRow({ status: "done" });
    const { service } = makeService({
      memberAccess: false,
      roles: ROLES,
      tasks: [task],
    });
    await expect(
      service.continueTask({
        ownerUserId: MEMBER,
        taskId: String(task.id),
        prompt: "继续",
      }),
    ).rejects.toThrow(/不可用|只对管理员开放/);
  });

  test("recover：恢复队列里的服务器任务不会发给宿主，直接失败", async () => {
    const queued = taskRow({ status: "starting", capacity_active: false });
    const { service, db, sent } = makeService({
      memberAccess: false,
      roles: ROLES,
      tasks: [queued],
    });
    await service.recover();
    await new Promise((r) => setTimeout(r, 30)); // dispatchQueued 是后台派发的
    expect(sent.filter((m) => m.type === "agent_run")).toHaveLength(0);
    expect(db.tables.tasks[0]!.status).toBe("failed");
  });

  test("tools：开关关时服务器实例不进授权工具列表；开时出现", async () => {
    const grantAll = {
      owner_user_id: MEMBER,
      bot_id: "bot1",
      mode: "all",
      instance_ids: [],
      expose_named_tools: true,
      allow_nested_subagents: true,
      max_depth: 3,
      updated_at: new Date().toISOString(),
    };
    const off = makeService({
      memberAccess: false,
      roles: ROLES,
      instances: [serverInstance()],
      grants: [grantAll],
    });
    const offTools = await off.service.tools({
      ownerUserId: MEMBER,
      botId: "bot1",
      botName: "B",
      threadId: "t1",
    });
    expect(offTools).toHaveLength(0);

    const on = makeService({
      memberAccess: true,
      roles: ROLES,
      instances: [serverInstance()],
      grants: [grantAll],
    });
    const onTools = await on.service.tools({
      ownerUserId: MEMBER,
      botId: "bot1",
      botName: "B",
      threadId: "t1",
    });
    expect(onTools.length).toBeGreaterThan(0);
    expect(onTools.some((t) => t.name === "subagent_run")).toBe(true);
  });

  test("默认 roleForUser 从 user_roles 读角色", async () => {
    const { service } = makeService({
      memberAccess: false,
      roles: { [ADMIN]: ["admin"], [MEMBER]: ["user"] },
      useDefaultRoleForUser: true,
    });
    expect(await service.serverHostAllowedFor(ADMIN)).toBe(true);
    expect(await service.serverHostAllowedFor(MEMBER)).toBe(false);
    expect(await service.serverHostAllowedFor("u_nobody")).toBe(false);
  });
});

describe("服务器本机环境：路由层", () => {
  const serverInstance = () =>
    instanceRow({
      id: SERVER_INST_ID,
      environment_id: SERVER_ENVIRONMENT_ID,
      slug: "srv-codex",
      name: "服务器 Codex",
    });

  test("GET /environments：开关关时普通用户看不到服务器环境；GET settings 404", async () => {
    const { service } = makeService({ memberAccess: false, roles: ROLES });
    const app = makeApp(service, ROLES);

    const memberRes = await app.request("/api/local-agents/environments", {
      headers: { "x-user-id": MEMBER },
    });
    expect(memberRes.status).toBe(200);
    const memberBody = (await memberRes.json()) as {
      environments: Array<{ id: string }>;
    };
    expect(
      memberBody.environments.find((e) => e.id === SERVER_ENVIRONMENT_ID),
    ).toBeUndefined();

    const adminRes = await app.request("/api/local-agents/environments", {
      headers: { "x-user-id": ADMIN },
    });
    const adminBody = (await adminRes.json()) as {
      environments: Array<{ id: string }>;
    };
    expect(
      adminBody.environments.find((e) => e.id === SERVER_ENVIRONMENT_ID),
    ).toMatchObject({ kind: "server" });

    const memberSettings = await app.request(
      "/api/local-agents/environments/server/settings",
      { headers: { "x-user-id": MEMBER } },
    );
    expect(memberSettings.status).toBe(404);
  });

  test("GET /instances 与 /instances/:id：按环境可见性过滤", async () => {
    const { service } = makeService({
      memberAccess: false,
      roles: ROLES,
      instances: [
        serverInstance(),
        instanceRow({
          id: "agi_admin1",
          owner_user_id: ADMIN,
          environment_id: SERVER_ENVIRONMENT_ID,
          slug: "srv-codex",
        }),
      ],
    });
    const app = makeApp(service, ROLES);

    const res = await app.request("/api/local-agents/instances", {
      headers: { "x-user-id": MEMBER },
    });
    const body = (await res.json()) as {
      instances: Array<{ id: string; environmentId: string }>;
    };
    expect(
      body.instances.find((i) => i.environmentId === SERVER_ENVIRONMENT_ID),
    ).toBeUndefined();

    const one = await app.request(
      `/api/local-agents/instances/${SERVER_INST_ID}`,
      { headers: { "x-user-id": MEMBER } },
    );
    expect(one.status).toBe(404);

    const adminOne = await app.request(
      "/api/local-agents/instances/agi_admin1",
      { headers: { "x-user-id": ADMIN } },
    );
    expect(adminOne.status).toBe(200);
  });

  test("PUT /environments/server/settings：普通用户 403；管理员能写 memberAccess", async () => {
    const { service, db } = makeService({
      memberAccess: false,
      roles: ROLES,
    });
    const app = makeApp(service, ROLES);

    const denied = await app.request(
      "/api/local-agents/environments/server/settings",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-user-id": MEMBER,
        },
        body: JSON.stringify({ memberAccess: true }),
      },
    );
    expect(denied.status).toBe(403);

    const ok = await app.request(
      "/api/local-agents/environments/server/settings",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-user-id": ADMIN,
        },
        body: JSON.stringify({ memberAccess: true }),
      },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      settings: { memberAccess: boolean };
    };
    expect(body.settings.memberAccess).toBe(true);
    expect(db.tables.settings[0]!.member_access).toBe(true);
  });

  test("PUT /bots/:botId/grants：botId 校验 + 服务器实例授权需 canUseServerHost", async () => {
    const { service, db } = makeService({
      memberAccess: false,
      roles: ROLES,
      instances: [serverInstance()],
      botAccessible: async () => true,
    });
    const app = makeApp(service, ROLES);

    // 开关关：普通用户不能把服务器实例授权给 Bot
    const denied = await app.request("/api/local-agents/bots/bot1/grants", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-id": MEMBER,
      },
      body: JSON.stringify({
        mode: "selected",
        instanceIds: [SERVER_INST_ID],
      }),
    });
    expect(denied.status).toBe(403);
    expect(db.tables.grants).toHaveLength(0);

    // 管理员可以
    const adminOk = await app.request("/api/local-agents/bots/bot1/grants", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-id": ADMIN,
      },
      body: JSON.stringify({
        mode: "selected",
        instanceIds: [SERVER_INST_ID],
      }),
    });
    expect(adminOk.status).toBe(200);
  });

  test("PUT grants：开关开后普通用户可以授权服务器实例；botId 不可访问 404", async () => {
    const on = makeService({
      memberAccess: true,
      roles: ROLES,
      instances: [serverInstance()],
      botAccessible: async () => true,
    });
    const onApp = makeApp(on.service, ROLES);
    const ok = await onApp.request("/api/local-agents/bots/bot1/grants", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-id": MEMBER,
      },
      body: JSON.stringify({
        mode: "selected",
        instanceIds: [SERVER_INST_ID],
      }),
    });
    expect(ok.status).toBe(200);

    const blocked = makeService({
      memberAccess: true,
      roles: ROLES,
      instances: [serverInstance()],
      botAccessible: async () => false,
    });
    const blockedApp = makeApp(blocked.service, ROLES);
    const res = await blockedApp.request(
      "/api/local-agents/bots/other-bot/grants",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-user-id": MEMBER,
        },
        body: JSON.stringify({ mode: "all" }),
      },
    );
    expect(res.status).toBe(404);
  });
});
