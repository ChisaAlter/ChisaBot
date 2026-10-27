import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

/**
 * 回合不能静默结束（DESIGN.md §100，2026-10-17 用户截图：星灵在 Hark 注册页选生日，「做了 3 步」后什么都没有）。
 *
 * 生产上的真实经过：机器人点开原生月份下拉框 → 按键时 agent-computer 超时 →
 * POST /api/approvals/computer 回 500 → 这里的工具处理函数抛错 → CopilotKit 只在处理函数没出错时才发起下一轮，
 * 于是这一轮停在一条「Error: …」的工具结果上，没有回答、没有提示。
 *
 * 这里钉住三件事：处理函数遇到非 2xx 交回 { ok:false } 而不是抛；任何异常都不往外抛（停止除外）；
 * 一轮最后是工具结果 / 空回复时，聊天里有一句中文原因。
 */

const real = await import("@copilotkit/react-core/v2");
type Registered = Parameters<typeof real.useFrontendTool>[0];
const registered: Registered[] = [];
mock.module("@copilotkit/react-core/v2", () => ({
  ...real,
  useCopilotKit: () => ({ copilotkit: { stopAgent: () => undefined } }),
  useFrontendTool: (tool: Registered) => {
    if (!registered.some((entry) => entry.name === tool.name)) registered.push(tool);
  },
}));
const { useFrontendTool, neverThrow } = await import("@/lib/copilot/approval-tools");
const { observeApprovalAgent } = await import("@/lib/copilot/approval-context");
const { unfinishedTurnReason, isAbortFailure } = await import("@/lib/copilot/stopped-turn");

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function Tools() {
  useFrontendTool({
    name: "computer_key",
    description: "Key",
    handler: async () => ({ pressed: true }),
  });
  useFrontendTool({
    name: "computer_read",
    description: "Read",
    handler: async () => {
      throw new Error("boom");
    },
  });
  return null;
}

async function callKeyWith(response: Response) {
  const originalFetch = global.fetch;
  global.fetch = Object.assign(async () => response, { preconnect: originalFetch.preconnect });
  try {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Tools />
      </QueryClientProvider>,
    );
    const tool = registered.find((entry) => entry.name === "computer_key");
    const toolCall = {
      id: "key-call",
      type: "function" as const,
      function: { name: "computer_key", arguments: '{"key":"Enter","ref":"f4e36","snapshotId":9}' },
    };
    const subscribers: { onRunInitialized?: (input: { input: unknown }) => void }[] = [];
    const agent = {
      threadId: "thread",
      state: {},
      messages: [
        { id: "u1", role: "user", content: "选啊" },
        { id: "a1", role: "assistant", content: "", toolCalls: [toolCall] },
      ],
      subscribe: (subscriber: (typeof subscribers)[number]) => {
        subscribers.push(subscriber);
        return { unsubscribe: () => undefined };
      },
    };
    const stop = observeApprovalAgent(agent as never);
    for (const subscriber of subscribers)
      subscriber.onRunInitialized?.({
        input: { runId: "run-1", threadId: "thread", messages: agent.messages, tools: [], context: [], state: {}, forwardedProps: {} },
      });
    const result = await tool?.handler?.({ key: "Enter", ref: "f4e36", snapshotId: 9 }, { agent, toolCall } as never);
    stop();
    return result;
  } finally {
    global.fetch = originalFetch;
  }
}

describe("a computer change that failed on the server", () => {
  test("a 500 comes back as a result the Bot can read, not a thrown error", async () => {
    const result = await callKeyWith(
      Response.json(
        { error: "Element f4e36 is not on the page any more. Take a fresh snapshot and use the refs from it." },
        { status: 500 },
      ),
    );
    expect(result).toEqual({
      ok: false,
      reason: "Element f4e36 is not on the page any more. Take a fresh snapshot and use the refs from it.",
    });
  });

  test("the server's own { ok:false } outcome passes straight through", async () => {
    const result = await callKeyWith(
      Response.json({ result: { ok: false, reason: "stale", staleRefs: true } }, { status: 200 }),
    );
    expect(result).toEqual({ ok: false, reason: "stale", staleRefs: true });
  });

  test("a read-only tool that throws still hands back a result", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Tools />
      </QueryClientProvider>,
    );
    const tool = registered.find((entry) => entry.name === "computer_read");
    const result = await tool?.handler?.({}, { toolCall: { id: "r" } } as never);
    expect(result).toEqual({ ok: false, reason: "这一步没有成功：boom" });
  });
});

describe("neverThrow", () => {
  test("turns any exception into { ok:false }", async () => {
    expect(await neverThrow(undefined, async () => { throw new Error("x"); })).toEqual({ ok: false, reason: "这一步没有成功：x" });
    expect(await neverThrow(undefined, async () => 3)).toBe(3);
  });
  test("a stop still stops", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(neverThrow(controller.signal, async () => { throw new Error("aborted"); })).rejects.toThrow("aborted");
  });
});

describe("a turn that ended without finishing", () => {
  const before = new Set(["u0", "a0"]);
  const call = (id: string, name: string) => ({ id, type: "function", function: { name, arguments: "{}" } });

  test("the production case: the last thing is a tool error, nothing after it", () => {
    const reason = unfinishedTurnReason(
      [
        { id: "u1", role: "user", content: "选啊" },
        { id: "a1", role: "assistant", content: "", toolCalls: [call("k2", "computer_key")] },
        { id: "t1", role: "tool", toolCallId: "k2", content: "Error: Element f4e36 is not on the page any more. Take a fresh snapshot and use the refs from it." },
      ],
      before,
    );
    expect(reason).toBe("机器人在「按键」这一步出错，这一轮没有做完：页面已经变了，它要找的元素不在了。点「重试」再来一次。");
  });

  test("a tool result with no follow-up (e.g. the follow-up limit) is still reported", () => {
    const reason = unfinishedTurnReason(
      [
        { id: "u1", role: "user", content: "hi" },
        { id: "a1", role: "assistant", content: "", toolCalls: [call("c1", "computer_click")] },
        { id: "t1", role: "tool", toolCallId: "c1", content: '{"ok":true}' },
      ],
      before,
    );
    expect(reason).toBe("机器人做完「点击」之后没有接着做，这一轮没有做完。点「重试」再来一次。");
  });

  test("an empty reply is reported", () => {
    expect(
      unfinishedTurnReason([{ id: "u1", role: "user", content: "hi" }, { id: "a1", role: "assistant", content: "" }], before),
    ).toContain("没有给出任何回复");
  });

  test("a normal answer, an approval wait and old messages are not", () => {
    expect(
      unfinishedTurnReason([{ id: "u1", role: "user", content: "hi" }, { id: "a1", role: "assistant", content: "好了" }], before),
    ).toBeNull();
    // 等审批卡：工具调用没有结果，或结果是 { waiting: true }。
    expect(
      unfinishedTurnReason(
        [{ id: "u1", role: "user", content: "hi" }, { id: "a1", role: "assistant", content: "", toolCalls: [call("c1", "computer_click")] }],
        before,
      ),
    ).toBeNull();
    expect(
      unfinishedTurnReason(
        [
          { id: "a1", role: "assistant", content: "", toolCalls: [call("c1", "computer_click")] },
          { id: "t1", role: "tool", toolCallId: "c1", content: '{"waiting":true}' },
        ],
        before,
      ),
    ).toBeNull();
    // 这一轮什么都没加（最后一条是发送前就有的）。
    expect(unfinishedTurnReason([{ id: "a0", role: "assistant", content: "" }], before)).toBeNull();
  });

  test("aborts are told apart from failures", () => {
    expect(isAbortFailure(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortFailure(new Error("The operation was aborted"))).toBe(true);
    expect(isAbortFailure(new Error("500 Internal"))).toBe(false);
  });
});

describe("how the unfinished-turn notice reads", () => {
  test("the reason is shown as the hint under a plain headline, not mistaken for a model timeout", async () => {
    const { friendlyError } = await import("@/lib/chat/friendly-error");
    const reason = "机器人在「按键」这一步出错，这一轮没有做完：Timeout 10000ms exceeded. 点「重试」再来一次。";
    expect(friendlyError(reason)).toEqual({ title: "这一轮没有做完", hint: reason, detail: "", retryable: true });
  });
});
