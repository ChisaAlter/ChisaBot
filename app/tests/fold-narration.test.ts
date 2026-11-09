import { describe, expect, test } from "bun:test";
import {
  type BaseEvent,
  defaultApplyEvents,
  type Message,
} from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { compactTurns } from "../src/components/channels/chat-transcript";
import {
  plainNote,
  workStepLines,
  workTimeline,
} from "../src/lib/chat/work-steps";
import {
  liveTailOf,
  tailReplayPatch,
} from "../src/lib/conversations/use-conversation-sync";

/**
 * DESIGN.md §90：中途说明文字（过程话）收进干活卡；liveTail 接入回放不再把同一段话接两遍。
 * 复现的是 2026-10-16 15:40 星灵那段对话：「检查结果显示 Node.js/npm 都未安装…」散在「做了 3 步」下面，
 * 「刚才安装调用中断了…」出现两遍。
 */
type Item = Parameters<typeof compactTurns>[0][number];
const user = (id: string, text: string): Item =>
  ({ kind: "text", id, role: "user", text }) as Item;
const bot = (id: string, text: string): Item =>
  ({ kind: "text", id, role: "assistant", text }) as Item;
const call = (
  id: string,
  name: string,
  result: string | undefined = "ok",
  args: Record<string, unknown> = { command: "node -v" },
): Item =>
  ({
    kind: "tool",
    id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    ...(result === undefined ? {} : { result }),
  }) as Item;

const NARRATION =
  "检查结果显示 Node.js/npm 都未安装，Ayase 有 `winget`。我先用它安装 Node.js LTS，完成后再装你指定的包。";

describe("过程话收进干活卡（§90）", () => {
  test("narration → tool：结束后收起，并按位置进卡片", () => {
    const items = [
      user("u1", "安装修复"),
      bot("a1", "我先检查 Node.js 和 npm。"),
      call("t1", "device_run_shell"),
      call("t2", "device_run_shell"),
      bot("a2", NARRATION),
      call("t3", "device_run_shell"),
      bot("a3", "装好了，版本 v22。"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.tone.get("a1")).toBe("lead");
    // §93：开场一句也收进卡片（原 §90 留它当气泡）。
    expect(compact.hidden.has("a1")).toBe(true);
    expect(compact.hidden.has("a2")).toBe(true);
    expect(compact.tone.get("a3")).toBe("final");
    expect(compact.hidden.has("a3")).toBe(false);
    expect(compact.work.get("t1")?.notes).toEqual([
      { at: 0, text: "我先检查 Node.js 和 npm。" },
      { at: 2, text: NARRATION },
    ]);
  });

  test("narration → tool：还在跑时，后面一调工具就收；最后一段（后面还没工具）照旧露着", () => {
    const items = [
      user("u1", "安装修复"),
      bot("a1", "我先检查。"),
      call("t1", "device_run_shell"),
      bot("a2", NARRATION),
      call("t2", "device_run_shell", undefined),
      bot("a3", "安装中，请在电脑上批准。"),
    ];
    const compact = compactTurns(items, true, new Set());
    expect(compact.hidden.has("a2")).toBe(true);
    expect(compact.hidden.has("a3")).toBe(false);
    expect(compact.tone.get("a3")).toBe("step");
    expect(compact.work.get("t1")?.live).toBe(true);
    expect(compact.work.get("t1")?.notes.map((n) => n.text)).toEqual([
      "我先检查。",
      NARRATION,
    ]);
  });

  test("narration → 中断的工具 → 出错（截图那一轮）：不再散在卡片下面", () => {
    const items = [
      user("u1", "安装修复"),
      bot("a1", "我先检查。"),
      call("t1", "device_run_shell"),
      call("t2", "device_run_shell"),
      bot("a2", NARRATION),
      call(
        "t3",
        "device_run_shell",
        "This call produced no result: the surface was interrupted before it could answer.",
      ),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.hidden.has("a2")).toBe(true);
    expect(compact.work.get("t1")?.notes.map((n) => n.text)).toEqual([
      "我先检查。",
      NARRATION,
    ]);
  });

  test("narration → 出错（后面没有工具）：照旧当结果——本机的「出错」可能只是流断了，服务器接着写完了（§90.4）", () => {
    const items = [
      user("u1", "安装修复"),
      bot("a1", "我先检查。"),
      call("t1", "device_run_shell"),
      bot("a2", NARRATION),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.tone.get("a2")).toBe("final");
    expect(compact.hidden.has("a2")).toBe(false);
  });

  test("narration → 停止（abort）：收进卡片，「已停止」挂在卡片那一行", () => {
    const items = [
      user("u1", "安装修复"),
      bot("a1", "我先检查。"),
      call("t1", "device_run_shell"),
      bot("a2", NARRATION),
    ];
    const compact = compactTurns(items, false, new Set(["u1"]));
    expect(compact.hidden.has("a2")).toBe(true);
    expect(compact.work.get("t1")?.notes.map((n) => n.text)).toEqual([
      "我先检查。",
      NARRATION,
    ]);
    expect(compact.stoppedAfter.has("t1")).toBe(true);
  });

  test("narration 就是结果：照旧是气泡，不进卡片", () => {
    const items = [
      user("u1", "安装修复"),
      bot("a1", "我先检查。"),
      call("t1", "device_run_shell"),
      bot("a2", "装好了。"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.tone.get("a2")).toBe("final");
    expect(compact.hidden.has("a2")).toBe(false);
    expect(compact.work.get("t1")?.notes.map((n) => n.text)).toEqual([
      "我先检查。",
    ]);
  });

  test("没有干活卡的一轮：规则不变（只有 render_ui / 技能）", () => {
    const items = [
      user("u1", "画个表"),
      bot("a1", "好的"),
      call("s1", "skill_list"),
      bot("a2", "在画"),
      call("r1", "render_ui"),
    ];
    const running = compactTurns(items, true, new Set());
    expect(running.work.size).toBe(0);
    expect(running.hidden.has("a2")).toBe(false);
  });

  test("卡片之后才出现的第一段话也算过程话", () => {
    const items = [
      user("u1", "查"),
      call("t1", "web_search", "ok", { query: "x" }),
      bot("a1", "再搜一次。"),
      call("t2", "web_search", "ok", { query: "y" }),
      bot("a2", "结果是 42。"),
    ];
    const compact = compactTurns(items, false, new Set());
    expect(compact.hidden.has("a1")).toBe(true);
    expect(compact.tone.get("a2")).toBe("final");
  });
});

describe("卡片点开的一列（§90）", () => {
  const calls = [
    { name: "skill_list", arguments: "{}", done: true },
    {
      name: "web_search",
      arguments: JSON.stringify({ query: "a" }),
      done: true,
    },
    {
      name: "web_search",
      arguments: JSON.stringify({ query: "b" }),
      done: true,
    },
  ];
  test("没有过程话时和 workStepLines 一样", () => {
    expect(workTimeline(calls).map((l) => l.text)).toEqual(
      workStepLines(calls),
    );
  });
  test("过程话按位置插在步骤之间，markdown 记号去掉", () => {
    const lines = workTimeline(calls, [
      { at: 2, text: "第一次没搜到，用 `b` 再搜。" },
      { at: 3, text: "**好了**" },
    ]);
    expect(lines.map((l) => l.kind)).toEqual(["step", "note", "step", "note"]);
    expect(lines[1]!.text).toBe("第一次没搜到，用 b 再搜。");
    expect(lines[3]!.text).toBe("好了");
    expect(plainNote("- 一\n- 二")).toBe("一 二");
  });
});

describe("liveTail 接入回放不再把同一段话接两遍（§90.3）", () => {
  const LEAD = "刚才安装调用中断了，我先确认 Node.js 是否已经装好。";
  const local: Message[] = [
    { id: "u1", role: "user", content: "你好？" },
    {
      id: "a1",
      role: "assistant",
      content: LEAD,
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "device_run_shell",
            arguments: '{"command":"node -v"}',
          },
        },
      ],
    },
    { id: "r1", role: "tool", content: "exit 1", toolCallId: "c1" },
  ] as Message[];
  // 服务器 connect 回放（compactEvents 之后，每条一个 CONTENT）
  const replay = [
    { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: LEAD },
    { type: "TEXT_MESSAGE_END", messageId: "a1" },
    {
      type: "TOOL_CALL_START",
      toolCallId: "c1",
      toolCallName: "device_run_shell",
      parentMessageId: "a1",
    },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: "c1",
      delta: '{"command":"node -v"}',
    },
    { type: "TOOL_CALL_END", toolCallId: "c1" },
    {
      type: "TOOL_CALL_RESULT",
      messageId: "r1",
      toolCallId: "c1",
      content: "exit 1",
      role: "tool",
    },
    { type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "a2",
      delta: "Node.js 还没安装成功。",
    },
    { type: "TEXT_MESSAGE_END", messageId: "a2" },
  ] as BaseEvent[];

  async function apply(subscribers: Parameters<typeof defaultApplyEvents>[3]) {
    const input = {
      threadId: "t",
      runId: "r",
      messages: local,
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    const agent = { messages: local, state: {} } as never;
    const out = await lastValueFrom(
      defaultApplyEvents(input as never, from(replay), agent, subscribers).pipe(
        toArray(),
      ),
    );
    return [...out].reverse().find((m) => m.messages)?.messages ?? local;
  }

  test("SDK 自己不清空已有消息：不处理就会接成两遍（这就是 bug）", async () => {
    const messages = await apply([]);
    expect(messages.find((m) => m.id === "a1")?.content).toBe(LEAD + LEAD);
  });

  test("tailReplayPatch：正文、参数各一份，工具结果不多一条，新消息照常接上", async () => {
    const tail = liveTailOf(local as never);
    const messages = await apply([
      {
        onEvent: ({ event, messages }) =>
          tailReplayPatch(event as never, messages as never, tail) as never,
      },
    ]);
    expect(messages.find((m) => m.id === "a1")?.content).toBe(LEAD);
    const toolCall = (
      messages.find((m) => m.id === "a1") as {
        toolCalls?: { function: { arguments: string } }[];
      }
    ).toolCalls?.[0];
    expect(toolCall?.function.arguments).toBe('{"command":"node -v"}');
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "r1", "a2"]);
    expect(messages.find((m) => m.id === "a2")?.content).toBe(
      "Node.js 还没安装成功。",
    );
  });

  test("最后一条用户消息之前的不在 tail 里，不动", () => {
    const tail = liveTailOf([
      { id: "u0", role: "user" },
      { id: "a0", role: "assistant" },
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant", toolCalls: [{ id: "c1" }] },
    ]);
    expect([...tail.messages]).toEqual(["a1"]);
    expect([...tail.toolCalls]).toEqual(["c1"]);
    expect(
      tailReplayPatch(
        { type: "TEXT_MESSAGE_START", messageId: "a0" },
        [{ id: "a0", role: "assistant", content: "x" }],
        tail,
      ),
    ).toBeUndefined();
  });
});
