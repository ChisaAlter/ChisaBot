import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { defaultCapabilities } from "../../shared/devices";
import {
  isInsideRoots,
  narrowerProfile,
  profileAllows,
  profileLine,
} from "../../shared/local-agents";
import { createDatabase } from "../src/db/client";
import { createDeviceHub } from "../src/devices/hub";
import type { DeviceRecord } from "../src/devices/store";
import { createLocalAgentService } from "../src/local-agents/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 本地 agent 与权限档位（docs/local-agents.md）。 */

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev_la",
    ownerUserId: "u1",
    name: "测试机",
    platform: "linux",
    osVersion: null,
    hostname: "box",
    arch: "x64",
    clientVersion: "0.1.8",
    capabilities: {
      ...defaultCapabilities(),
      shell: "allow",
      files_read: "allow",
      files_write: "allow",
      input: "allow",
    },
    allowedRoots: ["/home/u/code"],
    paused: false,
    revoked: false,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "x",
    ...overrides,
  };
}

describe("profiles", () => {
  const roots = ["/home/u/code"];
  test("readonly lets reads through and holds every change", () => {
    expect(
      profileAllows("readonly", "read_file", { path: "/etc/hosts" }, roots)
        .inside,
    ).toBe(true);
    expect(profileAllows("readonly", "screenshot", {}, roots).inside).toBe(
      true,
    );
    expect(profileAllows("readonly", "git_status", {}, roots).inside).toBe(
      true,
    );
    expect(
      profileAllows(
        "readonly",
        "write_file",
        { path: "/home/u/code/a.ts" },
        roots,
      ).inside,
    ).toBe(false);
    expect(
      profileAllows("readonly", "shell", { cwd: "/home/u/code" }, roots).inside,
    ).toBe(false);
    expect(profileAllows("readonly", "input", {}, roots).inside).toBe(false);
  });
  test("workspace: writes and commands only inside the folders", () => {
    expect(
      profileAllows(
        "workspace",
        "write_file",
        { path: "/home/u/code/src/a.ts" },
        roots,
      ).inside,
    ).toBe(true);
    expect(
      profileAllows("workspace", "write_file", { path: "src/a.ts" }, roots)
        .inside,
    ).toBe(true);
    expect(
      profileAllows(
        "workspace",
        "write_file",
        { path: "/home/u/code/../.ssh/authorized_keys" },
        roots,
      ).inside,
    ).toBe(false);
    expect(
      profileAllows(
        "workspace",
        "write_file",
        { path: "/home/u/codeX/a" },
        roots,
      ).inside,
    ).toBe(false);
    expect(
      profileAllows("workspace", "shell", { cwd: "/home/u/code/app" }, roots)
        .inside,
    ).toBe(true);
    expect(profileAllows("workspace", "shell", {}, roots).reason).toMatch(
      /工作目录/,
    );
    expect(
      profileAllows(
        "workspace",
        "open",
        { target: "https://example.com" },
        roots,
      ).inside,
    ).toBe(true);
    expect(
      profileAllows("workspace", "open", { target: "calc.exe" }, roots).inside,
    ).toBe(false);
    expect(profileAllows("workspace", "input", {}, roots).inside).toBe(false);
    expect(
      profileAllows("workspace", "edit_file", { path: "/home/u/code/x" }, roots)
        .inside,
    ).toBe(true);
    expect(profileAllows("workspace", "unknown_op", {}, roots).inside).toBe(
      false,
    );
  });
  test("full never narrows; task profile can only be stricter", () => {
    expect(profileAllows("full", "input", {}, roots).inside).toBe(true);
    expect(narrowerProfile("workspace", "full")).toBe("workspace");
    expect(narrowerProfile("workspace", "readonly")).toBe("readonly");
    expect(narrowerProfile("full", undefined)).toBe("full");
  });
  test("windows paths compare case-insensitively", () => {
    expect(
      isInsideRoots(
        "c:\\Users\\A\\Code\\x.txt",
        ["C:\\Users\\a\\code"],
        "win32",
      ),
    ).toBe(true);
    expect(isInsideRoots("D:\\x", ["C:\\Users\\a\\code"], "win32")).toBe(false);
    expect(
      profileLine({
        profile: "workspace",
        isolation: "worktree",
        network: false,
      }),
    ).toBe("工作区 · Git worktree · 断网");
  });
});

describe("hub gate", () => {
  test("an allowed operation outside the profile turns into an approval; inside runs directly", async () => {
    let current = record();
    const audits: Array<Record<string, unknown>> = [];
    const store = {
      get: async () => current,
      touch: async () => {},
      update: async () => current,
      audit: async (input: Record<string, unknown>) => (
        audits.push(input), String(audits.length - 1)
      ),
      finishAudit: async () => {},
    };
    const hub = createDeviceHub({ store: store as never, approvalTtlMs: 200 });
    const sent: Array<Record<string, unknown>> = [];
    const conn = hub.attach(
      current,
      { send: (d: string) => sent.push(JSON.parse(d)), close() {} },
      null,
    );
    hub.setExtension({
      gate: (_r, op, args) =>
        profileAllows("workspace", op, args, ["/home/u/code"]).inside
          ? null
          : "档位之外",
      onMessage: async (_r, message) =>
        void sent.push({ extension: message.type }),
    });
    // 档位之内：直接发 call。
    const inside = hub.invoke({
      device: current,
      operation: "write_file",
      args: { path: "/home/u/code/a" },
      bot: { id: "b", name: "B" },
      summary: "写入",
    });
    await new Promise((r) => setTimeout(r, 10));
    const call = sent.find((m) => m.type === "call");
    expect(call).toBeTruthy();
    await conn.onMessage(
      JSON.stringify({
        type: "result",
        id: call!.id,
        ok: true,
        result: { ok: 1 },
      }),
    );
    expect(await inside).toEqual({ ok: 1 });
    // 档位之外：先审批（超时按拒绝），摘要带原因。
    await expect(
      hub.invoke({
        device: current,
        operation: "write_file",
        args: { path: "/etc/passwd" },
        bot: { id: "b", name: "B" },
        summary: "写入",
      }),
    ).rejects.toThrow(/审批超时/);
    expect(
      sent.some(
        (m) =>
          m.type === "approval_request" &&
          String(m.summary).includes("档位之外"),
      ),
    ).toBe(true);
    // 不认识的消息交给扩展。
    await conn.onMessage(JSON.stringify({ type: "agent_event", taskId: "x" }));
    expect(sent.some((m) => m.extension === "agent_event")).toBe(true);
    current = { ...current };
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("local agent tasks (database)", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const sql = url ? database.$client : (null as never);
  const owner = `latest-${randomUUID().slice(0, 8)}`;
  let device = record({
    id: `dev_${randomUUID().slice(0, 8)}`,
    ownerUserId: owner,
  });
  const sent: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const delivered: Array<{ threadId: string; content: string }> = [];
  let approve = true;
  let lastApprovalId: string | null = null;
  const hub = {
    isOnline: () => true,
    sendRaw: (_id: string, message: Record<string, unknown>) => (
      sent.push(message), true
    ),
    requestUserApproval: async (
      _r: DeviceRecord,
      _input: unknown,
      onCreated?: (id: string) => void,
    ) => {
      lastApprovalId = randomUUID();
      onCreated?.(lastApprovalId);
      await new Promise((r) => setTimeout(r, 30));
      return { approved: approve, by: "web" };
    },
    decide: () => true,
  };
  const deviceStore = {
    get: async () => device,
    forOwner: async () => [device],
    audit: async (input: Record<string, unknown>) => (audits.push(input), "a"),
  };
  const service = url
    ? createLocalAgentService({
        database,
        hub: hub as never,
        deviceStore: deviceStore as never,
        inbox: {
          enqueue: async () => true,
          withdraw: async () => true,
        } as never,
        control: { isActive: () => false } as never,
        deliverTurn: (async (input: {
          threadId: string;
          instruction: string;
        }) => {
          delivered.push({
            threadId: input.threadId,
            content: input.instruction,
          });
          return { replyText: "好的" };
        }) as never,
        generate: async ({ messages }) => [
          { type: "text", text: `收到 ${messages.length} 条` },
        ],
      })
    : (null as never);
  const settle = () => new Promise((r) => setTimeout(r, 80));
  const node = (message: Record<string, unknown>) =>
    service.handleNodeMessage(device, message as never);

  beforeAll(async () => {
    await service.ensure();
    await node({
      type: "agents_detected",
      detection: {
        agents: [
          { kind: "builtin" },
          { kind: "claude", version: "2.1.165", path: "/usr/bin/claude" },
        ],
        sandboxes: { git: true, worktree: true, copy: true, bwrap: false },
        platform: "linux",
        root: true,
      },
    });
  });
  afterAll(async () => {
    await sql.unsafe(
      "DELETE FROM chisabot_local_agent_tasks WHERE owner_user_id = $1",
      [owner],
    );
    await sql.unsafe(
      "DELETE FROM chisabot_device_agent_settings WHERE owner_user_id = $1",
      [owner],
    );
  });

  test("detection is stored; defaults are workspace + worktree + builtin", async () => {
    const settings = await service.settingsFor(device.id);
    expect(settings.profile).toBe("workspace");
    expect(settings.detected?.agents.map((a) => a.kind)).toEqual([
      "builtin",
      "claude",
    ]);
    expect(settings.saved).toBe(true);
  });

  test("refusals: offline-ish choices, folders outside the workspace, missing agents, network", async () => {
    await expect(
      service.start({
        ownerUserId: owner,
        botId: "b",
        botName: "B",
        threadId: "t1",
        task: "x",
        agent: "codex",
      }),
    ).rejects.toThrow(/没有检测到 Codex/);
    await expect(
      service.start({
        ownerUserId: owner,
        botId: "b",
        botName: "B",
        threadId: "t1",
        task: "x",
        cwd: "/etc",
      }),
    ).rejects.toThrow(/不在这台电脑的工作区/);
    await expect(
      service.start({
        ownerUserId: owner,
        botId: "b",
        botName: "B",
        threadId: "t1",
        task: "x",
        agent: "claude",
        network: false,
      }),
    ).rejects.toThrow(/联网/);
    await expect(
      service.start({
        ownerUserId: owner,
        botId: "b",
        botName: "B",
        threadId: "t1",
        task: "x",
        isolation: "bwrap",
      }),
    ).rejects.toThrow(/不能用/);
    device = {
      ...device,
      capabilities: { ...device.capabilities, shell: "off" },
    };
    await expect(
      service.start({
        ownerUserId: owner,
        botId: "b",
        botName: "B",
        threadId: "t1",
        task: "x",
      }),
    ).rejects.toThrow(/命令行/);
    device = {
      ...device,
      capabilities: { ...device.capabilities, shell: "allow" },
    };
  });

  test("workspace profile: approval first, then run; events, done with a pending diff, delivery, apply", async () => {
    sent.length = 0;
    approve = true;
    const task = await service.start({
      ownerUserId: owner,
      botId: "b",
      botName: "B",
      threadId: "t1",
      task: "修好 README 里的错别字",
      title: "修错别字",
      agent: "claude",
    });
    expect(task.status).toBe("pending_approval");
    await settle();
    const run = sent.find((m) => m.type === "agent_run");
    expect(run).toBeTruthy();
    expect(run!.cwd).toBe("/home/u/code");
    expect(run!.isolation).toBe("worktree");
    expect(run!.skipPermissions).toBe(false); // 工作区 + worktree：不是系统级沙盒
    await node({ type: "agent_started", taskId: task.id });
    await node({
      type: "agent_event",
      taskId: task.id,
      kind: "tool",
      text: "修改 README.md",
      step: "修改 README.md",
    });
    let list = await service.forThread(owner, "t1");
    expect(list[0]!.status).toBe("running");
    expect(list[0]!.step).toBe("修改 README.md");
    expect(list[0]!.lines.some((l) => l.text === "修改 README.md")).toBe(true);
    await node({
      type: "agent_done",
      taskId: task.id,
      ok: true,
      exitCode: 0,
      summary: "改好了 2 处",
      diff: {
        files: [
          { path: "README.md", added: 2, removed: 2, status: "modified" },
        ],
        added: 2,
        removed: 2,
        pending: true,
        applied: false,
        patch: "diff --git",
      },
    });
    await settle();
    list = await service.forThread(owner, "t1");
    expect(list[0]!.status).toBe("done");
    expect(list[0]!.diff?.pending).toBe(true);
    expect(delivered.at(-1)?.content).toMatch(/^⟦chisabot:local-agent-result:/);
    expect(delivered.at(-1)?.content).toMatch(/应用改动/);
    // 应用改动：发给电脑，电脑回 agent_applied。
    const applying = service.applyChanges(owner, task.id, false);
    await settle();
    expect(
      sent.some((m) => m.type === "agent_apply" && m.taskId === task.id),
    ).toBe(true);
    await node({ type: "agent_applied", taskId: task.id, ok: true });
    const applied = await applying;
    expect(applied.diff?.applied).toBe(true);
    expect(applied.diff?.pending).toBe(false);
  });

  test("denied approval cancels; device full access (ADR-0009) starts directly and skips CLI confirmations", async () => {
    approve = false;
    const denied = await service.start({
      ownerUserId: owner,
      botId: "b",
      botName: "B",
      threadId: "t2",
      task: "x",
    });
    await settle();
    expect((await service.forThread(owner, "t2"))[0]!.status).toBe("cancelled");
    approve = true;
    // 存的档位不接受 full：完全访问是设备的完全访问开关。
    await expect(
      service.saveSettings(owner, device.id, { profile: "full" }),
    ).rejects.toThrow(/权限/);
    device = {
      ...device,
      fullAccessUntil: new Date(Date.now() + 3600_000).toISOString(),
    };
    sent.length = 0;
    const direct = await service.start({
      ownerUserId: owner,
      botId: "b",
      botName: "B",
      threadId: "t3",
      task: "x",
      agent: "claude",
      cwd: "/tmp/anything",
    });
    expect(direct.status).toBe("starting");
    await settle();
    const run = sent.find(
      (m) => m.type === "agent_run" && m.taskId === direct.id,
    );
    expect(run?.skipPermissions).toBe(true);
    // 任务档位可以更严：
    const narrow = await service.start({
      ownerUserId: owner,
      botId: "b",
      botName: "B",
      threadId: "t3",
      task: "只看看",
      profile: "readonly",
    });
    expect(narrow.profile).toBe("readonly");
    await service.stop(owner, direct.id);
    await service.stop(owner, narrow.id);
    // Stop is a request; only the actual node terminal proves an already sent run released its slot.
    await node({
      type: "agent_done",
      taskId: direct.id,
      stopped: true,
      ok: false,
    });
    await node({
      type: "agent_done",
      taskId: narrow.id,
      stopped: true,
      ok: false,
    });
    expect(denied.id).toBeTruthy();
    device = { ...device, fullAccessUntil: null };
    await service.saveSettings(owner, device.id, { profile: "readonly" });
    // 完全访问关掉后回到存的档位：任务要审批。
    const back = await service.start({
      ownerUserId: owner,
      botId: "b",
      botName: "B",
      threadId: "t3",
      task: "x",
    });
    expect(back.profile).toBe("readonly");
    expect(back.status).toBe("pending_approval");
    await service.stop(owner, back.id);
    await service.saveSettings(owner, device.id, { profile: "workspace" });
    expect(audits.some((a) => a.action === "agent_profile_changed")).toBe(true);
  });

  test("builtin agent: server proxies model calls and approvals for the node", async () => {
    sent.length = 0;
    approve = true;
    const task = await service.start({
      ownerUserId: owner,
      botId: "b",
      botName: "B",
      threadId: "t4",
      task: "列出文件",
    });
    for (
      let i = 0;
      i < 200 &&
      !sent.some(
        (message) => message.type === "agent_run" && message.taskId === task.id,
      );
      i++
    )
      await Bun.sleep(10);
    expect(
      sent.some(
        (message) => message.type === "agent_run" && message.taskId === task.id,
      ),
    ).toBe(true);
    await node({ type: "agent_started", taskId: task.id });
    await node({
      type: "agent_llm",
      taskId: task.id,
      reqId: "r1",
      messages: [{ role: "user", text: "hi" }],
      system: "s",
    });
    const reply = sent.find(
      (m) => m.type === "agent_llm_result" && m.reqId === "r1",
    );
    expect(reply).toEqual({
      type: "agent_llm_result",
      reqId: "r1",
      ok: true,
      content: [{ type: "text", text: "收到 1 条" }],
    });
    await node({
      type: "agent_approval",
      taskId: task.id,
      reqId: "a1",
      operation: "shell",
      summary: "运行 rm -rf build（档位之外）",
    });
    expect(
      sent.find((m) => m.type === "agent_approval_result" && m.reqId === "a1")
        ?.approved,
    ).toBe(true);
    // 别的设备发来的同一个任务 id：忽略。
    await service.handleNodeMessage({ ...device, id: "dev_other" }, {
      type: "agent_done",
      taskId: task.id,
      ok: true,
    } as never);
    expect((await service.forThread(owner, "t4"))[0]!.status).toBe("running");
    await node({
      type: "agent_done",
      taskId: task.id,
      ok: false,
      error: "boom",
    });
    expect((await service.forThread(owner, "t4"))[0]!.status).toBe("failed");
  });
});
