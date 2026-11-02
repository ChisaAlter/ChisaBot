import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db/client";
import { createImService, imConnectionOf } from "../src/im/service";
import type { WsLike } from "../src/im/types";
import type { TurnRunner } from "../src/turns/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * IM 接入端到端（库 + 服务 + OneBot 适配器 + 假协议端）：消息进来 → 机器人回合 → 回复发回去；
 * 群里没 @ 不理、白名单、/new 换对话、/id、凭据加密存库、删除清干净。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const owner = `imtest-${randomUUID().slice(0, 8)}`;
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

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
    // 假协议端：登录信息和发消息都马上回执。
    setTimeout(() => {
      if (frame.action === "get_login_info") this.push({ status: "ok", retcode: 0, data: { user_id: 10001, nickname: "测试号" }, echo: frame.echo });
      else this.push({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: frame.echo });
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
    return this.sent.map((item) => JSON.parse(item)).filter((frame) => frame.action === name);
  }
}

const sockets: FakeWs[] = [];
const turns: Parameters<TurnRunner>[0][] = [];
const runTurn: TurnRunner = async (input) => {
  turns.push(input);
  return { replyText: `**收到**：${String(input.userMessage?.content ?? "").split("\n").pop()}` };
};

const service = createImService({
  database,
  encryptionKey: key,
  runTurn,
  botAvailable: async (user, agentId) => user === owner && agentId === "bot-1",
  ws: (url) => {
    const socket = new FakeWs(url);
    sockets.push(socket);
    return socket;
  },
});

async function waitFor<T>(check: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const createdIds: string[] = [];

beforeAll(async () => {
  await service.ensure();
});

afterAll(async () => {
  await service.stopAll();
  for (const id of createdIds) await service.remove(owner, id).catch(() => {});
  await database.$client.close();
});

describe("IM 接入服务", () => {
  test("机器人不是自己的 → 拒绝；必填项没填 → 拒绝", async () => {
    await expect(service.create(owner, { platform: "onebot", agentId: "bot-x", config: { mode: "forward", url: "ws://a" } })).rejects.toThrow("请选择一个你的机器人");
    await expect(service.create(owner, { platform: "onebot", agentId: "bot-1", config: { mode: "forward" } })).rejects.toThrow("协议端 WebSocket 地址");
    await expect(service.create(owner, { platform: "nope", agentId: "bot-1" })).rejects.toThrow("不支持");
  });

  test("私聊一来一回、群里 @ 才回、/new 换对话、白名单、凭据加密", async () => {
    const view = await service.create(owner, {
      platform: "onebot",
      name: "测试 QQ",
      agentId: "bot-1",
      config: { mode: "forward", url: "ws://napcat.test:3001" },
      secrets: { accessToken: "secret-token-1" },
      ownerUsers: ["555"],
      allowUsers: ["777"],
    });
    createdIds.push(view.id);
    expect(view.secrets).toEqual({ accessToken: true });
    expect(JSON.stringify(view)).not.toContain("secret-token-1");
    const stored = await database.$client.unsafe<{ secrets: string }[]>("SELECT secrets FROM chisabot_im_connections WHERE id = $1", [view.id]);
    expect(stored[0]!.secrets).not.toContain("secret-token-1");

    const socket = await waitFor(() => sockets.find((item) => item.url.startsWith("ws://napcat.test:3001")));
    await waitFor(() => service.statusOf(view.id)?.state === "connected" && service.statusOf(view.id)?.account?.includes("10001"));

    // 私聊
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 555, message_id: 1, message: "今天天气怎么样", sender: { nickname: "小明" } });
    const reply = await waitFor(() => socket.actions("send_private_msg")[0]);
    expect(reply.params.user_id).toBe(555);
    expect(reply.params.message[0].data.text).toBe("收到：今天天气怎么样"); // QQ 不显示 Markdown：去掉 **
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ ownerUserId: owner, agentId: "bot-1", initiator: { kind: "routine", id: `im:${view.id}` } });
    expect(imConnectionOf(turns[0]!.initiator)).toBe(view.id);
    expect(String(turns[0]!.userMessage!.content)).toContain("经QQ 个人号（OneBot 11）私聊发来");
    const firstThread = turns[0]!.threadId;
    expect(firstThread.startsWith("im-")).toBe(true);

    // 同一个人再发：同一条对话
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 555, message_id: 2, message: "那明天呢" });
    await waitFor(() => turns.length === 2);
    expect(turns[1]!.threadId).toBe(firstThread);

    // /new：换对话，不跑回合
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 555, message_id: 3, message: "/new" });
    await waitFor(() => socket.actions("send_private_msg").some((frame) => frame.params.message[0].data.text.includes("新话题")));
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 555, message_id: 4, message: "重新问" });
    await waitFor(() => turns.length === 3);
    expect(turns[2]!.threadId).not.toBe(firstThread);

    // 群里没 @：不理；@ 了：回复引用原消息
    socket.push({ post_type: "message", message_type: "group", self_id: 10001, user_id: 777, group_id: 4242, message_id: 5, message: "大家好" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(turns).toHaveLength(3);
    socket.push({ post_type: "message", message_type: "group", self_id: 10001, user_id: 777, group_id: 4242, message_id: 6, message: [{ type: "at", data: { qq: "10001" } }, { type: "text", data: { text: " 帮个忙" } }] });
    const groupReply = await waitFor(() => socket.actions("send_group_msg")[0]);
    expect(groupReply.params.group_id).toBe(4242);
    expect(groupReply.params.message[0]).toEqual({ type: "reply", data: { id: "6" } });
    expect(turns[3]!.threadId).not.toBe(firstThread);

    // 白名单：只有 555 能用（主人名单之外再加 555）；别人发消息不跑回合，但 /id 照样回
    const updated = await service.update(owner, view.id, { allowUsers: ["555"] });
    expect(updated!.allowUsers).toEqual(["555"]);
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 888, message_id: 7, message: "我能用吗" });
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 888, message_id: 8, message: "/id" });
    await waitFor(() => socket.actions("send_private_msg").some((frame) => frame.params.user_id === 888 && frame.params.message[0].data.text.includes("888")));
    expect(turns).toHaveLength(4);

    const list = await service.list(owner);
    expect(list.find((item) => item.id === view.id)).toMatchObject({ status: "connected", allowUsers: ["555"] });
    expect(list.find((item) => item.id === view.id)!.lastMessageAt).not.toBeNull();
    const logs = await service.logs(owner, view.id);
    expect(logs!.some((entry) => entry.text.includes("不在可用名单"))).toBe(true);
    expect(await service.logs("someone-else", view.id)).toBeNull();
  });

  test("停用 → 断开；删除 → 行、会话、日志都清掉", async () => {
    const view = await service.create(owner, { platform: "onebot", agentId: "bot-1", config: { mode: "forward", url: "ws://napcat2.test:3001" } });
    const socket = await waitFor(() => sockets.find((item) => item.url.startsWith("ws://napcat2.test")));
    await waitFor(() => service.statusOf(view.id)?.state === "connected");
    const disabled = await service.update(owner, view.id, { enabled: false });
    expect(disabled!.status).toBe("disabled");
    expect(socket.readyState).toBe(3);
    expect(await service.remove("someone-else", view.id)).toBe(false);
    expect(await service.remove(owner, view.id)).toBe(true);
    const left = await database.$client.unsafe("SELECT 1 FROM chisabot_im_logs WHERE connection_id = $1 UNION ALL SELECT 1 FROM chisabot_im_connections WHERE id = $1", [view.id]);
    expect(left.length).toBe(0);
  });

  test("反向连接：自动生成 token，只认对的 token", async () => {
    const view = await service.create(owner, { platform: "onebot", agentId: "bot-1", config: { mode: "reverse" } });
    createdIds.push(view.id);
    expect(view.reversePath).toBe(`/api/im/onebot/${view.id}`);
    expect(view.secrets.accessToken).toBe(true);
    expect(await service.authorizeReverse(view.id, "wrong")).toBe(false);
    const row = await database.$client.unsafe<{ secrets: string }[]>("SELECT secrets FROM chisabot_im_connections WHERE id = $1", [view.id]);
    const { decryptSecret } = await import("../src/credentials");
    const token = JSON.parse(await decryptSecret(key, row[0]!.secrets)).accessToken;
    expect(await service.authorizeReverse(view.id, token)).toBe(true);
    await waitFor(() => service.statusOf(view.id)?.state === "waiting");
  });

  test("统一 Bot 会话与 IM 窗口授权闭环：共用网页端会话、推送待确认提示、回复「允许」直接放行", async () => {
    const { withConfirmActor, withConfirmTurn } = await import("../src/confirmations/context");
    const { createConfirmations } = await import("../src/confirmations/service");
    const confirmations = createConfirmations(database);
    await confirmations.ensure();
    let currentWebThread = `web-thread-${randomUUID().slice(0, 8)}`;
    const resolvedApprovals: Array<{ id: string; decision: "approve" | "deny" }> = [];

    const unifiedService = createImService({
      database,
      encryptionKey: key,
      botAvailable: async (user, agentId) => user === owner && agentId === "bot-1",
      resolveBotConversation: async (_user, _agentId, fresh) => {
        if (fresh) currentWebThread = `web-thread-${randomUUID().slice(0, 8)}`;
        return currentWebThread;
      },
      resolveApproval: async (user, threadId, decision) => {
        const allPending = (await confirmations.list(user, { threadId: threadId ?? undefined, limit: 20 })).filter((r) => r.status === "pending");
        const pending = allPending[0];
        if (!pending) return null;
        const decided = await confirmations.decide(user, pending.id, decision);
        resolvedApprovals.push({ id: pending.id, decision });
        return { title: decided.title, target: decided.target };
      },
      runTurn: async (input) => {
        // 模拟回合中触发需要用户确认的操作（如桌面窗口/浏览器操作）
        const check = await withConfirmTurn(
          { threadId: input.threadId, runId: "run-im", stopped: () => false },
          () =>
            withConfirmActor(
              input.initiator,
              () =>
                confirmations.check({
                  ownerUserId: input.ownerUserId,
                  agentId: input.agentId,
                  category: "message",
                  tool: "send_msg",
                  title: "点击桌面窗口",
                  target: "我的电脑",
                  details: [{ label: "坐标", value: "(100, 200)" }],
                  matchText: "点击桌面窗口 我的电脑",
                  digest: `digest-${randomUUID().slice(0, 8)}`,
                  initiator: input.initiator,
                }),
            ),
        );
        if (!check.ok) {
          return { replyText: check.message };
        }
        return { replyText: "操作已完成" };
      },
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });

    confirmations.setOnOpened((req) => {
      if (!req.threadId) return;
      void unifiedService.pushToThread(
        req.threadId,
        `⚠️ 待确认操作：「${req.title}」\n请直接回复「允许」或「拒绝」处理。`,
      );
    });

    const view = await unifiedService.create(owner, {
      platform: "onebot",
      name: "统一会话测试",
      agentId: "bot-1",
      config: { mode: "forward", url: "ws://napcat-unified.test:3001" },
      ownerUsers: ["666"],
    });
    createdIds.push(view.id);

    const socket = await waitFor(() => sockets.find((item) => item.url.startsWith("ws://napcat-unified.test:3001")));
    await waitFor(() => unifiedService.statusOf(view.id)?.state === "connected");

    // 1) 用户在 IM 发消息 -> 绑定到 currentWebThread，且触发待确认卡片并主动推送到 IM
    const initialWebThread = currentWebThread;
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 666, message_id: 10, message: "帮我点一下窗口" });

    await waitFor(() =>
      socket.actions("send_private_msg").some((frame) => frame.params.user_id === 666 && frame.params.message[0].data.text.includes("待确认操作：「点击桌面窗口」")),
    );
    const pendingList = (await confirmations.list(owner, { threadId: initialWebThread })).filter((r) => r.status === "pending");
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0]!.title).toBe("点击桌面窗口");

    // 2) 用户在 IM 直接回复「允许」 -> 主人本人私聊才能批：拦截并批准等待中的确认单
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 666, message_id: 11, message: "允许" });
    await waitFor(() =>
      socket.actions("send_private_msg").some((frame) => frame.params.user_id === 666 && frame.params.message[0].data.text.includes("已批准「点击桌面窗口」")),
    );
    expect(resolvedApprovals).toEqual([{ id: pendingList[0]!.id, decision: "approve" }]);
    expect((await confirmations.list(owner, { threadId: initialWebThread })).filter((r) => r.status === "pending")).toHaveLength(0);

    // 3) 用户在 IM 发送 /new -> 切换网页端当前会话
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 666, message_id: 12, message: "/new" });
    await waitFor(() => currentWebThread !== initialWebThread);

    await unifiedService.stopAll();
  });
});

