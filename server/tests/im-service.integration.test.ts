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

// 保存协议端地址时会预查 DNS：测试机可能是 fake-ip DNS（任何域名都解析成保留段），注入一个
// 永远「解析到公网」的实现；要验「解析到元数据被拒」的场景自己带 resolver。
const publicResolve = async () => [{ address: "93.184.216.34", family: 4 }];

const service = createImService({
  database,
  encryptionKey: key,
  runTurn,
  botAvailable: async (user, agentId) => user === owner && agentId === "bot-1",
  resolveDns: publicResolve,
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

    // 模拟回合中触发需要用户确认的操作（如桌面窗口/浏览器操作）。digest 固定：重试同一个操作要对上同一张卡片。
    const confirmRunTurn: TurnRunner = async (input) => {
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
                digest: "digest-点击桌面窗口",
                initiator: input.initiator,
              }),
          ),
      );
      if (!check.ok) {
        return { replyText: check.message };
      }
      return { replyText: "操作已完成" };
    };

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
      runTurn: confirmRunTurn,
      resolveDns: publicResolve,
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });

    // 和生产 index.ts 一样：批准一张「工具已经不等了」的卡片后，重跑同一回合并把回复推回 IM 私聊。
    // 重试用同一个 digest：check 会消耗掉刚才批准的授权（consumeGrant）直接放行，回合走到「操作已完成」。
    confirmations.setResume(async ({ ownerUserId, threadId, requestId, text }) => {
      const result = await confirmRunTurn({
        ownerUserId,
        routineId: `confirm:${requestId}`,
        agentId: "bot-1",
        threadId,
        instruction: text,
        initiator: { kind: "routine", id: `confirm:${requestId}` },
      });
      const replyText = result.replyText?.trim();
      if (replyText) await unifiedService.pushToThread(threadId, replyText, { privateOnly: true });
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
    // 批准后重跑的回合完成了那一步，结果照常推回 IM 私聊
    await waitFor(() =>
      socket.actions("send_private_msg").some((frame) => frame.params.user_id === 666 && frame.params.message[0].data.text.includes("操作已完成")),
    );
    expect(resolvedApprovals).toEqual([{ id: pendingList[0]!.id, decision: "approve" }]);
    expect((await confirmations.list(owner, { threadId: initialWebThread })).filter((r) => r.status === "pending")).toHaveLength(0);

    // 3) 用户在 IM 发送 /new -> 切换网页端当前会话
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 666, message_id: 12, message: "/new" });
    await waitFor(() => currentWebThread !== initialWebThread);

    await unifiedService.stopAll();
  });

  test("主人和白名单都空：私聊回一次怎么绑主人，10 分钟内不重发，群里不回", async () => {
    const view = await service.create(owner, {
      platform: "onebot",
      name: "空名单",
      agentId: "bot-1",
      config: { mode: "forward", url: "ws://napcat-empty.test:3001" },
    });
    createdIds.push(view.id);
    const socket = await waitFor(() => sockets.find((item) => item.url.startsWith("ws://napcat-empty.test")));
    await waitFor(() => service.statusOf(view.id)?.state === "connected");
    const turnsBefore = turns.length;

    // 陌生人私聊：回一次引导；再发不重复（10 分钟节流）；/id 不受影响
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 888, message_id: 20, message: "在吗" });
    await waitFor(() =>
      socket.actions("send_private_msg").some((frame) => frame.params.user_id === 888 && frame.params.message[0].data.text.includes("还没绑定主人")),
    );
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 888, message_id: 21, message: "人呢" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socket.actions("send_private_msg").filter((frame) => frame.params.user_id === 888 && frame.params.message[0].data.text.includes("还没绑定主人"))).toHaveLength(1);
    expect(turns.length).toBe(turnsBefore);

    // 群里 @ 机器人也绝不开口
    socket.push({ post_type: "message", message_type: "group", self_id: 10001, user_id: 888, group_id: 7777, message_id: 22, message: [{ type: "at", data: { qq: "10001" } }, { type: "text", data: { text: " 在吗" } }] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socket.actions("send_group_msg")).toHaveLength(0);

    // /id 在名单检查之前，陌生人照样拿得到自己的 id
    socket.push({ post_type: "message", message_type: "private", self_id: 10001, user_id: 888, message_id: 23, message: "/id" });
    await waitFor(() => socket.actions("send_private_msg").some((frame) => frame.params.user_id === 888 && frame.params.message[0].data.text.includes("888")));
  });

  test("扫码绑定：平台回了扫码人 id 就自动加进主人名单", async () => {
    const wxFetch = (async (input: string) => {
      const url = String(input);
      if (url.includes("get_bot_qrcode")) return new Response(JSON.stringify({ qrcode: "wx-qr-1", qrcode_img_content: "https://ilinkai.weixin.qq.com/qr/1" }), { status: 200 });
      if (url.includes("get_qrcode_status"))
        return new Response(
          JSON.stringify({ status: "confirmed", bot_token: "wx-token-1", ilink_user_id: "wx-owner-1", ilink_bot_id: "wx-bot-9", baseurl: "https://ilinkai.weixin.qq.com" }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ errcode: 0, get_updates_buf: "", msgs: [] }), { status: 200 });
    }) as typeof fetch;
    const wxService = createImService({
      database,
      encryptionKey: key,
      runTurn,
      botAvailable: async (user, agentId) => user === owner && agentId === "bot-1",
      fetch: wxFetch,
      resolveDns: publicResolve,
    });
    const started = await wxService.qrStart(owner, { platform: "weixin" });
    const polled = await wxService.qrPoll(owner, started.session);
    expect(polled.status).toBe("confirmed");
    if (polled.status !== "confirmed") throw new Error("扫码确认失败");
    const view = await wxService.create(owner, { platform: "weixin", agentId: "bot-1", qrLogin: polled.loginKey });
    createdIds.push(view.id);
    expect(view.ownerUsers).toEqual(["wx-owner-1"]);
    await wxService.stopAll();
  });

  test("「允许内网地址」：只有管理员能设置；放行只对这个连接自己配置的协议端主机生效", async () => {
    const wsCalls: { url: string; allowPrivate?: boolean }[] = [];
    const scoped = createImService({
      database,
      encryptionKey: key,
      runTurn,
      botAvailable: async (user, agentId) => user === owner && agentId === "bot-1",
      resolveDns: publicResolve,
      ws: (url, wsOptions) => {
        wsCalls.push({ url, allowPrivate: wsOptions?.allowPrivate });
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });

    // 非管理员：开关被忽略，私网地址照旧不过校验
    await expect(
      scoped.create(owner, { platform: "onebot", agentId: "bot-1", config: { mode: "forward", url: "ws://10.0.0.5:3001" }, allowPrivate: true }),
    ).rejects.toThrow("不能访问内网地址");
    const publicView = await scoped.create(owner, {
      platform: "onebot",
      agentId: "bot-1",
      config: { mode: "forward", url: "ws://napcat-public.test:3001" },
      allowPrivate: true,
    });
    createdIds.push(publicView.id);
    expect(publicView.allowPrivate).toBe(false);

    // 管理员：开关生效，私网地址过校验；适配器连的就是它，ws 收到 allowPrivate:true
    const privateView = await scoped.create(
      owner,
      { platform: "onebot", agentId: "bot-1", config: { mode: "forward", url: "ws://10.0.0.5:3001" }, allowPrivate: true },
      true,
    );
    createdIds.push(privateView.id);
    expect(privateView.allowPrivate).toBe(true);
    await waitFor(() => wsCalls.find((call) => call.url === "ws://10.0.0.5:3001"));
    await waitFor(() => wsCalls.find((call) => call.url === "ws://napcat-public.test:3001"));
    expect(wsCalls.find((call) => call.url === "ws://10.0.0.5:3001")!.allowPrivate).toBe(true);
    expect(wsCalls.find((call) => call.url === "ws://napcat-public.test:3001")!.allowPrivate).toBeFalsy();

    // 非管理员改连接（不动协议端地址）：开关值丢不掉也改不了（沿用库里已存的 true）
    const byUser = await scoped.update(owner, privateView.id, { allowPrivate: false, name: "改名而已" });
    expect(byUser!.allowPrivate).toBe(true);

    // 开关开着时改协议端地址 = 要重新确认：管理员没把开关再传一遍，先按「关」算——
    // 新地址是内网 → 地址校验 400 挡住；是公网 → 静默落库且开关置关。
    await expect(
      scoped.update(owner, privateView.id, { config: { url: "ws://10.9.9.9:6379" } }, true),
    ).rejects.toThrow("不能访问内网地址");
    const stillPrivate = await scoped.list(owner);
    expect(stillPrivate.find((item) => item.id === privateView.id)!.allowPrivate).toBe(true);
    expect(stillPrivate.find((item) => item.id === privateView.id)!.config.url).toBe("ws://10.0.0.5:3001");

    // 管理员重新把开关传一遍 = 确认过这个新地址 → 能改到另一个内网地址
    const reconfirmed = await scoped.update(
      owner,
      privateView.id,
      { config: { url: "ws://10.9.9.9:6379" }, allowPrivate: true },
      true,
    );
    expect(reconfirmed!.allowPrivate).toBe(true);
    expect(reconfirmed!.config.url).toBe("ws://10.9.9.9:6379");

    // 改到公网地址但没重传开关：保存成功，开关被重置成关
    const downgraded = await scoped.update(owner, privateView.id, { config: { url: "ws://napcat-public2.test:3001" } }, true);
    expect(downgraded!.allowPrivate).toBe(false);
    expect(downgraded!.config.url).toBe("ws://napcat-public2.test:3001");

    // 管理员把开关关掉（同时把地址换成公网才过校验）
    const byAdmin = await scoped.update(owner, privateView.id, { allowPrivate: false, config: { url: "ws://napcat-public3.test:3001" } }, true);
    expect(byAdmin!.allowPrivate).toBe(false);

    await scoped.stopAll();
  });

  test("保存时预查 DNS：主机名解析到元数据 / 内网就拒（#467 r2 P3）", async () => {
    const resolving = createImService({
      database,
      encryptionKey: key,
      runTurn,
      botAvailable: async (user, agentId) => user === owner && agentId === "bot-1",
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
      resolveDns: async (hostname) =>
        hostname === "meta.example"
          ? [{ address: "169.254.169.254", family: 4 }]
          : hostname === "ula.example"
            ? [{ address: "fd20:ce::254", family: 6 }]
            : [{ address: "93.184.216.34", family: 4 }],
    });

    // 解析到云元数据的主机名：普通模式拒，开了「允许内网地址」照样拒（169.254.0.0/16 永远拦）。
    await expect(
      resolving.create(owner, { platform: "onebot", agentId: "bot-1", config: { mode: "forward", url: "ws://meta.example:3001" } }),
    ).rejects.toThrow("不能访问内网地址");
    await expect(
      resolving.create(owner, { platform: "onebot", agentId: "bot-1", config: { mode: "forward", url: "ws://meta.example:3001" }, allowPrivate: true }, true),
    ).rejects.toThrow("不能访问内网地址");
    // ULA / IPv6 元数据：开关开着也拒。
    await expect(
      resolving.create(owner, { platform: "onebot", agentId: "bot-1", config: { mode: "forward", url: "ws://ula.example:3001" }, allowPrivate: true }, true),
    ).rejects.toThrow("不能访问内网地址");
    // 解析到公网的主机名照常保存。
    const ok = await resolving.create(owner, { platform: "onebot", agentId: "bot-1", enabled: false, config: { mode: "forward", url: "ws://pub.example:3001" } });
    createdIds.push(ok.id);
    expect(ok.config.url).toBe("ws://pub.example:3001");
    // 「测试连接」草稿也过同一道预查。
    await expect(
      resolving.testDraft(owner, { platform: "onebot", config: { mode: "forward", url: "ws://meta.example:3001" } }),
    ).rejects.toThrow("不能访问内网地址");
    await resolving.stopAll();
  });

  test("0061 迁移：私聊过机器人的人被回填成主人；白名单非空时只从白名单里挑（#467 r2）", async () => {
    const id = "im_backfill01";
    const untouched = "im_backfill02";
    const nochat = "im_backfill03";
    const allow = "im_backfill04";
    const allowNone = "im_backfill05";
    await database.$client.unsafe(
      `INSERT INTO chisabot_im_connections (id, owner_user_id, platform, name, agent_id, enabled, config, allow_users, owner_users)
       VALUES ($1, $2, 'onebot', '旧连接', 'bot-1', true, '{}', '[]', '[]'),
              ($3, $2, 'onebot', '已有主人', 'bot-1', true, '{}', '[]', '["kept"]'),
              ($4, $2, 'onebot', '没人聊过', 'bot-1', true, '{}', '[]', '[]'),
              ($5, $2, 'onebot', '白名单非空', 'bot-1', true, '{}', '["qq-777"]', '[]'),
              ($6, $2, 'onebot', '白名单不相交', 'bot-1', true, '{}', '["qq-999"]', '[]')`,
      [id, `backfill-${owner}`, untouched, nochat, allow, allowNone],
    );
    await database.$client.unsafe(
      `INSERT INTO chisabot_im_chats (connection_id, chat_key, thread_id)
       VALUES ($1, 'private:qq-777', 't1'), ($1, 'private:qq-888', 't2'), ($1, 'group:12345', 't3'),
              ($2, 'private:qq-777', 't4'), ($2, 'private:qq-888', 't5'),
              ($3, 'private:qq-777', 't6')`,
      [id, allow, allowNone],
    );
    try {
      const migration = await Bun.file(new URL("../drizzle/0061_im_owner_backfill.sql", import.meta.url)).text();
      await database.$client.unsafe(migration);
      // 幂等：再跑一遍结果不变。
      await database.$client.unsafe(migration);
      const rows = await database.$client.unsafe<{ id: string; owner_users: string[] }[]>(
        "SELECT id, owner_users FROM chisabot_im_connections WHERE id IN ($1, $2, $3, $4, $5)",
        [id, untouched, nochat, allow, allowNone],
      );
      const owners = new Map(rows.map((row) => [row.id, row.owner_users]));
      expect(owners.get(id)!.sort()).toEqual(["qq-777", "qq-888"]);
      expect(owners.get(untouched)).toEqual(["kept"]);
      expect(owners.get(nochat)).toEqual([]);
      // 白名单非空 = 主人只能出在白名单里：qq-888 私聊过也不能升级成主人；交集为空就不填。
      expect(owners.get(allow)).toEqual(["qq-777"]);
      expect(owners.get(allowNone)).toEqual([]);
    } finally {
      await database.$client.unsafe("DELETE FROM chisabot_im_chats WHERE connection_id IN ($1, $2, $3)", [id, allow, allowNone]);
      await database.$client.unsafe("DELETE FROM chisabot_im_connections WHERE id IN ($1, $2, $3, $4, $5)", [id, untouched, nochat, allow, allowNone]);
    }
  });
});

