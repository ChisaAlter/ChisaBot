import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createCloudCcService } from "../src/cloud-cc/service";
import { sha256Hex } from "../src/cloud-cc/node-script";
import { createDatabase } from "../src/db/client";
import type { DeviceRecord } from "../src/devices/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 云端 Claude 登录状态的缓存刷新（DESIGN.md §73.1）：
 *  - POST /claude/check（check）同一节点同时只发一次 rpc status，结果写回 claude_auth；
 *  - 节点在线时服务器按 authRefreshMs 定期复查；离线不查。
 */
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("cloud Claude auth refresh", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const sql = url ? database.$client : (null as never);
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const owner = `u_auth_${tag}`;
  const nodeId = `dev_authnode_${tag}`;
  const record = { id: nodeId, ownerUserId: owner, platform: "linux", revoked: false, paused: false, name: "云端工作区" } as unknown as DeviceRecord;
  let online = true;
  let loggedIn = true;
  let statusDelay = 30;
  let logoutDelay = 0;
  const statusCalls: string[] = [];
  let service: ReturnType<typeof createCloudCcService>;
  const hub = {
    isOnline: (id: string) => online && id === nodeId,
    sendRaw: (deviceId: string, message: Record<string, unknown>) => {
      if (!online) return false;
      if (message.type === "cc_rpc") {
        const op = String(message.op);
        if (op === "status") statusCalls.push(deviceId);
        // 节点在「收到」时就决定了答案：退出之前发出、退出之后才回来的 status 仍然说「已登录」。
        const answer = loggedIn;
        if (op === "logout") loggedIn = false;
        // 节点稍后回答（让并发的检查有机会撞在一起）
        setTimeout(() => {
          void service.extension.onMessage?.(record, {
            type: "cc_rpc_result",
            id: message.id,
            ok: true,
            result:
              op === "status"
                ? { loggedIn: answer, email: answer ? "a@example.com" : null, plan: answer ? "pro" : null, method: "claude.ai" }
                : op === "logout"
                  ? { loggedIn: false, email: null, plan: null, method: null, checkedAt: new Date().toISOString() }
                  : {},
          } as never);
        }, op === "status" ? statusDelay : op === "logout" ? logoutDelay : 0);
      }
      return true;
    },
  };

  afterAll(async () => {
    clearInterval(service?._internal.authTimer);
    await sql.unsafe("DELETE FROM chisabot_cloud_workspaces WHERE device_id = $1", [nodeId]);
    await sql.unsafe("DELETE FROM chisabot_cc_events WHERE owner_user_id = $1", [owner]).catch(() => {});
    await sql.end?.();
  });

  const cached = async () => (await sql.unsafe<{ claude_auth: { loggedIn: boolean; checkedAt: string } | null }[]>("SELECT claude_auth FROM chisabot_cloud_workspaces WHERE device_id = $1", [nodeId]))[0]?.claude_auth ?? null;

  test("check dedupes concurrent calls and writes the cache", async () => {
    service = createCloudCcService({ database, hub: hub as never, deviceStore: { get: async (id: string) => (id === nodeId ? ({ id, revoked: false } as never) : null) }, authRefreshMs: 150 });
    await service.ensure();
    // 节点登记（会顺手查一次登录状态）
    await service.extension.onMessage?.(record, { type: "cc_info", claudeVersion: "2.1.165", root: "/workspace" } as never);
    await Bun.sleep(80);
    expect((await cached())?.loggedIn).toBe(true);

    loggedIn = false;
    statusCalls.length = 0;
    const [a, b, c] = await Promise.all([service._internal.check(owner), service._internal.check(owner), service._internal.check(owner)]);
    expect(statusCalls.length).toBe(1);
    expect(a.claude.loggedIn).toBe(false);
    expect(b.claude).toEqual(a.claude);
    expect(c.claude).toEqual(a.claude);
    expect((await cached())?.loggedIn).toBe(false);
  });

  test("退出之后才回来的旧 status 不能把缓存改回「已登录」（「退出无效」）", async () => {
    loggedIn = true;
    statusDelay = 30;
    await service._internal.check(owner);
    expect((await cached())?.loggedIn).toBe(true);

    statusDelay = 120; // 这次检查很慢：退出发出之后它才回来
    const stale = service._internal.refreshAuth(nodeId);
    await Bun.sleep(20);
    const out = await service._internal.logout(owner);
    expect(out.claude.loggedIn).toBe(false);
    expect((await cached())?.loggedIn).toBe(false);

    await stale; // 旧的 status 回来了：不许写回缓存
    expect((await cached())?.loggedIn).toBe(false);
    statusDelay = 30;
  });

  test("退出进行中的检查直接回缓存，不和退出抢写", async () => {
    loggedIn = true;
    statusDelay = 30;
    await service._internal.check(owner);
    expect((await cached())?.loggedIn).toBe(true);

    logoutDelay = 60; // 退出要一会儿，期间自动复查会来敲门
    const running = service._internal.logout(owner);
    await Bun.sleep(10);
    statusCalls.length = 0;
    const during = await service._internal.check(owner);
    expect(during.claude.loggedIn).toBe(true); // 退出还没落定：给缓存，不写
    expect(statusCalls.length).toBe(0); // 也没有去问节点

    expect((await running).claude.loggedIn).toBe(false);
    expect((await cached())?.loggedIn).toBe(false);
    logoutDelay = 0;
  });

  test("server refreshes periodically while the node is online, not while offline", async () => {
    loggedIn = true;
    statusCalls.length = 0;
    await Bun.sleep(400);
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    expect((await cached())?.loggedIn).toBe(true);

    online = false;
    await Bun.sleep(50);
    statusCalls.length = 0;
    await Bun.sleep(400);
    expect(statusCalls.length).toBe(0);
  });

  // 「退出 Claude 还是不管用」（2026-10-22）：云端节点只在容器启动时下载节点程序，旧程序回的还是旧逻辑的答案。
  test("节点程序指纹对不上就是旧程序：页面据此提示，认得指纹的节点可以自己重启", async () => {
    online = true;
    const bundle = Buffer.from("node bundle v1");
    const cc = createCloudCcService({
      database,
      hub: hub as never,
      deviceStore: { get: async (id: string) => (id === nodeId ? ({ id, revoked: false } as never) : null) },
      nodeBundle: async () => bundle,
      scriptProbeMs: 60_000,
    });
    try {
      await cc.ensure();
      // 报了一个和服务器现在发的不一样的 = 旧程序；它认得自己的指纹，所以能点「重启节点」
      await cc.extension.onMessage?.(record, { type: "cc_info", script: "b".repeat(64) } as never);
      let view = await cc._internal.status(owner);
      expect(view.node?.scriptStale).toBe(true);
      expect(view.node?.scriptRestartable).toBe(true);

      // 报的和现在发的一样 = 新程序
      await cc.extension.onMessage?.(record, { type: "cc_info", script: sha256Hex(bundle) } as never);
      view = await cc._internal.status(owner);
      expect(view.node?.scriptStale).toBe(false);
      expect(view.node?.scriptRestartable).toBe(true);

      // 比这个功能还旧的节点：报不出指纹，只能人工 docker restart
      await cc.extension.onMessage?.(record, { type: "cc_info", claudeVersion: "2.1.165" } as never);
      view = await cc._internal.status(owner);
      expect(view.node?.scriptStale).toBe(true);
      expect(view.node?.scriptRestartable).toBe(false);
    } finally {
      clearInterval(cc._internal.authTimer);
      clearInterval(cc._internal.scriptTimer);
    }
  });
});
