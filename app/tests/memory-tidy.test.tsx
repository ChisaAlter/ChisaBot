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
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  runMemoryTidy,
  tidyConfirmItems,
} from "@/components/memory/memory-tidy";
import { ConfirmHost } from "@/components/ui/confirm";
import { resetToastsForTest, Toaster } from "@/components/ui/toast";
import type { MemoryTidyPreview } from "../../shared/memory-notes";
import { settleReactWork } from "./settle-react-work";

/**
 * 设置 → 记忆 →「更多」→「整理记忆…」（审计 12-settings 必修 1）：先预览、确认弹窗列出将合并的组，
 * 确认后带 token 整理，整理后给「撤销」；取消就什么都不发。
 */

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let originalFetch: typeof fetch;
let preview: MemoryTidyPreview;

const PREVIEW: MemoryTidyPreview = {
  token: "tok123",
  groups: [
    {
      kind: "person",
      title: "小林",
      agentId: "bot-a",
      context: null,
      count: 3,
      ids: ["mem_1", "mem_2", "mem_3"],
      length: 120,
      skipped: null,
    },
    {
      kind: "note",
      title: "长文",
      agentId: null,
      context: null,
      count: 2,
      ids: ["mem_4", "mem_5"],
      length: 6001,
      skipped: "too_long",
    },
  ],
  mergedCount: 2,
  deduplicatedCount: 1,
  totalRemaining: 4,
};

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3710/settings/memory" });
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  resetToastsForTest();
  calls = [];
  preview = structuredClone(PREVIEW);
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      if (url.endsWith("/dream/undo"))
        return Response.json({ restored: 3, skipped: 0 });
      if (url.endsWith("/dream") && method === "POST")
        return Response.json({
          ...preview,
          batchId: "tidy_abcdef0123456789",
          summary: "已整理记忆：合并了 2 条重复笔记",
        });
      if (url.endsWith("/dream")) return Response.json({ preview, last: null });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

const posts = () => calls.filter((call) => call.method === "POST");

test("确认弹窗的条目：种类、主题、谁记的、几条并一条；太长的写明不合并", () => {
  const items = tidyConfirmItems(PREVIEW, (id) =>
    id === "bot-a" ? "小助手" : null,
  );
  expect(items).toEqual([
    "人物「小林」（小助手记的）：3 条合并为 1 条",
    "其他「长文」（你记的）：2 条合并后有 6001 字，超过 4000 字，不合并",
    "另有 1 条笔记去掉重复的行",
  ]);
});

test("点整理先弹确认并列出组；取消就不整理", async () => {
  const view = render(
    <>
      <ConfirmHost />
      <Toaster />
    </>,
  );
  let done: Promise<boolean> = Promise.resolve(false);
  await act(async () => {
    done = runMemoryTidy({ refresh: async () => {} });
  });
  await waitFor(() =>
    expect(view.getByText("合并 1 组重复的记忆？")).toBeTruthy(),
  );
  expect(view.getByTestId("confirm-items").textContent).toContain(
    "人物「小林」（机器人记的）：3 条合并为 1 条",
  );
  fireEvent.click(view.getByRole("button", { name: "取消" }));
  expect(await done).toBe(false);
  expect(posts()).toHaveLength(0);
});

test("确认后带 token 整理，给「撤销」，点了就放回原文", async () => {
  const view = render(
    <>
      <ConfirmHost />
      <Toaster />
    </>,
  );
  let refreshed = 0;
  let done: Promise<boolean> = Promise.resolve(false);
  await act(async () => {
    done = runMemoryTidy({ refresh: async () => void refreshed++ });
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "整理" })).toBeTruthy(),
  );
  fireEvent.click(view.getByRole("button", { name: "整理" }));
  expect(await done).toBe(true);
  expect(posts()[0]).toMatchObject({
    method: "POST",
    body: { token: "tok123" },
  });
  expect(posts()[0]!.url).toEndWith("/api/memory-notes/dream");
  await waitFor(() =>
    expect(view.getByRole("button", { name: "撤销" })).toBeTruthy(),
  );
  fireEvent.click(view.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1]).toMatchObject({
    body: { batchId: "tidy_abcdef0123456789" },
  });
  await waitFor(() =>
    expect(view.getByText("已恢复整理前的 3 条记忆。")).toBeTruthy(),
  );
  expect(refreshed).toBe(2);
});

test("没有可合并的：不弹确认、不整理", async () => {
  preview = {
    ...PREVIEW,
    groups: [PREVIEW.groups[1]!],
    mergedCount: 0,
    deduplicatedCount: 0,
  };
  const view = render(
    <>
      <ConfirmHost />
      <Toaster />
    </>,
  );
  let result = true;
  await act(async () => {
    result = await runMemoryTidy({ refresh: async () => {} });
  });
  expect(result).toBe(false);
  expect(posts()).toHaveLength(0);
  expect(view.queryByRole("button", { name: "整理" })).toBeNull();
  await waitFor(() =>
    expect(view.getByText(/没有可以合并的记忆/)).toBeTruthy(),
  );
});
