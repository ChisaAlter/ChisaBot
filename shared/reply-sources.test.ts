import { describe, expect, test } from "bun:test";
import { renderUiTools } from "../server/src/generative-ui/render-ui";
import {
  REPLY_SOURCES_GUIDANCE,
  REPLY_SOURCES_MAX,
  type ReplySourceMessage,
  replySourcesByMessage,
  sourceFromFetchResult,
} from "./reply-sources";

/** 与 server/src/web/tools.ts 的 web_fetch 结果开头同一个格式。 */
const fetched = (url: string, title: string, status = 200) =>
  `网址：${url}\n状态：${status}${title ? `\n标题：${title}` : ""}\n<untrusted>正文</untrusted>`;
const call = (id: string, url: string) => ({
  id,
  function: { name: "web_fetch", arguments: JSON.stringify({ url }) },
});

describe("sourceFromFetchResult", () => {
  test("reads url, title and site from the header only", () => {
    expect(
      sourceFromFetchResult(
        fetched(
          "https://en.wikipedia.org/wiki/Liquid_glass#x",
          "Liquid Glass - Wikipedia",
        ),
        undefined,
        "t1",
      ),
    ).toEqual({
      url: "https://en.wikipedia.org/wiki/Liquid_glass",
      title: "Liquid Glass - Wikipedia",
      site: "en.wikipedia.org",
      toolCallId: "t1",
    });
  });
  test("refusals, errors, non-2xx and non-http are not sources", () => {
    expect(
      sourceFromFetchResult("Refused. 读取失败：timeout", undefined, "t"),
    ).toBeNull();
    expect(sourceFromFetchResult("Error: boom", undefined, "t")).toBeNull();
    expect(
      sourceFromFetchResult(
        fetched("https://a.com/", "A", 404),
        undefined,
        "t",
      ),
    ).toBeNull();
    expect(
      sourceFromFetchResult(
        fetched("javascript:alert(1)", "x"),
        undefined,
        "t",
      ),
    ).toBeNull();
  });
  test("falls back to the site when there is no title, and strips www.", () => {
    expect(
      sourceFromFetchResult(
        fetched("https://www.apple.com/iphone-17/specs/", ""),
        undefined,
        "t",
      )?.title,
    ).toBe("apple.com");
  });
});

describe("replySourcesByMessage", () => {
  const messages: ReplySourceMessage[] = [
    {
      id: "u1",
      role: "user",
      content: "总结 https://en.wikipedia.org/wiki/Liquid_glass",
    },
    {
      id: "a1",
      role: "assistant",
      content: "我去读一下。",
      toolCalls: [
        call("c1", "https://en.wikipedia.org/wiki/Liquid_glass"),
        call("c2", "https://bad.example/"),
      ],
    },
    {
      id: "r1",
      role: "tool",
      toolCallId: "c1",
      content: fetched(
        "https://en.wikipedia.org/wiki/Liquid_glass",
        "Liquid Glass",
      ),
    },
    { id: "r2", role: "tool", toolCallId: "c2", content: "Refused. 读取失败" },
    {
      id: "a2",
      role: "assistant",
      content: "Liquid Glass 是 Apple 2025 年发布的设计语言。",
    },
    { id: "u2", role: "user", content: "你好" },
    { id: "a3", role: "assistant", content: "你好。" },
  ];
  test("hangs the turn's fetched pages on its last text message; other turns get none", () => {
    const map = replySourcesByMessage(messages);
    expect([...map.keys()]).toEqual(["a2"]);
    expect(map.get("a2")?.v).toBe(1);
    expect(map.get("a2")?.sources.map((s) => s.url)).toEqual([
      "https://en.wikipedia.org/wiki/Liquid_glass",
    ]);
  });
  test("dedupes and caps", () => {
    const many: ReplySourceMessage[] = [{ id: "u", role: "user" }];
    const calls = Array.from({ length: 8 }, (_, i) =>
      call(`c${i}`, `https://s${i % 7}.com/`),
    );
    many.push({ id: "a", role: "assistant", content: "答", toolCalls: calls });
    for (const c of calls)
      many.push({
        id: `r${c.id}`,
        role: "tool",
        toolCallId: c.id,
        content: fetched(JSON.parse(c.function.arguments).url, ""),
      });
    expect(replySourcesByMessage(many).get("a")?.sources).toHaveLength(
      REPLY_SOURCES_MAX,
    );
  });
  test("web_search results and other tools are not sources", () => {
    const msgs: ReplySourceMessage[] = [
      { id: "u", role: "user" },
      {
        id: "a",
        role: "assistant",
        content: "答",
        toolCalls: [
          { id: "s", function: { name: "web_search", arguments: "{}" } },
        ],
      },
      {
        id: "r",
        role: "tool",
        toolCallId: "s",
        content: fetched("https://x.com/", "X"),
      },
    ];
    expect(replySourcesByMessage(msgs).size).toBe(0);
  });
});

describe("prompt switch", () => {
  test("render_ui carries the sources rule only when the deployment turned it on", () => {
    expect(renderUiTools()[0]?.guidance).toBeUndefined();
    expect(renderUiTools({ replySources: true })[0]?.guidance).toBe(
      REPLY_SOURCES_GUIDANCE,
    );
  });
});
