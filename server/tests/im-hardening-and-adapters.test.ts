import { describe, expect, test } from "bun:test";
import { imPlatform } from "../../shared/im";
import { encryptSecret } from "../src/credentials";
import type { Database } from "../src/db/client";
import {
  DiscordAdapter,
  parseDiscordMessage,
  testDiscord,
} from "../src/im/adapters/discord";
import {
  parseSlackEvent,
  SlackAdapter,
  testSlack,
} from "../src/im/adapters/slack";
import type { ImOutboxRecord } from "../src/im/delivery";
import { createAdapter, testAdapter } from "../src/im/registry";
import { createImService, isOwnerImSender } from "../src/im/service";
import { type JsonRecord, parseJsonRecord } from "../src/im/text";
import type {
  AdapterContext,
  FetchLike,
  ImAdapterStatus,
  ImInbound,
  WsLike,
} from "../src/im/types";
import { isImWindowExpiredError } from "../src/im/window-expiry";
import type { TurnRunner } from "../src/turns/types";

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

  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason });
  }

  push(data: unknown) {
    this.onmessage?.({
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
  }

  json(): JsonRecord[] {
    return this.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => parseJsonRecord(item));
  }
}

type FetchCall = { url: string; init?: RequestInit; body: JsonRecord | null };

function createAdapterHarness(
  config: Record<string, string>,
  secrets: Record<string, string>,
  routes: Record<string, (call: FetchCall) => unknown | Promise<unknown>> = {},
) {
  const sockets: FakeWs[] = [];
  const messages: ImInbound[] = [];
  const statuses: ImAdapterStatus[] = [];
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    let body: JsonRecord | null = null;
    try {
      body = init?.body ? parseJsonRecord(String(init.body)) : null;
    } catch {}
    const call = { url, init, body };
    calls.push(call);
    const matched = Object.keys(routes).find((pattern) =>
      url.includes(pattern),
    );
    if (!matched) {
      return new Response(JSON.stringify({ error: "no route" }), {
        status: 404,
      });
    }
    const handler = routes[matched];
    if (!handler) {
      return new Response(JSON.stringify({ error: "no handler" }), {
        status: 500,
      });
    }
    const result = await handler(call);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const ctx: AdapterContext = {
    connectionId: "im_test_conn",
    config,
    secrets,
    log: (level, text) => logs.push(`${level}:${text}`),
    setStatus: (status) => statuses.push(status),
    onMessage: (message) => messages.push(message),
    fetch: fetchFn,
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
  ms = 3000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type MockChatRow = {
  connection_id: string;
  chat_key: string;
  thread_id: string;
  taken_over: boolean;
  taken_over_at: string | null;
  last_inbound: ImInbound | null;
};

function createStatefulMockImDb(initialConnection: {
  id: string;
  owner_user_id: string;
  platform: string;
  name: string;
  agent_id: string;
  enabled: boolean;
  config: Record<string, string>;
  secrets: string | null;
  allow_users: string[];
  owner_users: string[];
  allow_devices: boolean;
  allow_private: boolean;
}) {
  const row = {
    ...initialConnection,
    account: null as string | null,
    last_message_at: null as Date | null,
    last_error: null as string | null,
    created_at: new Date(),
  };
  const chats = new Map<string, MockChatRow>();
  const inbox = new Map<string, Record<string, unknown>>();
  const outbox = new Map<string, Record<string, unknown>>();
  const logs: string[] = [];

  const chatMapKey = (connectionId: string, key: string) =>
    `${connectionId}|${key}`;

  const unsafe = async (
    query: string,
    args: unknown[] = [],
  ): Promise<Record<string, unknown>[]> => {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (normalized.includes("pg_try_advisory_lock")) return [{ locked: true }];
    if (normalized.includes("pg_advisory_unlock")) return [];

    if (normalized.startsWith("SELECT * FROM chisabot_im_connections")) {
      return [{ ...row }];
    }
    if (normalized.startsWith("INSERT INTO chisabot_im_logs")) {
      logs.push(String(args[2] ?? ""));
      return [];
    }
    if (normalized.startsWith("SELECT taken_over FROM chisabot_im_chats")) {
      const hit = chats.get(chatMapKey(String(args[0]), String(args[1])));
      return hit ? [{ taken_over: hit.taken_over }] : [];
    }
    if (normalized.startsWith("SELECT thread_id FROM chisabot_im_chats")) {
      const hit = chats.get(chatMapKey(String(args[0]), String(args[1])));
      return hit ? [{ thread_id: hit.thread_id }] : [];
    }
    if (
      normalized.startsWith(
        "INSERT INTO chisabot_im_chats (connection_id, chat_key, thread_id, taken_over, taken_over_at)",
      )
    ) {
      const connId = String(args[0]);
      const key = String(args[1]);
      const threadId = String(args[2]);
      const takenOver = normalized.includes("VALUES ($1, $2, $3, true");
      const existing = chats.get(chatMapKey(connId, key));
      chats.set(chatMapKey(connId, key), {
        connection_id: connId,
        chat_key: key,
        thread_id: existing?.thread_id ?? threadId,
        taken_over: takenOver,
        taken_over_at: takenOver ? new Date().toISOString() : null,
        last_inbound: existing?.last_inbound ?? null,
      });
      return [];
    }
    if (
      normalized.startsWith(
        "INSERT INTO chisabot_im_chats (connection_id, chat_key, thread_id)",
      )
    ) {
      const connId = String(args[0]);
      const key = String(args[1]);
      const threadId = String(args[2]);
      const existing = chats.get(chatMapKey(connId, key));
      chats.set(chatMapKey(connId, key), {
        connection_id: connId,
        chat_key: key,
        thread_id: threadId,
        taken_over: existing?.taken_over ?? false,
        taken_over_at: existing?.taken_over_at ?? null,
        last_inbound: existing?.last_inbound ?? null,
      });
      return [];
    }
    if (normalized.startsWith("UPDATE chisabot_im_chats SET last_inbound")) {
      const connId = String(args[0]);
      const key = String(args[1]);
      const inbound = JSON.parse(String(args[2])) as ImInbound;
      const existing = chats.get(chatMapKey(connId, key));
      if (existing) existing.last_inbound = inbound;
      return [];
    }
    if (normalized.includes("SELECT connection_id,last_inbound FROM")) {
      const threadId = String(args[0]);
      const filterConn = args[1] ? String(args[1]) : null;
      const privateOnly = normalized.includes("chatType'='private'");
      for (const chat of chats.values()) {
        if (chat.thread_id !== threadId) continue;
        if (filterConn && chat.connection_id !== filterConn) continue;
        if (!chat.last_inbound) continue;
        if (privateOnly && chat.last_inbound.chatType !== "private") continue;
        return [
          {
            connection_id: chat.connection_id,
            last_inbound: chat.last_inbound,
          },
        ];
      }
      return [];
    }
    if (normalized.startsWith("SELECT * FROM chisabot_im_inbox WHERE id=$1")) {
      const rec = inbox.get(String(args[0]));
      return rec ? [rec] : [];
    }
    if (normalized.startsWith("INSERT INTO chisabot_im_inbox")) {
      const id = String(args[0]);
      if (!inbox.has(id)) {
        inbox.set(id, {
          id,
          connection_id: String(args[1]),
          owner_user_id: String(args[2]),
          agent_id: String(args[3]),
          thread_id: String(args[4]),
          inbound: JSON.parse(String(args[5])),
          state: "pending",
        });
      }
      return [];
    }
    if (normalized.startsWith("UPDATE chisabot_im_inbox SET state='staged'")) {
      const rec = inbox.get(String(args[0]));
      if (rec) rec.state = "staged";
      return [];
    }
    if (normalized.startsWith("SELECT * FROM chisabot_im_outbox WHERE id=$1")) {
      const rec = outbox.get(String(args[0]));
      return rec ? [{ ...rec }] : [];
    }
    if (normalized.startsWith("INSERT INTO chisabot_im_outbox")) {
      const id = String(args[0]);
      if (!outbox.has(id)) {
        outbox.set(id, {
          id,
          connection_id: String(args[1]),
          owner_user_id: String(args[2]),
          agent_id: String(args[3]),
          thread_id: String(args[4]),
          inbound: JSON.parse(String(args[5])),
          text: String(args[6]),
          chunks: JSON.parse(String(args[7])),
          files: JSON.parse(String(args[8] ?? "[]")),
          state: "queued",
          receipt: null,
          error: null,
          window_expired_at: null,
        });
      }
      return [];
    }
    if (
      normalized.startsWith(
        "UPDATE chisabot_im_outbox SET state='window_expired'",
      )
    ) {
      const rec = outbox.get(String(args[0]));
      if (rec) {
        rec.state = "window_expired";
        rec.receipt = null;
        rec.error = String(args[1] ?? "");
        rec.window_expired_at = new Date().toISOString();
        return [{ ...rec }];
      }
      return [];
    }
    if (normalized.startsWith("UPDATE chisabot_im_outbox SET state=")) {
      const rec = outbox.get(String(args[0]));
      if (rec) {
        rec.state = String(args[1]);
        rec.receipt = args[2] ? JSON.parse(String(args[2])) : null;
        rec.error = args[3] ? String(args[3]) : null;
      }
      return [];
    }
    return [];
  };

  const client = {
    unsafe,
    begin: async (run: (tx: typeof client) => Promise<unknown>) => run(client),
    reserve: async () => ({ unsafe, release: () => {} }),
  };

  return {
    database: { $client: client } as unknown as Database,
    row,
    chats,
    inbox,
    outbox,
    logs,
  };
}

const TEST_ENC_KEY = Buffer.alloc(32, 9).toString("base64");

describe("群聊 / 非号主严格隔离与 isOwnerImSender", () => {
  test("isOwnerImSender 严格区分私聊号主、外部成员与群聊", () => {
    const withConfigOwner = {
      config: { ownerUserId: "boss-cfg" },
      owner_users: ["boss-list"],
      allow_users: ["guest-1"],
    };
    expect(
      isOwnerImSender(withConfigOwner, {
        chatType: "private",
        userId: "boss-cfg",
      }),
    ).toBe(true);
    expect(
      isOwnerImSender(withConfigOwner, {
        chatType: "private",
        userId: "boss-list",
      }),
    ).toBe(false);
    expect(
      isOwnerImSender(withConfigOwner, {
        chatType: "group",
        userId: "boss-cfg",
      }),
    ).toBe(false);

    const withOwnerList = {
      config: {},
      owner_users: ["boss-1"],
      allow_users: ["ext-1"],
    };
    expect(
      isOwnerImSender(withOwnerList, {
        chatType: "private",
        userId: "boss-1",
      }),
    ).toBe(true);
    expect(
      isOwnerImSender(withOwnerList, {
        chatType: "private",
        userId: "ext-1",
      }),
    ).toBe(false);
    expect(
      isOwnerImSender(withOwnerList, {
        chatType: "group",
        userId: "boss-1",
      }),
    ).toBe(false);
    expect(isOwnerImSender(withOwnerList, null)).toBe(false);
  });

  test("群聊与非号主强制分配 im-grp-/im-ext- 隔离线程并携带 imUntrustedScope，号主私聊共享网页主对话", async () => {
    const db = createStatefulMockImDb({
      id: "im_iso12345",
      owner_user_id: "user-owner",
      platform: "discord",
      name: "Discord Bot",
      agent_id: "bot-main",
      enabled: true,
      config: { ownerUserId: "dc-boss", gatewayUrl: "wss://gw.discord.test" },
      secrets: await encryptSecret(
        TEST_ENC_KEY,
        JSON.stringify({ botToken: "dc-tok" }),
      ),
      allow_users: ["dc-guest"],
      owner_users: ["dc-boss"],
      allow_devices: true,
      allow_private: false,
    });

    const sockets: FakeWs[] = [];
    const resolveCalls: Array<{
      owner: string;
      agent: string;
      fresh?: boolean;
    }> = [];
    const turns: Parameters<TurnRunner>[0][] = [];
    let webThread = "web-main-1";

    const service = createImService({
      database: db.database,
      encryptionKey: TEST_ENC_KEY,
      botAvailable: async () => true,
      resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
      resolveBotConversation: async (owner, agent, fresh) => {
        resolveCalls.push({ owner, agent, fresh });
        if (fresh) webThread = "web-main-2";
        return webThread;
      },
      runTurn: async (input) => {
        turns.push(input);
        return { replyText: "收到" };
      },
      fetch: async (url) => {
        if (url.includes("/messages")) {
          return new Response(JSON.stringify({ id: "dc-reply-1" }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      },
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });

    await service.startAll();
    try {
      const socket = await waitFor(() => sockets[0]);
      await waitFor(() => socket.readyState === 1);
      socket.push({ op: 10, d: { heartbeat_interval: 60_000 } });
      await waitFor(() => socket.json().find((frame) => frame.op === 2));
      socket.push({
        op: 0,
        s: 1,
        t: "READY",
        d: { session_id: "s1", user: { id: "dc-bot", username: "Chisa" } },
      });
      await waitFor(
        () => service.statusOf("im_iso12345")?.state === "connected",
      );

      // 1) 群聊（即使发件人是号主本人）→ 强制隔离 im-grp-，不调 resolveBotConversation，带 imUntrustedScope
      socket.push({
        op: 0,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "m-grp-1",
          channel_id: "ch-99",
          guild_id: "g-1",
          content: "<@dc-bot> 群里问一下",
          author: { id: "dc-boss", username: "Boss" },
          mentions: [{ id: "dc-bot" }],
        },
      });
      await waitFor(() => turns.length === 1);
      expect(turns[0]?.threadId.startsWith("im-grp-")).toBe(true);
      expect(turns[0]?.forwardedProps).toMatchObject({
        imUntrustedScope: true,
        chatType: "group",
      });
      expect(resolveCalls).toHaveLength(0);

      // 2) 非号主白名单成员私聊 → 强制隔离 im-ext-，不调 resolveBotConversation，带 imUntrustedScope
      socket.push({
        op: 0,
        s: 3,
        t: "MESSAGE_CREATE",
        d: {
          id: "m-ext-1",
          channel_id: "dm-ext",
          content: "外部成员私聊",
          author: { id: "dc-guest", username: "Guest" },
        },
      });
      await waitFor(() => turns.length === 2);
      expect(turns[1]?.threadId.startsWith("im-ext-")).toBe(true);
      expect(turns[1]?.forwardedProps).toMatchObject({
        imUntrustedScope: true,
        chatType: "private",
      });
      expect(resolveCalls).toHaveLength(0);

      // 3) 号主本人私聊 → 复用 resolveBotConversation 共享网页主对话，不带 imUntrustedScope
      socket.push({
        op: 0,
        s: 4,
        t: "MESSAGE_CREATE",
        d: {
          id: "m-owner-1",
          channel_id: "dm-boss",
          content: "号主私聊",
          author: { id: "dc-boss", username: "Boss" },
        },
      });
      await waitFor(() => turns.length === 3);
      expect(turns[2]?.threadId).toBe("web-main-1");
      expect(turns[2]?.forwardedProps?.imUntrustedScope).toBeUndefined();
      expect(turns[2]?.forwardedProps?.chatType).toBe("private");
      expect(resolveCalls).toHaveLength(1);

      // 4) 号主发送 /new 换网页主对话，不覆盖群聊 / 外部隔离线程
      const grpThreadBefore = db.chats.get(
        "im_iso12345|group:ch-99",
      )?.thread_id;
      const extThreadBefore = db.chats.get(
        "im_iso12345|private:dc-guest",
      )?.thread_id;
      socket.push({
        op: 0,
        s: 5,
        t: "MESSAGE_CREATE",
        d: {
          id: "m-owner-new",
          channel_id: "dm-boss",
          content: "/new",
          author: { id: "dc-boss", username: "Boss" },
        },
      });
      await waitFor(() => webThread === "web-main-2");
      expect(db.chats.get("im_iso12345|group:ch-99")?.thread_id).toBe(
        grpThreadBefore,
      );
      expect(db.chats.get("im_iso12345|private:dc-guest")?.thread_id).toBe(
        extThreadBefore,
      );
    } finally {
      await service.stopAll();
    }
  });
});

describe("/takeover & /release 人工接管模式", () => {
  test("号主可开关人工接管拦截自动回复，非号主无权触发", async () => {
    const db = createStatefulMockImDb({
      id: "im_takeover1",
      owner_user_id: "owner-u",
      platform: "discord",
      name: "Takeover Bot",
      agent_id: "bot-1",
      enabled: true,
      config: { ownerUserId: "dc-owner", gatewayUrl: "wss://gw.discord.test" },
      secrets: await encryptSecret(
        TEST_ENC_KEY,
        JSON.stringify({ botToken: "dc-tok" }),
      ),
      allow_users: ["dc-guest"],
      owner_users: ["dc-owner"],
      allow_devices: false,
      allow_private: false,
    });

    const sockets: FakeWs[] = [];
    const sentMessages: Array<{ url: string; content: string }> = [];
    const turns: Parameters<TurnRunner>[0][] = [];

    const service = createImService({
      database: db.database,
      encryptionKey: TEST_ENC_KEY,
      botAvailable: async () => true,
      resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
      runTurn: async (input) => {
        turns.push(input);
        return { replyText: `AI:${input.instruction}` };
      },
      fetch: async (url, init) => {
        if (url.includes("/messages")) {
          const parsed = parseJsonRecord(String(init?.body ?? "{}"));
          sentMessages.push({ url, content: String(parsed.content ?? "") });
          return new Response(
            JSON.stringify({ id: `dc-${sentMessages.length}` }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      },
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });

    await service.startAll();
    try {
      const socket = await waitFor(() => sockets[0]);
      await waitFor(() => socket.readyState === 1);
      socket.push({ op: 10, d: { heartbeat_interval: 60_000 } });
      await waitFor(() => socket.json().find((frame) => frame.op === 2));
      socket.push({
        op: 0,
        s: 1,
        t: "READY",
        d: { session_id: "s1", user: { id: "dc-bot", username: "Chisa" } },
      });
      await waitFor(
        () => service.statusOf("im_takeover1")?.state === "connected",
      );

      // 非号主尝试 /takeover → 被拒绝，taken_over 保持 false，不触发回合
      socket.push({
        op: 0,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "t-1",
          channel_id: "dm-guest",
          content: "/takeover",
          author: { id: "dc-guest" },
        },
      });
      await waitFor(() =>
        sentMessages.some((msg) => msg.content.includes("只有连接号主")),
      );
      expect(
        db.chats.get("im_takeover1|private:dc-guest")?.taken_over ?? false,
      ).toBe(false);
      expect(turns).toHaveLength(0);

      // 非号主在群里尝试 /release → 同样被拒绝
      socket.push({
        op: 0,
        s: 3,
        t: "MESSAGE_CREATE",
        d: {
          id: "t-2",
          channel_id: "ch-group",
          guild_id: "g1",
          content: "<@dc-bot> /release",
          author: { id: "dc-guest" },
          mentions: [{ id: "dc-bot" }],
        },
      });
      await waitFor(
        () =>
          sentMessages.filter((msg) => msg.content.includes("只有连接号主"))
            .length === 2,
      );

      // 号主在群里发送 /接管 → 开启接管
      socket.push({
        op: 0,
        s: 4,
        t: "MESSAGE_CREATE",
        d: {
          id: "t-3",
          channel_id: "ch-group",
          guild_id: "g1",
          content: "<@dc-bot> /接管",
          author: { id: "dc-owner" },
          mentions: [{ id: "dc-bot" }],
        },
      });
      await waitFor(() =>
        sentMessages.some((msg) => msg.content.includes("已进入人工接管模式")),
      );
      expect(db.chats.get("im_takeover1|group:ch-group")?.taken_over).toBe(
        true,
      );

      // 接管期间群成员发消息 → 不触发 Bot 回合与自动回复
      socket.push({
        op: 0,
        s: 5,
        t: "MESSAGE_CREATE",
        d: {
          id: "t-4",
          channel_id: "ch-group",
          guild_id: "g1",
          content: "<@dc-bot> 客服在吗？",
          author: { id: "dc-guest" },
          mentions: [{ id: "dc-bot" }],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(turns).toHaveLength(0);

      // 号主发送 /release → 解除接管并回复确认
      socket.push({
        op: 0,
        s: 6,
        t: "MESSAGE_CREATE",
        d: {
          id: "t-5",
          channel_id: "ch-group",
          guild_id: "g1",
          content: "<@dc-bot> /release",
          author: { id: "dc-owner" },
          mentions: [{ id: "dc-bot" }],
        },
      });
      await waitFor(() =>
        sentMessages.some((msg) => msg.content.includes("已解除人工接管模式")),
      );
      expect(db.chats.get("im_takeover1|group:ch-group")?.taken_over).toBe(
        false,
      );

      // 解除后普通消息正常触发回合
      socket.push({
        op: 0,
        s: 7,
        t: "MESSAGE_CREATE",
        d: {
          id: "t-6",
          channel_id: "ch-group",
          guild_id: "g1",
          content: "<@dc-bot> 现在恢复了吗？",
          author: { id: "dc-guest" },
          mentions: [{ id: "dc-bot" }],
        },
      });
      await waitFor(() => turns.length === 1);
      expect(String(turns[0]?.instruction)).toContain("现在恢复了吗？");
    } finally {
      await service.stopAll();
    }
  });
});

describe("富媒体入站转写与多模态透传 + 窗口过期透传", () => {
  test("语音附件自动调用 transcribeVoice 并拼入用户消息正文，内联图片构造多模态 userMessage", async () => {
    const db = createStatefulMockImDb({
      id: "im_media1",
      owner_user_id: "owner-m",
      platform: "discord",
      name: "Media Bot",
      agent_id: "bot-1",
      enabled: true,
      config: { ownerUserId: "dc-owner", gatewayUrl: "wss://gw.discord.test" },
      secrets: await encryptSecret(
        TEST_ENC_KEY,
        JSON.stringify({ botToken: "dc-tok" }),
      ),
      allow_users: [],
      owner_users: ["dc-owner"],
      allow_devices: false,
      allow_private: false,
    });

    const sockets: FakeWs[] = [];
    const turns: Parameters<TurnRunner>[0][] = [];
    const transcribeCalls: Array<{ ownerUserId: string; url?: string }> = [];

    const service = createImService({
      database: db.database,
      encryptionKey: TEST_ENC_KEY,
      botAvailable: async () => true,
      resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
      transcribeVoice: async ({ ownerUserId, attachment }) => {
        transcribeCalls.push({ ownerUserId, url: attachment.url });
        return "帮我预订明天上午十点的会议室";
      },
      runTurn: async (input) => {
        turns.push(input);
        return { replyText: "好的" };
      },
      fetch: async () =>
        new Response(JSON.stringify({ id: "dc-msg-ok" }), { status: 200 }),
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });

    await service.startAll();
    try {
      const socket = await waitFor(() => sockets[0]);
      await waitFor(() => socket.readyState === 1);
      socket.push({ op: 10, d: { heartbeat_interval: 60_000 } });
      await waitFor(() => socket.json().find((frame) => frame.op === 2));
      socket.push({
        op: 0,
        s: 1,
        t: "READY",
        d: { session_id: "s1", user: { id: "dc-bot", username: "Chisa" } },
      });
      await waitFor(() => service.statusOf("im_media1")?.state === "connected");

      // 1) 纯语音附件入站
      socket.push({
        op: 0,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "voice-1",
          channel_id: "dm-owner",
          content: "",
          author: { id: "dc-owner" },
          attachments: [
            {
              id: "att-v1",
              filename: "voice-message.ogg",
              content_type: "audio/ogg",
              url: "https://cdn.discordapp.com/voice-message.ogg",
              duration_secs: 4.2,
            },
          ],
        },
      });
      await waitFor(() => turns.length === 1);
      expect(transcribeCalls).toEqual([
        {
          ownerUserId: "owner-m",
          url: "https://cdn.discordapp.com/voice-message.ogg",
        },
      ]);
      expect(turns[0]?.instruction).toContain("帮我预订明天上午十点的会议室");
      expect(String(turns[0]?.userMessage?.content)).toContain(
        "帮我预订明天上午十点的会议室",
      );

      // 2) 直接投递带内联图片 dataBase64 的入站消息 → 多模态 userMessage
      const adapter = service.adapterOf("im_media1");
      expect(adapter).not.toBeNull();
      const ctxAccess = adapter as unknown as {
        ctx: AdapterContext;
      };
      ctxAccess.ctx.onMessage({
        messageId: "img-inline-1",
        chatType: "private",
        chatId: "dc-owner",
        userId: "dc-owner",
        text: "看看这张图",
        mentioned: true,
        reply: { channelId: "dm-owner", messageId: "img-inline-1" },
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            fileName: "shot.png",
            textSummary: "系统设置页截图",
            dataBase64: "iVBORw0KGgo=",
          },
        ],
      });
      await waitFor(() => turns.length === 2);
      expect(turns[1]?.instruction).toContain("系统设置页截图");
      expect(Array.isArray(turns[1]?.userMessage?.content)).toBe(true);
      const parts = turns[1]?.userMessage?.content as Array<{
        type: string;
        text?: string;
        source?: { type: string; value: string; mimeType: string };
      }>;
      expect(parts[0]?.type).toBe("text");
      expect(parts[1]).toEqual({
        type: "image",
        source: {
          type: "data",
          value: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      });
    } finally {
      await service.stopAll();
    }
  });

  test("pushToThread 遇到平台窗口过期抛出 ImWindowExpiredError 时返回 window_expired 而不抛错且触发 onWindowExpired", async () => {
    const db = createStatefulMockImDb({
      id: "im_winexp1",
      owner_user_id: "owner-w",
      platform: "discord",
      name: "Window Expiry Bot",
      agent_id: "bot-1",
      enabled: true,
      config: { ownerUserId: "dc-owner", gatewayUrl: "wss://gw.discord.test" },
      secrets: await encryptSecret(
        TEST_ENC_KEY,
        JSON.stringify({ botToken: "dc-tok" }),
      ),
      allow_users: [],
      owner_users: ["dc-owner"],
      allow_devices: false,
      allow_private: false,
    });

    const expiredEvents: Array<{ record: ImOutboxRecord; reason: string }> = [];
    const sockets: FakeWs[] = [];

    const service = createImService({
      database: db.database,
      encryptionKey: TEST_ENC_KEY,
      botAvailable: async () => true,
      resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
      onWindowExpired: async (record, reason) => {
        expiredEvents.push({ record, reason });
      },
      runTurn: async () => ({ replyText: "ok" }),
      fetch: async (url) => {
        if (url.includes("/messages")) {
          return new Response(
            JSON.stringify({
              code: 50007,
              message: "Cannot send messages to this user",
            }),
            { status: 403 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      },
      ws: (url) => {
        const socket = new FakeWs(url);
        sockets.push(socket);
        return socket;
      },
    });

    await service.startAll();
    try {
      const socket = await waitFor(() => sockets[0]);
      await waitFor(() => socket.readyState === 1);
      socket.push({ op: 10, d: { heartbeat_interval: 60_000 } });
      await waitFor(() => socket.json().find((frame) => frame.op === 2));
      socket.push({
        op: 0,
        s: 1,
        t: "READY",
        d: { session_id: "s1", user: { id: "dc-bot", username: "Chisa" } },
      });
      await waitFor(
        () => service.statusOf("im_winexp1")?.state === "connected",
      );

      db.chats.set("im_winexp1|private:dc-owner", {
        connection_id: "im_winexp1",
        chat_key: "private:dc-owner",
        thread_id: "thread-win-1",
        taken_over: false,
        taken_over_at: null,
        last_inbound: {
          messageId: "m-last",
          chatType: "private",
          chatId: "dc-owner",
          userId: "dc-owner",
          text: "hi",
          mentioned: true,
          reply: { channelId: "dm-closed", messageId: "m-last" },
        },
      });

      const outcome = await service.pushToThread(
        "thread-win-1",
        "定时提醒：窗口可能已关闭",
        { deliveryId: "sched-win-1" },
      );
      expect(outcome).toEqual({
        status: "window_expired",
        windowExpired: true,
      });
      expect(expiredEvents).toHaveLength(1);
      expect(expiredEvents[0]?.record.state).toBe("window_expired");
      expect(expiredEvents[0]?.reason).toContain("50007");

      // 幂等重入同一 deliveryId：直接返回 window_expired，不重复触发回调也不抛错
      const replay = await service.pushToThread(
        "thread-win-1",
        "定时提醒：窗口可能已关闭",
        { deliveryId: "sched-win-1" },
      );
      expect(replay).toEqual({
        status: "window_expired",
        windowExpired: true,
      });
      expect(expiredEvents).toHaveLength(1);
    } finally {
      await service.stopAll();
    }
  });
});

describe("Discord Gateway 原生适配器", () => {
  test("shared/im 与 registry 已正确登记 discord", () => {
    expect(imPlatform("discord")?.id).toBe("discord");
    const h = createAdapterHarness({}, { botToken: "tok" });
    expect(createAdapter("discord", h.ctx)).toBeInstanceOf(DiscordAdapter);
  });

  test("parseDiscordMessage 过滤 bot/自身消息，处理频道 @ 与回复提及以及附件", () => {
    expect(
      parseDiscordMessage(
        {
          id: "1",
          channel_id: "c1",
          content: "hi",
          author: { id: "b1", bot: true },
        },
        "bot-self",
      ),
    ).toBeNull();
    expect(
      parseDiscordMessage(
        {
          id: "2",
          channel_id: "c1",
          content: "self",
          author: { id: "bot-self" },
        },
        "bot-self",
      ),
    ).toBeNull();

    const nonMention = parseDiscordMessage(
      {
        id: "3",
        channel_id: "c1",
        guild_id: "g1",
        content: "路过聊天",
        author: { id: "u1", username: "Alice" },
      },
      "bot-self",
    );
    expect(nonMention?.mentioned).toBe(false);

    const mentioned = parseDiscordMessage(
      {
        id: "4",
        channel_id: "c1",
        guild_id: "g1",
        content: "<@!bot-self> 帮我看图",
        author: { id: "u1", username: "Alice" },
        mentions: [{ id: "bot-self" }],
        attachments: [
          {
            filename: "err.png",
            content_type: "image/png",
            url: "https://cdn.discord.test/err.png",
          },
          {
            filename: "voice.ogg",
            content_type: "audio/ogg",
            url: "https://cdn.discord.test/voice.ogg",
            duration_secs: 3,
          },
        ],
      },
      "bot-self",
    );
    expect(mentioned).toMatchObject({
      chatType: "group",
      chatId: "c1",
      userId: "u1",
      userName: "Alice",
      text: "帮我看图",
      mentioned: true,
    });
    expect(mentioned?.attachments).toEqual([
      {
        kind: "image",
        url: "https://cdn.discord.test/err.png",
        mimeType: "image/png",
        fileName: "err.png",
      },
      {
        kind: "voice",
        url: "https://cdn.discord.test/voice.ogg",
        mimeType: "audio/ogg",
        fileName: "voice.ogg",
        durationMs: 3000,
      },
    ]);
  });

  test("HELLO → IDENTIFY → 心跳 → READY → MESSAGE_CREATE → REST 发送与 50007 窗口过期 + testDiscord", async () => {
    const sentRest: FetchCall[] = [];
    let rejectWith50007 = false;
    const h = createAdapterHarness(
      {},
      { botToken: "dc-secret-tok" },
      {
        "/gateway/bot": () => ({ url: "wss://gateway.discord.test" }),
        "/users/@me": (call) => {
          const auth = (call.init?.headers as Record<string, string>)
            ?.Authorization;
          if (auth !== "Bot dc-secret-tok") {
            return new Response(
              JSON.stringify({ message: "401: Unauthorized" }),
              {
                status: 401,
              },
            );
          }
          return { id: "dc-bot-1", username: "ChisaDiscord" };
        },
        "/messages": (call) => {
          sentRest.push(call);
          if (rejectWith50007) {
            return new Response(
              JSON.stringify({
                code: 50007,
                message: "Cannot send messages to this user",
              }),
              { status: 403 },
            );
          }
          return { id: `sent-${sentRest.length}` };
        },
      },
    );

    const testOk = await testAdapter("discord", h.ctx);
    expect(testOk.ok).toBe(true);
    expect(testOk.detail).toContain("ChisaDiscord");

    const badHarness = createAdapterHarness(
      {},
      { botToken: "wrong-tok" },
      {
        "/users/@me": () =>
          new Response(JSON.stringify({ message: "Unauthorized" }), {
            status: 401,
          }),
      },
    );
    const testBad = await testDiscord(badHarness.ctx);
    expect(testBad.ok).toBe(false);

    const adapter = new DiscordAdapter(h.ctx);
    await adapter.start();
    try {
      const socket = await waitFor(() => h.sockets[0]);
      expect(socket.url).toBe("wss://gateway.discord.test/?v=10&encoding=json");
      await waitFor(() => socket.readyState === 1);

      socket.push({ op: 10, d: { heartbeat_interval: 25 } });
      const identify = await waitFor(() =>
        socket.json().find((frame) => frame.op === 2),
      );
      expect(identify.d).toMatchObject({
        token: "dc-secret-tok",
        intents: 37377,
      });
      await waitFor(() => socket.json().some((frame) => frame.op === 1));

      socket.push({
        op: 0,
        s: 1,
        t: "READY",
        d: {
          session_id: "sess-1",
          user: { id: "dc-bot-1", username: "ChisaDiscord" },
        },
      });
      await waitFor(() =>
        h.statuses.some(
          (status) =>
            status.state === "connected" &&
            status.account?.includes("ChisaDiscord"),
        ),
      );

      socket.push({
        op: 0,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "msg-dc-1",
          channel_id: "ch-100",
          guild_id: "guild-1",
          content: "<@dc-bot-1> 你好 Discord",
          author: { id: "u-9", username: "Bob" },
          mentions: [{ id: "dc-bot-1" }],
        },
      });
      const inbound = await waitFor(() => h.messages[0]);
      expect(inbound).toMatchObject({
        chatType: "group",
        chatId: "ch-100",
        userId: "u-9",
        text: "你好 Discord",
        mentioned: true,
      });

      const receipt = await adapter.send({
        inbound,
        chunks: ["第一段回复", "第二段回复"],
        text: "第一段回复\n第二段回复",
      });
      expect(receipt).toEqual({ messageIds: ["sent-1", "sent-2"] });
      expect(sentRest[0]?.body).toEqual({
        content: "第一段回复",
        message_reference: {
          message_id: "msg-dc-1",
          fail_if_not_exists: false,
        },
      });
      expect(sentRest[1]?.body).toEqual({ content: "第二段回复" });

      rejectWith50007 = true;
      let caught: unknown;
      try {
        await adapter.send({ inbound, chunks: ["测试过期"], text: "测试过期" });
      } catch (err) {
        caught = err;
      }
      expect(isImWindowExpiredError(caught)).toBe(true);
    } finally {
      await adapter.stop();
    }
  });
});

describe("Slack Socket Mode 原生适配器", () => {
  test("shared/im 与 registry 已正确登记 slack", () => {
    expect(imPlatform("slack")?.id).toBe("slack");
    const h = createAdapterHarness(
      {},
      { botToken: "xoxb-1", appToken: "xapp-1" },
    );
    expect(createAdapter("slack", h.ctx)).toBeInstanceOf(SlackAdapter);
  });

  test("parseSlackEvent 防自循环，识别 DM、频道 app_mention 与 files 附件", () => {
    expect(
      parseSlackEvent(
        {
          type: "message",
          channel: "C1",
          user: "U1",
          bot_id: "B1",
          text: "bot loop",
          ts: "1.1",
        },
        "U_BOT",
        "B_BOT",
      ),
    ).toBeNull();
    expect(
      parseSlackEvent(
        {
          type: "message",
          subtype: "bot_message",
          channel: "C1",
          user: "U1",
          text: "bot subtype",
          ts: "1.2",
        },
        "U_BOT",
      ),
    ).toBeNull();

    const dm = parseSlackEvent(
      {
        type: "message",
        channel: "D123",
        channel_type: "im",
        user: "U_USER",
        text: "私聊消息",
        ts: "1700.10",
      },
      "U_BOT",
    );
    expect(dm).toMatchObject({
      chatType: "private",
      chatId: "U_USER",
      userId: "U_USER",
      text: "私聊消息",
      mentioned: true,
      reply: { channel: "D123", ts: "1700.10" },
    });

    const mention = parseSlackEvent(
      {
        type: "app_mention",
        channel: "C999",
        user: "U_USER",
        text: "<@U_BOT> 帮我看日志",
        ts: "1700.20",
        files: [
          {
            name: "app.log",
            mimetype: "text/plain",
            filetype: "text",
            url_private: "https://files.slack.com/app.log",
          },
          {
            name: "screen.png",
            mimetype: "image/png",
            filetype: "png",
            url_private_download: "https://files.slack.com/screen.png",
          },
        ],
      },
      "U_BOT",
    );
    expect(mention).toMatchObject({
      messageId: "C999:1700.20",
      chatType: "group",
      chatId: "C999",
      text: "帮我看日志",
      mentioned: true,
      reply: { channel: "C999", threadTs: "1700.20", ts: "1700.20" },
      attachments: [
        {
          kind: "file",
          fileName: "app.log",
          mimeType: "text/plain",
          url: "https://files.slack.com/app.log",
        },
        {
          kind: "image",
          fileName: "screen.png",
          mimeType: "image/png",
          url: "https://files.slack.com/screen.png",
        },
      ],
    });
  });

  test("auth.test → apps.connections.open → envelope_id ACK → app_mention → chat.postMessage 与窗口过期错误 + testSlack", async () => {
    const posted: FetchCall[] = [];
    let slackError: string | null = null;
    const h = createAdapterHarness(
      {},
      { botToken: "xoxb-ok", appToken: "xapp-ok" },
      {
        "/auth.test": (call) => {
          const auth = (call.init?.headers as Record<string, string>)
            ?.Authorization;
          if (auth !== "Bearer xoxb-ok") {
            return { ok: false, error: "invalid_auth" };
          }
          return { ok: true, user_id: "U_BOT", bot_id: "B_BOT", user: "chisa" };
        },
        "/apps.connections.open": (call) => {
          const auth = (call.init?.headers as Record<string, string>)
            ?.Authorization;
          if (auth !== "Bearer xapp-ok") {
            return { ok: false, error: "invalid_auth" };
          }
          return {
            ok: true,
            url: "wss://wss-primary.slack.com/link/?ticket=1",
          };
        },
        "/chat.postMessage": (call) => {
          posted.push(call);
          if (slackError) {
            return { ok: false, error: slackError };
          }
          return { ok: true, ts: `1700.${posted.length}` };
        },
      },
    );

    const testOk = await testAdapter("slack", h.ctx);
    expect(testOk.ok).toBe(true);
    expect(testOk.detail).toContain("chisa");

    const badCtx = createAdapterHarness(
      {},
      { botToken: "xoxb-bad", appToken: "xapp-ok" },
      { "/auth.test": () => ({ ok: false, error: "invalid_auth" }) },
    ).ctx;
    expect((await testSlack(badCtx)).ok).toBe(false);

    const adapter = new SlackAdapter(h.ctx);
    await adapter.start();
    try {
      const socket = await waitFor(() => h.sockets[0]);
      expect(socket.url).toBe("wss://wss-primary.slack.com/link/?ticket=1");
      await waitFor(() =>
        h.statuses.some((status) => status.state === "connected"),
      );

      socket.push({ type: "hello", num_connections: 1 });
      socket.push({
        envelope_id: "env-42",
        type: "events_api",
        payload: {
          event: {
            type: "app_mention",
            channel: "C555",
            user: "U_ALICE",
            text: "<@U_BOT> 整理周报",
            ts: "1700.99",
          },
        },
      });
      // 同一条消息并发来的 message 事件应通过 messageId 去重
      socket.push({
        envelope_id: "env-43",
        type: "events_api",
        payload: {
          event: {
            type: "message",
            channel: "C555",
            channel_type: "channel",
            user: "U_ALICE",
            text: "<@U_BOT> 整理周报",
            ts: "1700.99",
          },
        },
      });

      const acks = await waitFor(() => {
        const list = socket.json().filter((frame) => frame.envelope_id);
        return list.length >= 2 ? list : null;
      });
      expect(acks.map((item) => item.envelope_id)).toEqual([
        "env-42",
        "env-43",
      ]);

      const inbound = await waitFor(() => h.messages[0]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.messages).toHaveLength(1);
      expect(inbound.text).toBe("整理周报");

      const receipt = await adapter.send({
        inbound,
        chunks: ["周报已生成"],
        text: "周报已生成",
      });
      expect(receipt).toEqual({ messageIds: ["1700.1"] });
      expect(posted[0]?.body).toEqual({
        channel: "C555",
        text: "周报已生成",
        thread_ts: "1700.99",
      });

      for (const code of ["channel_is_archived", "cannot_dm_bot"]) {
        slackError = code;
        let caught: unknown;
        try {
          await adapter.send({ inbound, chunks: ["fail"], text: "fail" });
        } catch (err) {
          caught = err;
        }
        expect(isImWindowExpiredError(caught)).toBe(true);
      }
    } finally {
      await adapter.stop();
    }
  });
});
