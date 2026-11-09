import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceHistoryClient } from "../src/conversations/intelligence-history";
import {
  importIntelligenceInventory,
  inventoryIntelligence,
  type LegacyInventory,
} from "../src/conversations/legacy-import";
import { createDatabase } from "../src/db/client";

test("legacy inventory preserves owner, message identity, metadata and state while refusing active or incomplete sources", async () => {
  let active = false,
    truncated = false,
    pending = false;
  const seen: URL[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push(url);
      expect(request.headers.get("authorization")).toBe("Bearer source-key");
      if (url.pathname.endsWith("/events"))
        return Response.json({
          truncated,
          decodeErrorRowIds: [],
          events: [
            { type: "RUN_STARTED", runId: "run-1" },
            ...(!active
              ? [
                  {
                    type: "RUN_FINISHED",
                    runId: "run-1",
                    ...(pending ? { outcome: { type: "interrupt" } } : {}),
                  },
                ]
              : []),
          ],
        });
      if (url.pathname.endsWith("/state"))
        return Response.json({
          kind: "snapshot",
          state: { panel: "kept" },
          skippedDeltas: 0,
        });
      if (url.pathname.endsWith("/messages"))
        return Response.json({
          messages: [
            { id: "user-1", role: "user", content: "Keep this" },
            {
              id: "reply-1",
              role: "assistant",
              content: null,
              metadata: { customProvider: "preserve-me" },
              toolCalls: [
                { id: "tool-1", name: "save", args: "{}" },
                {
                  id: "tool-2",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"report"}' },
                },
              ],
            },
            {
              id: "receipt-1",
              role: "tool",
              toolCallId: "tool-1",
              content: "receipt",
            },
            {
              id: "receipt-2",
              role: "tool",
              toolCallId: "tool-2",
              content: "read receipt",
            },
          ],
        });
      const thread = {
        id: "thread-1",
        agentId: "bot-1",
        createdById: "owner-1",
        name: "Archive",
        archived: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      };
      return Response.json(
        url.pathname === "/api/threads"
          ? { threads: [thread], nextCursor: null }
          : { thread },
      );
    },
  });
  try {
    const client = new IntelligenceHistoryClient({
      apiUrl: server.url.origin,
      apiKey: "source-key",
    });
    const inventory = await inventoryIntelligence(client, "owner-1", "bot-1");
    expect(inventory.threads[0]?.messages.map((message) => message.id)).toEqual(
      ["user-1", "reply-1", "receipt-1", "receipt-2"],
    );
    expect(inventory.threads[0]?.messages[1]).toMatchObject({
      content: "",
      toolCalls: [
        { id: "tool-1", function: { name: "save", arguments: "{}" } },
        {
          id: "tool-2",
          function: { name: "read", arguments: '{"path":"report"}' },
        },
      ],
    });
    expect(inventory.threads[0]?.originalMessages[1]).toMatchObject({
      content: null,
      metadata: { customProvider: "preserve-me" },
    });
    expect(inventory.threads[0]?.state).toEqual({ panel: "kept" });
    expect(inventory.threads[0]?.thread.archived).toBe(true);
    expect(
      seen
        .filter((url) => !url.pathname.includes("_inspect"))
        .every((url) => url.searchParams.get("userId") === "owner-1"),
    ).toBe(true);
    active = true;
    await expect(
      inventoryIntelligence(client, "owner-1", "bot-1"),
    ).rejects.toThrow("active or waiting");
    active = false;
    pending = true;
    await expect(
      inventoryIntelligence(client, "owner-1", "bot-1"),
    ).rejects.toThrow("active or waiting");
    pending = false;
    truncated = true;
    await expect(
      inventoryIntelligence(client, "owner-1", "bot-1"),
    ).rejects.toThrow("incomplete event log");
  } finally {
    server.stop(true);
  }
});

const url = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
(url ? test : test.skip)(
  "legacy import is atomic and preserves exact identities without overwriting an existing conversation",
  async () => {
    const database = createDatabase(url!);
    const root = await mkdtemp(join(tmpdir(), "chisabot-import-"));
    const previous = process.env.CHISABOT_DSH_ROOT;
    process.env.CHISABOT_DSH_ROOT = root;
    const id = `legacy-${crypto.randomUUID()}`;
    const inventory: LegacyInventory = {
      version: 1,
      capturedAt: "2026-01-03T00:00:00Z",
      ownerUserId: "migration-owner",
      botId: "migration-bot",
      threads: [
        {
          thread: {
            id,
            name: "Imported",
            archived: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
          },
          messages: [
            { id: "original-message", role: "user", content: "Keep IDs" },
          ],
          originalMessages: [
            {
              id: "original-message",
              role: "user",
              content: "Keep IDs",
              metadata: { retained: true },
            },
          ],
          state: { panel: "retained" },
          events: [{ type: "RUN_FINISHED", runId: "old-run" }],
        },
      ],
    };
    try {
      await expect(
        importIntelligenceInventory(database, inventory),
      ).rejects.toThrow("Pause admission");
      await writeFile(join(root, ".maintenance"), "migration-test");
      expect(await importIntelligenceInventory(database, inventory)).toBe(1);
      const [row] = await database.$client.unsafe(
        "SELECT * FROM chisabot_local_threads WHERE id=$1",
        [id],
      );
      expect(row.owner_user_id).toBe("migration-owner");
      expect(row.agent_id).toBe("migration-bot");
      expect(row.messages).toEqual(inventory.threads[0]!.messages);
      expect(row.state).toEqual({ panel: "retained" });
      expect(row.archived).toBe(true);
      expect(new Date(row.created_at).toISOString()).toBe(
        "2026-01-01T00:00:00.000Z",
      );
      const [source] = await database.$client.unsafe(
        "SELECT source FROM chisabot_legacy_imports WHERE thread_id=$1",
        [id],
      );
      expect(source.source.events).toEqual(inventory.threads[0]!.events);
      expect(source.source.messages).toEqual(
        inventory.threads[0]!.originalMessages,
      );
      const conflicting = structuredClone(inventory);
      conflicting.threads.unshift({
        ...structuredClone(inventory.threads[0]!),
        thread: { id: `${id}-rolled-back` },
      });
      await expect(
        importIntelligenceInventory(database, conflicting),
      ).rejects.toThrow("already exists");
      expect(
        await database.$client.unsafe(
          "SELECT id FROM chisabot_local_threads WHERE id=$1",
          [`${id}-rolled-back`],
        ),
      ).toHaveLength(0);
    } finally {
      await database.$client.unsafe(
        "DELETE FROM chisabot_local_threads WHERE id IN ($1,$2)",
        [id, `${id}-rolled-back`],
      );
      await database.$client.close();
      if (previous === undefined) delete process.env.CHISABOT_DSH_ROOT;
      else process.env.CHISABOT_DSH_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
