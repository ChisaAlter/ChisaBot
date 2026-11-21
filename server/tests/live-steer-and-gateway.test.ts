import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/client";
import { z } from "zod";
import {
  DshEventProjection,
  isSteerCutReason,
} from "../src/conversations/dsh-events";
import { trimToolBoundary } from "../src/conversations/side-threads";
import {
  createDshToolGateway,
  isPromotableReadTool,
} from "../src/conversations/tool-gateway";
import type { ToolOperationStore } from "../src/conversations/tool-operations";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createFakeOperations() {
  const settled: { id: string; status: string; result: unknown }[] = [];
  const store = {
    async claim() {
      return { kind: "claimed" as const, id: "op-1" };
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
      return { kind: "claimed" as const, id: "op-1" };
    },
  } as unknown as ToolOperationStore;
  return { store, settled };
}

describe("ToolGateway 1s 后台化与副作用隔离", () => {
  test("isPromotableReadTool 仅允许声明 effect=read 且无 prepareConfirm 的工具", () => {
    expect(isPromotableReadTool({ effect: "read" })).toBe(true);
    expect(isPromotableReadTool({ effect: "write" })).toBe(false);
    expect(isPromotableReadTool({})).toBe(false);
    expect(
      isPromotableReadTool({
        effect: "read",
        prepareConfirm: async () => ({ skip: "no" }),
      }),
    ).toBe(false);
  });

  test("慢速只读工具收到 steer-signal 后在宽限期满转入后台，不中断原任务并在完成后结算账本", async () => {
    const { store, settled } = createFakeOperations();
    const gateway = createDshToolGateway(store, undefined, {
      steerGraceMs: 40,
    });
    const abort = new AbortController();
    let backgroundAborted = false;
    let backgroundDone = false;

    const binding = {
      sessionId: "sess-1",
      runId: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      actorId: "user-1",
      revision: 1,
      generation: "gen-1",
    };

    const { capability, close } = gateway.register({
      bindingId: "bind-1",
      identity: binding,
      input: {
        threadId: "thread-1",
        runId: "run-1",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      signal: abort.signal,
      tools: [
        {
          name: "slow_read",
          description: "Slow read query",
          ref: "test/slow_read",
          effect: "read",
          parameters: z.object({ q: z.string() }),
          execute: async (_args, ctx) => {
            ctx?.signal?.addEventListener("abort", () => {
              backgroundAborted = true;
            });
            await wait(220);
            backgroundDone = true;
            return "真实只读结果";
          },
        },
      ],
      continuationMessages: async () => [
        {
          id: "ast-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "sess-1:1:1:call-read",
              type: "function",
              function: {
                name: "slow_read",
                arguments: '{"q":"status"}',
              },
            },
          ],
        },
      ],
    });

    try {
      const execPromise = gateway.routes.request("/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${capability}`,
        },
        body: JSON.stringify({
          binding,
          callId: "call-read",
          name: "slow_read",
          args: { q: "status" },
          turn: 1,
          step: 1,
          throughSeq: 1,
        }),
      });

      await wait(15);
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
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        content: string;
        backgroundPromoted?: boolean;
      };
      expect(body.backgroundPromoted).toBe(true);
      expect(body.content).toContain("后台");
      expect(backgroundDone).toBe(false);
      expect(backgroundAborted).toBe(false);

      await wait(260);
      expect(backgroundDone).toBe(true);
      expect(backgroundAborted).toBe(false);
      expect(settled).toEqual([
        {
          id: "op-1",
          status: "completed",
          result: { content: "真实只读结果" },
        },
      ]);
    } finally {
      close();
    }
  });

  test("副作用写入工具（effect=write）即使收到 steer-signal 也绝不后台化", async () => {
    const { store, settled } = createFakeOperations();
    const gateway = createDshToolGateway(store, undefined, {
      steerGraceMs: 20,
    });
    const abort = new AbortController();

    const binding = {
      sessionId: "sess-2",
      runId: "run-2",
      threadId: "thread-2",
      botId: "bot-2",
      actorId: "user-2",
      revision: 1,
      generation: "gen-2",
    };

    const { capability, close } = gateway.register({
      bindingId: "bind-2",
      identity: binding,
      input: {
        threadId: "thread-2",
        runId: "run-2",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      signal: abort.signal,
      tools: [
        {
          name: "write_item",
          description: "Write tool",
          ref: "test/write_item",
          effect: "write",
          parameters: z.object({ v: z.string() }),
          execute: async () => {
            await wait(120);
            return "写入成功";
          },
        },
      ],
      continuationMessages: async () => [
        {
          id: "ast-2",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "sess-2:1:1:call-write",
              type: "function",
              function: { name: "write_item", arguments: '{"v":"ok"}' },
            },
          ],
        },
      ],
    });

    try {
      const execPromise = gateway.routes.request("/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${capability}`,
        },
        body: JSON.stringify({
          binding,
          callId: "call-write",
          name: "write_item",
          args: { v: "ok" },
          turn: 1,
          step: 1,
          throughSeq: 1,
        }),
      });

      await wait(10);
      await gateway.routes.request("/steer-signal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${capability}`,
        },
        body: JSON.stringify({ binding }),
      });

      const response = await execPromise;
      const body = (await response.json()) as {
        content: string;
        backgroundPromoted?: boolean;
      };
      expect(body.backgroundPromoted).toBeUndefined();
      expect(body.content).toBe("写入成功");
      expect(settled).toEqual([
        { id: "op-1", status: "completed", result: { content: "写入成功" } },
      ]);
    } finally {
      close();
    }
  });
});

describe("trimToolBoundary 与 DshEventProjection STEER_CUT", () => {
  test("trimToolBoundary 裁掉尾部未闭合工具调用但保留完整闭合轮次", () => {
    const dangling = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "ok" },
      {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1" }, { id: "c2" }],
      },
      { id: "t1", role: "tool", toolCallId: "c1", content: "half" },
    ];
    expect(trimToolBoundary(dangling).map((m) => m.id)).toEqual(["u1", "a1"]);

    const complete = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a2", role: "assistant", content: "", toolCalls: [{ id: "c1" }] },
      { id: "t1", role: "tool", toolCallId: "c1", content: "done" },
    ];
    expect(trimToolBoundary(complete).map((m) => m.id)).toEqual([
      "u1",
      "a2",
      "t1",
    ]);
  });

  test("isSteerCutReason 与 DshEventProjection 保留半截输出并投影中途注入的 user/message", () => {
    expect(
      isSteerCutReason({
        kind: "aborted",
        reason: { kind: "hook", reason: "chisabot/steer" },
      }),
    ).toBe(true);
    expect(
      isSteerCutReason({ kind: "aborted", reason: { kind: "user" } }),
    ).toBe(false);

    const events: { type: string; [k: string]: unknown }[] = [];
    const projection = new DshEventProjection(
      "sess-p",
      (ev) => events.push(ev as { type: string; [k: string]: unknown }),
      [{ id: "u0", role: "user", content: "初始问题" }],
      new Set(["u0"]),
    );

    projection.live({
      type: "start",
      attemptId: "att-1",
      turn: 1,
      step: 1,
      startedAfterSeq: -1,
    });
    projection.live({
      type: "chunk",
      attemptId: "att-1",
      index: 0,
      chunk: { type: "text-delta", text: "半截内容" },
    });
    projection.durable({
      seq: 0,
      type: "turn/end",
      data: {
        turn: 1,
        reason: {
          kind: "aborted",
          reason: { kind: "hook", reason: "chisabot/steer" },
        },
      },
    } as never);

    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(
      true,
    );

    // Initial request & :resume: internal messages must NOT inject duplicate user snapshots
    projection.durable({
      seq: 1,
      type: "user/message",
      data: {
        content: [{ type: "text", text: "初始问题" }],
        source: { kind: "user", rpcId: "u0" },
      },
    } as never);
    projection.durable({
      seq: 2,
      type: "user/message",
      data: {
        content: [{ type: "text", text: "恢复提示" }],
        source: { kind: "user", rpcId: "run:resume:t1" },
      },
    } as never);
    expect(events.some((e) => e.type === EventType.MESSAGES_SNAPSHOT)).toBe(
      false,
    );

    // Mid-turn live steer user message MUST inject and emit MESSAGES_SNAPSHOT
    projection.durable({
      seq: 3,
      type: "user/message",
      data: {
        content: [{ type: "text", text: "改用简洁表格" }],
        source: { kind: "user", rpcId: "steer-msg-1" },
      },
    } as never);
    const snap = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT);
    expect(snap).toBeDefined();
    expect(
      projection
        .snapshot()
        .some((m) => m.id === "steer-msg-1" && m.content === "改用简洁表格"),
    ).toBe(true);
  });

  test("user/message 含附件块时向 AG-UI MESSAGES_SNAPSHOT 投影纯字符串，不泄露 DSH attachment", () => {
    const events: { type: string; messages?: { id: string; content: unknown }[] }[] =
      [];
    const projection = new DshEventProjection("sess-att", (ev) =>
      events.push(ev as (typeof events)[number]),
    );

    projection.durable({
      seq: 0,
      type: "user/message",
      data: {
        content: [{ type: "image", attachment: { id: "att-1" } }],
        source: { kind: "user", rpcId: "u-img-only" },
      },
    } as never);
    projection.durable({
      seq: 1,
      type: "user/message",
      data: {
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image", attachment: { id: "att-2" } },
        ],
        source: { kind: "user", rpcId: "u-text-img" },
      },
    } as never);

    const snaps = events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT);
    expect(snaps.length).toBe(2);

    const latestMessages = snaps.at(-1)?.messages ?? [];
    const imgOnly = latestMessages.find((m) => m.id === "u-img-only");
    const textImg = latestMessages.find((m) => m.id === "u-text-img");
    expect(imgOnly?.content).toBe("[附件]");
    expect(textImg?.content).toBe("看看这张图");
    expect(JSON.stringify(snaps)).not.toContain("attachment");
  });
});
