import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  anchorsPresent,
  attachMidTurnNoticeToToolResult,
  classifyMidTurnIntent,
  formatMidTurnMessageForModel,
  isWorkerResult,
  newSteerSession,
  promptMessageFor,
  steerLanguageModel,
  trailingToolCallIds,
  weaveMessages,
  weavePrompt,
  withSteering,
  WORKER_RESULT_MARKER,
} from "../src/thread-inbox";
import { describeWorkerStep, frameWorkerTask } from "../src/workers/service";

type Prompt = { role: string; content: unknown }[];
const user = (id: string, content: string) => ({ id, role: "user", content }) as Message;
const tool = (id: string, toolCallId: string) => ({ id, role: "tool", toolCallId, content: "ok" }) as Message;
const assistant = (id: string, toolCallId?: string) =>
  ({ id, role: "assistant", content: "", ...(toolCallId ? { toolCalls: [{ id: toolCallId, type: "function", function: { name: "web_search", arguments: "{}" } }] } : {}) }) as Message;

/** 一个假的 AI SDK 模型：记下每一步收到的 prompt。 */
function fakeModel() {
  const prompts: Prompt[] = [];
  const model = {
    modelId: "fake",
    async doStream(options: { prompt: Prompt }) {
      prompts.push(options.prompt);
      return { stream: new ReadableStream() };
    },
  };
  return { model, prompts };
}

const toolStep = (ids: string[]): Prompt[number] => ({
  role: "tool",
  content: ids.map((toolCallId) => ({ type: "tool-result", toolCallId, toolName: "web_search", output: { type: "text", value: "x" } })),
});

describe("weavePrompt", () => {
  test("keeps injections at their original positions while the prompt grows", () => {
    const base: Prompt = [{ role: "system", content: "s" }, { role: "user", content: "q" }, { role: "assistant", content: "a" }, toolStep(["t1"])];
    const injected = { index: 4, messages: [{ role: "user", content: "fix" }] };
    const grown: Prompt = [...base, { role: "assistant", content: "b" }, toolStep(["t2"])];
    expect(weavePrompt(grown, [injected]).map((m) => m.content)).toEqual(["s", "q", "a", base[3]!.content, "fix", "b", grown[5]!.content]);
  });

  test("an index past the end is appended rather than dropped", () => {
    expect(weavePrompt([{ role: "user", content: "q" }], [{ index: 9, messages: [{ role: "user", content: "late" }] }]).map((m) => m.content)).toEqual(["q", "late"]);
  });
});

describe("steerLanguageModel", () => {
  test("injects queued messages at a step boundary and keeps them in later steps", async () => {
    const { model, prompts } = fakeModel();
    const steered = steerLanguageModel(model);
    const queue = [user("m1", "改成只看 2026 年的")];
    const injected: { ids: string[]; anchors: string[] }[] = [];
    const session = newSteerSession(
      async () => queue.splice(0),
      (messages, anchors) => injected.push({ ids: messages.map((m) => m.id), anchors }),
    );
    const first: Prompt = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
    const second: Prompt = [...first, { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1" }] }, toolStep(["t1"])];
    const third: Prompt = [...second, { role: "assistant", content: [{ type: "tool-call", toolCallId: "t2" }] }, toolStep(["t2"])];
    await withSteering(session, async () => {
      await steered.doStream({ prompt: first });
      await steered.doStream({ prompt: second });
      await steered.doStream({ prompt: second }); // a retry of the same step claims nothing new
      await steered.doStream({ prompt: third });
    });
    expect(prompts[0]).toEqual(first);
    expect(prompts[1]!.length).toBe(second.length + 1);
    expect(JSON.stringify(prompts[1]![4])).toContain("改成只看 2026 年的");
    expect(prompts[2]!.length).toBe(second.length + 1);
    // still there, right after the tool result it followed
    expect(JSON.stringify(prompts[3]![4])).toContain("改成只看 2026 年的");
    expect(prompts[3]!.length).toBe(third.length + 1);
    expect(injected).toEqual([{ ids: ["m1"], anchors: ["t1"] }]);
  });

  test("does nothing without a steering session", async () => {
    const { model, prompts } = fakeModel();
    const prompt: Prompt = [{ role: "user", content: "q" }, toolStep(["t1"])];
    await steerLanguageModel(model).doStream({ prompt });
    expect(prompts[0]).toBe(prompt);
  });

  test("does not claim at the first step (the runner already put queued messages in the input)", async () => {
    const { model } = fakeModel();
    let claims = 0;
    const session = newSteerSession(async () => { claims++; return []; }, () => {});
    await withSteering(session, () => steerLanguageModel(model).doStream({ prompt: [{ role: "user", content: "q" }] }));
    expect(claims).toBe(0);
  });

  test("model-only framing for a mid-turn user message; worker results go in as they are", () => {
    expect(JSON.stringify(promptMessageFor(user("a", "再加一条")))).toContain("过程中");
    const result = user("r", `${WORKER_RESULT_MARKER}w1:done⟧\n后台任务「x」已完成。`);
    expect(isWorkerResult(result)).toBe(true);
    expect(JSON.stringify(promptMessageFor(result))).not.toContain("过程中");
  });

  test("classifyMidTurnIntent differentiates interrupt, concurrent new task, and supplement", () => {
    expect(classifyMidTurnIntent("停，别查了，改成看明天上海天气")).toBe("interrupt");
    expect(classifyMidTurnIntent("算了，不用弄刚才那个了")).toBe("interrupt");
    expect(classifyMidTurnIntent("不对，不是这个意思，我是要查高铁")).toBe("interrupt");
    expect(classifyMidTurnIntent("另外帮我查一下下周去东京的机票")).toBe("concurrent");
    expect(classifyMidTurnIntent("顺便帮我整理一份周报草稿")).toBe("concurrent");
    expect(classifyMidTurnIntent("同时再帮我对比一下索尼的型号")).toBe("concurrent");
    expect(classifyMidTurnIntent("预算改成 2000 以内")).toBe("supplement");
    expect(classifyMidTurnIntent("只要京东自营的")).toBe("supplement");
    expect(classifyMidTurnIntent("再加一条：需要支持多设备连接")).toBe("supplement");

    expect(formatMidTurnMessageForModel(user("i1", "停一下，改成查天气"))).toContain("打断指令");
    expect(formatMidTurnMessageForModel(user("c1", "另外帮我查一下机票"))).toContain("新的独立需求");
    expect(formatMidTurnMessageForModel(user("s1", "预算改成 2000"))).toContain("补充更正");
  });

  test("attachMidTurnNoticeToToolResult preserves JSON structure or appends text", () => {
    const jsonOut = attachMidTurnNoticeToToolResult(
      JSON.stringify({ ok: true, count: 3 }),
      [user("m1", "另外帮我查一下机票")],
    );
    const parsed = JSON.parse(jsonOut) as { ok: boolean; count: number; _userMidTurnNotice: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(3);
    expect(parsed._userMidTurnNotice).toContain("新的独立需求");

    const textOut = attachMidTurnNoticeToToolResult("搜索完成", [user("m2", "只要 256G 的")]);
    expect(textOut).toContain("搜索完成");
    expect(textOut).toContain("只要 256G 的");
  });

  test("trailing tool call ids", () => {
    expect(trailingToolCallIds([{ role: "user", content: "q" }, toolStep(["a", "b"]), toolStep(["c"])])).toEqual(["c", "a", "b"]);
    expect(trailingToolCallIds([{ role: "user", content: "q" }])).toEqual([]);
  });
});

describe("weaveMessages", () => {
  test("places an injection right after the tool result it followed, before later output", () => {
    const base = [user("u1", "q"), assistant("a1", "t1"), tool("r1", "t1"), assistant("a2")];
    const woven = weaveMessages(base, [{ message: user("m1", "补充"), anchors: ["t1"] }]);
    expect(woven.map((m) => m.id)).toEqual(["u1", "a1", "r1", "m1", "a2"]);
  });

  test("anchor not applied yet: appended for now, moved into place on the next weave", () => {
    const injection = { message: user("m1", "补充"), anchors: ["t1"] };
    expect(weaveMessages([user("u1", "q"), assistant("a1", "t1")], [injection]).map((m) => m.id)).toEqual(["u1", "a1", "m1"]);
    expect(weaveMessages([user("u1", "q"), assistant("a1", "t1"), tool("r1", "t1"), assistant("a2")], [injection]).map((m) => m.id)).toEqual(["u1", "a1", "r1", "m1", "a2"]);
  });

  test("afterId keeps queue order and never duplicates", () => {
    const base = [user("u1", "q"), assistant("a1")];
    const injections = [
      { message: user("m1", "1"), anchors: [], afterId: "a1" },
      { message: user("m2", "2"), anchors: [], afterId: "a1" },
    ];
    const woven = weaveMessages(base, injections);
    expect(woven.map((m) => m.id)).toEqual(["u1", "a1", "m1", "m2"]);
    expect(weaveMessages(woven, injections).map((m) => m.id)).toEqual(["u1", "a1", "m1", "m2"]);
  });

  test("anchorsPresent", () => {
    expect(anchorsPresent([tool("r1", "t1")], ["t1"])).toBe(true);
    expect(anchorsPresent([assistant("a1", "t1")], ["t1"])).toBe(false);
    expect(anchorsPresent([], [])).toBe(true);
  });
});

describe("worker cards", () => {
  test("step lines read like what the worker is doing", () => {
    expect(describeWorkerStep("computer_navigate", { url: "https://accounts.x.ai/sign-in" })).toBe("正在打开 accounts.x.ai");
    expect(describeWorkerStep("web_search", { query: "降噪耳机 2026 评测" })).toBe("正在搜索「降噪耳机 2026 评测」");
    expect(describeWorkerStep("worker_plan", {})).toBeNull();
    expect(describeWorkerStep("panel_update", {})).toBe("正在更新面板");
  });

  test("the task frame tells the worker to keep a plan and hand back a result", () => {
    const framed = frameWorkerTask("对比耳机", "对比三款");
    expect(framed).toContain("worker_plan");
    expect(framed).toContain("对比三款");
  });
});

describe("weaveMessages order", () => {
  test("several injections behind the same tool result keep queue order", () => {
    const base = [user("u1", "q"), assistant("a1", "t1"), tool("r1", "t1"), assistant("a2")];
    const woven = weaveMessages(base, [
      { message: user("m1", "1"), anchors: ["t1"] },
      { message: user("m2", "2"), anchors: ["t1"] },
    ]);
    expect(woven.map((m) => m.id)).toEqual(["u1", "a1", "r1", "m1", "m2", "a2"]);
  });
});
