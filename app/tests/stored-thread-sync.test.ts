import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  readStoredRows,
  readThreadMessages,
  resetStoredSyncs,
} from "@/lib/copilot/thread-messages";
import { applyStoredAnswer } from "@/lib/copilot/thread-sync";

/*
 * 恢复历史（readThreadMessages，channel-chat 各处读存储都走它）和对话顺序核对（use-conversation-sync）
 * 的增量读：第一次 since= 拿整份和 version / cursor，之后带 since+cursor，没变只回 unchanged，
 * 只变尾部只回尾部；对不上、读失败、旧服务器都退回整份。
 */
const NativeResponse = globalThis.Response;
const one = { id: "one", role: "user", content: "first" };
const two = { id: "two", role: "assistant", content: "second" };
const three = { id: "three", role: "assistant", content: "third" };
const edited = { id: "two", role: "assistant", content: "second, edited" };

let originalFetch: typeof fetch;
let answers: unknown[] = [];
let sent: URLSearchParams[] = [];

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    sent.push(url.searchParams);
    const answer = answers.shift();
    if (answer === undefined) throw new Error("No scripted answer");
    return typeof answer === "number"
      ? new NativeResponse("nope", { status: answer })
      : NativeResponse.json(answer);
  }) as typeof fetch;
});
afterEach(() => {
  resetStoredSyncs();
  answers = [];
  sent = [];
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const query = (index: number) => {
  const params = sent[index];
  if (!params) throw new Error(`No request ${index}`);
  return {
    agentId: params.get("agentId"),
    since: params.get("since"),
    cursor: params.get("cursor"),
  };
};

test("history reads send since, then since+cursor, and an unchanged answer returns the very same result", async () => {
  answers = [
    { messages: [one, two], version: "v1", cursor: "c1", start: 0 },
    { unchanged: true, version: "v1", cursor: "c1" },
  ];
  const first = await readThreadMessages("thread", "bot");
  expect(first.messages.map((message) => message.id)).toEqual(["one", "two"]);
  expect(query(0)).toEqual({ agentId: "bot", since: "", cursor: null });
  const second = await readThreadMessages("thread", "bot");
  expect(query(1)).toEqual({ agentId: "bot", since: "v1", cursor: "c1" });
  // 同一个对象：channel-chat 的 mergeStoredMessages / withStoredTail 原样返回本地数组，不会 setMessages。
  expect(second).toBe(first);
});

test("a tail answer is appended to the stored rows", async () => {
  answers = [
    { messages: [one, two], version: "v1", cursor: "c1", start: 0 },
    { messages: [two, three], version: "v2", cursor: "c2", start: 1 },
    { unchanged: true, version: "v2", cursor: "c2" },
  ];
  await readThreadMessages("thread", "bot");
  const grown = await readThreadMessages("thread", "bot");
  expect(grown.messages.map((message) => message.id)).toEqual([
    "one",
    "two",
    "three",
  ]);
  await readThreadMessages("thread", "bot");
  expect(query(2)).toEqual({ agentId: "bot", since: "v2", cursor: "c2" });
});

test("an edit or delete (server answers from 0) replaces the whole list", async () => {
  answers = [
    { messages: [one, two, three], version: "v1", cursor: "c1", start: 0 },
    { messages: [one, edited], version: "v2", cursor: "c2", start: 0 },
  ];
  await readThreadMessages("thread", "bot");
  const after = await readThreadMessages("thread", "bot");
  expect(after.messages as readonly unknown[]).toEqual([one, edited]);
});

test("an answer that does not fit the stored base drops it and reads the whole list once more", async () => {
  answers = [
    { messages: [one], version: "v1", cursor: "c1", start: 0 },
    { messages: [three], version: "v9", cursor: "c9", start: 5 },
    { messages: [one, two, three], version: "v3", cursor: "c3", start: 0 },
  ];
  await readThreadMessages("thread", "bot");
  const after = await readThreadMessages("thread", "bot");
  expect(query(1)).toEqual({ agentId: "bot", since: "v1", cursor: "c1" });
  expect(query(2)).toEqual({ agentId: "bot", since: "", cursor: null });
  expect(after.messages.map((message) => message.id)).toEqual([
    "one",
    "two",
    "three",
  ]);
});

test("a failed read (401 / 5xx) stays unavailable and the next read starts over", async () => {
  answers = [
    { messages: [one], version: "v1", cursor: "c1", start: 0 },
    401,
    { messages: [one], version: "v1", cursor: "c1", start: 0 },
  ];
  await readThreadMessages("thread", "bot");
  const failed = await readThreadMessages("thread", "bot");
  expect(failed.availability).toBe("unavailable");
  expect(failed.messages).toEqual([]);
  await readThreadMessages("thread", "bot");
  expect(query(2)).toEqual({ agentId: "bot", since: "", cursor: null });
});

test("a server without the delta protocol keeps answering the whole list", async () => {
  answers = [{ messages: [one] }, { messages: [one, two] }];
  await readThreadMessages("thread", "bot");
  const after = await readThreadMessages("thread", "bot");
  expect(query(1)).toEqual({ agentId: "bot", since: "", cursor: null });
  expect(after.messages.map((message) => message.id)).toEqual(["one", "two"]);
});

test("the order check reads through the caller's request, without agentId, and keeps its own base", async () => {
  const paths: string[] = [];
  const request = async (path: string) => {
    paths.push(path);
    return globalThis.fetch(path);
  };
  answers = [
    { messages: [one], version: "v1", cursor: "c1", start: 0 },
    { unchanged: true, version: "v1", cursor: "c1" },
  ];
  const first = await readStoredRows("thread", undefined, request);
  const second = await readStoredRows("thread", undefined, request);
  expect(second).toBe(first);
  expect(paths[0]).toBe("/api/copilotkit/threads/thread/messages?since=");
  expect(query(1)).toEqual({ agentId: null, since: "v1", cursor: "c1" });
});

test("applyStoredAnswer rejects answers it cannot place", () => {
  const base = { version: "v1", cursor: "c1", rows: [one, two] };
  expect(
    applyStoredAnswer(null, { unchanged: true, version: "v1", cursor: "c1" }),
  ).toBeNull();
  expect(applyStoredAnswer(base, { messages: [three], start: 3 })).toBeNull();
  expect(applyStoredAnswer(base, { messages: [three], start: -1 })).toBeNull();
  expect(applyStoredAnswer(base, { nope: true })).toBeNull();
  expect(
    applyStoredAnswer(base, {
      messages: [three],
      start: 2,
      version: "v2",
      cursor: "c2",
    })?.rows,
  ).toEqual([one, two, three]);
});
