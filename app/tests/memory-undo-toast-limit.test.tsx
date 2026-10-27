import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  jest,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  deleteWithUndo,
  flushOnPageHide,
  MEMORY_UNDO_MS,
  MEMORY_UNDO_TOAST_LIMIT,
  pendingMemoryDeletes,
} from "@/components/memory/memory-notes";
import { Toaster } from "@/components/ui/toast";
import type { MemoryNoteView } from "../../shared/memory-notes";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-111：连删记忆时撤销提示不堆叠。同时最多 3 条单独的「撤销」；第 4 次起并进一条
 * 「已删除 N 条记忆 · 全部撤销」。「全部撤销」只撤合并进来的那些，单独显示的各自撤销。
 * 一条都不丢：每次待删除都能撤、计时到了都真删。
 */

let forgets: string[][] = [];
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3710/settings/memory" });
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  forgets = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("/forget") && typeof init?.body === "string")
        forgets.push((JSON.parse(init.body) as { ids: string[] }).ids);
      return Response.json({ removed: 1 });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  jest.useFakeTimers();
});
afterEach(async () => {
  // 把本测试剩下的待删除都走完，模块级状态不串到下一条。
  // 真删是异步的，删完才收提示、收提示又有 180ms 退场计时：多走几轮。
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(MEMORY_UNDO_MS + 1000);
    await settle();
  }
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  cleanup();
});

const note = (i: number): MemoryNoteView =>
  ({
    id: `mem_${String(i).padStart(20, "0")}`,
    kind: "preference",
    subject: `记忆${i}`,
    content: `内容${i}`,
    context: null,
    agentId: null,
    author: "you",
    shared: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as MemoryNoteView;

const flush = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
const settle = async () => {
  await act(async () => {
    await flush();
  });
};
const deleted = () => forgets.flat().sort();

test("上限是 3：前 3 次各一条「撤销」，第 4、5 次并进「已删除 2 条记忆」", async () => {
  expect(MEMORY_UNDO_TOAST_LIMIT).toBe(3);
  const view = render(<Toaster />);
  for (let i = 1; i <= 3; i++) deleteWithUndo([note(i)], async () => {});
  await settle();
  expect(view.getAllByRole("button", { name: "撤销" })).toHaveLength(3);
  expect(view.queryByRole("button", { name: "全部撤销" })).toBeNull();

  deleteWithUndo([note(4)], async () => {});
  await settle();
  expect(view.getAllByRole("button", { name: "撤销" })).toHaveLength(3);
  expect(view.getAllByRole("button", { name: "全部撤销" })).toHaveLength(1);
  expect(view.getByText("已删除 1 条记忆")).toBeTruthy();

  deleteWithUndo([note(5)], async () => {});
  await settle();
  expect(view.getAllByRole("status")).toHaveLength(4);
  expect(view.getByText("已删除 2 条记忆")).toBeTruthy();
  // 批量删（一次 3 条）并进来按记忆条数算。
  deleteWithUndo([note(6), note(7), note(8)], async () => {});
  await settle();
  expect(view.getByText("已删除 5 条记忆")).toBeTruthy();
  expect(pendingMemoryDeletes.snapshot().size).toBe(8);
});

test("计时到了每一条都真删（含合并的），合并提示随之收起", async () => {
  const view = render(<Toaster />);
  for (let i = 1; i <= 5; i++) deleteWithUndo([note(i)], async () => {});
  await settle();
  jest.advanceTimersByTime(MEMORY_UNDO_MS - 1);
  await settle();
  expect(forgets).toHaveLength(0);
  expect(view.getByText("已删除 2 条记忆")).toBeTruthy();
  jest.advanceTimersByTime(1);
  await settle();
  expect(deleted()).toEqual([1, 2, 3, 4, 5].map((i) => note(i).id).sort());
  expect(pendingMemoryDeletes.snapshot().size).toBe(0);
  jest.advanceTimersByTime(300);
  await settle();
  expect(view.queryByRole("button", { name: "全部撤销" })).toBeNull();
});

test("错开时间删：合并的条数随各自到期递减，提示一直留到最后一条", async () => {
  const view = render(<Toaster />);
  for (let i = 1; i <= 3; i++) deleteWithUndo([note(i)], async () => {});
  deleteWithUndo([note(4)], async () => {});
  jest.advanceTimersByTime(2000);
  deleteWithUndo([note(5)], async () => {});
  await settle();
  expect(view.getByText("已删除 2 条记忆")).toBeTruthy();
  jest.advanceTimersByTime(MEMORY_UNDO_MS - 2000);
  await settle();
  expect(deleted()).toEqual([1, 2, 3, 4].map((i) => note(i).id).sort());
  expect(view.getByText("已删除 1 条记忆")).toBeTruthy();
  // 第 5 条还在窗口里：仍可撤销。
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "全部撤销" }));
  });
  jest.advanceTimersByTime(MEMORY_UNDO_MS);
  await settle();
  expect(deleted()).not.toContain(note(5).id);
  expect(pendingMemoryDeletes.snapshot().has(note(5).id)).toBe(false);
});

test("「全部撤销」撤回所有合并进来的；单独显示的不受影响、到期照删", async () => {
  const view = render(<Toaster />);
  for (let i = 1; i <= 6; i++) deleteWithUndo([note(i)], async () => {});
  await settle();
  expect(view.getByText("已删除 3 条记忆")).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "全部撤销" }));
  });
  expect(
    [4, 5, 6].some((i) => pendingMemoryDeletes.snapshot().has(note(i).id)),
  ).toBe(false);
  expect(pendingMemoryDeletes.snapshot().size).toBe(3);
  jest.advanceTimersByTime(MEMORY_UNDO_MS);
  await settle();
  expect(deleted()).toEqual([1, 2, 3].map((i) => note(i).id).sort());
});

test("单独的「撤销」照常可用，撤掉一条后空出的位置给下一次删除", async () => {
  const view = render(<Toaster />);
  for (let i = 1; i <= 4; i++) deleteWithUndo([note(i)], async () => {});
  await settle();
  await act(async () => {
    fireEvent.click(
      view.getAllByRole("button", { name: "撤销" })[1] as HTMLElement,
    );
  });
  jest.advanceTimersByTime(300);
  await settle();
  expect(pendingMemoryDeletes.snapshot().has(note(2).id)).toBe(false);
  expect(view.getAllByRole("button", { name: "撤销" })).toHaveLength(2);
  deleteWithUndo([note(5)], async () => {});
  await settle();
  // 有空位：第 5 次单独显示，合并提示仍只有第 4 次。
  expect(view.getAllByRole("button", { name: "撤销" })).toHaveLength(3);
  expect(view.getByText("已删除 1 条记忆")).toBeTruthy();
  jest.advanceTimersByTime(MEMORY_UNDO_MS);
  await settle();
  expect(deleted()).toEqual([1, 3, 4, 5].map((i) => note(i).id).sort());
});

test("关页（pagehide）时合并的也用 keepalive 发出去，一条不丢", async () => {
  const view = render(<Toaster />);
  for (let i = 1; i <= 5; i++) deleteWithUndo([note(i)], async () => {});
  await settle();
  flushOnPageHide();
  await settle();
  expect(deleted()).toEqual([1, 2, 3, 4, 5].map((i) => note(i).id).sort());
  expect(pendingMemoryDeletes.snapshot().size).toBe(0);
  jest.advanceTimersByTime(300);
  await settle();
  expect(view.queryByRole("button", { name: "全部撤销" })).toBeNull();
});
