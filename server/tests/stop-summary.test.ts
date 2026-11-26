import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  buildStopSummary,
  summarizeRunProgress,
} from "../src/agents/stop-summary";
import {
  createDshToolGateway,
  isYieldToSteerTool,
} from "../src/conversations/tool-gateway";
import type { ToolOperationStore } from "../src/conversations/tool-operations";

describe("StopSummary (纯规则收尾/中断摘要)", () => {
  test("什么都没做时保持原简洁文案不变", () => {
    const base = "用户已停止这一轮。";
    expect(
      buildStopSummary({ baseMessage: base, events: [], operations: [] }),
    ).toBe(base);
  });

  test("从 tool_operations 与 local_events 聚合工具统计、动作摘要与流出文本预览", () => {
    const summary = buildStopSummary({
      baseMessage: "用户已停止这一轮。",
      operations: [
        {
          callId: "c1",
          toolName: "computer_navigate",
          args: { url: "https://example.com/orders" },
          status: "completed",
          result: { content: "ok" },
        },
        {
          callId: "c2",
          toolName: "computer_run_command",
          args: { command: "bun test" },
          status: "failed",
          result: { content: "failed", error: "exit 1" },
        },
        {
          callId: "c3",
          toolName: "device_run_shell",
          args: { command: "sleep 30" },
          status: "outcome_unknown",
        },
      ],
      events: [
        { type: "TEXT_MESSAGE_CONTENT", delta: "正在检查订单页面，" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "接下来跑测试。" },
      ],
    });

    expect(summary).toContain("用户已停止这一轮。");
    expect(summary).toContain("已执行 3 次工具调用（成功 1、失败 1、未决 1）");
    expect(summary).toContain("computer_navigate(https://example.com/orders)");
    expect(summary).toContain("computer_run_command(bun test)");
    expect(summary).toContain(
      "已输出内容：「正在检查订单页面，接下来跑测试。」",
    );
  });

  test("无 tool_operations 时从 AG-UI 事件补齐统计并剥离 untrusted 包装", () => {
    const stats = summarizeRunProgress({
      events: [
        {
          type: "TOOL_CALL_START",
          toolCallId: "t1",
          toolCallName: "web_search",
        },
        {
          type: "TOOL_CALL_RESULT",
          toolCallId: "t1",
          content: JSON.stringify({ content: "done" }),
        },
        {
          type: "TOOL_CALL_START",
          toolCallId: "t2",
          toolCallName: "computer_click",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          delta: "已找到相关结果",
        },
      ],
      maxPreviewChars: 24,
    });

    expect(stats.totalTools).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.unknown).toBe(1);
    expect(stats.highlights).toEqual(["web_search", "computer_click"]);
    expect(stats.textPreview).toBe("已找到相关结果");
  });

  test("超长输出预览与参数按上限截断", () => {
    const longText = "甲".repeat(200);
    const summary = buildStopSummary({
      baseMessage: "中断",
      events: [{ type: "TEXT_MESSAGE_CONTENT", delta: longText }],
      maxPreviewChars: 30,
    });
    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(120);
  });
});

describe("tool-gateway yieldsToSteer 零延迟打断", () => {
  test("isYieldToSteerTool 识别 wait/sleep 工具与显式 yieldsToSteer 标记", () => {
    expect(isYieldToSteerTool({ name: "wait" })).toBe(true);
    expect(isYieldToSteerTool({ name: "sleep" })).toBe(true);
    expect(
      isYieldToSteerTool({ name: "custom_delay", yieldsToSteer: true }),
    ).toBe(true);
    expect(
      isYieldToSteerTool({
        name: "wait",
        prepareConfirm: async () => ({ skip: "confirm" }),
      }),
    ).toBe(false);
    expect(isYieldToSteerTool({ name: "web_search" })).toBe(false);
  });

  test("yieldsToSteer 工具收到 steer-signal 时零延迟 abort 并返回 skipped_for_new_message", async () => {
    const settled: { id: string; status: string; result: unknown }[] = [];
    const store = {
      async claim() {
        return { kind: "claimed" as const, id: "op-yield-1" };
      },
      async settle(id: string, status: string, result: unknown) {
        settled.push({ id, status, result });
      },
      async waitingForConfirmation() {},
      async markOutcomeUnknown() {},
      async markRunOutcomeUnknown() {},
      async listUnknown() {
        return [];
      },
      async resumeConfirmation() {
        return { kind: "claimed" as const, id: "op-yield-1" };
      },
    } as unknown as ToolOperationStore;

    // 刻意设很长的 5000ms steerGraceMs，验证 yieldsToSteer 不会等 1s/5s 宽限期。
    const gateway = createDshToolGateway(store, undefined, {
      steerGraceMs: 5_000,
    });
    const runAbort = new AbortController();
    let callAborted = false;

    const binding = {
      sessionId: "sess-yield",
      runId: "run-yield",
      threadId: "thread-yield",
      botId: "bot-1",
      actorId: "user-1",
      revision: 1,
      generation: "gen-yield",
    };

    const { capability, close } = gateway.register({
      bindingId: "bind-yield",
      identity: binding,
      input: {
        threadId: "thread-yield",
        runId: "run-yield",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      signal: runAbort.signal,
      tools: [
        {
          name: "sleep",
          description: "Wait for a few seconds",
          ref: "test/sleep",
          effect: "read",
          parameters: z.object({ seconds: z.number() }),
          execute: async (_args, ctx) => {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 10_000);
              ctx?.signal?.addEventListener(
                "abort",
                () => {
                  callAborted = true;
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
            return "slept";
          },
        },
      ],
      continuationMessages: async () => [
        {
          id: "ast-yield-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "sess-yield:1:1:call-sleep",
              type: "function",
              function: {
                name: "sleep",
                arguments: '{"seconds":10}',
              },
            },
          ],
        },
      ],
    });

    try {
      const startedAt = Date.now();
      const execPromise = gateway.routes.request("/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${capability}`,
        },
        body: JSON.stringify({
          binding,
          callId: "call-sleep",
          name: "sleep",
          args: { seconds: 10 },
          turn: 1,
          step: 1,
          throughSeq: 1,
        }),
      });

      await new Promise((r) => setTimeout(r, 20));
      const steerRes = await gateway.routes.request("/steer-signal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${capability}`,
        },
        body: JSON.stringify({ binding }),
      });
      expect(steerRes.status).toBe(200);

      const response = await execPromise;
      const elapsedMs = Date.now() - startedAt;
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status?: string;
        content: string;
        skippedForNewMessage?: boolean;
      };
      expect(body.status).toBe("skipped_for_new_message");
      expect(body.skippedForNewMessage).toBe(true);
      expect(body.content).toContain("skipped_for_new_message");
      expect(callAborted).toBe(true);
      expect(runAbort.signal.aborted).toBe(false);
      expect(elapsedMs).toBeLessThan(400);
      expect(settled).toHaveLength(1);
    } finally {
      close();
    }
  });
});
