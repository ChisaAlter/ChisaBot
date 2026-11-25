import { describe, expect, test } from "bun:test";
import { defaultCapabilities } from "../../shared/devices";
import type { AgentProfile } from "../../shared/local-agents";
import type { Database } from "../src/db/client";
import type { DeviceRecord } from "../src/devices/store";
import type { InstanceRow } from "../src/local-agents/instances-store";
import { createLocalAgentService } from "../src/local-agents/service";

type StoredTask = {
  id: string;
  owner_user_id: string;
  device_id: string;
  device_name: string;
  agent_id: string;
  bot_name: string | null;
  thread_id: string | null;
  agent: string;
  instance_id: string | null;
  instance_name: string | null;
  environment_id: string | null;
  parent_task_id: string | null;
  depth: number;
  invocation_mode: string | null;
  title: string;
  task: string;
  profile: AgentProfile;
  isolation: string;
  network: boolean;
  cwd: string | null;
  status: string;
  step: string | null;
  transcript: unknown[];
  line_count: number;
  summary: string | null;
  diff: unknown;
  error: string | null;
  llm_calls: number;
  result_message_id: string | null;
  capacity_active: boolean;
  session_id: string | null;
  turn_count: number;
  pending_input: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type StoredGrant = {
  owner_user_id: string;
  bot_id: string;
  mode: string;
  instance_ids: string[];
  expose_named_tools: boolean;
  allow_nested_subagents: boolean;
  max_depth: number;
  updated_at: string;
};

function makeDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev_enh_1",
    ownerUserId: "user_enh_1",
    name: "开发机",
    platform: "linux",
    osVersion: null,
    hostname: "dev-box",
    arch: "x64",
    clientVersion: "0.2.0",
    capabilities: {
      ...defaultCapabilities(),
      shell: "allow",
      files_read: "allow",
      files_write: "allow",
      input: "allow",
    },
    allowedRoots: ["/home/dev/repo"],
    paused: false,
    revoked: false,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "hash",
    ...overrides,
  };
}

function makeInstance(overrides: Partial<InstanceRow> = {}): InstanceRow {
  const now = new Date().toISOString();
  return {
    id: "agi_codex_1",
    owner_user_id: "user_enh_1",
    environment_id: "dev_enh_1",
    slug: "codex-worker",
    driver: "codex",
    name: "Codex Worker",
    description: "代码实现与审查子代理",
    enabled: true,
    expose_as_tool: true,
    is_default_seed: false,
    sort_order: 0,
    config: {},
    env_vars: [],
    probe: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeTask(overrides: Partial<StoredTask> = {}): StoredTask {
  const now = new Date().toISOString();
  return {
    id: "task_parent_1",
    owner_user_id: "user_enh_1",
    device_id: "dev_enh_1",
    device_name: "开发机",
    agent_id: "bot_enh_1",
    bot_name: "Chisa",
    thread_id: "thread_enh_1",
    agent: "codex",
    instance_id: "agi_codex_1",
    instance_name: "Codex Worker",
    environment_id: "dev_enh_1",
    parent_task_id: null,
    depth: 0,
    invocation_mode: "wait",
    title: "父任务",
    task: "协调子任务",
    profile: "workspace",
    isolation: "worktree",
    network: true,
    cwd: "/home/dev/repo",
    status: "running",
    step: "执行中",
    transcript: [],
    line_count: 0,
    summary: null,
    diff: null,
    error: null,
    llm_calls: 0,
    result_message_id: null,
    capacity_active: true,
    session_id: null,
    turn_count: 1,
    pending_input: null,
    created_at: now,
    started_at: now,
    finished_at: null,
    ...overrides,
  };
}

function createHarness(options?: {
  device?: DeviceRecord;
  deviceProfile?: AgentProfile;
  instances?: InstanceRow[];
  grant?: Partial<StoredGrant>;
}) {
  let device = options?.device ?? makeDevice();
  const tasks = new Map<string, StoredTask>();
  const instances: InstanceRow[] = options?.instances ?? [makeInstance()];
  const grant: StoredGrant = {
    owner_user_id: device.ownerUserId,
    bot_id: "bot_enh_1",
    mode: "all",
    instance_ids: [],
    expose_named_tools: true,
    allow_nested_subagents: true,
    max_depth: 3,
    updated_at: new Date().toISOString(),
    ...options?.grant,
  };
  const settingsRow = {
    device_id: device.id,
    owner_user_id: device.ownerUserId,
    profile: options?.deviceProfile ?? "workspace",
    workspace_roots: ["/home/dev/repo"],
    network: true,
    isolation: "worktree",
    default_agent: "builtin",
    builtin_model: { kind: "server" },
    container_image: "debian:bookworm-slim",
    detected: {
      agents: [{ kind: "builtin" }, { kind: "codex", version: "1.0.0" }],
      sandboxes: { git: true, worktree: true, copy: true },
      platform: "linux",
      checkedAt: new Date().toISOString(),
    },
    member_access: false,
    updated_at: new Date().toISOString(),
  };

  const activeStatuses = new Set([
    "pending_approval",
    "starting",
    "running",
    "needs_input",
  ]);

  const unsafe = async (
    query: string,
    params: unknown[] = [],
  ): Promise<unknown[]> => {
    const q = query.replace(/\s+/g, " ").trim();

    if (q.startsWith("SELECT pg_advisory_xact_lock")) {
      return [];
    }
    if (q.includes("to_regclass('public.chisabot_local_agent_tasks')")) {
      return [{ devices: false, threads: false, dsh: false }];
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_bot_agent_grants WHERE owner_user_id = $1 AND bot_id = $2",
      )
    ) {
      if (params[0] === grant.owner_user_id && params[1] === grant.bot_id) {
        return [grant];
      }
      return [];
    }
    if (q.startsWith("SELECT * FROM chisabot_agent_instances")) {
      const ownerId = String(params[0] ?? "");
      const envId = params.length > 1 ? String(params[1]) : undefined;
      return instances.filter(
        (inst) =>
          inst.owner_user_id === ownerId &&
          (envId === undefined || inst.environment_id === envId),
      );
    }
    if (
      q.startsWith(
        "SELECT * FROM chisabot_device_agent_settings WHERE device_id = $1",
      )
    ) {
      return params[0] === settingsRow.device_id ? [settingsRow] : [];
    }
    if (
      q.startsWith("SELECT * FROM chisabot_local_agent_tasks WHERE id = $1")
    ) {
      const row = tasks.get(String(params[0] ?? ""));
      return row ? [{ ...row }] : [];
    }
    if (
      q.startsWith(
        "SELECT status,capacity_active FROM chisabot_local_agent_tasks WHERE id=$1 FOR UPDATE",
      )
    ) {
      const row = tasks.get(String(params[0] ?? ""));
      return row
        ? [{ status: row.status, capacity_active: row.capacity_active }]
        : [];
    }
    if (
      q.startsWith(
        "SELECT count(*)::int AS n FROM chisabot_local_agent_tasks WHERE device_id = $1",
      )
    ) {
      const devId = String(params[0] ?? "");
      const n = [...tasks.values()].filter(
        (t) => t.device_id === devId && activeStatuses.has(t.status),
      ).length;
      return [{ n }];
    }
    if (
      q.startsWith(
        "SELECT count(*)::int AS n FROM chisabot_local_agent_tasks WHERE owner_user_id = $1",
      )
    ) {
      const ownerId = String(params[0] ?? "");
      const n = [...tasks.values()].filter(
        (t) => t.owner_user_id === ownerId && activeStatuses.has(t.status),
      ).length;
      return [{ n }];
    }
    if (q.startsWith("INSERT INTO chisabot_local_agent_tasks")) {
      const now = new Date().toISOString();
      const row: StoredTask = {
        id: String(params[0]),
        owner_user_id: String(params[1]),
        device_id: String(params[2]),
        device_name: String(params[3]),
        agent_id: String(params[4]),
        bot_name: params[5] ? String(params[5]) : null,
        thread_id: params[6] ? String(params[6]) : null,
        agent: String(params[7]),
        instance_id: params[8] ? String(params[8]) : null,
        instance_name: params[9] ? String(params[9]) : null,
        environment_id: params[10] ? String(params[10]) : null,
        parent_task_id: params[11] ? String(params[11]) : null,
        depth: Number(params[12] ?? 0),
        invocation_mode: params[13] ? String(params[13]) : null,
        title: String(params[14]),
        task: String(params[15]),
        profile: params[16] as AgentProfile,
        isolation: String(params[17]),
        network: Boolean(params[18]),
        cwd: params[19] ? String(params[19]) : null,
        status: String(params[20]),
        step: params[21] ? String(params[21]) : null,
        transcript: [],
        line_count: 0,
        summary: null,
        diff: null,
        error: null,
        llm_calls: 0,
        result_message_id: null,
        capacity_active: false,
        session_id: null,
        turn_count: 1,
        pending_input: null,
        created_at: now,
        started_at: null,
        finished_at: null,
      };
      tasks.set(row.id, row);
      return [];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_local_agent_tasks SET capacity_active=true,status=$2",
      )
    ) {
      const row = tasks.get(String(params[0] ?? ""));
      if (row) {
        row.capacity_active = true;
        row.status = String(params[1]);
        row.step = "正在执行";
      }
      return [];
    }
    if (
      q.startsWith(
        "UPDATE chisabot_local_agent_tasks SET capacity_active=false",
      )
    ) {
      const row = tasks.get(String(params[0] ?? ""));
      if (row) row.capacity_active = false;
      return [];
    }
    if (q.startsWith("UPDATE chisabot_local_agent_tasks SET transcript = $2")) {
      const row = tasks.get(String(params[0] ?? ""));
      if (row) {
        row.transcript = JSON.parse(String(params[1] ?? "[]")) as unknown[];
        row.line_count = Number(params[2] ?? 0);
        row.step = params[3] ? String(params[3]) : null;
      }
      return [];
    }
    if (q.startsWith("UPDATE chisabot_local_agent_tasks")) {
      return [];
    }
    return [];
  };

  const client = {
    unsafe,
    begin: async <T>(fn: (tx: { unsafe: typeof unsafe }) => Promise<T>) =>
      fn({ unsafe }),
  };

  const sent: Array<Record<string, unknown>> = [];
  const hub = {
    isOnline: (id: string) => id === device.id,
    sendRaw: (_id: string, message: Record<string, unknown>) => {
      sent.push(message);
      return true;
    },
    requestUserApproval: async () => ({ approved: true, by: "web" }),
    decide: () => true,
  };
  const deviceStore = {
    get: async (id: string) => (id === device.id ? device : null),
    forOwner: async (ownerId: string) =>
      ownerId === device.ownerUserId ? [device] : [],
    audit: async () => "audit_1",
  };

  const service = createLocalAgentService({
    database: { $client: client } as unknown as Database,
    hub: hub as never,
    deviceStore: deviceStore as never,
    inbox: {
      enqueue: async () => true,
      withdraw: async () => true,
    } as never,
    control: { isActive: () => false } as never,
    deliverTurn: (async () => ({ replyText: "ok" })) as never,
    generate: async () => [{ type: "text", text: "ok" }],
  });

  const waitForAgentRun = async (taskId: string) => {
    for (let i = 0; i < 100; i++) {
      const msg = sent.find(
        (m) => m.type === "agent_run" && m.taskId === taskId,
      );
      if (msg) return msg;
      await Bun.sleep(10);
    }
    return undefined;
  };

  return {
    get device() {
      return device;
    },
    setDevice(next: DeviceRecord) {
      device = next;
    },
    tasks,
    sent,
    service,
    waitForAgentRun,
  };
}

describe("local-agents enhancements", () => {
  test("tools() guidance instructs bots to prefer local_agent_continue for follow-ups and needs_input", async () => {
    const harness = createHarness();
    const grantedTools = await harness.service.tools({
      ownerUserId: harness.device.ownerUserId,
      botId: "bot_enh_1",
      botName: "Chisa",
      threadId: "thread_enh_1",
    });

    expect(grantedTools.some((t) => t.name === "local_agent_continue")).toBe(
      true,
    );
    const guidanceOwner = grantedTools.find(
      (t) => typeof t.guidance === "string",
    );
    expect(guidanceOwner).toBeDefined();
    const guidance = guidanceOwner?.guidance ?? "";
    expect(guidance).toContain("local_agent_continue");
    expect(guidance).toContain("needs_input");
    expect(guidance).toContain("taskId");
    expect(guidance).toContain("sessionId");
  });

  test("tools() guidance also includes local_agent_continue when only online devices exist without instances", async () => {
    const harness = createHarness({ instances: [] });
    const grantedTools = await harness.service.tools({
      ownerUserId: harness.device.ownerUserId,
      botId: "bot_enh_1",
      botName: "Chisa",
      threadId: "thread_enh_1",
    });

    const guidanceOwner = grantedTools.find(
      (t) => typeof t.guidance === "string",
    );
    expect(guidanceOwner).toBeDefined();
    expect(guidanceOwner?.guidance ?? "").toContain("local_agent_continue");
  });

  test("agent_subcall tightens child profile when workspace parent requests readonly", async () => {
    const harness = createHarness({ deviceProfile: "workspace" });
    const parent = makeTask({ id: "parent_ws_1", profile: "workspace" });
    harness.tasks.set(parent.id, parent);

    await harness.service.handleNodeMessage(harness.device, {
      type: "agent_subcall",
      taskId: parent.id,
      reqId: "req_tighten_ro",
      action: "run",
      params: {
        instance: "codex-worker",
        task: "只读检查仓库代码结构",
        mode: "async",
        profile: "readonly",
      },
    });

    const reply = harness.sent.find(
      (m) => m.type === "agent_subcall_result" && m.reqId === "req_tighten_ro",
    );
    expect(reply?.ok).toBe(true);
    const data = reply?.data as { taskId?: string } | undefined;
    const childId = data?.taskId ?? "";
    expect(childId.length).toBeGreaterThan(0);

    const childRow = harness.tasks.get(childId);
    expect(childRow?.profile).toBe("readonly");
    expect(childRow?.parent_task_id).toBe(parent.id);
    expect(childRow?.depth).toBe(1);

    const runMsg = await harness.waitForAgentRun(childId);
    expect(runMsg?.profile).toBe("readonly");
  });

  test("agent_subcall clamps readonly parent so child requesting full or workspace never widens", async () => {
    const harness = createHarness({
      device: makeDevice({
        fullAccessUntil: new Date(Date.now() + 3600_000).toISOString(),
      }),
      deviceProfile: "workspace",
    });
    const parent = makeTask({ id: "parent_ro_1", profile: "readonly" });
    harness.tasks.set(parent.id, parent);

    await harness.service.handleNodeMessage(harness.device, {
      type: "agent_subcall",
      taskId: parent.id,
      reqId: "req_clamp_full",
      action: "run",
      params: {
        instance: "codex-worker",
        task: "尝试以 full 档位执行",
        mode: "async",
        profile: "full",
      },
    });

    const fullReply = harness.sent.find(
      (m) => m.type === "agent_subcall_result" && m.reqId === "req_clamp_full",
    );
    expect(fullReply?.ok).toBe(true);
    const fullChildId =
      (fullReply?.data as { taskId?: string } | undefined)?.taskId ?? "";
    expect(fullChildId.length).toBeGreaterThan(0);
    expect(harness.tasks.get(fullChildId)?.profile).toBe("readonly");
    const fullRunMsg = await harness.waitForAgentRun(fullChildId);
    expect(fullRunMsg?.profile).toBe("readonly");

    await harness.service.handleNodeMessage(harness.device, {
      type: "agent_subcall",
      taskId: parent.id,
      reqId: "req_clamp_ws",
      action: "run",
      params: {
        instance: "codex-worker",
        task: "尝试以 workspace 档位执行",
        mode: "async",
        profile: "workspace",
      },
    });

    const wsReply = harness.sent.find(
      (m) => m.type === "agent_subcall_result" && m.reqId === "req_clamp_ws",
    );
    expect(wsReply?.ok).toBe(true);
    const wsChildId =
      (wsReply?.data as { taskId?: string } | undefined)?.taskId ?? "";
    expect(wsChildId.length).toBeGreaterThan(0);
    expect(harness.tasks.get(wsChildId)?.profile).toBe("readonly");
    const wsRunMsg = await harness.waitForAgentRun(wsChildId);
    expect(wsRunMsg?.profile).toBe("readonly");
  });

  test("agent_subcall inherits parent profile when profile is omitted or invalid", async () => {
    const harness = createHarness({ deviceProfile: "workspace" });
    const parent = makeTask({ id: "parent_ws_inherit", profile: "workspace" });
    harness.tasks.set(parent.id, parent);

    await harness.service.handleNodeMessage(harness.device, {
      type: "agent_subcall",
      taskId: parent.id,
      reqId: "req_inherit_omitted",
      action: "run",
      params: {
        instance: "codex-worker",
        task: "未显式指定 profile 的子调用",
        mode: "async",
      },
    });

    const omittedReply = harness.sent.find(
      (m) =>
        m.type === "agent_subcall_result" && m.reqId === "req_inherit_omitted",
    );
    expect(omittedReply?.ok).toBe(true);
    const omittedChildId =
      (omittedReply?.data as { taskId?: string } | undefined)?.taskId ?? "";
    expect(omittedChildId.length).toBeGreaterThan(0);
    expect(harness.tasks.get(omittedChildId)?.profile).toBe("workspace");
    const omittedRunMsg = await harness.waitForAgentRun(omittedChildId);
    expect(omittedRunMsg?.profile).toBe("workspace");

    await harness.service.handleNodeMessage(harness.device, {
      type: "agent_subcall",
      taskId: parent.id,
      reqId: "req_inherit_invalid",
      action: "run",
      params: {
        instance: "codex-worker",
        task: "传入非法 profile 的子调用",
        mode: "async",
        profile: "elevated_invalid",
      },
    });

    const invalidReply = harness.sent.find(
      (m) =>
        m.type === "agent_subcall_result" && m.reqId === "req_inherit_invalid",
    );
    expect(invalidReply?.ok).toBe(true);
    const invalidChildId =
      (invalidReply?.data as { taskId?: string } | undefined)?.taskId ?? "";
    expect(invalidChildId.length).toBeGreaterThan(0);
    expect(harness.tasks.get(invalidChildId)?.profile).toBe("workspace");
    const invalidRunMsg = await harness.waitForAgentRun(invalidChildId);
    expect(invalidRunMsg?.profile).toBe("workspace");
  });
});
