import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createCloudCcService } from "../src/cloud-cc/service";
import { createCloudSyncService } from "../src/cloud-cc/sync";
import { createDatabase } from "../src/db/client";
import type { DeviceRecord } from "../src/devices/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 电脑文件夹导入失败后残留、移除后无法重新导入（DESIGN.md §87）：服务器这一侧。
 *  - 新建 / 开启同步之前先 sync_probe 边车，连不上什么都不建；
 *  - 撤销新建（abandon）删节点目录 + 同步记录 + 工作区；有会话的不撤；
 *  - 删工作区时 forgetWorkspace 拆掉绑定 / 租约 / 冲突，通知登记过的电脑 sync_forget；
 *  - 对账 reconcile 告诉电脑哪些工作区已经没了；启动时清掉工作区已删的残留记录。
 */
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("cloud folder sync cleanup", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const sql = url ? database.$client : (null as never);
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const owner = `u_sync_${tag}`;
  const nodeId = `dev_node_${tag}`;
  const pcId = `dev_pc_${tag}`;
  const pc = { id: pcId, ownerUserId: owner, platform: "win32", revoked: false, paused: false, name: "Ayase" } as unknown as DeviceRecord;
  const sent: { deviceId: string; message: Record<string, unknown> }[] = [];
  const rpcCalls: { op: string; args: unknown }[] = [];
  let probe: { ok: boolean; error?: string } | "unknown" = { ok: true };
  let pcOnline = true;
  const hub = {
    isOnline: (id: string) => id === nodeId || (id === pcId && pcOnline),
    sendRaw: (deviceId: string, message: Record<string, unknown>) => {
      if (deviceId === pcId && !pcOnline) return false;
      sent.push({ deviceId, message });
      return true;
    },
  };
  const nodeRpc = async <T,>(_device: string, op: string, args: Record<string, unknown> = {}) => {
    rpcCalls.push({ op, args });
    if (op === "sync_probe") {
      if (probe === "unknown") throw new Error("不认识的操作 sync_probe");
      return probe as T;
    }
    if (op === "ws_init_local") return { git: true } as T;
    if (op === "sync_host_key") return { hostKey: "ssh-ed25519 AAAA", workPath: `/workspace/projects/${args.workspaceId}/work` } as T;
    return { ok: true } as T;
  };
  const sync = url
    ? createCloudSyncService({ database, hub, deviceStore: { get: async () => null }, nodeRpc: nodeRpc as never, nodeFor: async () => ({ device_id: nodeId }) })
    : (null as never);
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrW7vYqk4H7qC6lq0q1nW8mXo8bJqk0q0Vd1u0bU9xY";
  const ids: string[] = [];

  async function ready() {
    // 工作区 / 会话表由云端 Claude Code 服务建（和生产一样的 DDL）
    await createCloudCcService({ database, hub: hub as never, deviceStore: { get: async () => null } }).ensure();
    await sync.ensure();
  }
  const count = async (table: string, ws: string) => (await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [ws]))[0]!.n;
  const wsRow = async (ws: string) => (await sql.unsafe("SELECT id FROM chisabot_cc_workspaces WHERE id = $1", [ws])).length;

  afterAll(async () => {
    for (const ws of ids) {
      for (const t of ["chisabot_cc_sync_bindings", "chisabot_cc_leases", "chisabot_cc_sync_conflicts", "chisabot_cc_sync_events", "chisabot_cc_sessions"]) await sql.unsafe(`DELETE FROM ${t} WHERE workspace_id = $1`, [ws]);
      await sql.unsafe("DELETE FROM chisabot_cc_workspaces WHERE id = $1", [ws]);
    }
    await sql.end?.();
  });

  test("sidecar down → create refused before anything is written; old node (no sync_probe) still works", async () => {
    await ready();
    probe = { ok: false, error: "连不上同步边车：ECONNREFUSED" };
    const before = (await sql.unsafe("SELECT id FROM chisabot_cc_workspaces WHERE owner_user_id = $1", [owner])).length;
    await expect(sync._internal.createLocalWorkspace(pc, { name: "Seelen-UI", label: "C:\\AI\\Seelen-UI" })).rejects.toThrow(/同步组件没有就绪.*ECONNREFUSED.*什么都没有建/);
    expect((await sql.unsafe("SELECT id FROM chisabot_cc_workspaces WHERE owner_user_id = $1", [owner])).length).toBe(before);
    expect(rpcCalls.some((c) => c.op === "ws_init_local")).toBe(false);
    probe = "unknown";
    const ws = await sync._internal.createLocalWorkspace(pc, { name: "Seelen-UI", label: "C:\\AI\\Seelen-UI" });
    ids.push(ws.id);
    expect(await wsRow(ws.id)).toBe(1);
    probe = { ok: true };
  });

  test("bind also probes first: sidecar down → no binding row", async () => {
    const ws = await sync._internal.createLocalWorkspace(pc, { name: "b", label: "C:\\b" });
    ids.push(ws.id);
    probe = { ok: false, error: "连不上同步边车：ECONNREFUSED" };
    await expect(sync._internal.bind(pc, { workspaceId: ws.id, pubKey: key, label: "C:\\b" })).rejects.toThrow(/同步组件没有就绪/);
    expect(await count("chisabot_cc_sync_bindings", ws.id)).toBe(0);
    probe = { ok: true };
  });

  test("abandon a failed create: node dir + rows + workspace gone; refused once a session exists", async () => {
    const ws = await sync._internal.createLocalWorkspace(pc, { name: "Seelen-UI", label: "C:\\AI\\Seelen-UI" });
    ids.push(ws.id);
    await sync._internal.bind(pc, { workspaceId: ws.id, pubKey: key, label: "C:\\AI\\Seelen-UI" });
    expect(await count("chisabot_cc_sync_bindings", ws.id)).toBe(1);
    expect(await count("chisabot_cc_leases", ws.id)).toBe(1);
    rpcCalls.length = 0;
    const r = await sync._internal.dropNewLocal(owner, ws.id, pcId, "abandoned");
    expect(r).toMatchObject({ abandoned: true, gone: true, diskLeft: false });
    expect(rpcCalls.map((c) => c.op)).toContain("ws_delete");
    expect(await wsRow(ws.id)).toBe(0);
    expect(await count("chisabot_cc_sync_bindings", ws.id)).toBe(0);
    expect(await count("chisabot_cc_leases", ws.id)).toBe(0);
    // 再撤一次：已经没了
    expect(await sync._internal.dropNewLocal(owner, ws.id, pcId, "abandoned")).toMatchObject({ abandoned: false, gone: true });
    // 有会话的不撤
    const ws2 = await sync._internal.createLocalWorkspace(pc, { name: "c", label: "C:\\c" });
    ids.push(ws2.id);
    await sql.unsafe("INSERT INTO chisabot_cc_sessions (id, owner_user_id, workspace_id, title) VALUES ($1, $2, $3, 'x')", [`ccs_${tag}`, owner, ws2.id]);
    await expect(sync._internal.dropNewLocal(owner, ws2.id, pcId, "abandoned")).rejects.toThrow(/已经开过会话/);
    expect(await wsRow(ws2.id)).toBe(1);
  });

  test("delete workspace → forgetWorkspace drops binding / lease / conflicts and tells the pc (sync_forget)", async () => {
    const ws = await sync._internal.createLocalWorkspace(pc, { name: "d", label: "C:\\d" });
    ids.push(ws.id);
    await sync._internal.bind(pc, { workspaceId: ws.id, pubKey: key, label: "C:\\d" });
    await sync._internal.release(pc, { workspaceId: ws.id });
    await sql.unsafe("INSERT INTO chisabot_cc_sync_conflicts (id, binding_id, workspace_id, path) VALUES ($1, 'sb_x', $2, 'a.txt')", [`scf_${tag}`, ws.id]);
    sent.length = 0;
    rpcCalls.length = 0;
    expect(await sync.forgetWorkspace(owner, ws.id, nodeId)).toBe(1);
    for (const t of ["chisabot_cc_sync_bindings", "chisabot_cc_leases", "chisabot_cc_sync_conflicts"]) expect(await count(t, ws.id)).toBe(0);
    expect(sent).toContainEqual({ deviceId: pcId, message: { type: "sync_forget", workspaceId: ws.id } });
    expect(rpcCalls.map((c) => c.op)).toContain("sync_keys_set");
    const ev = await sql.unsafe<{ kind: string }[]>("SELECT kind FROM chisabot_cc_sync_events WHERE workspace_id = $1 ORDER BY id", [ws.id]);
    expect(ev.map((e) => e.kind)).toContain("forgotten");
  });

  test("reconcile tells the pc which workspaces are gone; startup cleans orphan rows (the 2026-10-16 prod state)", async () => {
    const live = await sync._internal.createLocalWorkspace(pc, { name: "live", label: "C:\\live" });
    ids.push(live.id);
    await sync._internal.bind(pc, { workspaceId: live.id, pubKey: key, label: "C:\\live" });
    // 旧版本删工作区留下的：工作区行没了，绑定 / 租约还在
    const orphan = `ws_orphan${tag}`;
    ids.push(orphan);
    await sql.unsafe(
      "INSERT INTO chisabot_cc_sync_bindings (id, owner_user_id, workspace_id, pc_device_id, local_path_label, pub_key, ssh_key_fpr, enabled, last_state) VALUES ($1, $2, $3, $4, 'C:\\AI\\Seelen-UI', $5, 'SHA256:x', false, 'paused')",
      [`sb_orphan${tag}`, owner, orphan, pcId, key],
    );
    await sql.unsafe("INSERT INTO chisabot_cc_leases (workspace_id, holder, binding_epoch) VALUES ($1, 'cloud', 1)", [orphan]);
    const r = await sync._internal.reconcile(pc, { workspaceIds: [live.id, orphan, "../bad"] });
    expect(r.gone).toEqual([orphan]);
    expect(await count("chisabot_cc_sync_bindings", orphan)).toBe(0);
    // 启动清理
    await sql.unsafe("INSERT INTO chisabot_cc_leases (workspace_id, holder, binding_epoch) VALUES ($1, 'cloud', 1)", [orphan]);
    const cleaned = await sync.cleanupOrphans();
    expect(cleaned).toContain(orphan);
    expect(cleaned).not.toContain(live.id);
    expect(await count("chisabot_cc_leases", orphan)).toBe(0);
    expect(await count("chisabot_cc_sync_bindings", live.id)).toBe(1);
  });

  test("flushBeforeTurn syncs when PC is online; withHandoff auto-pauses and completes write when PC is offline", async () => {
    const ws = await sync._internal.createLocalWorkspace(pc, { name: "handoff-test", label: "C:\\handoff" });
    ids.push(ws.id);
    await sync._internal.bind(pc, { workspaceId: ws.id, pubKey: key, label: "C:\\handoff" });
    await sync._internal.report(pc, { workspaceId: ws.id, state: "pc_active" });

    sent.length = 0;
    const flushPromise = sync.flushBeforeTurn(owner, ws.id, 2000);
    // Wait a tick for sync_flush to be sent
    await new Promise((r) => setTimeout(r, 20));
    const flushMsg = sent.find((s) => s.message.type === "sync_flush" && s.message.workspaceId === ws.id);
    expect(flushMsg).toBeDefined();
    await sync._internal.flushDone(pc, { workspaceId: ws.id, flushId: String(flushMsg!.message.flushId), ok: true });
    expect(await flushPromise).toEqual({ synced: true });

    // When PC goes offline, flushBeforeTurn returns skipped: pc_offline without throwing
    pcOnline = false;
    expect(await sync.flushBeforeTurn(owner, ws.id, 500)).toEqual({ synced: false, skipped: "pc_offline" });

    // When PC is offline during withHandoff (e.g. mergeSession), auto-pause binding & reclaim lease to cloud
    const res = await sync.withHandoff(
      owner,
      ws.id,
      async () => ({ merged: true }),
      (x) => x.merged,
    );
    expect(res).toEqual({ merged: true });
    const [wsAfter] = await sql.unsafe<{ sync_state: string }[]>("SELECT sync_state FROM chisabot_cc_workspaces WHERE id = $1", [ws.id]);
    expect(wsAfter?.sync_state).toBe("paused");
    const [leaseAfter] = await sql.unsafe<{ holder: string }[]>("SELECT holder FROM chisabot_cc_leases WHERE workspace_id = $1", [ws.id]);
    expect(leaseAfter?.holder).toBe("cloud");
    pcOnline = true;
  });
});
