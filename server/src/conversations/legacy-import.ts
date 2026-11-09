import { MessageSchema } from "@ag-ui/core/schemas";
import { z } from "zod";
import type { Database } from "../db/client";
import type {
  IntelligenceHistoryClient,
  LegacyHistoryMessage,
} from "./intelligence-history";
import { conversationAdmissionClosed } from "./maintenance";

const threadSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().optional(),
    createdById: z.string().optional(),
    name: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    lastUpdatedAt: z.string().optional(),
    lastRunAt: z.string().optional(),
  })
  .passthrough();
export const legacyInventorySchema = z.object({
  version: z.literal(1),
  capturedAt: z.string(),
  ownerUserId: z.string().min(1),
  botId: z.string().min(1),
  threads: z.array(
    z.object({
      thread: threadSchema,
      messages: z.array(MessageSchema),
      originalMessages: z.array(z.record(z.string(), z.unknown())),
      state: z.unknown(),
      events: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});
export type LegacyInventory = z.infer<typeof legacyInventorySchema>;

function convertedMessage(message: LegacyHistoryMessage) {
  return MessageSchema.parse({
    ...message,
    content: message.content ?? "",
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => {
            const name = "function" in call ? call.function.name : call.name;
            const args =
              "function" in call ? call.function.arguments : call.args;
            return {
              id: call.id,
              type: "function",
              function: {
                name,
                arguments:
                  typeof args === "string" ? args : JSON.stringify(args ?? {}),
              },
            };
          }),
        }
      : {}),
  });
}

/** A bounded inventory cannot silently omit capped event logs or unresolved work. */
export async function inventoryIntelligence(
  client: IntelligenceHistoryClient,
  ownerUserId: string,
  botId: string,
  maxThreads = 1000,
): Promise<LegacyInventory> {
  const result: LegacyInventory = {
    version: 1,
    capturedAt: new Date().toISOString(),
    ownerUserId,
    botId,
    threads: [],
  };
  const seen = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listThreads({
      userId: ownerUserId,
      agentId: botId,
      includeArchived: true,
      limit: Math.min(maxThreads + 1, 100),
      cursor,
    });
    for (const entry of page.threads) {
      if (seen.has(entry.id))
        throw new Error(
          "Remote inventory changed while paging; pause the old service and export again.",
        );
      seen.add(entry.id);
      if (seen.size > maxThreads)
        throw new Error(
          `Inventory exceeds --limit ${maxThreads}; increase the explicit limit.`,
        );
      const thread = await client.getThread({
        threadId: entry.id,
        userId: ownerUserId,
      });
      if (
        thread.id !== entry.id ||
        (thread.agentId && thread.agentId !== botId) ||
        (thread.createdById && thread.createdById !== ownerUserId)
      )
        throw new Error(
          `Thread ${entry.id} does not belong to this owner and Bot.`,
        );
      const [history, log, projection] = await Promise.all([
        client.getThreadMessages({ threadId: entry.id, userId: ownerUserId }),
        client.getThreadEvents({ threadId: entry.id }),
        client.getThreadState({ threadId: entry.id }),
      ]);
      if (log.truncated || log.decodeErrorRowIds.length)
        throw new Error(
          `Thread ${entry.id} has an incomplete event log; preserve and repair it before migration.`,
        );
      if (
        projection.kind === "snapshot-decode-error" ||
        (projection.kind === "snapshot" && projection.skippedDeltas)
      )
        throw new Error(`Thread ${entry.id} has unreadable state.`);
      let active = false;
      for (const event of log.events) {
        if (event.type === "RUN_STARTED") active = true;
        if (event.type === "RUN_ERROR" || event.type === "RUN_FINISHED")
          active = false;
      }
      const terminal = log.events.findLast(
        (event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR",
      );
      if (
        active ||
        (terminal?.outcome as { type?: string } | undefined)?.type ===
          "interrupt"
      )
        throw new Error(
          `Thread ${entry.id} has active or waiting execution. Settle it on the old service first.`,
        );
      const messages = history.messages.map(convertedMessage),
        unanswered = new Set<string>();
      for (const message of messages) {
        if (message.role === "assistant")
          for (const call of message.toolCalls ?? []) unanswered.add(call.id);
        if (message.role === "tool") unanswered.delete(message.toolCallId);
      }
      if (unanswered.size)
        throw new Error(
          `Thread ${entry.id} has unresolved tools; settle them before migration.`,
        );
      result.threads.push({
        thread,
        messages,
        originalMessages: history.messages,
        state: projection.kind === "snapshot" ? projection.state : {},
        events: log.events,
      });
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor))
      throw new Error("Remote inventory repeated its page cursor.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result;
}

/** Insert exact legacy IDs in one transaction; no source mutation and no overwriting local state. */
export async function importIntelligenceInventory(
  database: Database,
  input: LegacyInventory,
): Promise<number> {
  const inventory = legacyInventorySchema.parse(input);
  if (!conversationAdmissionClosed())
    throw new Error(
      "Pause admission with CHISABOT_DSH_ROOT/.maintenance before importing history.",
    );
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_local_threads (
    id text PRIMARY KEY, owner_user_id text NOT NULL, agent_id text NOT NULL, name text,
    archived boolean NOT NULL DEFAULT false, messages jsonb NOT NULL DEFAULT '[]', state jsonb NOT NULL DEFAULT '{}',
    run_id text, lock_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), snapshot_sequence bigint)`);
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_legacy_imports (
    thread_id text PRIMARY KEY REFERENCES chisabot_local_threads(id) ON DELETE CASCADE,
    owner_user_id text NOT NULL, bot_id text NOT NULL, captured_at timestamptz NOT NULL,
    source jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now())`);
  await database.$client.begin(async (transaction) => {
    await transaction.unsafe(
      "LOCK TABLE chisabot_local_threads IN SHARE ROW EXCLUSIVE MODE",
    );
    for (const item of inventory.threads) {
      if (
        (item.thread.agentId && item.thread.agentId !== inventory.botId) ||
        (item.thread.createdById &&
          item.thread.createdById !== inventory.ownerUserId)
      )
        throw new Error(
          `Snapshot thread ${item.thread.id} has conflicting ownership.`,
        );
      if (
        (
          await transaction.unsafe(
            "SELECT id FROM chisabot_local_threads WHERE id=$1",
            [item.thread.id],
          )
        ).length
      )
        throw new Error(
          `Local thread ${item.thread.id} already exists; no data was replaced.`,
        );
      await transaction.unsafe(
        `INSERT INTO chisabot_local_threads(id,owner_user_id,agent_id,name,archived,messages,state,created_at,updated_at,snapshot_sequence)
        VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7::text::jsonb,$8::timestamptz,$9::timestamptz,0)`,
        [
          item.thread.id,
          inventory.ownerUserId,
          inventory.botId,
          item.thread.name ?? null,
          item.thread.archived ?? false,
          JSON.stringify(item.messages),
          JSON.stringify(item.state),
          item.thread.createdAt ?? inventory.capturedAt,
          item.thread.updatedAt ??
            item.thread.lastUpdatedAt ??
            item.thread.lastRunAt ??
            inventory.capturedAt,
        ],
      );
      await transaction.unsafe(
        "INSERT INTO chisabot_legacy_imports(thread_id,owner_user_id,bot_id,captured_at,source) VALUES($1,$2,$3,$4::timestamptz,$5::text::jsonb)",
        [
          item.thread.id,
          inventory.ownerUserId,
          inventory.botId,
          inventory.capturedAt,
          JSON.stringify({
            thread: item.thread,
            messages: item.originalMessages,
            events: item.events,
          }),
        ],
      );
    }
  });
  return inventory.threads.length;
}
