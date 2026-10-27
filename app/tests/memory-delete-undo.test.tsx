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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  confirmNoteDelete,
  deleteErrorText,
  deleteWithUndo,
  MEMORY_GROUP_LIMIT,
  MEMORY_UNDO_MS,
  pendingMemoryDeletes,
  undoToastText,
  visibleNotes,
} from "@/components/memory/memory-notes";
import { ConfirmHost } from "@/components/ui/confirm";
import { Toaster, toast } from "@/components/ui/toast";
import type { MemoryNoteView } from "../../shared/memory-notes";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-106：设置 → 记忆的删除。删一条先确认（和技能页一致），确认后只隐藏并立刻给 8 秒「撤销」，
 * 8 秒窗口过了才真正删库；撤销只是取消待删除，原记录原样保留。一组只先画前 N 条。
 */

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3710/settings/memory" });
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  calls = [];
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
      if (url.includes("/forget")) return Response.json({ removed: 1 });
      if (method === "POST")
        return Response.json(
          { note: { ...(body as object), id: "mem_new" } },
          { status: 201 },
        );
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

const note = (over: Partial<MemoryNoteView> = {}): MemoryNoteView =>
  ({
    id: "mem_aaaaaaaaaaaaaaaaaaaa",
    kind: "preference",
    subject: "饮品偏好",
    content: "用户喜欢喝冰美式，不加糖。",
    context: null,
    agentId: null,
    author: "user",
    shared: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }) as MemoryNoteView;

const forgets = () => calls.filter((c) => c.url.includes("/forget"));
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test("确认后只隐藏、立刻给「撤销」；8 秒前不发删除请求，8 秒整才删", async () => {
  jest.useFakeTimers();
  try {
    const view = render(<Toaster />);
    let refreshed = 0;
    deleteWithUndo([note()], async () => void refreshed++);
    expect(
      pendingMemoryDeletes.snapshot().has("mem_aaaaaaaaaaaaaaaaaaaa"),
    ).toBe(true);
    await act(async () => {});
    expect(view.getByRole("button", { name: "撤销" })).toBeTruthy();
    expect(view.getByText("已删除记忆「饮品偏好」")).toBeTruthy();
    jest.advanceTimersByTime(MEMORY_UNDO_MS - 1);
    await flush();
    expect(forgets()).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await flush();
    expect(forgets()).toHaveLength(1);
    expect(forgets()[0]?.body).toEqual({ ids: ["mem_aaaaaaaaaaaaaaaaaaaa"] });
    expect(refreshed).toBe(1);
    expect(pendingMemoryDeletes.snapshot().size).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test("8 秒内撤销：不发删除请求、不重建，原记录原样（id / created_at / agent_id 不变）", async () => {
  jest.useFakeTimers();
  try {
    const original = note({
      id: "mem_keep",
      agentId: "agent_x",
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    const snapshot = structuredClone(original);
    const view = render(<Toaster />);
    deleteWithUndo([original], async () => {});
    await act(async () => {});
    jest.advanceTimersByTime(MEMORY_UNDO_MS - 1000);
    await act(async () => {
      fireEvent.click(
        view.getAllByRole("button", { name: "撤销" }).at(-1) as HTMLElement,
      );
    });
    expect(pendingMemoryDeletes.snapshot().has("mem_keep")).toBe(false);
    jest.advanceTimersByTime(MEMORY_UNDO_MS * 2);
    await flush();
    expect(forgets()).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(original).toEqual(snapshot);
  } finally {
    jest.useRealTimers();
  }
});

test("连删两次：各自计时、各自撤销", async () => {
  jest.useFakeTimers();
  try {
    deleteWithUndo([note({ id: "mem_a" })], async () => {});
    jest.advanceTimersByTime(3000);
    deleteWithUndo([note({ id: "mem_b" })], async () => {});
    expect([...pendingMemoryDeletes.snapshot()].sort()).toEqual([
      "mem_a",
      "mem_b",
    ]);
    jest.advanceTimersByTime(MEMORY_UNDO_MS - 3000);
    await flush();
    expect(forgets().map((c) => c.body)).toEqual([{ ids: ["mem_a"] }]);
    jest.advanceTimersByTime(3000);
    await flush();
    expect(forgets().map((c) => c.body)).toEqual([
      { ids: ["mem_a"] },
      { ids: ["mem_b"] },
    ]);
  } finally {
    jest.useRealTimers();
  }
});

test("8 秒后删除失败：放开隐藏、报错", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "boom" }, { status: 500 }),
    {
      preconnect: originalFetch.preconnect,
    },
  ) as typeof fetch;
  jest.useFakeTimers();
  try {
    const view = render(<Toaster />);
    let refreshed = 0;
    deleteWithUndo([note({ id: "mem_fail" })], async () => void refreshed++);
    expect(pendingMemoryDeletes.snapshot().has("mem_fail")).toBe(true);
    jest.advanceTimersByTime(MEMORY_UNDO_MS);
    await act(async () => {
      await flush();
    });
    expect(pendingMemoryDeletes.snapshot().has("mem_fail")).toBe(false);
    expect(refreshed).toBe(0);
    expect(
      view.container.querySelector('.glass-toast[data-kind="error"]'),
    ).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

test("删一条先确认：取消不删，确认才删", async () => {
  const view = render(<ConfirmHost />);
  const first = confirmNoteDelete(note());
  await waitFor(() =>
    expect(view.getByText("删除记忆「饮品偏好」？")).toBeTruthy(),
  );
  expect(
    view.getByText("所有机器人都不会再记得这条内容。删除后 8 秒内可以撤销。"),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "取消" }));
  });
  expect(await first).toBe(false);
  const second = confirmNoteDelete(note());
  await waitFor(() =>
    expect(view.getByRole("button", { name: "删除" })).toBeTruthy(),
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "删除" }));
  });
  expect(await second).toBe(true);
});

test("一组只先画前 N 条，展开或搜索时全画", () => {
  const many = Array.from({ length: MEMORY_GROUP_LIMIT + 7 }, (_, i) => i);
  expect(visibleNotes(many, false)).toHaveLength(MEMORY_GROUP_LIMIT);
  expect(visibleNotes(many, true)).toHaveLength(MEMORY_GROUP_LIMIT + 7);
  expect(visibleNotes(many.slice(0, 3), false)).toHaveLength(3);
});

test("QA #326：连删两条（文案相同也一样），两条「撤销」都在，各自撤销后都不发删除", async () => {
  jest.useFakeTimers();
  try {
    const view = render(<Toaster />);
    await act(async () => {});
    // 前面用例留下的提示（模块级）不算。
    const before = view.queryAllByRole("button", { name: "撤销" }).length;
    const beforeText = view.queryAllByText("已删除 1 条记忆").length;
    deleteWithUndo(
      [note({ id: "mem_x", subject: null, content: "" })],
      async () => {},
    );
    await act(async () => {});
    jest.advanceTimersByTime(2000);
    deleteWithUndo(
      [note({ id: "mem_y", subject: null, content: "" })],
      async () => {},
    );
    await act(async () => {});
    const buttons = view.getAllByRole("button", { name: "撤销" }).slice(before);
    expect(buttons).toHaveLength(2);
    expect(view.getAllByText("已删除 1 条记忆")).toHaveLength(beforeText + 2);
    await act(async () => {
      fireEvent.click(buttons[0] as HTMLElement);
    });
    expect(pendingMemoryDeletes.snapshot().has("mem_x")).toBe(false);
    expect(pendingMemoryDeletes.snapshot().has("mem_y")).toBe(true);
    await act(async () => {
      fireEvent.click(
        view.getAllByRole("button", { name: "撤销" }).at(-1) as HTMLElement,
      );
    });
    expect(pendingMemoryDeletes.snapshot().size).toBe(0);
    jest.advanceTimersByTime(MEMORY_UNDO_MS * 2);
    await flush();
    expect(forgets()).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});

test("连删六条：撤销提示一条不丢", async () => {
  jest.useFakeTimers();
  try {
    const view = render(<Toaster />);
    await act(async () => {});
    const before = view.queryAllByRole("button", { name: "撤销" }).length;
    for (let i = 0; i < 6; i++)
      deleteWithUndo([note({ id: `mem_${i}` })], async () => {});
    toast.info("普通提示");
    await act(async () => {});
    expect(view.getAllByRole("button", { name: "撤销" })).toHaveLength(
      before + 6,
    );
    jest.advanceTimersByTime(MEMORY_UNDO_MS * 2);
    await flush();
  } finally {
    jest.useRealTimers();
  }
});

test("普通提示仍按文案去重", async () => {
  jest.useFakeTimers();
  try {
    const view = render(<Toaster />);
    await act(async () => {
      toast.success("已保存");
      toast.success("已保存");
    });
    expect(view.getAllByText("已保存")).toHaveLength(1);
    jest.advanceTimersByTime(10000);
  } finally {
    jest.useRealTimers();
  }
});

test("撤销文案带标题、长的截断；断网失败给中文", () => {
  expect(undoToastText([note({ subject: "饮品偏好" })])).toBe(
    "已删除记忆「饮品偏好」",
  );
  expect(
    undoToastText([note({ subject: "一二三四五六七八九十一二三四五六七八" })]),
  ).toBe("已删除记忆「一二三四五六七八九十一二三四五六…」");
  expect(undoToastText([note(), note()])).toBe("已删除 2 条记忆");
  expect(deleteErrorText(new TypeError("Failed to fetch"))).toBe(
    "网络连不上，这条记忆没删",
  );
  expect(deleteErrorText(new Error("boom"))).toBe("boom");
});

test("8 秒后断网删除失败：提示中文，不露 Failed to fetch", async () => {
  globalThis.fetch = Object.assign(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  jest.useFakeTimers();
  try {
    const view = render(<Toaster />);
    deleteWithUndo([note({ id: "mem_off" })], async () => {});
    jest.advanceTimersByTime(MEMORY_UNDO_MS);
    await act(async () => {
      await flush();
    });
    expect(view.getByText("网络连不上，这条记忆没删")).toBeTruthy();
    expect(view.queryByText("Failed to fetch")).toBeNull();
    expect(pendingMemoryDeletes.snapshot().has("mem_off")).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});
