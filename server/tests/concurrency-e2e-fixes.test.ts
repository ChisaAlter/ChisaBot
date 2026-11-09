// 2026-10-13 生产实测（后台任务 / 回答中插话）发现的几处问题的回归测试。
import { expect, test } from "bun:test";
import { wakeUpTools } from "../src/agents/wake-up";
import {
  MAX_OUTPUT_CAP,
  outputLimitLanguageModel,
  setModelOutputLimitResolver,
} from "../src/conversation-runtime";
import { stripWorkerMarkers } from "../src/workers/service";

function fakeModel() {
  const seen: unknown[] = [];
  const model = {
    modelId: "x",
    specificationVersion: "v3",
    async doStream(options: unknown) {
      seen.push(options);
      return { stream: new ReadableStream() };
    },
    async doGenerate(options: unknown) {
      seen.push(options);
      return { content: [] };
    },
  };
  return { model, seen };
}

test("unknown Anthropic-protocol models get the catalog's output limit instead of the SDK's 4096", async () => {
  setModelOutputLimitResolver(async (id) =>
    id === "clinepass/cline-free/mimo-v2.6-flash" ? 131072 : undefined,
  );
  const { model, seen } = fakeModel();
  const wrapped = outputLimitLanguageModel(
    model,
    "clinepass/cline-free/mimo-v2.6-flash",
  );
  await wrapped.doStream({ prompt: [] });
  await wrapped.doGenerate({ prompt: [], maxOutputTokens: 256 });
  expect((seen[0] as { maxOutputTokens?: number }).maxOutputTokens).toBe(
    MAX_OUTPUT_CAP,
  );
  expect((seen[1] as { maxOutputTokens?: number }).maxOutputTokens).toBe(256);
  expect(wrapped.modelId).toBe("x");
});

test("no catalog entry or a Claude id leaves the call untouched", async () => {
  setModelOutputLimitResolver(async () => undefined);
  const a = fakeModel();
  await outputLimitLanguageModel(a.model, "someone/unknown").doStream({
    prompt: [],
  });
  expect(
    (a.seen[0] as { maxOutputTokens?: number }).maxOutputTokens,
  ).toBeUndefined();
  setModelOutputLimitResolver(async () => 999999);
  const b = fakeModel();
  expect(outputLimitLanguageModel(b.model, "claude-sonnet-4-5")).toBe(b.model);
  setModelOutputLimitResolver(async () => {
    throw new Error("catalog down");
  });
  const c = fakeModel();
  await outputLimitLanguageModel(c.model, "someone/unknown").doStream({
    prompt: [],
  });
  expect(
    (c.seen[0] as { maxOutputTokens?: number }).maxOutputTokens,
  ).toBeUndefined();
  setModelOutputLimitResolver(async () => undefined);
});

test("a worker's own copy of the result marker is stripped from what it hands back", () => {
  expect(
    stripWorkerMarkers("⟦chisabot:worker-result:⟧ 悉尼当前天气：18°C"),
  ).toBe("悉尼当前天气：18°C");
  expect(
    stripWorkerMarkers("结果\n⟦chisabot:worker-result:abc:done⟧\n正文"),
  ).toBe("结果\n\n正文");
  expect(stripWorkerMarkers("普通文字 ⟦不是标记⟧")).toBe("普通文字 ⟦不是标记⟧");
});

test("cancel_follow_up accepts the bare uuid the model copies out of the full id", async () => {
  const full = 'wake:["u1","a1"]:82c62c55-2f6b-4df9-8013-9478ee311f3c';
  const cancelled: string[] = [];
  const store = {
    async cancel(_owner: string, _agent: string, id: string) {
      if (id === full) {
        cancelled.push(id);
        return true;
      }
      return false;
    },
    async list() {
      return [
        {
          id: full,
          reason: "r",
          dueAt: new Date().toISOString(),
          state: "scheduled",
        },
      ];
    },
    async schedule() {
      throw new Error("unused");
    },
  };
  const tools = wakeUpTools({
    store: store as never,
    ownerUserId: "u1",
    agentId: "a1",
  });
  const cancel = tools.find((tool) => tool.name === "cancel_follow_up")!;
  expect(
    JSON.parse(
      String(
        await cancel.execute({ id: "82c62c55-2f6b-4df9-8013-9478ee311f3c" }),
      ),
    ),
  ).toEqual({ cancelled: true });
  expect(cancelled).toEqual([full]);
  expect(JSON.parse(String(await cancel.execute({ id: "nope" })))).toEqual({
    cancelled: false,
  });
});
