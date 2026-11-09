import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { CHAT_FILES_MARKER } from "../../shared/chat-files";
import {
  type TaskCenterTask,
  taskInputSchema,
  validateTaskPlan,
} from "../../shared/task-center";
import type { Database } from "../src/db/client";
import {
  createLocalAgentRun,
  localAgentThreadId,
} from "../src/task-center/local-agent-runner";
import {
  assertTaskEvidence,
  TaskResultNeedsReview,
  taskTurnFailure,
  verifyTaskTurn,
} from "../src/task-center/outcome";
import { taskThreadId } from "../src/task-center/runtime";

const task = (overrides: Partial<TaskCenterTask> = {}) =>
  ({
    id: "task",
    ownerUserId: "owner",
    agentId: "bot",
    title: "交付文件",
    description: "交付文件并核对",
    executor: "bot",
    version: 1,
    attempts: 1,
    ...overrides,
  }) as TaskCenterTask;
const fileResult = `${CHAT_FILES_MARKER}[{"id":"file-1","url":"/api/chat-files/file-1"}]`;
const operation = (
  content: unknown,
  overrides: Record<string, unknown> = {},
) => ({
  id: "op-1",
  tool_name: "file_share",
  status: "completed",
  result: { content },
  args: {},
  ...overrides,
});
function records(
  options: {
    operations?: unknown[];
    file?: unknown;
    delivery?: unknown;
    inherited?: unknown[];
  } = {},
) {
  const queries: Array<{ statement: string; params: unknown[] }> = [];
  const database = {
    $client: {
      unsafe: async (statement: string, params: unknown[] = []) => {
        queries.push({ statement, params });
        if (statement.includes("to_regclass")) return [{ available: true }];
        if (statement.includes("FROM chisabot_tool_operations"))
          return options.operations ?? [];
        if (statement.includes("FROM chisabot_chat_files"))
          return options.file ? [options.file] : [];
        if (statement.includes("FROM chisabot_personal_deliveries"))
          return options.delivery ? [options.delivery] : [];
        if (statement.includes("FROM chisabot_task_center_events"))
          return [{ data: { evidence: options.inherited ?? [] } }];
        throw Error(`Unexpected query ${statement}`);
      },
    },
  } as unknown as Database;
  return { database, queries };
}
const check = (
  database: Database,
  overrides: Partial<TaskCenterTask> = {},
  messages: Message[] = [],
) =>
  verifyTaskTurn({ database, task: task(overrides), runId: "run-1", messages });

describe("task completion evidence", () => {
  test("legacy and explicit text-only results keep their original contract", async () => {
    expect(() =>
      assertTaskEvidence(task(), { summary: "分析结论" }),
    ).not.toThrow();
    expect(() =>
      assertTaskEvidence(
        task({ completion: { criteria: "给出分析", required: [] } }),
        { summary: "结论" },
      ),
    ).not.toThrow();
    expect(await check(records().database)).toEqual({
      artifacts: [],
      evidence: [],
    });
    expect(
      taskInputSchema.parse({ title: "建议", description: "分析方案" })
        .completion,
    ).toBeUndefined();
  });

  test("failure after a tool record keeps the saved attempt, while a model-only failure can retry", async () => {
    const beforeTools = await taskTurnFailure(
      records().database,
      task(),
      "run-1",
      "模型不可用",
    );
    expect(beforeTools).not.toBeInstanceOf(TaskResultNeedsReview);
    const db = records({ operations: [{ id: "recorded" }] });
    expect(
      await taskTurnFailure(db.database, task(), "run-1", "最终总结失败"),
    ).toBeInstanceOf(TaskResultNeedsReview);
    expect(db.queries.at(-1)?.params).toEqual(["owner", "run-1"]);
  });

  test("a file name or component alone cannot satisfy a required saved file", () => {
    expect(() =>
      assertTaskEvidence(
        task({ completion: { criteria: "实际文件", required: ["file"] } }),
        {
          summary: "文件已写好",
          artifacts: [{ name: "report.md", content: "{component:Card}" }],
        },
      ),
    ).toThrow(TaskResultNeedsReview);
  });

  test("file marker resolves to owned readable bytes and uses the authoritative filename", async () => {
    const db = records({
      operations: [operation(fileResult)],
      file: {
        id: "file-1",
        name: "报告.md",
        mime_type: "text/markdown",
        size_bytes: 12,
        stored_bytes: 12,
      },
    });
    const result = await check(db.database);
    expect(result.artifacts).toEqual([
      {
        name: "报告.md",
        uri: "/api/chat-files/file-1",
        mediaType: "text/markdown",
      },
    ]);
    expect(result.evidence[0]?.kind).toBe("file");
    expect(
      db.queries.find((q) => q.statement.includes("FROM chisabot_chat_files"))
        ?.params,
    ).toEqual(["file-1", "owner"]);
  });

  test("missing, wrong-owner and incomplete stored files fail without automatic execution retry", async () => {
    for (const file of [
      undefined,
      { id: "file-1", name: "file", size_bytes: 12, stored_bytes: null },
      { id: "file-1", name: "file", size_bytes: 12, stored_bytes: 11 },
    ]) {
      await expect(
        check(records({ operations: [operation(fileResult)], file }).database),
      ).rejects.toBeInstanceOf(TaskResultNeedsReview);
    }
  });

  test("refused or uncertain tool outcomes override a cheerful model summary", async () => {
    for (const op of [
      operation("Refused. 需要批准"),
      operation("", { status: "outcome_unknown" }),
      operation("", { status: "waiting_approval" }),
      operation("", { result: { content: "", error: "denied" } }),
    ]) {
      await expect(
        check(records({ operations: [op] }).database),
      ).rejects.toBeInstanceOf(TaskResultNeedsReview);
    }
    await expect(
      check(records().database, {}, [
        {
          id: "tool",
          role: "tool",
          toolCallId: "c",
          content: '"Refused. 未执行"',
        },
      ]),
    ).rejects.toBeInstanceOf(TaskResultNeedsReview);
  });

  test("personal delivery requires the exact owned same-run durable receipt", async () => {
    const content = JSON.stringify({
      type: "personal_delivery",
      id: "delivery-1",
      channel: "smtp",
      state: "accepted",
      providerMessageIds: ["provider-id"],
      summary: "SMTP 已接纳",
    });
    const accepted = records({
      operations: [operation(content, { tool_name: "email_send" })],
      delivery: {
        id: "delivery-1",
        state: "sent",
        receipt: { providerMessageIds: ["provider-id"] },
      },
    });
    const result = await check(accepted.database);
    expect(result.evidence).toEqual([
      { kind: "delivery", reference: "delivery-1", detail: "发送平台已接纳" },
    ]);
    expect(
      accepted.queries.find((q) =>
        q.statement.includes("FROM chisabot_personal_deliveries"),
      )?.params,
    ).toEqual(["delivery-1", "owner", "run-1"]);
    await expect(
      check(
        records({
          operations: [operation(content)],
          delivery: {
            id: "delivery-1",
            state: "outcome_unknown",
            receipt: null,
          },
        }).database,
      ),
    ).rejects.toBeInstanceOf(TaskResultNeedsReview);
    expect(
      (
        await check(
          records({
            operations: [
              operation("我已经发送了邮件", { tool_name: "email_send" }),
            ],
          }).database,
        )
      ).evidence,
    ).toEqual([]);
  });

  test("a definite failed call can recover for the same arguments, but an unknown effect cannot", async () => {
    const refused = operation("Refused. 临时不可用", {
      tool_name: "lookup",
      args: { target: "a" },
    });
    const recovered = operation("读取完成", {
      id: "op-2",
      tool_name: "lookup",
      args: { target: "a" },
    });
    expect(
      await check(records({ operations: [refused, recovered] }).database, {}, [
        {
          id: "t",
          role: "tool",
          toolCallId: "c",
          content: "Refused. 临时不可用",
        },
      ]),
    ).toEqual({ artifacts: [], evidence: [] });
    await expect(
      check(
        records({
          operations: [refused, { ...recovered, args: { target: "b" } }],
        }).database,
      ),
    ).rejects.toBeInstanceOf(TaskResultNeedsReview);
    await expect(
      check(
        records({
          operations: [{ ...refused, status: "outcome_unknown" }, recovered],
        }).database,
      ),
    ).rejects.toBeInstanceOf(TaskResultNeedsReview);
  });

  test("device failure and background admission are not successful execution; read-back supplies file evidence", async () => {
    for (const content of [
      JSON.stringify({ exitCode: 1 }),
      JSON.stringify({ timedOut: true }),
      JSON.stringify({ status: "timeout", exitCode: null }),
      JSON.stringify({ exitCode: "signal SIGTERM" }),
      "设备操作失败：断线",
    ]) {
      await expect(
        check(
          records({
            operations: [operation(content, { tool_name: "device_run_shell" })],
          }).database,
        ),
      ).rejects.toBeInstanceOf(TaskResultNeedsReview);
    }
    expect(
      (
        await check(
          records({
            operations: [
              operation(JSON.stringify({ status: "running", jobId: "job" }), {
                tool_name: "device_run_shell",
                args: { background: true },
              }),
            ],
          }).database,
        )
      ).evidence,
    ).toEqual([]);
    expect(
      (
        await check(
          records({
            operations: [
              operation(JSON.stringify({ jobs: [] }), {
                tool_name: "device_shell_output",
              }),
            ],
          }).database,
        )
      ).evidence,
    ).toEqual([]);
    expect(
      (
        await check(
          records({
            operations: [
              operation(JSON.stringify({ exitCode: null }), {
                tool_name: "device_run_shell",
              }),
            ],
          }).database,
        )
      ).evidence,
    ).toEqual([]);
    expect(
      (
        await check(
          records({
            operations: [
              operation(
                JSON.stringify({ status: "exited", exitCode: 0, jobId: "job" }),
                { tool_name: "device_run_shell", args: { background: true } },
              ),
            ],
          }).database,
        )
      ).evidence[0]?.kind,
    ).toBe("device");
    const result = await check(
      records({
        operations: [
          operation(
            JSON.stringify({
              path: "C:/work/report.md",
              size: 4,
              content: "done",
              encoding: "utf8",
              truncated: false,
            }),
            { tool_name: "device_read_file" },
          ),
        ],
      }).database,
    );
    expect(result.evidence.map((item) => item.kind)).toEqual([
      "device",
      "file",
    ]);
    expect(result.artifacts[0]?.content).toBe("done");
  });

  test("completion schema rejects made-up evidence kinds and retry versions have distinct execution identities", () => {
    expect(() =>
      validateTaskPlan({
        summary: "",
        completion: { criteria: "x", required: ["model_says_done" as "file"] },
        steps: [],
      }),
    ).toThrow();
    expect(taskThreadId(task(), "run")).toBe("task-center:task:run:1");
    expect(taskThreadId(task({ version: 2 }), "run")).toBe(
      "task-center:task:run:v2:1",
    );
  });
});

describe("existing local-agent result adapter", () => {
  test("a resumed task reattaches to the original owned result without dispatching", async () => {
    let starts = 0;
    const db = {
      $client: {
        unsafe: async (q: string, p: unknown[]) => {
          if (q.includes("thread_id=$2")) {
            expect(p).toEqual([
              "owner",
              localAgentThreadId(task({ executor: "local-agent" })),
            ]);
            return [{ id: "device-task" }];
          }
          expect(p).toEqual(["device-task", "owner"]);
          return [
            {
              status: "done",
              summary: "读取完成",
              diff: null,
              device_id: "device",
            },
          ];
        },
      },
    } as unknown as Database;
    const run = createLocalAgentRun({
      database: db,
      localAgents: {
        start: async () => {
          starts++;
          throw Error("must not start");
        },
        stop: async () => {},
      } as never,
      botNameFor: async () => "Bot",
    });
    const result = await run(task({ executor: "local-agent" }), "bot", {
      signal: new AbortController().signal,
      onEvent: async () => {},
    } as never);
    expect(starts).toBe(0);
    expect(result.evidence?.[0]).toEqual({
      kind: "device",
      reference: "device-task",
      detail: "设备执行已完成",
    });
  });

  test("unapplied local changes require review instead of declaring delivery", async () => {
    const db = {
      $client: {
        unsafe: async (q: string) =>
          q.includes("thread_id=$2")
            ? [{ id: "device-task" }]
            : [
                {
                  status: "done",
                  summary: "修改已完成",
                  diff: {
                    pending: true,
                    applied: false,
                    files: [{ path: "file" }],
                  },
                  device_id: "device",
                },
              ],
      },
    } as unknown as Database;
    const run = createLocalAgentRun({
      database: db,
      localAgents: {
        start: async () => {
          throw Error("must not start");
        },
        stop: async () => {},
      } as never,
      botNameFor: async () => "Bot",
    });
    await expect(
      run(
        task({
          completion: { criteria: "应用设备改动", required: ["device"] },
        }),
        "bot",
        {
          signal: new AbortController().signal,
          onEvent: async () => {},
        } as never,
      ),
    ).rejects.toBeInstanceOf(TaskResultNeedsReview);
    const draft = await run(
      task({ completion: { criteria: "提交建议改动供审查", required: [] } }),
      "bot",
      {
        signal: new AbortController().signal,
        onEvent: async () => {},
      } as never,
    );
    expect(draft.summary).toContain("尚未应用");
    expect(draft.evidence).toEqual([]);
  });
});
