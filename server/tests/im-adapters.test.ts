import { describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { splitChatOrigin } from "../../app/src/components/channels/chat-origin";
import { DingtalkAdapter } from "../src/im/adapters/dingtalk";
import { FeishuAdapter, parseFeishuMessage } from "../src/im/adapters/feishu";
import {
  OneBotAdapter,
  parseCqString,
  parseOneBotEvent,
} from "../src/im/adapters/onebot";
import {
  parseQqEvent,
  QqOfficialAdapter,
} from "../src/im/adapters/qq-official";
import {
  parseTelegramUpdate,
  TelegramAdapter,
} from "../src/im/adapters/telegram";
import {
  parseWecomMessage,
  WecomBotAdapter,
} from "../src/im/adapters/wecom-bot";
import { parseWeixinMessage, WeixinAdapter } from "../src/im/adapters/weixin";
import { decodeFrame, encodeFrame, headerOf } from "../src/im/feishu-proto";
import {
  decryptQqBotSecret,
  pollPlatformQr,
  startPlatformQr,
} from "../src/im/qr-auth";
import { chatKey, frameInbound } from "../src/im/service";
import { backoffMs, markdownToPlain, splitText } from "../src/im/text";
import type {
  AdapterContext,
  ImAdapterStatus,
  ImInbound,
  WsLike,
} from "../src/im/types";

/** 假的 WebSocket：记录发出的帧，测试从「平台」那边推消息进来。 */
class FakeWs implements WsLike {
  readyState = 0;
  binaryType?: string;
  sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    public url: string,
    public options?: { headers?: Record<string, string> },
  ) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(data: string | ArrayBufferLike | Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000 });
  }
  push(data: unknown) {
    this.onmessage?.({ data });
  }
  json(): any[] {
    return this.sent
      .filter((item) => typeof item === "string")
      .map((item) => JSON.parse(item as string));
  }
}

type FetchCall = { url: string; init?: RequestInit; body: any };

function harness(
  config: Record<string, string>,
  secrets: Record<string, string>,
  routes: Record<string, (call: FetchCall) => unknown | Promise<unknown>> = {},
) {
  const sockets: FakeWs[] = [];
  const messages: ImInbound[] = [];
  const statuses: ImAdapterStatus[] = [];
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  const ctx: AdapterContext = {
    connectionId: "im_test",
    config,
    secrets,
    log: (level, text) => logs.push(`${level}:${text}`),
    setStatus: (status) => statuses.push(status),
    onMessage: (message) => messages.push(message),
    fetch: async (url, init) => {
      let body: any = null;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : null;
      } catch {}
      const call = { url, init, body };
      calls.push(call);
      const key = Object.keys(routes).find((pattern) => url.includes(pattern));
      if (!key)
        return new Response(JSON.stringify({ error: "no route" }), {
          status: 404,
        });
      const result = await routes[key]!(call);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    ws: (url, options) => {
      const socket = new FakeWs(url, options);
      sockets.push(socket);
      return socket;
    },
  };
  return { ctx, sockets, messages, statuses, calls, logs };
}

async function waitFor<T>(
  check: () => T | undefined | null | false,
  ms = 2000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const inbound = (overrides: Partial<ImInbound> = {}): ImInbound => ({
  messageId: "m1",
  chatType: "private",
  chatId: "u1",
  userId: "u1",
  text: "你好",
  mentioned: true,
  reply: {},
  ...overrides,
});

describe("文字处理", () => {
  test("长回复按段落切开，每段不超过上限", () => {
    const text = `${"第一段。".repeat(30)}\n\n${"第二段内容，".repeat(40)}`;
    const parts = splitText(text, 100);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(100);
    expect(parts.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
  test("短回复不切，空回复没有段", () => {
    expect(splitText("  好的  ", 100)).toEqual(["好的"]);
    expect(splitText("   ", 100)).toEqual([]);
  });
  test("Markdown 变纯文本", () => {
    const plain = markdownToPlain(
      "## 标题\n**粗体** 和 `代码` 还有 [链接](https://a.com)\n- 一\n- 二\n```js\nlet a = 1;\n```\n![图](https://img/x.png)",
    );
    expect(plain).toBe(
      "标题\n粗体 和 代码 还有 链接（https://a.com）\n• 一\n• 二\nlet a = 1;\n[图片：图] https://img/x.png",
    );
  });
  test("退避：指数增长、有上限", () => {
    expect(backoffMs(0, () => 0.5)).toBe(1000);
    expect(backoffMs(3, () => 0.5)).toBe(8000);
    expect(backoffMs(20, () => 0.5)).toBe(60_000);
  });
  test("给机器人的消息带上平台和发送者", () => {
    const framed = frameInbound(
      "QQ",
      inbound({
        chatType: "group",
        chatId: "g1",
        userName: "小明",
        text: "帮我查天气",
        attachments: [{ kind: "image" }],
      }),
    );
    expect(framed).toContain("经QQ群聊发来");
    expect(framed).toContain("小明（u1）");
    expect(framed).toContain("[图片]");
    expect(framed.endsWith("帮我查天气")).toBe(true);
    expect(chatKey({ chatType: "group", chatId: "g1" })).toBe("group:g1");
  });
});

describe("飞书 pbbp2 帧", () => {
  test("编码再解码一致（含大整数和二进制负载）", () => {
    const payload = new TextEncoder().encode(JSON.stringify({ hello: "世界" }));
    const frame = {
      SeqID: 12345678901234n,
      LogID: 7n,
      service: 33,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "abc" },
      ],
      payload,
    };
    const back = decodeFrame(encodeFrame(frame));
    expect(back.SeqID).toBe(12345678901234n);
    expect(back.service).toBe(33);
    expect(back.method).toBe(1);
    expect(headerOf(back, "message_id")).toBe("abc");
    expect(new TextDecoder().decode(back.payload!)).toBe(
      JSON.stringify({ hello: "世界" }),
    );
  });
});

describe("OneBot 11（QQ 个人号）", () => {
  test("CQ 码字符串和段数组都能解析，@ 自己才算叫到", () => {
    expect(parseCqString("[CQ:at,qq=10001] 你好&#91;x&#93;")).toEqual([
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: " 你好[x]" } },
    ]);
    const group = parseOneBotEvent(
      {
        post_type: "message",
        message_type: "group",
        self_id: 10001,
        user_id: 2,
        group_id: 99,
        message_id: 5,
        message: "[CQ:at,qq=10001] 查天气",
        sender: { nickname: "小红" },
      },
      null,
    )!;
    expect(group).toMatchObject({
      chatType: "group",
      chatId: "99",
      userId: "2",
      text: "查天气",
      mentioned: true,
      userName: "小红",
    });
    const other = parseOneBotEvent(
      {
        post_type: "message",
        message_type: "group",
        self_id: 10001,
        user_id: 2,
        group_id: 99,
        message_id: 6,
        message: [{ type: "text", data: { text: "随便聊" } }],
      },
      null,
    )!;
    expect(other.mentioned).toBe(false);
    expect(
      parseOneBotEvent(
        {
          post_type: "message",
          message_type: "private",
          self_id: 10001,
          user_id: 10001,
          message: "自己",
        },
        null,
      ),
    ).toBeNull();
  });

  test("正向连接：带 token 连上、读登录信息、收消息、群回复引用原消息", async () => {
    const h = harness(
      { mode: "forward", url: "ws://napcat:3001" },
      { accessToken: "tok" },
    );
    const adapter = new OneBotAdapter(h.ctx);
    await adapter.start();
    const socket = await waitFor(() => h.sockets[0]);
    expect(socket.url).toBe("ws://napcat:3001?access_token=tok");
    expect(socket.options?.headers?.Authorization).toBe("Bearer tok");
    const ask = await waitFor(() =>
      socket.json().find((frame) => frame.action === "get_login_info"),
    );
    socket.push(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { user_id: 10001, nickname: "机器人" },
        echo: ask.echo,
      }),
    );
    await waitFor(() =>
      h.statuses.find(
        (status) =>
          status.state === "connected" && status.account?.includes("10001"),
      ),
    );
    socket.push(
      JSON.stringify({
        post_type: "message",
        message_type: "group",
        self_id: 10001,
        user_id: 2,
        group_id: 99,
        message_id: 5,
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: " 你好" } },
        ],
      }),
    );
    socket.push(
      JSON.stringify({
        post_type: "message",
        message_type: "group",
        self_id: 10001,
        user_id: 2,
        group_id: 99,
        message_id: 5,
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: " 你好" } },
        ],
      }),
    );
    await waitFor(() => h.messages.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.messages.length).toBe(1); // 重投的同一条去重
    const sending = adapter.send({
      inbound: h.messages[0]!,
      chunks: ["第一段", "第二段"],
      text: "",
    });
    const first = await waitFor(() =>
      socket.json().find((frame) => frame.action === "send_group_msg"),
    );
    expect(first.params.group_id).toBe(99);
    expect(first.params.message[0]).toEqual({
      type: "reply",
      data: { id: "5" },
    });
    socket.push(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message_id: 1 },
        echo: first.echo,
      }),
    );
    const second = await waitFor(
      () =>
        socket.json().filter((frame) => frame.action === "send_group_msg")[1],
    );
    expect(second.params.message).toEqual([
      { type: "text", data: { text: "第二段" } },
    ]);
    socket.push(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message_id: 2 },
        echo: second.echo,
      }),
    );
    await sending;
    await adapter.stop();
  });

  test("反向连接：协议端连进来以后才算连上，私聊回复用 send_private_msg", async () => {
    const h = harness({ mode: "reverse" }, { accessToken: "tok" });
    const adapter = new OneBotAdapter(h.ctx);
    await adapter.start();
    await waitFor(() =>
      h.statuses.find((status) => status.state === "waiting"),
    );
    const socket = new FakeWs("reverse");
    socket.readyState = 1;
    expect(adapter.attach(socket, "10001")).toBe(true);
    await waitFor(() =>
      h.statuses.find((status) => status.state === "connected"),
    );
    socket.push(
      JSON.stringify({
        post_type: "message",
        message_type: "private",
        self_id: 10001,
        user_id: 3,
        message_id: 8,
        message: "在吗",
      }),
    );
    const message = await waitFor(() => h.messages[0]);
    expect(message).toMatchObject({
      chatType: "private",
      chatId: "3",
      text: "在吗",
      mentioned: true,
    });
    const sending = adapter.send({
      inbound: message,
      chunks: ["在"],
      text: "在",
    });
    const frame = await waitFor(() =>
      socket.json().find((item) => item.action === "send_private_msg"),
    );
    expect(frame.params).toEqual({
      user_id: 3,
      message: [{ type: "text", data: { text: "在" } }],
    });
    socket.push(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo }));
    await sending;
    socket.close();
    await waitFor(
      () =>
        h.statuses.filter((status) => status.state === "waiting").length >= 2,
    );
    await adapter.stop();
  });
});

describe("QQ 官方机器人", () => {
  test("事件解析：私聊、群 @、频道 @ 去掉 <@!id>", () => {
    expect(
      parseQqEvent("C2C_MESSAGE_CREATE", {
        id: "a",
        content: "你好",
        author: { user_openid: "U" },
      }),
    ).toMatchObject({ chatType: "private", chatId: "U", text: "你好" });
    expect(
      parseQqEvent("GROUP_AT_MESSAGE_CREATE", {
        id: "b",
        content: " 查天气",
        group_openid: "G",
        author: { member_openid: "M" },
      }),
    ).toMatchObject({
      chatType: "group",
      chatId: "G",
      userId: "M",
      text: "查天气",
      mentioned: true,
    });
    expect(
      parseQqEvent("AT_MESSAGE_CREATE", {
        id: "c",
        content: "<@!123> 帮忙",
        channel_id: "C",
        author: { id: "9", username: "x" },
      })!.text,
    ).toBe("帮忙");
    expect(parseQqEvent("GUILD_CREATE", {})).toBeNull();
  });

  test("拿令牌 → 网关 → Hello 后 Identify → READY → 收群消息 → 被动回复带 msg_id 和递增 msg_seq", async () => {
    const posts: FetchCall[] = [];
    const h = harness(
      { appId: "102", scope: "qq", sandbox: "prod" },
      { appSecret: "s" },
      {
        "bots.qq.com/app/getAppAccessToken": () => ({
          access_token: "AT",
          expires_in: "7200",
        }),
        "/gateway": () => ({ url: "wss://api.sgroup.qq.com/websocket" }),
        "/v2/groups/": (call) => {
          posts.push(call);
          return { id: "sent" };
        },
      },
    );
    const adapter = new QqOfficialAdapter(h.ctx);
    await adapter.start();
    const socket = await waitFor(() => h.sockets[0]);
    expect(h.calls[0]!.body).toEqual({ appId: "102", clientSecret: "s" });
    await waitFor(() => socket.readyState === 1);
    socket.push(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
    const identify = await waitFor(() =>
      socket.json().find((frame) => frame.op === 2),
    );
    expect(identify.d).toMatchObject({
      token: "QQBot AT",
      intents: 1 << 25,
      shard: [0, 1],
    });
    socket.push(
      JSON.stringify({
        op: 0,
        s: 1,
        t: "READY",
        d: { session_id: "S", user: { username: "小Q" } },
      }),
    );
    await waitFor(() =>
      h.statuses.find((status) => status.state === "connected"),
    );
    socket.push(
      JSON.stringify({
        op: 0,
        s: 2,
        t: "GROUP_AT_MESSAGE_CREATE",
        d: {
          id: "MSG",
          content: " 你好",
          group_openid: "G",
          author: { member_openid: "M" },
        },
      }),
    );
    const message = await waitFor(() => h.messages[0]);
    await adapter.send({
      inbound: message,
      chunks: ["一", "二"],
      text: "一二",
    });
    expect(posts.map((call) => call.body)).toEqual([
      { content: "一", msg_type: 0, msg_id: "MSG", msg_seq: 1 },
      { content: "二", msg_type: 0, msg_id: "MSG", msg_seq: 2 },
    ]);
    expect(
      (posts[0]!.init!.headers as Record<string, string>).Authorization,
    ).toBe("QQBot AT");
    await adapter.stop();
  });
});

describe("飞书长连接", () => {
  test("解析 im.message.receive_v1：群里 @ 机器人才算叫到，@ 标记被替换", () => {
    const event = {
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      message: {
        message_id: "om_1",
        chat_id: "oc_g",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 @_user_2 你好" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" },
          { key: "@_user_2", id: { open_id: "ou_x" }, name: "张三" },
        ],
      },
    };
    expect(parseFeishuMessage(event, "ou_bot")).toMatchObject({
      chatType: "group",
      chatId: "oc_g",
      userId: "ou_user",
      text: "@张三 你好",
      mentioned: true,
    });
    expect(parseFeishuMessage(event, "ou_other")!.mentioned).toBe(false);
  });

  test("拿长连接地址 → 连上 → 收事件帧 → 回 code 200 帧 → 回复走 reply 接口（Markdown）", async () => {
    const replies: FetchCall[] = [];
    const h = harness(
      { appId: "cli_1", domain: "feishu" },
      { appSecret: "sec" },
      {
        "tenant_access_token/internal": () => ({
          code: 0,
          tenant_access_token: "TT",
          expire: 7200,
        }),
        "/open-apis/bot/v3/info": () => ({
          code: 0,
          bot: { open_id: "ou_bot", app_name: "小飞" },
        }),
        "/callback/ws/endpoint": () => ({
          code: 0,
          data: {
            URL: "wss://msg-frontier.feishu.cn/ws/v2?device_id=d&service_id=77",
            ClientConfig: { PingInterval: 120 },
          },
        }),
        "/reply": (call) => {
          replies.push(call);
          return { code: 0 };
        },
      },
    );
    const adapter = new FeishuAdapter(h.ctx);
    await adapter.start();
    const socket = await waitFor(() => h.sockets[0]);
    expect(socket.binaryType).toBe("arraybuffer");
    await waitFor(() =>
      h.statuses.find(
        (status) =>
          status.state === "connected" && status.account?.includes("小飞"),
      ),
    );
    const event = {
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
        message: {
          message_id: "om_9",
          chat_id: "oc_p",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "你好" }),
        },
      },
    };
    const frame = encodeFrame({
      SeqID: 1n,
      LogID: 2n,
      service: 77,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "e1" },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
      ],
      payload: new TextEncoder().encode(JSON.stringify(event)),
    });
    socket.push(frame.buffer);
    const message = await waitFor(() => h.messages[0]);
    expect(message).toMatchObject({
      chatType: "private",
      text: "你好",
      userId: "ou_user",
    });
    const ack = await waitFor(
      () =>
        socket.sent.find((item) => item instanceof Uint8Array) as
          | Uint8Array
          | undefined,
    );
    const decoded = decodeFrame(ack);
    expect(headerOf(decoded, "biz_rt")).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(decoded.payload!))).toEqual({
      code: 200,
    });
    await adapter.send({
      inbound: message,
      chunks: ["**好的**"],
      text: "**好的**",
    });
    expect(replies[0]!.url).toContain("/open-apis/im/v1/messages/om_9/reply");
    expect(replies[0]!.body.msg_type).toBe("post");
    expect(JSON.parse(replies[0]!.body.content)).toEqual({
      zh_cn: { content: [[{ tag: "md", text: "**好的**" }]] },
    });
    await adapter.stop();
  });

  test("分片事件合并后才处理", async () => {
    const h = harness(
      { appId: "cli_1" },
      { appSecret: "sec" },
      {
        "tenant_access_token/internal": () => ({
          code: 0,
          tenant_access_token: "TT",
          expire: 7200,
        }),
        "/open-apis/bot/v3/info": () => ({
          code: 0,
          bot: { open_id: "ou_bot", app_name: "小飞" },
        }),
        "/callback/ws/endpoint": () => ({
          code: 0,
          data: {
            URL: "wss://x/ws?service_id=1",
            ClientConfig: { PingInterval: 120 },
          },
        }),
      },
    );
    const adapter = new FeishuAdapter(h.ctx);
    await adapter.start();
    const socket = await waitFor(() => h.sockets[0]);
    await waitFor(() =>
      h.statuses.find((status) => status.state === "connected"),
    );
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        header: { event_type: "im.message.receive_v1" },
        event: {
          sender: { sender_id: { open_id: "u" } },
          message: {
            message_id: "om_x",
            chat_id: "c",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "拼起来" }),
          },
        },
      }),
    );
    const half = Math.floor(bytes.length / 2);
    for (const [seq, part] of [
      [1, bytes.slice(half)],
      [0, bytes.slice(0, half)],
    ] as const) {
      socket.push(
        encodeFrame({
          SeqID: 0n,
          LogID: 0n,
          service: 1,
          method: 1,
          headers: [
            { key: "type", value: "event" },
            { key: "message_id", value: "big" },
            { key: "sum", value: "2" },
            { key: "seq", value: String(seq) },
          ],
          payload: part,
        }).buffer,
      );
    }
    expect((await waitFor(() => h.messages[0])).text).toBe("拼起来");
    await adapter.stop();
  });
});

describe("企业微信智能机器人", () => {
  test("消息解析：群消息去掉开头的 @机器人", () => {
    expect(
      parseWecomMessage({
        msgid: "1",
        chattype: "group",
        chatid: "G",
        from: { userid: "zhang" },
        msgtype: "text",
        text: { content: "@助手 你好" },
      }),
    ).toMatchObject({ chatType: "group", chatId: "G", text: "你好" });
  });

  test("订阅 → 收消息先回空流式帧 → 回复发 finish 的流式帧，多余段主动发送", async () => {
    const h = harness({ botId: "B1" }, { secret: "S1" });
    const adapter = new WecomBotAdapter(h.ctx);
    await adapter.start();
    const socket = await waitFor(() => h.sockets[0]);
    const sub = await waitFor(() =>
      socket.json().find((frame) => frame.cmd === "aibot_subscribe"),
    );
    expect(sub.body).toEqual({ bot_id: "B1", secret: "S1" });
    socket.push(
      JSON.stringify({
        headers: { req_id: sub.headers.req_id },
        errcode: 0,
        errmsg: "ok",
      }),
    );
    await waitFor(() =>
      h.statuses.find((status) => status.state === "connected"),
    );
    socket.push(
      JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: { req_id: "REQ" },
        body: {
          msgid: "M",
          chattype: "single",
          from: { userid: "zhang" },
          msgtype: "text",
          text: { content: "你好" },
        },
      }),
    );
    const message = await waitFor(() => h.messages[0]);
    const initial = socket
      .json()
      .find((frame) => frame.cmd === "aibot_respond_msg")!;
    expect(initial.headers.req_id).toBe("REQ");
    expect(initial.body.stream.finish).toBe(false);
    const sending = adapter.send({
      inbound: message,
      chunks: ["第一段", "第二段"],
      text: "",
    });
    const final = await waitFor(() =>
      socket
        .json()
        .find(
          (frame) =>
            frame.cmd === "aibot_respond_msg" && frame.body.stream.finish,
        ),
    );
    expect(final.body.stream).toMatchObject({
      id: initial.body.stream.id,
      finish: true,
      content: "第一段",
    });
    socket.push(JSON.stringify({ headers: { req_id: "REQ" }, errcode: 0 }));
    const active = await waitFor(() =>
      socket.json().find((frame) => frame.cmd === "aibot_send_msg"),
    );
    expect(active.body).toEqual({
      chatid: "zhang",
      msgtype: "markdown",
      markdown: { content: "第二段" },
    });
    socket.push(
      JSON.stringify({
        headers: { req_id: active.headers.req_id },
        errcode: 0,
      }),
    );
    await sending;
    await adapter.stop();
  });
});

describe("个人微信（ClawBot / iLink）", () => {
  test("只收用户发来的私聊消息，带上 context_token", () => {
    expect(
      parseWeixinMessage({
        message_type: 1,
        from_user_id: "wx_u",
        message_id: 9,
        context_token: "CT",
        item_list: [{ type: 1, text_item: { text: "你好" } }],
      }),
    ).toMatchObject({
      chatId: "wx_u",
      text: "你好",
      reply: { contextToken: "CT" },
    });
    expect(
      parseWeixinMessage({ message_type: 2, from_user_id: "bot" }),
    ).toBeNull();
  });

  test("长轮询收消息、发消息带 context_token、授权过期报错", async () => {
    let polls = 0;
    const sent: FetchCall[] = [];
    const h = harness(
      { baseUrl: "https://ilink.test" },
      { token: "BT" },
      {
        "/ilink/bot/getupdates": async () => {
          polls++;
          if (polls === 1)
            return {
              ret: 0,
              get_updates_buf: "c1",
              msgs: [
                {
                  message_type: 1,
                  from_user_id: "wx_u",
                  message_id: 1,
                  context_token: "CT",
                  item_list: [{ type: 1, text_item: { text: "在吗" } }],
                },
              ],
            };
          if (polls === 2) return { ret: -14, errmsg: "session expired" };
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ret: 0, msgs: [] };
        },
        "/ilink/bot/sendmessage": (call) => {
          sent.push(call);
          return { ret: 0 };
        },
      },
    );
    const adapter = new WeixinAdapter(h.ctx);
    await adapter.start();
    const message = await waitFor(() => h.messages[0]);
    expect(
      (h.calls[0]!.init!.headers as Record<string, string>).Authorization,
    ).toBe("Bearer BT");
    expect(h.calls[0]!.body.base_info).toEqual({ channel_version: "1.0.0" });
    await adapter.send({ inbound: message, chunks: ["在的"], text: "在的" });
    expect(sent[0]!.body.msg).toMatchObject({
      to_user_id: "wx_u",
      message_type: 2,
      message_state: 2,
      context_token: "CT",
      item_list: [{ type: 1, text_item: { text: "在的" } }],
    });
    await waitFor(() =>
      h.statuses.find(
        (status) => status.state === "error" && status.detail?.includes("过期"),
      ),
    );
    expect(h.calls[1]!.body.get_updates_buf).toBe("c1");
    await adapter.stop();
  });
});

describe("钉钉 Stream", () => {
  test("ping 原样回、回调先回执再交给服务、回复走 sessionWebhook", async () => {
    const hooks: FetchCall[] = [];
    const h = harness(
      { clientId: "ding1" },
      { clientSecret: "x" },
      {
        "gateway/connections/open": () => ({
          endpoint: "wss://wss-open-connection.dingtalk.com/connect",
          ticket: "T",
        }),
        "oapi.dingtalk.com/robot/sendBySession": (call) => {
          hooks.push(call);
          return { errcode: 0 };
        },
      },
    );
    const adapter = new DingtalkAdapter(h.ctx);
    await adapter.start();
    const socket = await waitFor(() => h.sockets[0]);
    expect(socket.url).toBe(
      "wss://wss-open-connection.dingtalk.com/connect?ticket=T",
    );
    await waitFor(() => socket.readyState === 1);
    socket.push(
      JSON.stringify({
        type: "SYSTEM",
        headers: { topic: "ping", messageId: "p1" },
        data: '{"opaque":"1"}',
      }),
    );
    expect(
      await waitFor(() =>
        socket.json().find((frame) => frame.headers?.messageId === "p1"),
      ),
    ).toMatchObject({ code: 200, data: '{"opaque":"1"}' });
    const data = {
      msgId: "M1",
      conversationType: "2",
      conversationId: "cid",
      senderStaffId: "staff",
      senderNick: "李四",
      msgtype: "text",
      text: { content: " 你好" },
      isInAtList: true,
      sessionWebhook:
        "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
    };
    socket.push(
      JSON.stringify({
        type: "CALLBACK",
        headers: { topic: "/v1.0/im/bot/messages/get", messageId: "cb1" },
        data: JSON.stringify(data),
      }),
    );
    const message = await waitFor(() => h.messages[0]);
    expect(message).toMatchObject({
      chatType: "group",
      chatId: "cid",
      userId: "staff",
      text: "你好",
      mentioned: true,
    });
    expect(
      socket.json().find((frame) => frame.headers?.messageId === "cb1"),
    ).toMatchObject({ code: 200 });
    await adapter.send({
      inbound: message,
      chunks: ["# 好的"],
      text: "# 好的",
    });
    expect(hooks[0]!.body).toMatchObject({
      msgtype: "markdown",
      markdown: { text: "# 好的" },
    });
    await adapter.stop();
  });
});

describe("Telegram", () => {
  test("群里 @ 才算叫到，回复引用原消息", async () => {
    expect(
      parseTelegramUpdate(
        {
          message: {
            message_id: 1,
            chat: { id: -5, type: "group" },
            from: { id: 9, first_name: "A" },
            text: "hi all",
          },
        },
        { id: 1, username: "cb_bot" },
      )!.mentioned,
    ).toBe(false);
    const sent: FetchCall[] = [];
    let served = false;
    const h = harness(
      {},
      { token: "123:abc" },
      {
        "/getMe": () => ({ ok: true, result: { id: 1, username: "cb_bot" } }),
        "/getUpdates": async () => {
          if (!served) {
            served = true;
            return {
              ok: true,
              result: [
                {
                  update_id: 10,
                  message: {
                    message_id: 7,
                    chat: { id: -5, type: "supergroup" },
                    from: { id: 9, first_name: "A" },
                    text: "@cb_bot 查天气",
                  },
                },
              ],
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: true, result: [] };
        },
        "/sendMessage": (call) => {
          sent.push(call);
          return { ok: true, result: {} };
        },
        "/sendChatAction": () => ({ ok: true, result: true }),
      },
    );
    const adapter = new TelegramAdapter(h.ctx);
    await adapter.start();
    const message = await waitFor(() => h.messages[0]);
    expect(message).toMatchObject({
      chatType: "group",
      chatId: "-5",
      text: "查天气",
      mentioned: true,
    });
    await adapter.send({ inbound: message, chunks: ["晴"], text: "晴" });
    expect(sent[0]!.body).toEqual({
      chat_id: "-5",
      text: "晴",
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
    });
    const nextPoll = await waitFor(
      () => h.calls.filter((call) => call.url.includes("/getUpdates"))[1],
    );
    expect(nextPoll.body.offset).toBe(11);
    await adapter.stop();
  });
});

describe("多平台扫码绑定与消息来源解析", () => {
  test("QQ 机器人扫码绑定：AES-256-GCM 解密 bot_encrypt_secret 并返回 appId + appSecret", async () => {
    const taskId = "qq-task-123";
    const plainSecret = "qq-secret-xyz";
    let capturedKey = "";

    const mockFetch: typeof fetch = (async (
      url: string,
      init?: RequestInit,
    ) => {
      if (url.includes("/create_bind_task")) {
        const reqBody = JSON.parse(String(init?.body ?? "{}"));
        capturedKey = reqBody.key;
        return new Response(
          JSON.stringify({ retcode: 0, data: { task_id: taskId } }),
          { status: 200 },
        );
      }
      const keyBuf = Buffer.from(capturedKey, "base64");
      const iv = Buffer.alloc(12, 7);
      const cipher = createCipheriv("aes-256-gcm", keyBuf, iv);
      const encrypted = Buffer.concat([
        cipher.update(plainSecret, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const payload = Buffer.concat([iv, encrypted, tag]).toString("base64");

      expect(decryptQqBotSecret(payload, capturedKey)).toBe(plainSecret);
      return new Response(
        JSON.stringify({
          retcode: 0,
          data: { status: 2, bot_appid: 102030, bot_encrypt_secret: payload },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const started = await startPlatformQr(
      { platform: "qq_official" },
      mockFetch,
    );
    expect(started.qrUrl).toContain("task_id=qq-task-123");
    const polled = await pollPlatformQr(
      "qq_official",
      started.state,
      mockFetch,
    );
    expect(polled).toEqual({
      status: "confirmed",
      config: { appId: "102030" },
      secrets: { appSecret: plainSecret },
      account: "AppID 102030",
    });
  });

  test("企业微信智能机器人 / 钉钉 / 飞书扫码绑定：轮询成功后返回对应凭据", async () => {
    const mockFetch: typeof fetch = (async (
      url: string,
      init?: RequestInit,
    ) => {
      if (url.includes("work.weixin.qq.com/ai/qc/generate")) {
        return new Response(
          JSON.stringify({
            data: {
              scode: "sc_1",
              auth_url: "https://work.weixin.qq.com/qr/1",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("work.weixin.qq.com/ai/qc/query_result")) {
        return new Response(
          JSON.stringify({
            data: {
              status: "success",
              bot_info: { botid: "ww_bot_1", secret: "ww_sec_1" },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("oapi.dingtalk.com/app/registration/init")) {
        return new Response(
          JSON.stringify({ errcode: 0, nonce: "dt_nonce_1" }),
          { status: 200 },
        );
      }
      if (url.includes("oapi.dingtalk.com/app/registration/begin")) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            device_code: "dt_dev_1",
            verification_uri_complete: "https://dingtalk.com/qr/1",
          }),
          { status: 200 },
        );
      }
      if (url.includes("oapi.dingtalk.com/app/registration/poll")) {
        return new Response(
          JSON.stringify({
            errcode: 0,
            status: "SUCCESS",
            client_id: "ding_id",
            client_secret: "ding_sec",
          }),
          { status: 200 },
        );
      }
      if (url.includes("accounts.feishu.cn/oauth/v1/app/registration")) {
        const body = String(init?.body ?? "");
        if (body.includes("action=init")) {
          return new Response(
            JSON.stringify({ supported_auth_methods: ["client_secret"] }),
            { status: 200 },
          );
        }
        if (body.includes("action=begin")) {
          return new Response(
            JSON.stringify({
              device_code: "fs_dev_1",
              verification_uri_complete: "https://feishu.cn/qr/1",
              interval: 1,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            client_id: "cli_fs_1",
            client_secret: "sec_fs_1",
            user_info: { open_id: "ou_owner" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const wecom = await startPlatformQr({ platform: "wecom_bot" }, mockFetch);
    expect(await pollPlatformQr("wecom_bot", wecom.state, mockFetch)).toEqual({
      status: "confirmed",
      config: { botId: "ww_bot_1" },
      secrets: { secret: "ww_sec_1" },
      account: "ww_bot_1",
    });

    const ding = await startPlatformQr({ platform: "dingtalk" }, mockFetch);
    expect(await pollPlatformQr("dingtalk", ding.state, mockFetch)).toEqual({
      status: "confirmed",
      config: { clientId: "ding_id" },
      secrets: { clientSecret: "ding_sec" },
      account: "ding_id",
    });

    const feishu = await startPlatformQr({ platform: "feishu" }, mockFetch);
    expect(await pollPlatformQr("feishu", feishu.state, mockFetch)).toEqual({
      status: "confirmed",
      config: { appId: "cli_fs_1", domain: "feishu" },
      secrets: { appSecret: "sec_fs_1" },
      account: "cli_fs_1",
    });
  });

  test("splitChatOrigin 识别 ChisaBot IM 消息前缀并提取干净正文", () => {
    const framed = frameInbound("QQ 机器人（官方）", {
      platform: "qq_official",
      chatType: "private",
      chatId: "u1",
      userId: "u1",
      userName: "小千",
      messageId: "m1",
      text: "帮我打开浏览器",
      mentioned: true,
      reply: {},
    });
    expect(splitChatOrigin(framed)).toEqual({
      via: "QQ 机器人（官方）",
      text: "帮我打开浏览器",
    });
  });
});
