/**
 * 服务重启时还在跑的那一轮（DESIGN.md §89，「模型老断」）：重启后要把它补完——没结果的工具调用补「被打断」结果，
 * 补一条说清原因的 RUN_ERROR，对话记录里也补上结果，这样重新打开时那张「正在操作你的设备」卡不会一直转。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/client";
import { createDatabase } from "../src/db/client";
import { closeInterruptedRun, createLocalConversations, type LocalConversationBackend, RESTART_INTERRUPTED_MESSAGE } from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("a run cut off by a restart is closed on the next boot", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const owner = `restart-test-${randomUUID()}`;
  const thread = `${owner}-thread`;
  const runId = `${owner}-run`;

  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    backend = await createLocalConversations(database);
    await backend.client.getOrCreateThread({ threadId: thread, userId: owner, agentId: `${owner}-bot` });
    const messages = [
      { id: "u1", role: "user", content: "装 Node.js" },
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "call-done", type: "function", function: { name: "device_run_shell", arguments: "{}" } }] },
      { id: "r1", role: "tool", toolCallId: "call-done", content: "ok" },
      { id: "a2", role: "assistant", content: "", toolCalls: [{ id: "call-open", type: "function", function: { name: "device_run_shell", arguments: '{"command":"winget install"}' } }] },
    ];
    await database.$client.unsafe(
      "UPDATE openbot_local_threads SET messages = $2::text::jsonb, run_id = $3, lock_expires_at = now() + interval '120 seconds' WHERE id = $1",
      [thread, JSON.stringify(messages), runId],
    );
    await database.$client.unsafe("INSERT INTO openbot_local_runs (thread_id, run_id, status) VALUES ($1, $2, 'running')", [thread, runId]);
    const events = [
      { type: EventType.RUN_STARTED, threadId: thread, runId },
      { type: EventType.TOOL_CALL_START, toolCallId: "call-done", toolCallName: "device_run_shell", parentMessageId: "a1" },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-done" },
      { type: EventType.TOOL_CALL_RESULT, toolCallId: "call-done", messageId: "r1", role: "tool", content: "ok" },
      { type: EventType.TOOL_CALL_START, toolCallId: "call-open", toolCallName: "device_run_shell", parentMessageId: "a2" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-open", delta: '{"command":"winget install"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-open" },
    ];
    for (const event of events) {
      await database.$client.unsafe(
        "INSERT INTO openbot_local_events (thread_id, run_id, event) VALUES ($1, $2, $3::text::jsonb)",
        [thread, runId, JSON.stringify(event)],
      );
    }
  });

  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]);
    await database.$client.close();
  });

  test("boot release marks it interrupted, closes the open tool and ends with a RUN_ERROR that says why", async () => {
    const released = await backend.client.releaseOrphanedLocks();
    expect(released.runs).toBeGreaterThanOrEqual(1);
    expect(released.closed).toBeGreaterThanOrEqual(1);
    const [run] = await database.$client.unsafe<{ status: string }[]>(
      "SELECT status FROM openbot_local_runs WHERE thread_id = $1 AND run_id = $2", [thread, runId],
    );
    expect(run?.status).toBe("interrupted");
    const rows = await database.$client.unsafe<{ event: { type: string; toolCallId?: string; message?: string; content?: string } }[]>(
      "SELECT event FROM openbot_local_events WHERE thread_id = $1 AND run_id = $2 ORDER BY sequence", [thread, runId],
    );
    const types = rows.map((row) => row.event.type);
    expect(types.slice(-2)).toEqual([EventType.TOOL_CALL_RESULT, EventType.RUN_ERROR]);
    const result = rows.at(-2)!.event;
    expect(result.toolCallId).toBe("call-open");
    expect(JSON.parse(result.content!).message).toBe(RESTART_INTERRUPTED_MESSAGE);
    expect(rows.at(-1)!.event.message).toBe(RESTART_INTERRUPTED_MESSAGE);
    // 已经有结果的那一步不再补。
    expect(rows.filter((row) => row.event.type === EventType.TOOL_CALL_RESULT && row.event.toolCallId === "call-done")).toHaveLength(1);

    const [threadRow] = await database.$client.unsafe<{ messages: Array<{ role: string; toolCallId?: string }>; run_id: string | null }[]>(
      "SELECT messages, run_id FROM openbot_local_threads WHERE id = $1", [thread],
    );
    expect(threadRow?.run_id).toBeNull();
    const toolMessages = threadRow!.messages.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(["call-done", "call-open"]);
  });

  test("closing twice adds nothing", async () => {
    expect(await closeInterruptedRun(database, thread, runId)).toBe(false);
  });
});
