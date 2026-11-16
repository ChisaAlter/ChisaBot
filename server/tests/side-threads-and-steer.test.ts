import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createBotThreads } from "../src/bot-threads";
import {
  buildSideContextDigest,
  buildSteerInboxPayload,
  createSideThreadRoutes,
  createSideThreadStore,
  SideThreadNotFoundError,
  SideThreadValidationError,
} from "../src/conversations/side-threads";
import type { Database } from "../src/db/client";
import { INBOX_TEXT_LIMIT } from "../src/thread-inbox";

type FakeThreadRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  name: string | null;
  messages: unknown[];
  state: Record<string, unknown>;
  thread_kind: string;
  parent_thread_id: string | null;
  anchor_message_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function createFakeSideDatabase(initialRows: FakeThreadRow[] = []) {
  const rows = new Map<string, FakeThreadRow>(
    initialRows.map((row) => [row.id, structuredClone(row)]),
  );
  const queries: string[] = [];
  const botThreadWrites: string[] = [];

  const unsafe = async (query: string, params: unknown[] = []) => {
    const q = query.replace(/\s+/g, " ").trim();
    queries.push(q);

    if (q.startsWith("CREATE TABLE")) return [];

    if (q.startsWith("SELECT id, name, jsonb_array_length(messages)")) {
      const ownerUserId = String(params[0]);
      const agentId = String(params[1]);
      return [...rows.values()]
        .filter(
          (row) =>
            row.owner_user_id === ownerUserId &&
            row.agent_id === agentId &&
            !row.id.startsWith("worker-") &&
            !row.id.startsWith("im-") &&
            (row.thread_kind ?? "primary") === "primary" &&
            row.messages.length > 0,
        )
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .map((row) => {
          const firstUser = row.messages.find(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as { role?: unknown }).role === "user",
          ) as { content?: unknown } | undefined;
          return {
            id: row.id,
            name: row.name,
            count: row.messages.length,
            updated_at: row.updated_at,
            first: firstUser?.content ?? null,
          };
        });
    }

    if (q.startsWith("INSERT INTO chisabot_bot_threads")) {
      botThreadWrites.push(q);
      return [];
    }

    if (
      q.startsWith(
        "SELECT id, owner_user_id, agent_id, name, messages, state",
      ) &&
      q.includes(
        "WHERE id = $1 AND owner_user_id = $2 AND thread_kind = 'side'",
      )
    ) {
      const id = String(params[0]);
      const owner = String(params[1]);
      const row = rows.get(id);
      if (!row || row.owner_user_id !== owner || row.thread_kind !== "side") {
        return [];
      }
      return [structuredClone(row)];
    }

    if (
      q.startsWith(
        "SELECT id, owner_user_id, agent_id, name, messages, state",
      ) &&
      q.includes("WHERE id = $1")
    ) {
      const row = rows.get(String(params[0]));
      return row ? [structuredClone(row)] : [];
    }

    if (
      q.startsWith(
        "SELECT id, owner_user_id, agent_id, name, messages, state",
      ) &&
      q.includes(
        "WHERE owner_user_id = $1 AND thread_kind = 'side' AND parent_thread_id = $2",
      )
    ) {
      const owner = String(params[0]);
      const parentId = String(params[1]);
      return [...rows.values()]
        .filter(
          (row) =>
            row.owner_user_id === owner &&
            row.thread_kind === "side" &&
            row.parent_thread_id === parentId,
        )
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .map((row) => structuredClone(row));
    }

    if (q.startsWith("INSERT INTO chisabot_local_threads")) {
      const now = new Date();
      const row: FakeThreadRow = {
        id: String(params[0]),
        owner_user_id: String(params[1]),
        agent_id: String(params[2]),
        name: params[3] === null ? null : String(params[3]),
        messages: JSON.parse(String(params[4])) as unknown[],
        state: JSON.parse(String(params[5])) as Record<string, unknown>,
        thread_kind: "side",
        parent_thread_id: String(params[6]),
        anchor_message_id:
          params[7] === null || params[7] === undefined
            ? null
            : String(params[7]),
        created_at: now,
        updated_at: now,
      };
      rows.set(row.id, row);
      return [structuredClone(row)];
    }

    if (q.startsWith("UPDATE chisabot_local_threads SET name = COALESCE")) {
      const id = String(params[0]);
      const owner = String(params[1]);
      const autoTitle = params[2] === null ? null : String(params[2]);
      const nextMessages = JSON.parse(String(params[3])) as unknown[];
      const row = rows.get(id);
      if (!row || row.owner_user_id !== owner || row.thread_kind !== "side") {
        return [];
      }
      row.name = row.name ?? autoTitle;
      row.messages = nextMessages;
      row.updated_at = new Date(Date.now() + 10);
      return [structuredClone(row)];
    }

    if (q.startsWith("DELETE FROM chisabot_local_threads")) {
      const id = String(params[0]);
      const owner = String(params[1]);
      const row = rows.get(id);
      if (!row || row.owner_user_id !== owner || row.thread_kind !== "side") {
        return [];
      }
      rows.delete(id);
      return [{ id }];
    }

    throw new Error(`unexpected fake SQL: ${q}`);
  };

  return {
    database: { $client: { unsafe } } as unknown as Database,
    rows,
    queries,
    botThreadWrites,
  };
}

const asUser =
  (id: string): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (c, next) => {
    c.set("actor", {
      id,
      email: `${id}@example.com`,
      role: "member",
    } as AppVariables["actor"]);
    await next();
  };

describe("buildSideContextDigest", () => {
  test("read-only extraction skips base64 payloads, internal objects, and obeys anchorMessageId + maxMessages", () => {
    const hugeBase64 = "A".repeat(260);
    const messages = [
      Object.freeze({
        id: "m1",
        role: "user",
        content: "第一步先看架构",
        metadata: { secretInternal: "should-not-leak" },
      }),
      Object.freeze({
        id: "m2",
        role: "tool",
        content: '{"rawToolOutput":"internal"}',
      }),
      Object.freeze({
        id: "m3",
        role: "assistant",
        content: [
          {
            type: "text",
            text: `请看截图 data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA 以及 ${hugeBase64}`,
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,BBB" },
          },
          { type: "binary", data: "CCC" },
        ],
        toolCalls: [{ id: "tc1", function: { name: "bash", arguments: "{}" } }],
      }),
      Object.freeze({
        id: "m4",
        role: "user",
        content: "锚点后面的新消息",
      }),
    ];
    Object.freeze(messages);

    const digestAnchored = buildSideContextDigest(messages, "m3", 2);
    expect(digestAnchored).toContain("用户: 第一步先看架构");
    expect(digestAnchored).toContain(
      "[锚点] 助手: 请看截图 [已省略 base64 数据] 以及 [已省略编码数据]",
    );
    expect(digestAnchored).not.toContain("should-not-leak");
    expect(digestAnchored).not.toContain("rawToolOutput");
    expect(digestAnchored).not.toContain("iVBORw0KGgo");
    expect(digestAnchored).not.toContain(hugeBase64);
    expect(digestAnchored).not.toContain("锚点后面的新消息");

    const digestLatestOne = buildSideContextDigest(messages, undefined, 1);
    expect(digestLatestOne).toBe("用户: 锚点后面的新消息");
  });
});

describe("sideThreadStore & isolation", () => {
  const baseTime = new Date("2026-11-16T01:00:00.000Z");

  test("creates side thread with parent digest, runs multi-turn side Q&A without mutating parent or bot_threads", async () => {
    const parentMessages = [
      { id: "p1", role: "user", content: "请帮我检查部署脚本" },
      { id: "p2", role: "assistant", content: "我看到脚本里缺少回滚步骤。" },
    ];
    const fake = createFakeSideDatabase([
      {
        id: "thread-main-1",
        owner_user_id: "u1",
        agent_id: "bot-a",
        name: "主对话",
        messages: parentMessages,
        state: { mode: "primary" },
        thread_kind: "primary",
        parent_thread_id: null,
        anchor_message_id: null,
        created_at: baseTime,
        updated_at: baseTime,
      },
    ]);

    const seenInstructions: string[] = [];
    const store = createSideThreadStore(fake.database, {
      askSideQuestion: async (input) => {
        seenInstructions.push(input.instruction);
        return `旁白解答(${input.history.length / 2 + 1}): ${input.question}`;
      },
    });

    const created = await store.create({
      ownerUserId: "u1",
      parentThreadId: "thread-main-1",
      anchorMessageId: "p2",
    });

    expect(created.id.startsWith("side_")).toBe(true);
    expect(created.parentThreadId).toBe("thread-main-1");
    expect(created.anchorMessageId).toBe("p2");
    expect(created.messages).toEqual([]);
    expect(created.contextDigest).toContain(
      "[锚点] 助手: 我看到脚本里缺少回滚步骤。",
    );

    const turn1 = await store.ask("u1", created.id, "为什么要回滚？");
    expect(turn1.reply?.content).toBe("旁白解答(1): 为什么要回滚？");
    expect(turn1.thread.messages).toHaveLength(2);

    const turn2 = await store.ask("u1", created.id, "怎么加最稳？");
    expect(turn2.reply?.content).toBe("旁白解答(2): 怎么加最稳？");
    expect(turn2.thread.messages).toHaveLength(4);
    expect(seenInstructions[1]).toContain("【主对话只读背景摘要】");
    expect(seenInstructions[1]).toContain("【本侧边问答历史】");
    expect(seenInstructions[1]).toContain("为什么要回滚？");

    const parentRow = fake.rows.get("thread-main-1");
    expect(parentRow?.messages).toEqual(parentMessages);
    expect(parentRow?.state).toEqual({ mode: "primary" });
    expect(fake.botThreadWrites).toEqual([]);
    expect(
      fake.queries.some((q) => q.startsWith("UPDATE chisabot_local_threads")),
    ).toBe(true);
  });

  test("forbids cross-user access, primary thread access via side API, and nesting side inside side", async () => {
    const fake = createFakeSideDatabase([
      {
        id: "thread-u1",
        owner_user_id: "u1",
        agent_id: "bot-a",
        name: null,
        messages: [{ id: "m1", role: "user", content: "hello" }],
        state: {},
        thread_kind: "primary",
        parent_thread_id: null,
        anchor_message_id: null,
        created_at: baseTime,
        updated_at: baseTime,
      },
      {
        id: "thread-u2",
        owner_user_id: "u2",
        agent_id: "bot-a",
        name: null,
        messages: [{ id: "m2", role: "user", content: "secret" }],
        state: {},
        thread_kind: "primary",
        parent_thread_id: null,
        anchor_message_id: null,
        created_at: baseTime,
        updated_at: baseTime,
      },
    ]);

    const store = createSideThreadStore(fake.database);

    await expect(
      store.create({ ownerUserId: "u1", parentThreadId: "thread-u2" }),
    ).rejects.toBeInstanceOf(SideThreadNotFoundError);

    const side = await store.create({
      ownerUserId: "u1",
      parentThreadId: "thread-u1",
    });

    await expect(
      store.create({ ownerUserId: "u1", parentThreadId: side.id }),
    ).rejects.toBeInstanceOf(SideThreadValidationError);

    await expect(store.get("u2", side.id)).rejects.toBeInstanceOf(
      SideThreadNotFoundError,
    );
    await expect(store.get("u1", "thread-u1")).rejects.toBeInstanceOf(
      SideThreadNotFoundError,
    );
    await expect(store.remove("u2", side.id)).rejects.toBeInstanceOf(
      SideThreadNotFoundError,
    );
    await expect(store.remove("u1", "thread-u1")).rejects.toBeInstanceOf(
      SideThreadNotFoundError,
    );

    expect(await store.list("u2", "thread-u1")).toEqual([]);
    expect((await store.list("u1", "thread-u1")).map((t) => t.id)).toEqual([
      side.id,
    ]);
  });
});

describe("bot-threads history exclusion", () => {
  test("history() SQL filters on thread_kind and excludes side threads from primary history", async () => {
    const t1 = new Date("2026-11-16T01:00:00.000Z");
    const t2 = new Date("2026-11-16T02:00:00.000Z");
    const fake = createFakeSideDatabase([
      {
        id: "primary-1",
        owner_user_id: "u1",
        agent_id: "bot-a",
        name: "主对话",
        messages: [
          { role: "user", content: "帮我总结今天进度" },
          { role: "assistant", content: "好的" },
        ],
        state: {},
        thread_kind: "primary",
        parent_thread_id: null,
        anchor_message_id: null,
        created_at: t1,
        updated_at: t1,
      },
      {
        id: "side_abc",
        owner_user_id: "u1",
        agent_id: "bot-a",
        name: "旁白问题",
        messages: [
          { role: "user", content: "这个术语是什么意思" },
          { role: "assistant", content: "解释如下" },
        ],
        state: {},
        thread_kind: "side",
        parent_thread_id: "primary-1",
        anchor_message_id: null,
        created_at: t2,
        updated_at: t2,
      },
    ]);

    const botThreads = await createBotThreads(fake.database);
    const items = await botThreads.history("u1", "bot-a");
    expect(items.map((item) => item.threadId)).toEqual(["primary-1"]);
    const historyQuery = fake.queries.find((q) =>
      q.startsWith("SELECT id, name, jsonb_array_length(messages)"),
    );
    expect(historyQuery).toContain(
      "COALESCE(thread_kind, 'primary') = 'primary'",
    );
  });
});

describe("buildSteerInboxPayload & HTTP side-thread routes", () => {
  test("buildSteerInboxPayload validates id and text bounds", () => {
    expect(buildSteerInboxPayload(" msg-1 ", "  先看日志再改代码  ")).toEqual({
      id: "msg-1",
      text: "先看日志再改代码",
    });
    expect(() => buildSteerInboxPayload("  ", "hello")).toThrow(
      SideThreadValidationError,
    );
    expect(() => buildSteerInboxPayload("msg-1", "   ")).toThrow(
      SideThreadValidationError,
    );
    expect(() =>
      buildSteerInboxPayload("msg-1", "x".repeat(INBOX_TEXT_LIMIT + 1)),
    ).toThrow(SideThreadValidationError);
  });

  test("HTTP routes enforce validation (400), ownership (404), and side-thread CRUD + steer (200/201)", async () => {
    const now = new Date("2026-11-16T03:00:00.000Z");
    const fake = createFakeSideDatabase([
      {
        id: "main-1",
        owner_user_id: "u1",
        agent_id: "bot-a",
        name: null,
        messages: [{ id: "m1", role: "user", content: "讨论方案 A" }],
        state: {},
        thread_kind: "primary",
        parent_thread_id: null,
        anchor_message_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: "main-u2",
        owner_user_id: "u2",
        agent_id: "bot-a",
        name: null,
        messages: [{ id: "m2", role: "user", content: "u2 private" }],
        state: {},
        thread_kind: "primary",
        parent_thread_id: null,
        anchor_message_id: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    const steered: { parentThreadId: string; id: string; text: string }[] = [];
    const store = createSideThreadStore(fake.database, {
      runTurn: async ({ instruction }) => ({
        replyText: `模型回答（含摘要=${instruction.includes("讨论方案 A")}）`,
      }),
    });

    const u1App = createSideThreadRoutes(store, asUser("u1"), {
      steerParentThread: async (input) => {
        steered.push({
          parentThreadId: input.parentThreadId,
          id: input.id,
          text: input.text,
        });
        return { queued: true, status: "queued" };
      },
    });
    const u2App = createSideThreadRoutes(store, asUser("u2"));

    expect((await u1App.request("/?parentThreadId=bad%20id")).status).toBe(400);
    expect(
      (
        await u1App.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentThreadId: "main-u2" }),
        })
      ).status,
    ).toBe(404);

    const createRes = await u1App.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentThreadId: "main-1",
        anchorMessageId: "m1",
        question: "方案 A 有什么风险？",
      }),
    });
    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as {
      thread: {
        id: string;
        messages: { role: string; content: string }[];
      };
      reply: { content: string };
    };
    const sideId = createdBody.thread.id;
    expect(sideId.startsWith("side_")).toBe(true);
    expect(createdBody.reply.content).toBe("模型回答（含摘要=true）");
    expect(createdBody.thread.messages).toHaveLength(2);

    const listRes = await u1App.request("/?parentThreadId=main-1");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      threads: { id: string; messageCount: number }[];
    };
    expect(listBody.threads).toHaveLength(1);
    expect(listBody.threads[0]?.messageCount).toBe(2);

    expect((await u2App.request(`/${sideId}`)).status).toBe(404);

    const badAskRes = await u1App.request(`/${sideId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(badAskRes.status).toBe(400);

    const askRes = await u1App.request(`/${sideId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "能举个例子吗？" }),
    });
    expect(askRes.status).toBe(200);
    const askBody = (await askRes.json()) as {
      thread: { messages: { role: string; content: string }[] };
    };
    expect(askBody.thread.messages).toHaveLength(4);

    const getRes = await u1App.request(`/${sideId}`);
    expect(getRes.status).toBe(200);
    expect(
      ((await getRes.json()) as { thread: { messages: unknown[] } }).thread
        .messages,
    ).toHaveLength(4);

    const steerRes = await u1App.request("/steer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentThreadId: "main-1",
        id: "steer-1",
        text: "改为优先排查权限校验",
      }),
    });
    expect(steerRes.status).toBe(200);
    expect(await steerRes.json()).toEqual({ queued: true, status: "queued" });
    expect(steered).toEqual([
      {
        parentThreadId: "main-1",
        id: "steer-1",
        text: "改为优先排查权限校验",
      },
    ]);

    expect(
      (await u2App.request(`/${sideId}`, { method: "DELETE" })).status,
    ).toBe(404);
    const delRes = await u1App.request(`/${sideId}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });
    expect((await u1App.request(`/${sideId}`)).status).toBe(404);

    expect(fake.rows.get("main-1")?.messages).toEqual([
      { id: "m1", role: "user", content: "讨论方案 A" },
    ]);
  });
});
