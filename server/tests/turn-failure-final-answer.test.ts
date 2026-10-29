import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { z } from "zod";
import { buildAgents, type RuntimeModel } from "../src/copilot";
import { type GrantedTool, REFUSAL_MARKER } from "../src/plugins/tools";
import { searchQueryForUrl, type WebIo, webTools } from "../src/web/tools";

/**
 * Hark 对比 #12（A4，2026-10-29）：「帮我总结这个网页 <维基>」第一次整轮没有回答。
 * web_fetch 失败（「1 步失败」）之后模型一个字没说，这一轮照样 RUN_FINISHED，界面只剩「这一轮没有收到回答」。
 *
 * 第一组用 aimock 当模型：第一步说一句开场白并调 web_fetch，工具失败，第二步模型返回空内容。
 * 断言这一轮最后一定有一句说清原因的回答（修之前 origin/main 上这里没有任何文字）。
 */

const URL_12 = "https://en.wikipedia.org/wiki/Liquid_glass";
const PROMPT_12 = `帮我总结这个网页 ${URL_12}`;
const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };

function input(): RunAgentInput {
  return {
    threadId: `turn-failure-${crypto.randomUUID()}`,
    runId: `turn-failure-run-${crypto.randomUUID()}`,
    messages: [{ id: "user", role: "user", content: PROMPT_12 }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

/** 这一轮里最后一个工具结果之后说出来的文字。 */
function textAfterLastToolResult(events: BaseEvent[]): string {
  const last = events.findLastIndex(
    (event) => event.type === EventType.TOOL_CALL_RESULT,
  );
  return events
    .slice(last + 1)
    .filter(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT ||
        event.type === EventType.TEXT_MESSAGE_CHUNK,
    )
    .map((event) => String((event as { delta?: unknown }).delta ?? ""))
    .join("")
    .trim();
}

async function runOnce(tool: GrantedTool): Promise<BaseEvent[]> {
  const agents = await buildAgents(
    [
      {
        id: "assistant",
        name: "助手",
        type: "built_in",
        systemPrompt: "你是通用助手。",
      },
    ],
    model,
    "synthetic-fixture-key",
    undefined,
    async () => [tool],
  );
  const agent = agents.assistant?.clone();
  if (!agent) throw new Error("assistant missing");
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    agent.run(input()).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: resolve,
    }),
  );
  return events;
}

const failingFetch = (result: string): GrantedTool => ({
  ref: "web/web_fetch",
  name: "web_fetch",
  description: "读取一个公开网址的内容。",
  parameters: z.object({ url: z.string() }),
  execute: async () => result,
});

describe("一个工具步骤失败之后，这一轮仍然有回答", () => {
  const llm = new LLMock();
  const originalBase = process.env.OPENAI_BASE_URL;
  let secondStep = "";

  beforeAll(async () => {
    process.env.OPENAI_BASE_URL = await llm.start();
    // 第二步（拿到工具结果之后）：按用例决定模型说什么；空字符串就是线上那次「什么都没说」。
    llm.onToolResult("call_fetch_12", () => ({ content: secondStep }));
    llm.onMessage(/总结这个网页/, {
      content: "我先读一下网页内容。",
      toolCalls: [
        {
          id: "call_fetch_12",
          name: "web_fetch",
          arguments: JSON.stringify({ url: URL_12 }),
        },
      ],
    });
  });
  afterAll(async () => {
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await llm.stop();
  });

  test("web_fetch 超时、模型之后返回空内容：最后补一句说清原因的回答，而不是空回复", async () => {
    secondStep = "";
    const events = await runOnce(
      failingFetch(`${REFUSAL_MARKER} 读取失败：请求超时`),
    );
    expect(
      events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    const answer = textAfterLastToolResult(events);
    expect(answer).not.toBe("");
    expect(answer).toContain("读取网页");
    expect(answer).toContain("请求超时");
  });

  test("模型自己解释了失败：不重复补话", async () => {
    secondStep = "这个网页暂时读不到（请求超时），你可以把正文贴过来。";
    const events = await runOnce(
      failingFetch(`${REFUSAL_MARKER} 读取失败：请求超时`),
    );
    expect(textAfterLastToolResult(events)).toBe(secondStep);
  });

  test("用户自己按了停止：不补话", async () => {
    secondStep = "";
    const events = await runOnce(
      failingFetch(`${REFUSAL_MARKER} 用户已停止这一轮，这一步没有执行。`),
    );
    expect(textAfterLastToolResult(events)).toBe("");
  });
});

describe("web_fetch 失败时重试，再降级成搜索摘要", () => {
  const timeout = () => Object.assign(new Error("请求超时"), {});
  const hit = {
    title: "Liquid Glass - Wikipedia",
    url: URL_12,
    snippet: "Liquid Glass is a design language by Apple.",
  };
  const tool = (io: WebIo) => {
    const found = webTools(io).find(
      (candidate) => candidate.name === "web_fetch",
    );
    if (!found) throw new Error("web_fetch missing");
    return found;
  };

  test("第一次超时、第二次成功：重试一次就拿到正文", async () => {
    let calls = 0;
    const result = await tool({
      fetch: async (url) => {
        calls++;
        if (calls === 1) throw timeout();
        return {
          url,
          status: 200,
          kind: "html",
          title: "Liquid Glass",
          text: "正文",
          truncated: false,
        };
      },
      search: async () => [],
    }).execute({ url: URL_12 });
    expect(calls).toBe(2);
    expect(String(result)).toContain("标题：Liquid Glass");
  });

  test("两次都超时：用搜索摘要回答，不算失败步骤", async () => {
    const queries: string[] = [];
    const result = String(
      await tool({
        fetch: async () => {
          throw timeout();
        },
        search: async (query) => {
          queries.push(query);
          return [hit];
        },
      }).execute({ url: URL_12 }),
    );
    expect(queries).toEqual(["Liquid glass wikipedia"]);
    expect(result.startsWith(REFUSAL_MARKER)).toBe(false);
    expect(result).toContain("结果摘要");
    expect(result).toContain("Liquid Glass is a design language by Apple.");
  });

  test("连接被对方掐断（报错里带 aborted）不再说成「用户已停止」", async () => {
    const result = String(
      await tool({
        fetch: async () => {
          throw new Error("aborted");
        },
        search: async () => [],
      }).execute({ url: URL_12 }),
    );
    expect(result).not.toContain("用户已停止");
    expect(result).toContain("读取失败：aborted");
  });

  test("搜索词：维基用条目名，其余用域名和路径", () => {
    expect(searchQueryForUrl(URL_12)).toBe("Liquid glass wikipedia");
    expect(
      searchQueryForUrl("https://www.example.com/blog/hello-world.html"),
    ).toBe("example.com blog hello world");
    expect(searchQueryForUrl("not a url")).toBeNull();
  });
});
