import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  withConfirmActor,
  withConfirmTurn,
} from "../src/confirmations/context";
import { createConfirmations } from "../src/confirmations/service";
import { createDatabase } from "../src/db/client";
import { imGuardedFetch, imGuardedWs } from "../src/im/net";
import { createImService } from "../src/im/service";
import type { WsLike } from "../src/im/types";
import type { TurnRunner } from "../src/turns/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * RV-02：IM 里回「允许 / 拒绝」的审批门禁。
 * - 只有私聊、发件人是绑定的主人平台 id、且待确认正好属于这段对话才批；
 * - 群聊 / 陌生人 / 白名单非主人都不行；对不上 thread 的待确认绝不兜底；
 * - 主人 id + 白名单都空 = 谁也不理（旧语义「空 = 所有人可用」已废除）；
 * - 待确认详情只推私聊。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const confirmations = createConfirmations(database);
const owner = `imowner-${randomUUID().slice(0, 8)}`;
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
  "base64",
);

class FakeWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(data: unknown) {
    const frame = JSON.parse(String(data));
    this.sent.push(String(data));
    setTimeout(() => {
      if (frame.action === "get_login_info")
        this.push({
          status: "ok",
          retcode: 0,
          data: { user_id: 10001, nickname: "测试号" },
          echo: frame.echo,
        });
      else
        this.push({
          status: "ok",
          retcode: 0,
          data: { message_id: 1 },
          echo: frame.echo,
        });
    }, 1);
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000 });
  }
  push(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  actions(name: string) {
    return this.sent
      .map((item) => JSON.parse(item))
      .filter((frame) => frame.action === name);
  }
}

const sockets: FakeWs[] = [];
const turns: Parameters<TurnRunner>[0][] = [];

async function waitFor<T>(
  check: () => T | undefined | null | false,
  ms = 4000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function imMessage(
  socket: FakeWs,
  input: {
    user: number;
    text: string;
    group?: number;
    at?: boolean;
    id?: number;
  },
) {
  socket.push({
    post_type: "message",
    message_type: input.group ? "group" : "private",
    self_id: 10001,
    user_id: input.user,
    ...(input.group ? { group_id: input.group } : {}),
    message_id: input.id ?? Math.floor(Math.random() * 1e9),
    message: input.at
      ? [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: ` ${input.text}` } },
        ]
      : input.text,
    sender: { nickname: `u${input.user}` },
  });
}

const privateReplies = (socket: FakeWs, userId: number) =>
  socket
    .actions("send_private_msg")
    .filter((frame) => frame.params.user_id === userId)
    .map((frame) => String(frame.params.message.at(-1).data.text));
const groupReplies = (socket: FakeWs, groupId: number) =>
  socket
    .actions("send_group_msg")
    .filter((frame) => frame.params.group_id === groupId)
    .map((frame) => String(frame.params.message.at(-1).data.text));

const createdIds: string[] = [];

beforeAll(async () => {
  await confirmations.ensure();
});

afterAll(async () => {
  await database.$client
    .unsafe("DELETE FROM chisabot_im_connections WHERE owner_user_id = $1", [
      owner,
    ])
    .catch(() => {});
  await database.$client
    .unsafe("DELETE FROM chisabot_confirm_requests WHERE owner_user_id = $1", [
      owner,
    ])
    .catch(() => {});
  await database.$client.close();
});

describe("RV-02: IM 审批门禁", () => {
  test("主人 + 白名单都为空 = 任何人的消息都不理（陌生人也不能发起回合、不能审批）", async () => {
    const approvals: unknown[] = [];
    const service = createImService({
      database,
      encryptionKey: key,
      runTurn: async (input) => {
        turns.push(input);
        return { replyText: "ok" };
      },
      botAvailable: async () => true,
      resolveBotConversation: async () => `web-${randomUUID().slice(0, 8)}`,
      resolveApproval: async () => {
        approvals.push(1);
        return { title: "x" };
      },
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });
    await service.ensure();
    const view = await service.create(owner, {
      platform: "onebot",
      agentId: "bot-1",
      config: { mode: "forward", url: "ws://empty-list.test:3001" },
    });
    createdIds.push(view.id);
    const socket = await waitFor(() =>
      sockets.find((item) => item.url.startsWith("ws://empty-list.test")),
    );
    await waitFor(() => service.statusOf(view.id)?.state === "connected");
    const turnCount = turns.length;
    imMessage(socket, { user: 424242, text: "你好" });
    imMessage(socket, { user: 424242, text: "允许" });
    imMessage(socket, { user: 424242, text: "批准" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turns.length).toBe(turnCount);
    expect(approvals).toHaveLength(0);
    expect(privateReplies(socket, 424242)).toHaveLength(0);
    await service.stopAll();
  });

  test("白名单非主人能聊不能批；群里审批被拒；thread 不匹配不兜底；主人私聊审批成功", async () => {
    const resolvedApprovals: Array<{ id: string; decision: string }> = [];
    let webThread = `web-${randomUUID().slice(0, 8)}`;
    const service = createImService({
      database,
      encryptionKey: key,
      runTurn: async (input) => {
        turns.push(input);
        if (!String(input.userMessage?.content ?? "").includes("付款"))
          return { replyText: "好的" };
        const check = await withConfirmTurn(
          {
            threadId: input.threadId,
            runId: `run-${randomUUID().slice(0, 6)}`,
            stopped: () => false,
          },
          () =>
            withConfirmActor(input.initiator, () =>
              confirmations.check({
                ownerUserId: input.ownerUserId,
                agentId: input.agentId,
                category: "message",
                tool: "send_msg",
                title: "发出一笔付款",
                target: "我的银行卡",
                details: [{ label: "金额", value: "999 元" }],
                matchText: "发出一笔付款 我的银行卡",
                digest: `digest-${randomUUID().slice(0, 8)}`,
                initiator: input.initiator,
              }),
            ),
        );
        return { replyText: check.ok ? "操作完成" : check.message };
      },
      botAvailable: async () => true,
      resolveBotConversation: async (_user, _agent, fresh) => {
        if (fresh) webThread = `web-${randomUUID().slice(0, 8)}`;
        return webThread;
      },
      // 和生产 resolveApproval 同一套语义：只批属于当前 thread 的待确认，不兜底。
      resolveApproval: async (user, threadId, decision) => {
        if (!threadId) return null;
        const pending = (await confirmations.list(user, { limit: 20 })).filter(
          (r) => r.status === "pending",
        );
        const target = pending.find((r) => r.threadId === threadId);
        if (!target) return null;
        const decided = await confirmations.decide(user, target.id, decision);
        resolvedApprovals.push({ id: target.id, decision });
        return { title: decided.title, target: decided.target };
      },
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });
    await service.ensure();
    const view = await service.create(owner, {
      platform: "onebot",
      agentId: "bot-1",
      config: { mode: "forward", url: "ws://approval.test:3001" },
      ownerUsers: ["10086"],
      allowUsers: ["20002"],
    });
    createdIds.push(view.id);
    confirmations.setOnOpened((req) => {
      if (!req.threadId) return;
      // 和生产一样：待确认详情只推私聊。
      void service
        .pushToThread(
          req.threadId,
          `⚠️ 待确认操作：「${req.title}」\n请直接回复「允许」或「拒绝」处理。`,
          { privateOnly: true },
        )
        .catch(() => {});
    });
    const socket = await waitFor(() =>
      sockets.find((item) => item.url.startsWith("ws://approval.test")),
    );
    await waitFor(() => service.statusOf(view.id)?.state === "connected");

    // 主人私聊发一条，触发一个待确认（详情只推私聊）。
    const bossThread = webThread;
    imMessage(socket, { user: 10086, text: "帮我付款", id: 1 });
    await waitFor(
      () =>
        privateReplies(socket, 10086).some((text) =>
          text.includes("待确认操作：「发出一笔付款」"),
        ),
      6000,
    );
    const pendingOnBoss = (
      await confirmations.list(owner, { threadId: bossThread })
    ).filter((r) => r.status === "pending");
    expect(pendingOnBoss).toHaveLength(1);
    expect(
      groupReplies(socket, 4242).every(
        (text) => !text.includes("发出一笔付款"),
      ),
    ).toBe(true);

    // 1) 白名单成员（非主人）私聊回「允许」→ 拒，待确认不动。
    imMessage(socket, { user: 20002, text: "允许", id: 2 });
    await waitFor(() =>
      privateReplies(socket, 20002).some((text) =>
        text.includes("只有这个连接的主人"),
      ),
    );
    expect(resolvedApprovals).toHaveLength(0);
    expect(
      (await confirmations.list(owner, { threadId: bossThread })).filter(
        (r) => r.status === "pending",
      ),
    ).toHaveLength(1);

    // 2) 白名单成员正常聊天：回合照跑（他不是陌生人）。
    imMessage(socket, { user: 20002, text: "随便聊聊", id: 3 });
    await waitFor(() => privateReplies(socket, 20002).length > 0, 6000);

    // 3) 主人在群聊里 @ 回「允许」→ 拒（详情没推给群，群里也批不了）。
    imMessage(socket, {
      user: 10086,
      text: "允许",
      group: 4242,
      at: true,
      id: 4,
    });
    await waitFor(() =>
      groupReplies(socket, 4242).some((text) =>
        text.includes("只能由主人在私聊"),
      ),
    );
    expect(resolvedApprovals).toHaveLength(0);
    expect(
      (await confirmations.list(owner, { threadId: bossThread })).filter(
        (r) => r.status === "pending",
      ),
    ).toHaveLength(1);

    // 4) 另一个人在私聊里发的消息映射到另一条 thread —— 主人换到那条对话上回「允许」，
    //    待确认在 boss 的对话上，对不上 → 不兜底。
    imMessage(socket, { user: 20002, text: "另起一段", id: 5 });
    await waitFor(() => privateReplies(socket, 20002).length > 1, 6000);
    // 模拟「主人的私聊换到没有待确认的对话」：先 /new 换对话再回「允许」。
    imMessage(socket, { user: 10086, text: "/new", id: 6 });
    await waitFor(() =>
      privateReplies(socket, 10086).some((text) => text.includes("新话题")),
    );
    imMessage(socket, { user: 10086, text: "允许", id: 7 });
    await waitFor(() =>
      privateReplies(socket, 10086).some((text) => text.includes("没有待确认")),
    );
    expect(resolvedApprovals).toHaveLength(0);
    expect(
      (await confirmations.list(owner, { threadId: bossThread })).filter(
        (r) => r.status === "pending",
      ),
    ).toHaveLength(1);

    // 5) 当前对话上恰好有一条待确认时，主人私聊「允许」→ 批了。
    const pendingNow = await withConfirmTurn(
      { threadId: webThread, runId: "direct", stopped: () => false },
      () =>
        withConfirmActor({ kind: "routine", id: `im:${view.id}` }, () =>
          confirmations.check({
            ownerUserId: owner,
            agentId: "bot-1",
            category: "message",
            tool: "send_msg",
            title: "删除一个文件",
            target: "报告.docx",
            matchText: "删除一个文件 报告.docx",
            digest: `digest-${randomUUID().slice(0, 8)}`,
            initiator: { kind: "routine", id: `im:${view.id}` },
          }),
        ),
    );
    expect(pendingNow.ok).toBe(false);
    imMessage(socket, { user: 10086, text: "允许", id: 8 });
    await waitFor(() =>
      privateReplies(socket, 10086).some((text) =>
        text.includes("已批准「删除一个文件」"),
      ),
    );
    expect(resolvedApprovals).toEqual([
      { id: expect.any(String), decision: "approve" },
    ]);
    expect(
      (await confirmations.list(owner, { threadId: webThread })).filter(
        (r) => r.status === "pending",
      ),
    ).toHaveLength(0);

    await service.stopAll();
  });

  test("待确认详情只推私聊：群里也绑了同一条对话时也不会推到群里", async () => {
    const service = createImService({
      database,
      encryptionKey: key,
      runTurn: async () => ({ replyText: "ok" }),
      botAvailable: async () => true,
      resolveBotConversation: async () => "shared-thread-1",
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });
    await service.ensure();
    const view = await service.create(owner, {
      platform: "onebot",
      agentId: "bot-1",
      config: { mode: "forward", url: "ws://private-only.test:3001" },
      ownerUsers: ["10086"],
      allowUsers: ["20002"],
    });
    createdIds.push(view.id);
    const socket = await waitFor(() =>
      sockets.find((item) => item.url.startsWith("ws://private-only.test")),
    );
    await waitFor(() => service.statusOf(view.id)?.state === "connected");

    // 主人私聊 + 群聊都绑到同一条 shared-thread-1；群聊是最近活动 → 普通推送会进群。
    imMessage(socket, { user: 10086, text: "hi", id: 11 });
    imMessage(socket, {
      user: 20002,
      text: "hello",
      group: 4242,
      at: true,
      id: 12,
    });
    await waitFor(() => privateReplies(socket, 10086).length > 0, 6000);
    await waitFor(() => groupReplies(socket, 4242).length > 0, 6000);

    await service.pushToThread("shared-thread-1", "⚠️ 待确认操作：「付款」", {
      privateOnly: true,
    });
    await waitFor(() =>
      privateReplies(socket, 10086).some((text) =>
        text.includes("待确认操作：「付款」"),
      ),
    );
    expect(
      groupReplies(socket, 4242).every((text) => !text.includes("待确认操作")),
    ).toBe(true);

    // 不带 privateOnly 的主动推送（定时任务结果）仍按原语义回到最近活跃会话（群）。
    await service.pushToThread("shared-thread-1", "定时任务结果");
    await waitFor(
      () =>
        groupReplies(socket, 4242).some((text) =>
          text.includes("定时任务结果"),
        ) ||
        privateReplies(socket, 10086).some((text) =>
          text.includes("定时任务结果"),
        ),
    );
    await service.stopAll();
  });

  test("不注入 fetch / ws 时，适配器拿到的就是带防护的默认实现", async () => {
    const service = createImService({
      database,
      encryptionKey: key,
      runTurn: async () => ({ replyText: "" }),
      botAvailable: async () => true,
    });
    await service.ensure();
    const view = await service.create(owner, {
      platform: "onebot",
      agentId: "bot-1",
      config: { mode: "reverse" },
      enabled: false,
      ownerUsers: ["1"],
    });
    createdIds.push(view.id);
    await service.update(owner, view.id, { enabled: true });
    await waitFor(() => service.adapterOf(view.id) !== null);
    const ctx = (
      service.adapterOf(view.id) as unknown as {
        ctx: { fetch: unknown; ws: unknown };
      }
    ).ctx;
    expect(ctx.fetch).toBe(imGuardedFetch);
    expect(ctx.ws).toBe(imGuardedWs);
    await service.stopAll();
  });
});
