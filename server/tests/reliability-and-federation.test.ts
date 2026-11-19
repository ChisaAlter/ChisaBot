import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import {
  partitionScheduleList,
  RUN_STATUS_ZH,
  type ScheduleView,
} from "../../shared/schedules";
import type { AppVariables } from "../src/auth/guards";
import {
  FEDERATION_ENVELOPE_SKEW_MS,
  NonceReplayCache,
  signFederationEnvelope,
  verifyFederationEnvelope,
} from "../src/federation/envelope";
import {
  createFederationIdentity,
  FederationError,
  hostIdFromPublicKey,
  sealFederationIdentity,
  unsealFederationIdentity,
  validateFederationUrl,
} from "../src/federation/identity";
import { validatePeerCapabilities } from "../src/federation/queue";
import {
  createFederationRoutes,
  createFederationService,
} from "../src/federation/routes";
import {
  ActiveToolJournalError,
  type AwaitingBadgeState,
  createDurableToolJournal,
  currentToolJournalScope,
  HandoffStore,
  reconcileHandoffsOnStartup,
  type SessionHandoffCard,
  withToolJournalScope,
} from "../src/reliability/turn-reliability";
import {
  BOOT_INTERRUPTED_RESULT,
  createSchedules,
  ScheduleDedupLedger,
} from "../src/schedules/service";
import { liveConnections } from "../src/security/http-hardening";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

describe("§6.3 #9 Tool Journal 父子对话树保护与交互卡片原子一次性续跑", () => {
  test("父子对话树活跃执行期间删除父会话被拒并保留全部记录，结束后才允许清理", async () => {
    const dir = await makeTempDir("cb-tool-journal-");
    const journal = createDurableToolJournal(dir);

    let childStarted!: () => void;
    const childReady = new Promise<void>((resolveReady) => {
      childStarted = resolveReady;
    });
    let releaseChild!: () => void;
    const childDoneGate = new Promise<void>((resolveDone) => {
      releaseChild = resolveDone;
    });

    let childPromise: Promise<unknown> | undefined;

    await withToolJournalScope("conv-parent", async () => {
      expect(currentToolJournalScope()).toEqual({
        conversationId: "conv-parent",
        rootConversationId: "conv-parent",
      });

      const parentRes = await journal.runJournaledTool({
        toolCallId: "call-parent-1",
        toolName: "spawn_subagent",
        args: { task: "analyze" },
        execute: async () => "spawned",
      });
      expect(parentRes).toEqual({
        kind: "executed",
        result: "spawned",
        resumedFromDeferred: false,
      });

      // 子代理继承 parentConversationId & rootConversationId
      childPromise = withToolJournalScope("conv-child", async () => {
        expect(currentToolJournalScope()).toEqual({
          conversationId: "conv-child",
          parentConversationId: "conv-parent",
          rootConversationId: "conv-parent",
        });
        return journal.runJournaledTool({
          toolCallId: "call-child-1",
          toolName: "deploy_step",
          args: { env: "prod" },
          execute: async () => {
            childStarted();
            await childDoneGate;
            return "child-done";
          },
        });
      });
    });

    await childReady;

    // 删除父会话时子代理仍活跃 -> 拒绝清理并保留全部父子记录
    await expect(
      journal.removeToolJournal("conv-parent"),
    ).rejects.toBeInstanceOf(ActiveToolJournalError);
    expect(existsSync(journal.baseDir)).toBe(true);

    // 放行子代理完成
    releaseChild();
    expect(await childPromise).toEqual({
      kind: "executed",
      result: "child-done",
      resumedFromDeferred: false,
    });

    // 全部空闲后，删除父会话一次性清理整棵父子对话树（2 个 scope）
    const cleaned = await journal.removeToolJournal("conv-parent");
    expect(cleaned.removedScopes).toBe(2);
  });

  test("交互卡片延迟续跑通过 deferred -> resumed-<uuid> 原子占坑防双次续跑", async () => {
    const dir = await makeTempDir("cb-tool-defer-");
    const journal = createDurableToolJournal(dir);

    class DeferredInteractionError extends Error {}

    let sideEffects = 0;

    await withToolJournalScope("conv-defer", async () => {
      // 首次执行命中交互挂起，写入 deferred 标记
      await expect(
        journal.runJournaledTool({
          toolCallId: "call-confirm-1",
          toolName: "send_email",
          args: { to: "a@example.com" },
          isDeferred: (error) => error instanceof DeferredInteractionError,
          execute: async () => {
            throw new DeferredInteractionError("awaiting user confirmation");
          },
        }),
      ).rejects.toBeInstanceOf(DeferredInteractionError);

      // 模拟两次并发/重复续跑：仅一次能抢到 rename("deferred", "resumed-<uuid>")
      let startResume!: () => void;
      const resumeGate = new Promise<void>((resolveGate) => {
        startResume = resolveGate;
      });

      const firstResume = journal.runJournaledTool({
        toolCallId: "call-confirm-1",
        toolName: "send_email",
        args: { to: "a@example.com" },
        execute: async () => {
          sideEffects += 1;
          await resumeGate;
          return { sent: true };
        },
      });

      // 用独立的新 journal 实例模拟双进程/非内存去重下的并发续跑
      const secondJournal = createDurableToolJournal(dir);
      const secondResume = secondJournal.runJournaledTool({
        toolCallId: "call-confirm-1",
        toolName: "send_email",
        args: { to: "a@example.com" },
        execute: async () => {
          sideEffects += 1;
          return { sent: true };
        },
      });

      startResume();
      const [r1, r2] = await Promise.all([firstResume, secondResume]);
      const kinds = [r1.kind, r2.kind].sort();
      expect(kinds).toEqual(["executed", "unknown"]);
      expect(sideEffects).toBe(1);

      // 完成后再次重放直接返回持久化结果，不二次执行
      const replay = await secondJournal.runJournaledTool({
        toolCallId: "call-confirm-1",
        toolName: "send_email",
        args: { to: "a@example.com" },
        execute: async () => {
          sideEffects += 1;
          return { sent: false };
        },
      });
      expect(replay).toEqual({ kind: "replayed", result: { sent: true } });
      expect(sideEffects).toBe(1);
    });
  });
});

describe("§6.3 #9 Handoff 三方双向对账与回调失败保 pending", () => {
  test("回调失败保留 pending；启动三方对账覆盖孤儿清理、反向恢复、虚假角标清理与角标修复", async () => {
    const dir = await makeTempDir("cb-handoff-");
    const store = new HandoffStore(dir);

    store.set("sess-keep", {
      requestId: "h-1",
      instruction: "等待用户完成云端登录",
    });
    store.set("sess-orphan", {
      requestId: "h-orphan",
      instruction: "会话已被删除",
    });

    // 回调失败必须保留 pending 防丢交接
    await expect(
      store.complete("sess-keep", async () => {
        throw new Error("downstream callback network error");
      }),
    ).rejects.toThrow("downstream callback network error");
    expect(store.get("sess-keep")?.requestId).toBe("h-1");

    // 构造各会话本地状态（awaiting 角标 + 历史卡片）
    const sessions = new Map<
      string,
      { badge: AwaitingBadgeState | null; cards: SessionHandoffCard[] }
    >([
      // 1. store 有 pending，但前次回调失败把角标清空了 -> 应修复角标
      [
        "sess-keep",
        { badge: null, cards: [{ requestId: "h-1", resolution: null }] },
      ],
      // 2. store 无 pending，但 awaiting 角标指向 handoff 且最新卡未解决 -> 应反向恢复入 store
      [
        "sess-restore",
        {
          badge: { tabId: "handoff", reason: "继续操作浏览器", since: 1000 },
          cards: [
            { requestId: "h-old", instruction: "旧卡", resolution: "done" },
            {
              requestId: "h-new",
              instruction: "继续操作浏览器",
              resolution: null,
            },
          ],
        },
      ],
      // 3. store 无 pending，awaiting 指向 handoff，但最新卡已解决（即便更早有未解决旧卡）-> 清虚假角标
      [
        "sess-stale-badge",
        {
          badge: { tabId: "handoff", reason: "陈旧角标", since: 2000 },
          cards: [
            { requestId: "h-ancient-unresolved", resolution: null },
            { requestId: "h-latest-done", resolution: "handed_back" },
          ],
        },
      ],
      // 4. store 有 pending，但会话角标属于其他功能 tab -> 绝不覆盖其他功能的角标
      [
        "sess-other-tab",
        {
          badge: { tabId: "approval", reason: "正在等审批", since: 3000 },
          cards: [],
        },
      ],
    ]);

    store.set("sess-other-tab", {
      requestId: "h-other",
      instruction: "交接说明",
    });

    const report = await reconcileHandoffsOnStartup({
      handoffStore: store,
      listSessionIds: () => [...sessions.keys()],
      openSession: (id) => {
        const entry = sessions.get(id);
        if (!entry) return null;
        return {
          getAwaitingBadge: () => entry.badge,
          setAwaitingBadgeForTab: (_tabId, badge) => {
            entry.badge = badge;
          },
          getHandoffCards: () => entry.cards,
        };
      },
      now: () => 5000,
    });

    expect(report.orphansRemoved).toEqual(["sess-orphan"]);
    expect(report.restored).toEqual(["sess-restore"]);
    expect(report.cleared).toEqual(["sess-stale-badge"]);
    expect(report.badgesRepaired).toEqual(["sess-keep"]);

    expect(store.get("sess-orphan")).toBeNull();
    expect(store.get("sess-restore")?.requestId).toBe("h-new");
    expect(sessions.get("sess-stale-badge")?.badge).toBeNull();
    expect(sessions.get("sess-keep")?.badge).toEqual({
      tabId: "handoff",
      reason: "等待用户完成云端登录",
      since: 5000,
    });
    expect(sessions.get("sess-other-tab")?.badge?.tabId).toBe("approval");

    // 回调成功后才真正删除 pending
    await store.complete("sess-keep", async (pending) => {
      expect(pending.requestId).toBe("h-1");
    });
    expect(store.get("sess-keep")).toBeNull();
  });
});

describe("§6.3 #9 定时任务重启标 interrupted 与去重账本安全清理", () => {
  test("重启恢复把遗留 running 显式标 interrupted 且不重放副作用；仅确认删除后清理去重账本", async () => {
    // 1. 共享状态与分区语义
    expect(RUN_STATUS_ZH.interrupted).toBe("已中断");
    const sample: ScheduleView = {
      id: "sch_1",
      agentId: "bot-1",
      threadId: "t-1",
      source: "web",
      title: "日报",
      instruction: "发送日报",
      kind: "cron",
      cron: "0 9 * * *",
      runAt: null,
      timezone: "Asia/Shanghai",
      status: "active",
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
      lastRunAt: new Date().toISOString(),
      lastStatus: "interrupted",
      lastResult: BOOT_INTERRUPTED_RESULT,
      runCount: 1,
      createdAt: new Date().toISOString(),
      schedule: "每天 09:00",
      running: false,
    };
    const partitioned = partitionScheduleList([sample], ["bot-1"]);
    expect(partitioned.needsAttention.map((s) => s.id)).toEqual(["sch_1"]);

    // 2. ScheduleDedupLedger 行为
    const ledger = new ScheduleDedupLedger();
    ledger.recordClaim("sch_1", "run_1", "2026-11-19T01:00:00.000Z", 1000);
    ledger.recordClaim("sch_2", "run_2", "2026-11-19T02:00:00.000Z", 1000);
    ledger.markFinished("sch_2", "run_2", "completed", 2000);

    expect(ledger.markRunningInterruptedOnBoot(3000)).toEqual(["sch_1"]);
    expect(ledger.get("sch_1")?.state).toBe("interrupted");
    expect(ledger.get("sch_2")?.state).toBe("completed");

    // 枚举异常/未确认删除绝不清去重账本
    const notPruned = await ledger.pruneConfirmedDeleted(
      ["sch_1", "sch_2"],
      async (id) => {
        if (id === "sch_1") throw new Error("db unreachable");
        return false;
      },
    );
    expect(notPruned).toEqual([]);
    expect(ledger.size()).toBe(2);

    // 仅当确认真实删除后才清理对应条目
    const pruned = await ledger.pruneConfirmedDeleted(
      ["sch_1", "sch_2"],
      (id) => id === "sch_1",
    );
    expect(pruned).toEqual(["sch_1"]);
    expect(ledger.get("sch_1")).toBeNull();
    expect(ledger.get("sch_2")).not.toBeNull();

    // 3. 验证 createSchedules().ensure() 启动恢复调用 reclaimInterruptedOnBoot 并释放对话锁
    const sqlCalls: string[] = [];
    const releasedThreads: string[] = [];
    const fakeSql = {
      async unsafe(query: string) {
        sqlCalls.push(query);
        if (query.includes("to_regclass('public.chisabot_dsh_runs')")) {
          return [{ available: false }];
        }
        if (query.includes("SET status = 'interrupted'")) {
          return [
            { id: "run_old_1", schedule_id: "sch_boot_1", thread_id: "thr_1" },
          ];
        }
        return [];
      },
    };
    const schedules = createSchedules({ $client: fakeSql } as never, {
      runTurn: async () => {
        throw new Error("重启恢复绝不能自动重放定时任务");
      },
      releaseThread: async (threadId) => {
        releasedThreads.push(threadId);
      },
    });
    await schedules.ensure();
    expect(sqlCalls.some((q) => q.includes("SET status = 'interrupted'"))).toBe(
      true,
    );
    expect(sqlCalls.some((q) => q.includes("last_status='interrupted'"))).toBe(
      true,
    );
    expect(releasedThreads).toEqual(["thr_1"]);
  });
});

describe("§1.2 Host↔Host 联邦协议基础底盘（Ed25519、±5min 防重放、per-peer 配额、远端审批硬拒）", () => {
  const ENC_KEY = "federation-test-master-encryption-key-32bytes!";

  test("Ed25519 身份指纹、AES-256-GCM 私钥封存与 URL 安全校验", async () => {
    const id = createFederationIdentity();
    expect(id.id).toMatch(/^[a-f0-9]{64}$/);
    expect(hostIdFromPublicKey(id.publicKey)).toBe(id.id);

    const sealed = await sealFederationIdentity(id, ENC_KEY);
    expect(sealed.sealedPrivateKey).not.toContain("BEGIN PRIVATE KEY");
    const restored = await unsealFederationIdentity(sealed, ENC_KEY);
    expect(restored.privateKey).toBe(id.privateKey);
    expect(restored.id).toBe(id.id);

    // 错密钥解封失败
    await expect(
      unsealFederationIdentity(sealed, "wrong-encryption-key"),
    ).rejects.toBeInstanceOf(FederationError);

    // 默认拒绝明文 http://，强制 https://
    expect(() => validateFederationUrl("http://peer.example.com")).toThrow(
      FederationError,
    );
    expect(validateFederationUrl("https://peer.example.com/")).toBe(
      "https://peer.example.com",
    );
  });

  test("Ed25519 签名信封：合法验真、篡改/超 ±5 分钟窗口/nonce 重放一律 401 拒阻", () => {
    const hostA = createFederationIdentity();
    const replayCache = new NonceReplayCache();
    const now = 1_770_000_000_000;

    const envelope = signFederationEnvelope(
      hostA,
      "sync",
      { hello: "world" },
      { now },
    );

    // 合法验真通过
    const ok = verifyFederationEnvelope<{ hello: string }>(envelope, "sync", {
      expectedPublicKey: hostA.publicKey,
      now,
      replayCache,
    });
    expect(ok.sender).toBe(hostA.id);
    expect(ok.body).toEqual({ hello: "world" });

    // 相同 nonce 重放 -> 401 NONCE_REPLAYED
    try {
      verifyFederationEnvelope(envelope, "sync", {
        expectedPublicKey: hostA.publicKey,
        now: now + 1000,
        replayCache,
      });
      throw new Error("expected replay rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(FederationError);
      expect((error as FederationError).status).toBe(401);
      expect((error as FederationError).code).toBe("NONCE_REPLAYED");
    }

    // 超出 ±5 分钟窗口 -> 401 TIMESTAMP_OUT_OF_WINDOW
    const staleEnvelope = signFederationEnvelope(
      hostA,
      "sync",
      { hello: "stale" },
      { now: now - FEDERATION_ENVELOPE_SKEW_MS - 1_000 },
    );
    try {
      verifyFederationEnvelope(staleEnvelope, "sync", {
        expectedPublicKey: hostA.publicKey,
        now,
      });
      throw new Error("expected stale rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(FederationError);
      expect((error as FederationError).code).toBe("TIMESTAMP_OUT_OF_WINDOW");
    }

    // 篡改载荷 -> 401 SIGNATURE_VERIFICATION_FAILED
    const tampered = {
      ...envelope,
      payload: { ...envelope.payload, body: { hello: "evil" } },
    };
    expect(() =>
      verifyFederationEnvelope(tampered, "sync", {
        expectedPublicKey: hostA.publicKey,
        now,
      }),
    ).toThrow(FederationError);
  });

  test("一次性邀请配对、digest 幂等去重、严格 per-peer 配额与远端代批审批硬拒绝", async () => {
    const now = 1_770_000_000_000;
    const primary = createFederationService({
      encryptionKey: ENC_KEY,
      hostName: "Primary Host",
      hostUrl: "https://primary.example.com",
      maxQueuedPerPeer: 2,
      now: () => now,
      listLocalBots: () => [
        { id: "bot-main", name: "主助手", description: "主力" },
      ],
    });

    const peerA = createFederationIdentity();
    const peerB = createFederationIdentity();
    const intruder = createFederationIdentity();

    // 1. 尝试授予 resolve_approval 能力在配置层即 403 硬拒
    expect(() =>
      validatePeerCapabilities(["bot_message", "resolve_approval"]),
    ).toThrow(FederationError);

    // 2. 创建一次性邀请，Peer A 完成配对，第三方复用同一邀请 409 拒绝
    const inviteA = primary.createInvitation({ allowedBots: ["bot-main"] });
    const pairEnvA = signFederationEnvelope(
      peerA,
      "pair",
      {
        invitationId: inviteA.invitationId,
        token: inviteA.token,
        identity: {
          id: peerA.id,
          publicKey: peerA.publicKey,
          name: "Peer A",
          url: "https://peer-a.example.com",
        },
        bots: [{ id: "remote-a", name: "Bot A", description: "" }],
      },
      { now },
    );
    const pairResultA = await primary.receivePair(pairEnvA);
    expect(pairResultA.payload.purpose).toBe("pair-result");

    const hijackEnv = signFederationEnvelope(
      intruder,
      "pair",
      {
        invitationId: inviteA.invitationId,
        token: inviteA.token,
        identity: {
          id: intruder.id,
          publicKey: intruder.publicKey,
          name: "Intruder",
        },
        bots: [{ id: "remote-x", name: "Bot X", description: "" }],
      },
      { now },
    );
    await expect(primary.receivePair(hijackEnv)).rejects.toMatchObject({
      status: 409,
      code: "INVITATION_USED",
    });

    // 注册第二个健康节点 Peer B
    primary.registerPeerForSync({
      id: peerB.id,
      publicKey: peerB.publicKey,
      name: "Peer B",
      allowedBots: ["bot-main"],
      remoteBots: [{ id: "remote-b", name: "Bot B", description: "" }],
    });

    // 3. 按 digest 幂等去重 + 改内容 409 Conflict
    const msgId1 = randomUUID();
    const msgId2 = randomUUID();
    const sync1 = signFederationEnvelope(
      peerA,
      "sync",
      {
        messages: [
          {
            id: msgId1,
            fromAgentId: "remote-a",
            toAgentId: "bot-main",
            text: "hello 1",
            createdAt: now,
          },
        ],
      },
      { now },
    );
    const syncRes1 = primary.receiveSync(sync1);
    expect(syncRes1.payload.body.revoked).toBe(false);

    // 相同 ID + 相同内容重投（新信封 nonce）-> 幂等去重，队列不增长
    const syncDup = signFederationEnvelope(
      peerA,
      "sync",
      {
        messages: [
          {
            id: msgId1,
            fromAgentId: "remote-a",
            toAgentId: "bot-main",
            text: "hello 1",
            createdAt: now,
          },
        ],
      },
      { now },
    );
    primary.receiveSync(syncDup);
    expect(primary.listMessages(peerA.id)).toHaveLength(1);

    // 相同 ID + 不同内容 -> 409 MESSAGE_DIGEST_CONFLICT
    const syncTamper = signFederationEnvelope(
      peerA,
      "sync",
      {
        messages: [
          {
            id: msgId1,
            fromAgentId: "remote-a",
            toAgentId: "bot-main",
            text: "tampered text",
            createdAt: now,
          },
        ],
      },
      { now },
    );
    expect(() => primary.receiveSync(syncTamper)).toThrow(FederationError);

    // 4. Per-Peer 配额上限（maxQueuedPerPeer = 2）：Peer A 填满第 2 条后第 3 条 429，Peer B 正常收发！
    primary.receiveSync(
      signFederationEnvelope(
        peerA,
        "sync",
        {
          messages: [
            {
              id: msgId2,
              fromAgentId: "remote-a",
              toAgentId: "bot-main",
              text: "hello 2",
              createdAt: now,
            },
          ],
        },
        { now },
      ),
    );
    try {
      primary.receiveSync(
        signFederationEnvelope(
          peerA,
          "sync",
          {
            messages: [
              {
                id: randomUUID(),
                fromAgentId: "remote-a",
                toAgentId: "bot-main",
                text: "overflow 3",
                createdAt: now,
              },
            ],
          },
          { now },
        ),
      );
      throw new Error("expected peer A quota 429");
    } catch (error) {
      expect(error).toBeInstanceOf(FederationError);
      expect((error as FederationError).status).toBe(429);
      expect((error as FederationError).code).toBe("PEER_QUEUE_FULL");
    }

    // Peer B 完全不受坏 Peer A 影响
    const syncB = primary.receiveSync(
      signFederationEnvelope(
        peerB,
        "sync",
        {
          messages: [
            {
              id: randomUUID(),
              fromAgentId: "remote-b",
              toAgentId: "bot-main",
              text: "peer B healthy message",
              createdAt: now,
            },
          ],
        },
        { now },
      ),
    );
    expect(syncB.payload.body.revoked).toBe(false);
    expect(primary.listMessages(peerB.id)).toHaveLength(1);

    // 5. HTTP 路由测试：远端 peer 尝试代批本地审批（resolve_approval）永久 403 硬拒
    const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", { id: "admin-1", role: "admin", email: "a@t" } as never);
      await next();
    };
    const app = new Hono().route(
      "/api/federation",
      createFederationRoutes({ service: primary, requireUser: asAdmin }),
    );

    const resolveApprovalEnv = signFederationEnvelope(
      peerA,
      "control",
      {
        action: "resolve_approval",
        args: {
          requestId: "req-local-1",
          decision: "approve",
          scope: "always",
        },
      },
      { now },
    );
    const controlRes = await app.request("/api/federation/v1/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resolveApprovalEnv),
    });
    expect(controlRes.status).toBe(403);
    expect(await controlRes.json()).toMatchObject({
      code: "REMOTE_APPROVAL_FORBIDDEN",
    });

    // 6. 吊销 peer 时立断其名下活流
    let peerStreamClosed = false;
    const detach = liveConnections.track(`peer:${peerA.id}`, {
      kind: "sse",
      close: () => {
        peerStreamClosed = true;
      },
    });
    try {
      const revokeRes = await app.request(
        `/api/federation/peers/${peerA.id}/revoke`,
        { method: "POST" },
      );
      expect(revokeRes.status).toBe(200);
      expect(peerStreamClosed).toBe(true);
    } finally {
      detach();
    }
  });
});

describe("Wave 10 审查修复回归（#107 Group 3/4/5：联邦防桶投毒、回合可靠边界、定时去重联动）", () => {
  const ENC_KEY = "federation-test-master-encryption-key-32bytes!";

  test("Group 3: 联邦路由先验签再扣 per-peer 限流（防 Rate-Limit Bucket Poisoning DoS），/v1/* 统一 Cache-Control: no-store", async () => {
    const now = 1_770_000_000_000;
    const primary = createFederationService({
      encryptionKey: ENC_KEY,
      hostName: "Primary",
      now: () => now,
    });
    const honestPeer = createFederationIdentity();
    primary.registerPeerForSync({
      id: honestPeer.id,
      publicKey: honestPeer.publicKey,
      name: "Honest Peer",
      allowedBots: ["bot-1"],
      remoteBots: [{ id: "r-1", name: "R1", description: "" }],
    });

    const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", { id: "admin-1", role: "admin", email: "a@t" } as never);
      await next();
    };
    const app = new Hono().route(
      "/api/federation",
      createFederationRoutes({
        service: primary,
        requireUser: asAdmin,
        peerRateLimitPerMinute: 2,
        preAuthRateLimitPerMinute: 50,
      }),
    );

    // 攻击者伪造 honestPeer.id 连续发送 6 条伪造签名垃圾包：全部 401，且绝不能扣减 honestPeer 的 per-peer 配额
    for (let i = 0; i < 6; i += 1) {
      const forged = {
        payload: {
          version: 1,
          purpose: "sync",
          sender: honestPeer.id,
          senderKey: honestPeer.publicKey,
          timestamp: now,
          nonce: randomUUID(),
          body: { messages: [], acks: [] },
        },
        signature: Buffer.alloc(64, i + 1).toString("base64url"),
      };
      const res = await app.request("/api/federation/v1/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `attacker-${i}`,
        },
        body: JSON.stringify(forged),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }

    // 合法节点仍完整拥有 2 次/分钟配额：前 2 次 200，第 3 次触发 429 PEER_RATE_LIMITED
    for (let i = 0; i < 2; i += 1) {
      const validEnv = signFederationEnvelope(
        honestPeer,
        "sync",
        { messages: [], acks: [] },
        { now },
      );
      const okRes = await app.request("/api/federation/v1/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "honest-peer-client",
        },
        body: JSON.stringify(validEnv),
      });
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get("cache-control")).toBe("no-store");
    }

    const thirdEnv = signFederationEnvelope(
      honestPeer,
      "sync",
      { messages: [], acks: [] },
      { now },
    );
    const limitedRes = await app.request("/api/federation/v1/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "honest-peer-client",
      },
      body: JSON.stringify(thirdEnv),
    });
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers.get("cache-control")).toBe("no-store");
    expect(await limitedRes.json()).toMatchObject({
      code: "PEER_RATE_LIMITED",
    });
  });

  test("Group 4: HandoffStore.complete 并发互斥防双触发；启动对账清理已解决卡片残留的旧 pending 绝不复活幽灵角标；已中止续跑不提前消耗 deferred 令牌", async () => {
    // 1. HandoffStore.complete 并发互斥 + 启动对账处理「pending 仍在但最新卡已解决」
    const handoffDir = await makeTempDir("cb-handoff-p1-");
    const store = new HandoffStore(handoffDir);
    store.set("sess-mutex", { requestId: "h-m", instruction: "完成 OAuth" });
    store.set("sess-resolved-stale", {
      requestId: "h-done",
      instruction: "已完成但忘清 pending",
    });

    let completeCalls = 0;
    let releaseComplete!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseComplete = resolveGate;
    });

    const first = store.complete("sess-mutex", async () => {
      completeCalls += 1;
      await gate;
      return "done-once";
    });
    const second = store.complete("sess-mutex", async () => {
      completeCalls += 1;
      return "duplicate";
    });

    await expect(second).rejects.toThrow("正在完成中");
    releaseComplete();
    expect(await first).toBe("done-once");
    expect(completeCalls).toBe(1);
    expect(store.get("sess-mutex")).toBeNull();

    // 启动对账：sess-resolved-stale 在 store 中有旧 pending 且有 handoff 角标，但最新卡片已 resolution != null
    const sessions = new Map<
      string,
      { badge: AwaitingBadgeState | null; cards: SessionHandoffCard[] }
    >([
      [
        "sess-resolved-stale",
        {
          badge: {
            tabId: "handoff",
            reason: "已完成但忘清 pending",
            since: 1234,
          },
          cards: [
            {
              requestId: "h-done",
              instruction: "已完成但忘清 pending",
              resolution: "handed_back",
            },
          ],
        },
      ],
    ]);

    const report = await reconcileHandoffsOnStartup({
      handoffStore: store,
      listSessionIds: () => [...sessions.keys()],
      openSession: (id) => {
        const entry = sessions.get(id);
        if (!entry) return null;
        return {
          getAwaitingBadge: () => entry.badge,
          setAwaitingBadgeForTab: (_tabId, badge) => {
            entry.badge = badge;
          },
          getHandoffCards: () => entry.cards,
        };
      },
      now: () => 9999,
    });

    expect(store.get("sess-resolved-stale")).toBeNull();
    expect(sessions.get("sess-resolved-stale")?.badge).toBeNull();
    expect(report.cleared).toEqual(["sess-resolved-stale"]);
    expect(report.badgesRepaired).toEqual([]);

    // 2. 已中止信号不提前消耗 deferred 令牌，后续正常续跑仍可一次性成功
    const journalDir = await makeTempDir("cb-tool-abort-");
    const journal = createDurableToolJournal(journalDir);
    class DeferErr extends Error {}

    await withToolJournalScope("conv-abort-defer", async () => {
      await expect(
        journal.runJournaledTool({
          toolCallId: "call-abort-1",
          toolName: "deploy",
          args: { env: "prod" },
          isDeferred: (e) => e instanceof DeferErr,
          execute: async () => {
            throw new DeferErr("wait");
          },
        }),
      ).rejects.toBeInstanceOf(DeferErr);

      const abortedCtrl = new AbortController();
      abortedCtrl.abort(new Error("client_disconnected"));
      await expect(
        journal.runJournaledTool({
          toolCallId: "call-abort-1",
          toolName: "deploy",
          args: { env: "prod" },
          signal: abortedCtrl.signal,
          execute: async () => ({ ok: true }),
        }),
      ).rejects.toThrow("中止");

      // 未消耗 deferred，正常续跑依然成功一次
      const resumed = await journal.runJournaledTool({
        toolCallId: "call-abort-1",
        toolName: "deploy",
        args: { env: "prod" },
        execute: async () => ({ ok: true }),
      });
      expect(resumed).toEqual({
        kind: "executed",
        result: { ok: true },
        resumedFromDeferred: true,
      });
    });
  });

  test("Group 5: ScheduleDedupLedger 真实读写联动：重启回填 DB running 标 interrupted 并拦阻 sweep/runNow 重复触发", async () => {
    const slotIso = "2026-11-19T12:00:00.000Z";
    let runTurnCalls = 0;

    const scheduleRow = {
      id: "sch_dedup_1",
      owner_user_id: "user-1",
      agent_id: "bot-1",
      agent_instance_id: null,
      thread_id: "thr-1",
      im_connection_id: null,
      title: "防重放例程",
      instruction: "检查状态",
      kind: "cron" as const,
      cron: "0 * * * *",
      run_at: null,
      timezone: "UTC",
      status: "active" as const,
      next_run_at: slotIso,
      last_run_at: null,
      last_status: null,
      last_result: null,
      run_count: 0,
      created_at: slotIso,
      updated_at: slotIso,
    };

    const fakeSql = {
      async unsafe(query: string) {
        if (query.includes("to_regclass('public.chisabot_dsh_runs')")) {
          return [{ available: false }];
        }
        if (query.includes("SET status = 'interrupted'")) {
          return [
            {
              id: "run_boot_1",
              schedule_id: "sch_dedup_1",
              scheduled_for: slotIso,
              thread_id: "thr-1",
            },
          ];
        }
        if (
          query.includes(
            "SELECT * FROM chisabot_schedules WHERE status = 'active' AND next_run_at <= now()",
          )
        ) {
          return [scheduleRow];
        }
        return [];
      },
      async begin<T>(
        fn: (tx: { unsafe: (q: string) => Promise<unknown[]> }) => Promise<T>,
      ): Promise<T> {
        return fn({
          async unsafe(query: string) {
            if (query.includes("FOR UPDATE")) return [{ id: "sch_dedup_1" }];
            if (query.includes("INSERT INTO chisabot_schedule_runs")) {
              return [{ id: "run_skipped_dup" }];
            }
            return [];
          },
        });
      },
    };

    const schedules = createSchedules({ $client: fakeSql } as never, {
      runTurn: async () => {
        runTurnCalls += 1;
        return "ok";
      },
      now: () => new Date("2026-11-19T12:00:10.000Z"),
    });

    // 启动恢复：DB 中遗留的 running 自动回填进 dedupLedger 并转为 interrupted，锁定 slotIso
    expect(await schedules.reclaimInterruptedOnBoot()).toBe(1);
    expect(schedules.dedupLedger.get("sch_dedup_1")?.state).toBe("interrupted");
    expect(schedules.dedupLedger.isSlotClaimed("sch_dedup_1", slotIso)).toBe(
      true,
    );

    // 紧接着 sweep() 扫到同一个 slotIso：去重账本拦阻重复触发，记为 skipped 且 runTurnCalls 保持 0
    const sweepReport = await schedules.sweep();
    expect(sweepReport.fired).toEqual([]);
    expect(sweepReport.skipped).toEqual(["sch_dedup_1"]);
    expect(runTurnCalls).toBe(0);

    // 正在运行态时 runNow() 被去重账本直接拦阻
    schedules.dedupLedger.recordClaim(
      "sch_dedup_1",
      "run_active_now",
      "2026-11-19T13:00:00.000Z",
    );
    await expect(schedules.runNow("user-1", "sch_dedup_1")).rejects.toThrow(
      "正在运行",
    );
  });
});
