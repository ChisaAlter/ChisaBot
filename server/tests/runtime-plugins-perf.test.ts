import { describe, expect, test } from "bun:test";
import { EventType, type Message } from "@ag-ui/client";
import { Hono } from "hono";
import { createChannelEventHub } from "../src/channels/events";
import {
  assertConversationAdmissionOpenAsync,
  clearMaintenanceProbeCache,
  ConversationMaintenanceError,
  conversationAdmissionClosedAsync,
  MAINTENANCE_PROBE_CACHE_TTL_MS,
} from "../src/conversations/maintenance";
import {
  createIncrementalMessageCapture,
  createLocalConversations,
  prepareConversationMessages,
  SNAPSHOT_CHECKPOINT_MS,
} from "../src/local-conversations";
import {
  createModelSettingsService,
  type ModelSettingsSnapshot,
  type ModelSettingsStore,
} from "../src/model-settings";
import {
  createMcpEnhancementStore,
  createMemoryMcpEnhancementStorage,
  type McpEnhancementStorage,
} from "../src/plugins/mcp-enhancements";
import {
  THREAD_MESSAGES_DELTA_HANDLED_HEADER,
  threadMessagesDelta,
} from "../src/thread-messages-delta";

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("local-conversations streaming hot path & metadata projection", () => {
  test("SNAPSHOT_CHECKPOINT_MS is raised to 2500ms to cut PG WAL write amplification", () => {
    expect(SNAPSHOT_CHECKPOINT_MS).toBe(2_500);
  });

  test("prepareConversationMessages short-circuits sanitize and event when privateIds is empty", () => {
    const stored: Message[] = [
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: "hi" },
    ];
    const input: Message[] = [
      ...stored,
      { id: "u2", role: "user", content: "follow up" },
    ];
    const prepared = prepareConversationMessages(stored, input);
    const stateObj = { nested: { count: 42 }, items: [1, 2, 3] };
    expect(prepared.sanitize(stateObj)).toBe(stateObj);

    const deltaEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "a2",
      delta: "chunk",
    };
    expect(prepared.event(deltaEvent)).toBe(deltaEvent);
  });

  test("createIncrementalMessageCapture reuses finalized prefix references and freezes prior snapshots against mutation", () => {
    const capturer = createIncrementalMessageCapture();
    const history: Message[] = Array.from({ length: 50 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history-${index}`,
    }));
    const liveTail: Message = {
      id: "live-1",
      role: "assistant",
      content: "A",
    };
    const source: Message[] = [...history, liveTail];

    const snap1 = capturer.capture(source, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "live-1",
    });
    expect(snap1).toHaveLength(51);
    expect(snap1[50]?.content).toBe("A");

    // Mutate the live tail in-place (simulating @ag-ui/client delta accumulation).
    liveTail.content = "AB";
    const snap2 = capturer.capture(source, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "live-1",
    });

    // Stop freeze / watermark invariant: snap1 MUST remain completely unaffected.
    expect(snap1[50]?.content).toBe("A");
    expect(snap2[50]?.content).toBe("AB");
    expect(snap2).not.toBe(snap1);

    // Prefix 0..49 MUST reuse immutable frozen references (O(1) tail clone).
    for (let i = 0; i < 50; i++) {
      expect(snap2[i]).toBe(snap1[i]);
    }
    expect(snap2[50]).not.toBe(snap1[50]);

    // Appending a new message reuses 0..49 and snapshots both previous tail and new tail.
    const toolResult: Message = {
      id: "tool-res-1",
      role: "tool",
      toolCallId: "tc-1",
      content: "ok",
    };
    source.push(toolResult);
    const snap3 = capturer.capture(source, {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tool-res-1",
      toolCallId: "tc-1",
    });
    expect(snap3).toHaveLength(52);
    for (let i = 0; i < 50; i++) {
      expect(snap3[i]).toBe(snap2[i]);
    }
    expect(snap3[51]?.content).toBe("ok");

    // Mutating toolResult in-place after capture must not affect snap3.
    toolResult.content = "mutated";
    expect(snap3[51]?.content).toBe("ok");

    // Tool call arguments delta clones nested toolCalls[].function so prior snapshots stay frozen.
    const assistantWithTool: Message = {
      id: "a-tool",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "search", arguments: '{"q":"a' },
        },
      ],
    };
    source.push(assistantWithTool);
    const snap4 = capturer.capture(source, {
      type: EventType.TOOL_CALL_START,
      messageId: "a-tool",
      toolCallId: "call-1",
    });
    assistantWithTool.toolCalls[0].function.arguments = '{"q":"ab"}';
    const snap5 = capturer.capture(source, {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call-1",
    });
    const snap4Tail = snap4[52];
    const snap5Tail = snap5[52];
    expect(
      snap4Tail && "toolCalls" in snap4Tail
        ? snap4Tail.toolCalls?.[0]?.function.arguments
        : null,
    ).toBe('{"q":"a');
    expect(
      snap5Tail && "toolCalls" in snap5Tail
        ? snap5Tail.toolCalls?.[0]?.function.arguments
        : null,
    ).toBe('{"q":"ab"}');
    expect(snap5[0]).toBe(snap4[0]);

    // MESSAGES_SNAPSHOT falls back to full clone cleanly.
    const replaced: Message[] = [
      { id: "m-0", role: "user", content: "edited" },
    ];
    const snap6 = capturer.capture(replaced, {
      type: EventType.MESSAGES_SNAPSHOT,
    });
    expect(snap6).toHaveLength(1);
    expect(snap6[0]?.content).toBe("edited");
    expect(snap6[0]).not.toBe(snap5[0]);
  });

  test("metadata projection avoids SELECT * and lazily loads messages only when needed; native tail skips double-slicing", async () => {
    const queries: string[] = [];
    const sampleMessages: Message[] = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `content-${i}`,
    }));
    const metaRow = {
      id: "t-1",
      owner_user_id: "user-1",
      agent_id: "bot-1",
      name: "Demo",
      archived: false,
      run_id: null,
      lock_expires_at: null,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
      snapshot_sequence: 10,
    };

    let hasMeasuredUsage = true;
    const unsafe = async (sqlText: string, params?: unknown[]) => {
      const normalized = sqlText.replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (normalized.startsWith("CREATE TABLE") || normalized.startsWith("CREATE INDEX") || normalized.startsWith("ALTER TABLE")) {
        return [];
      }
      if (normalized.startsWith("UPDATE chisabot_local_threads SET run_id = NULL")) {
        return [];
      }
      if (normalized.startsWith("SELECT id, owner_user_id, agent_id")) {
        if (params?.[0] === "user-1" || params?.[0] === "t-1") {
          return [metaRow];
        }
        return [];
      }
      if (normalized.startsWith("SELECT messages FROM chisabot_local_threads")) {
        return [{ messages: sampleMessages }];
      }
      if (normalized.includes("event->>'type' = 'RUN_FINISHED'") && normalized.includes("contextUsage")) {
        return hasMeasuredUsage
          ? [
              {
                event: {
                  type: "RUN_FINISHED",
                  metadata: {
                    contextUsage: { inputTokens: 120, outputTokens: 30 },
                  },
                },
                created_at: new Date("2026-01-02T00:00:00.000Z"),
              },
            ]
          : [];
      }
      if (normalized.includes("r.status = 'stopped'")) {
        return [];
      }
      if (normalized.includes("modelFallback")) {
        return [];
      }
      if (normalized.startsWith("UPDATE chisabot_local_threads SET name = $3")) {
        return [{ ...metaRow, name: String(params?.[2] ?? "Demo") }];
      }
      if (normalized.startsWith("SELECT id, run_id, lock_expires_at FROM chisabot_local_threads")) {
        return [];
      }
      return [];
    };

    const fakeDb = {
      $client: {
        unsafe,
        begin: async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) =>
          fn({ unsafe }),
      },
    };

    const backend = await createLocalConversations(fakeDb as never);
    queries.length = 0;

    // 1. GET /threads list must NOT run SELECT *
    const listRes = await backend.handle(
      new Request("http://local/api/conversations/threads"),
      "user-1",
    );
    expect(listRes?.status).toBe(200);
    expect(queries.some((q) => q.includes("SELECT *"))).toBe(false);
    expect(queries.some((q) => q.includes("SELECT messages"))).toBe(false);

    // 2. GET /context with RUN_FINISHED usage, /stopped (none), /fallbacks (none), /threads/:id, PATCH /:id must NOT fetch messages
    queries.length = 0;
    const ctxRes = await backend.handle(
      new Request("http://local/api/conversations/threads/t-1/context"),
      "user-1",
    );
    expect(ctxRes?.status).toBe(200);
    expect(await ctxRes?.json()).toMatchObject({
      context: { tokens: 150, source: "measured" },
    });

    const stoppedRes = await backend.handle(
      new Request("http://local/api/conversations/threads/t-1/stopped"),
      "user-1",
    );
    expect(stoppedRes?.status).toBe(200);
    expect(await stoppedRes?.json()).toEqual({ userMessageIds: [] });

    const fbRes = await backend.handle(
      new Request("http://local/api/conversations/threads/t-1/fallbacks"),
      "user-1",
    );
    expect(fbRes?.status).toBe(200);
    expect(await fbRes?.json()).toEqual({ turns: [] });

    const patchRes = await backend.handle(
      new Request("http://local/api/conversations/threads/t-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
      "user-1",
    );
    expect(patchRes?.status).toBe(200);
    expect(queries.some((q) => q.includes("SELECT *"))).toBe(false);
    expect(queries.some((q) => q.includes("RETURNING *"))).toBe(false);
    expect(queries.some((q) => q.includes("SELECT messages"))).toBe(false);

    // 3. When RUN_FINISHED has no usage, /context lazily loads messages for estimation
    hasMeasuredUsage = false;
    queries.length = 0;
    const estRes = await backend.handle(
      new Request("http://local/api/conversations/threads/t-1/context"),
      "user-1",
    );
    expect(estRes?.status).toBe(200);
    expect(await estRes?.json()).toMatchObject({
      context: { source: "estimate" },
    });
    expect(queries.some((q) => q.includes("SELECT messages"))).toBe(true);

    // 4. Non-owned or missing thread keeps 200 empty for EMPTY_THREAD_READS and 404 for others
    const otherCtx = await backend.handle(
      new Request("http://local/api/conversations/threads/t-1/context"),
      "other-user",
    );
    expect(otherCtx?.status).toBe(200);
    expect(await otherCtx?.json()).toEqual({ context: null });

    const otherMeta = await backend.handle(
      new Request("http://local/api/conversations/threads/t-1"),
      "other-user",
    );
    expect(otherMeta?.status).toBe(404);

    // 5. Native ?tail=20 mounted behind threadMessagesDelta middleware:
    // MUST strip internal skip header and MUST NOT double-slice or corrupt total!
    const app = new Hono();
    app.use("/api/conversations/*", threadMessagesDelta);
    app.all("/api/conversations/*", async (context) => {
      const response = await backend.handle(context.req.raw, "user-1");
      return response ?? context.notFound();
    });

    const tailRes = await app.request(
      "/api/conversations/threads/t-1/messages?tail=20",
    );
    expect(tailRes.status).toBe(200);
    expect(tailRes.headers.has(THREAD_MESSAGES_DELTA_HANDLED_HEADER)).toBe(
      false,
    );
    expect(tailRes.headers.get("cache-control")).toBe("no-store");
    const tailBody = (await tailRes.json()) as {
      messages: Message[];
      total: number;
      partial: boolean;
      version?: string;
    };
    expect(tailBody.partial).toBe(true);
    expect(tailBody.total).toBe(50);
    expect(tailBody.messages).toHaveLength(20);
    expect(tailBody.messages[0]?.id).toBe("msg-30");
    expect(tailBody.messages[19]?.id).toBe("msg-49");
    expect(tailBody.version).toBeUndefined();

    // 6. Native ?since= / ?cursor= through middleware returns version, then unchanged
    const firstDeltaRes = await app.request(
      "/api/conversations/threads/t-1/messages?since=",
    );
    expect(firstDeltaRes.status).toBe(200);
    expect(firstDeltaRes.headers.has(THREAD_MESSAGES_DELTA_HANDLED_HEADER)).toBe(
      false,
    );
    const firstDelta = (await firstDeltaRes.json()) as {
      version: string;
      cursor: string;
      start: number;
      messages: Message[];
    };
    expect(firstDelta.start).toBe(0);
    expect(firstDelta.messages).toHaveLength(50);

    const unchangedRes = await app.request(
      `/api/conversations/threads/t-1/messages?since=${encodeURIComponent(firstDelta.version)}&cursor=${encodeURIComponent(firstDelta.cursor)}`,
    );
    expect(unchangedRes.status).toBe(200);
    expect(await unchangedRes.json()).toEqual({
      unchanged: true,
      version: firstDelta.version,
      cursor: firstDelta.cursor,
    });
  });
});

describe("threadMessagesDelta skip guard & tail cache", () => {
  test("strips internal handled header and never double-slices or corrupts total", async () => {
    const app = new Hono();
    app.use("/api/conversations/*", threadMessagesDelta);
    app.get("/api/conversations/threads/:id/messages", () =>
      Response.json(
        {
          messages: Array.from({ length: 25 }, (_, i) => ({
            id: `m-${i}`,
            role: "user",
            content: "hi",
          })),
          total: 200,
          partial: true,
        },
        {
          headers: {
            "cache-control": "no-store",
            [THREAD_MESSAGES_DELTA_HANDLED_HEADER]: "1",
          },
        },
      ),
    );

    const res = await app.request(
      "/api/conversations/threads/t1/messages?tail=20",
    );
    expect(res.status).toBe(200);
    expect(res.headers.has(THREAD_MESSAGES_DELTA_HANDLED_HEADER)).toBe(false);
    const body = (await res.json()) as {
      messages: unknown[];
      total: number;
      partial: boolean;
    };
    expect(body.total).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.messages).toHaveLength(25);
  });
});

describe("mcp-enhancements batch metadata, zero last_good_tools read & never caching credentials", () => {
  test("batches disabledTools/customInstructions in one call, invalidates on write, and never caches decrypted secrets", async () => {
    const memory = createMemoryMcpEnhancementStorage();
    let getCalls = 0;
    let getBatchMetaCalls = 0;
    let getRuntimeCalls = 0;
    const tracked: McpEnhancementStorage = {
      ensure: () => memory.ensure(),
      get: async (id) => {
        getCalls += 1;
        return memory.get(id);
      },
      getBatchMeta: async (ids) => {
        getBatchMetaCalls += 1;
        return memory.getBatchMeta
          ? memory.getBatchMeta(ids)
          : new Map();
      },
      getRuntime: async (id) => {
        getRuntimeCalls += 1;
        return memory.getRuntime ? memory.getRuntime(id) : null;
      },
      list: () => memory.list(),
      upsert: (row) => memory.upsert(row),
      updateOAuthOnly: (id, oauth, at) =>
        memory.updateOAuthOnly(id, oauth, at),
      delete: (id) => memory.delete(id),
    };

    let now = 1_000;
    const store = createMcpEnhancementStore({
      storage: tracked,
      encryptionKey: ENCRYPTION_KEY,
      now: () => now,
      metaCacheTtlMs: 5_000,
    });

    await store.update(
      "srv-a",
      {
        disabledTools: ["danger_op"],
        customInstructions: "Use srv-a carefully",
        customHeaders: { "X-Secret": "secret-v1" },
      },
      "admin",
    );
    await store.update(
      "srv-b",
      {
        disabledTools: ["drop_all"],
        customInstructions: "Use srv-b safely",
      },
      "admin",
    );
    getCalls = 0;
    getBatchMetaCalls = 0;
    getRuntimeCalls = 0;

    // Batch metadata read for 3 servers (including one without enhancement row) hits getBatchMeta ONCE, never get()
    const meta = await store.metadataForServers(["srv-a", "srv-b", "srv-c"]);
    expect(getBatchMetaCalls).toBe(1);
    expect(getCalls).toBe(0);
    expect(meta.get("srv-a")?.disabledTools.has("danger_op")).toBe(true);
    expect(meta.get("srv-b")?.customInstructions).toBe("Use srv-b safely");
    expect(meta.get("srv-c")?.disabledTools.size).toBe(0);

    // Subsequent disabledToolsMap / customInstructionsForServers / isToolDisabled hit cache (0 DB reads!)
    const disabled = await store.disabledToolsMap(["srv-a", "srv-b"]);
    const instructions = await store.customInstructionsForServers([
      "srv-a",
      "srv-b",
    ]);
    const isDisabled = await store.isToolDisabled("srv-a", "danger_op");
    expect(getBatchMetaCalls).toBe(1);
    expect(getCalls).toBe(0);
    expect(disabled.get("srv-a")?.has("danger_op")).toBe(true);
    expect(instructions).toHaveLength(2);
    expect(isDisabled).toBe(true);

    // Write immediately invalidates metadata cache
    await store.update("srv-a", { disabledTools: [] }, "admin");
    expect(await store.isToolDisabled("srv-a", "danger_op")).toBe(false);
    expect(getBatchMetaCalls).toBe(2);

    // resolveConnectionOverlay uses getRuntime (skipping last_good_tools) and NEVER caches decrypted credentials
    getCalls = 0;
    getRuntimeCalls = 0;
    const overlay1 = await store.resolveConnectionOverlay("srv-a");
    expect(overlay1.extraHeaders["X-Secret"]).toBe("secret-v1");
    expect(getRuntimeCalls).toBe(1);
    expect(getCalls).toBe(0);

    const overlay2 = await store.resolveConnectionOverlay("srv-a");
    expect(overlay2.extraHeaders["X-Secret"]).toBe("secret-v1");
    // Must re-read & decrypt on every call — never cached!
    expect(getRuntimeCalls).toBe(2);
    expect(getCalls).toBe(0);

    // TTL expiration refreshes metadata cache
    now += 6_000;
    await store.isToolDisabled("srv-b", "drop_all");
    expect(getBatchMetaCalls).toBe(3);
  });
});

describe("model-settings resolve cache, write invalidation & parallel decryption", () => {
  test("caches resolve() within TTL, isolates returned clones, invalidates on save(), and decrypts pooled keys in parallel", async () => {
    let snapshot: ModelSettingsSnapshot | null = null;
    let reads = 0;
    const store: ModelSettingsStore = {
      read: async () => {
        reads += 1;
        return snapshot;
      },
      update: async (change) => {
        snapshot = await change(snapshot);
        return snapshot;
      },
    };
    let now = 10_000;
    const service = createModelSettingsService({
      store,
      encryptionKey: ENCRYPTION_KEY,
      fallback: {
        provider: "openai",
        model: "env-model",
        baseUrl: "https://env.test/v1",
      },
      fallbackApiKey: async () => "env-key",
      now: () => now,
      resolveCacheTtlMs: 5_000,
    });

    await service.save({
      provider: "openai",
      model: "saved-v1",
      baseUrl: "https://api.test/v1",
      apiKey: "primary-key",
      pooledKeys: [
        { id: "k1", label: "Key 1", apiKey: "secret-1" },
        { id: "k2", label: "Key 2", apiKey: "secret-2" },
        { id: "k3", label: "Key 3", apiKey: "secret-3" },
      ],
    });
    reads = 0;

    const r1 = await service.resolve();
    const r2 = await service.resolve();
    expect(reads).toBe(1);
    expect(r1.model).toBe("saved-v1");
    expect(r1.apiKey).toBe("primary-key");
    expect(r1.pooledKeys?.map((k) => k.apiKey)).toEqual([
      "secret-1",
      "secret-2",
      "secret-3",
    ]);

    // Mutating caller's returned object must not pollute cache
    r1.apiKey = "tampered";
    if (r1.pooledKeys?.[0]) r1.pooledKeys[0].apiKey = "tampered";
    const r3 = await service.resolve();
    expect(r3.apiKey).toBe("primary-key");
    expect(r3.pooledKeys?.[0]?.apiKey).toBe("secret-1");
    expect(r2.apiKey).toBe("primary-key");

    // save() invalidates cache immediately
    await service.save({
      provider: "openai",
      model: "saved-v2",
      baseUrl: "https://api.test/v1",
      apiKey: "primary-key-v2",
    });
    const r4 = await service.resolve();
    expect(r4.model).toBe("saved-v2");
    expect(r4.apiKey).toBe("primary-key-v2");

    // Advancing clock beyond TTL triggers a fresh read
    const readsBeforeExpire = reads;
    now += 5_500;
    await service.resolve();
    expect(reads).toBe(readsBeforeExpire + 1);
  });
});

describe("channels/events deliver lazy single serialization", () => {
  test("serializes event at most once across multiple users/connections and zero times when nobody is connected", () => {
    const hub = createChannelEventHub();
    let serializeCount = 0;
    const makeEvent = () =>
      ({
        channelId: "ch-1",
        memberIds: ["u1", "u2", "u3"],
        lastMessage: "hi",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        lastMessageAgentId: null,
        toJSON() {
          serializeCount += 1;
          return {
            channelId: "ch-1",
            memberIds: ["u1", "u2", "u3"],
            lastMessage: "hi",
            lastMessageAt: "2026-01-01T00:00:00.000Z",
            lastMessageAgentId: null,
          };
        },
      }) as Parameters<typeof hub.deliver>[0];

    // Zero connected members -> zero JSON.stringify calls
    hub.deliver(makeEvent());
    expect(serializeCount).toBe(0);

    const received: string[] = [];
    const detach1 = hub.register("u1", (p) => received.push(p));
    const detach2 = hub.register("u1", (p) => received.push(p));
    const detach3 = hub.register("u2", (p) => received.push(p));

    hub.deliver(makeEvent());
    expect(serializeCount).toBe(1);
    expect(received).toHaveLength(3);
    expect(received[0]).toBe(received[1]);
    expect(received[1]).toBe(received[2]);

    detach1();
    detach2();
    detach3();
  });
});

describe("conversations/maintenance async access() with 500ms cache & fail-closed semantics", () => {
  test("caches ENOENT/exists for 500ms, coalesces concurrent probes, and fails closed on non-ENOENT errors", async () => {
    const oldRoot = process.env.CHISABOT_DSH_ROOT;
    process.env.CHISABOT_DSH_ROOT = "/tmp/chisabot-maint-test";
    clearMaintenanceProbeCache();
    let now = 1_000;
    let probes = 0;
    let mode: "open" | "closed" | "eacces" = "open";

    const accessFn = async () => {
      probes += 1;
      if (mode === "closed") return;
      const err = new Error("fs error") as NodeJS.ErrnoException;
      err.code = mode === "open" ? "ENOENT" : "EACCES";
      throw err;
    };

    try {
      expect(MAINTENANCE_PROBE_CACHE_TTL_MS).toBe(500);

      // Concurrent cold probes coalesce into 1 async access call
      const [a, b] = await Promise.all([
        conversationAdmissionClosedAsync({ now: () => now, accessFn }),
        conversationAdmissionClosedAsync({ now: () => now, accessFn }),
      ]);
      expect(a).toBe(false);
      expect(b).toBe(false);
      expect(probes).toBe(1);

      // Cached within 500ms
      mode = "closed";
      now += 400;
      expect(
        await conversationAdmissionClosedAsync({ now: () => now, accessFn }),
      ).toBe(false);
      expect(probes).toBe(1);

      // Expires at 500ms and observes created .maintenance marker
      now += 150;
      expect(
        await conversationAdmissionClosedAsync({ now: () => now, accessFn }),
      ).toBe(true);
      expect(probes).toBe(2);
      await expect(
        assertConversationAdmissionOpenAsync({ now: () => now, accessFn }),
      ).rejects.toBeInstanceOf(ConversationMaintenanceError);

      // Marker removed -> opens again after TTL
      mode = "open";
      now += 500;
      expect(
        await conversationAdmissionClosedAsync({ now: () => now, accessFn }),
      ).toBe(false);
      expect(probes).toBe(3);

      // Non-ENOENT (EACCES) fails closed by throwing ConversationMaintenanceError
      mode = "eacces";
      now += 500;
      await expect(
        conversationAdmissionClosedAsync({ now: () => now, accessFn }),
      ).rejects.toBeInstanceOf(ConversationMaintenanceError);
      expect(probes).toBe(4);
    } finally {
      clearMaintenanceProbeCache();
      if (oldRoot === undefined) delete process.env.CHISABOT_DSH_ROOT;
      else process.env.CHISABOT_DSH_ROOT = oldRoot;
    }
  });
});
