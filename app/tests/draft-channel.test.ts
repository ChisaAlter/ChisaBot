import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  holdDraftChannel,
  isDraftChannel,
  markDraftChannel,
  moveTextDraft,
  releaseDraftChannel,
  resetDraftChannelsForTest,
  settleDraftChannel,
} from "@/lib/channels/draft-channel";
import {
  resetUiMemory,
  setThreadUi,
  stashDraftFiles,
  takeDraftFiles,
  threadUi,
} from "@/lib/chat/ui-memory";

/**
 * 新话题页上加附件时提前建的草稿对话（A1）：发出第一条之前离开就删掉，删之前把写了一半的字放回新话题页；
 * 发出去以后就是普通对话，离开不删。
 */

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered)
    GlobalRegistrator.register({ url: "http://localhost/" });
});
afterAll(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});
beforeEach(() => {
  resetDraftChannelsForTest();
  resetUiMemory();
});
afterEach(() => {
  resetDraftChannelsForTest();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("没发就离开：删掉草稿对话，字放回新话题页，文件丢掉", async () => {
  const removed: string[] = [];
  markDraftChannel("ch_a", "new:bot");
  setThreadUi("ch_a", { draft: [{ type: "text", text: "看这张图" }] });
  stashDraftFiles("ch_a", [new File(["x"], "a.png", { type: "image/png" })]);

  const release = holdDraftChannel("ch_a", async (id) => removed.push(id));
  release();
  await tick();

  expect(removed).toEqual(["ch_a"]);
  expect(isDraftChannel("ch_a")).toBe(false);
  expect(threadUi("new:bot")?.draft).toEqual([
    { type: "text", text: "看这张图" },
  ]);
  expect(threadUi("ch_a")?.draft).toBeUndefined();
  expect(takeDraftFiles("ch_a")).toEqual([]);
});

test("发出第一条以后离开：不删", async () => {
  const removed: string[] = [];
  markDraftChannel("ch_b", "new:bot");
  const release = holdDraftChannel("ch_b", async (id) => removed.push(id));
  settleDraftChannel("ch_b");
  release();
  await tick();
  expect(removed).toEqual([]);
});

test("StrictMode 的「挂载 → 卸载 → 挂载」不算离开", async () => {
  const removed: string[] = [];
  const remove = async (id: string) => removed.push(id);
  markDraftChannel("ch_c", "new:bot");
  holdDraftChannel("ch_c", remove)();
  const second = holdDraftChannel("ch_c", remove);
  await tick();
  expect(removed).toEqual([]);
  expect(isDraftChannel("ch_c")).toBe(true);
  second();
  await tick();
  expect(removed).toEqual(["ch_c"]);
});

test("普通对话的页面卸载什么都不删", async () => {
  const removed: string[] = [];
  holdDraftChannel("ch_plain", async (id) => removed.push(id))();
  releaseDraftChannel("ch_plain", async (id) => removed.push(id));
  await tick();
  expect(removed).toEqual([]);
});

test("删不掉也不抛出（它没有消息，列表本来就不列它）", async () => {
  markDraftChannel("ch_d", "new:bot");
  releaseDraftChannel("ch_d", async () => {
    throw new Error("offline");
  });
  await tick();
  expect(isDraftChannel("ch_d")).toBe(false);
});

test("刷新后还记得哪段是草稿（sessionStorage）", () => {
  markDraftChannel("ch_e", "new:bot");
  // 模拟刷新：清掉内存里的那份，只留 sessionStorage。
  const saved = window.sessionStorage.getItem("chisabot-draft-channels:v1");
  resetDraftChannelsForTest();
  window.sessionStorage.setItem("chisabot-draft-channels:v1", saved ?? "");
  expect(isDraftChannel("ch_e")).toBe(true);
});

test("挪字：目标已经有字时不覆盖，源头总是清掉", () => {
  setThreadUi("from", { draft: [{ type: "text", text: "一" }] });
  setThreadUi("to", { draft: [{ type: "text", text: "二" }] });
  moveTextDraft("from", "to");
  expect(threadUi("from")?.draft).toBeUndefined();
  expect(threadUi("to")?.draft).toEqual([{ type: "text", text: "二" }]);
});

test("默认的删除带条件（?draft=1）：服务端仍是空草稿才删，回 409 时这里也不抛出", async () => {
  const original = globalThis.fetch;
  const calls: { method: string; path: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: String(input) });
    return Response.json(
      { error: "This conversation is not an empty draft, so it was kept." },
      { status: 409 },
    );
  }) as typeof fetch;
  try {
    markDraftChannel("ch_f", "new:bot");
    releaseDraftChannel("ch_f");
    await tick();
    expect(calls).toEqual([
      { method: "DELETE", path: "/api/channels/ch_f?draft=1" },
    ]);
    expect(isDraftChannel("ch_f")).toBe(false);
  } finally {
    globalThis.fetch = original;
  }
});
