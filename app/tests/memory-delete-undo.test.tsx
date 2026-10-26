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
  confirmNoteDelete,
  deleteWithUndo,
  MEMORY_GROUP_LIMIT,
  visibleNotes,
} from "@/components/memory/memory-notes";
import { ConfirmHost } from "@/components/ui/confirm";
import { Toaster } from "@/components/ui/toast";
import type { MemoryNoteView } from "../../shared/memory-notes";

/**
 * CB-106：设置 → 记忆的删除。删一条先确认（和技能页一致），删完立刻给 8 秒「撤销」，
 * 不等列表重新拉完；撤销按原样重建（含公共知识库标记）。一组只先画前 N 条。
 */

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3710/settings/memory" });
});
afterAll(async () => {
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

test("删除后「撤销」立刻出现，不等列表刷新", async () => {
  const view = render(<Toaster />);
  const hidden: (string[] | null)[] = [];
  // 列表刷新永远不回来（模拟几千条记忆时的慢刷新）。
  const refresh = () => new Promise<unknown>(() => {});
  void deleteWithUndo([note()], refresh, (ids) => hidden.push(ids));
  await waitFor(() =>
    expect(view.getByRole("button", { name: "撤销" })).toBeTruthy(),
  );
  expect(view.getByText("已删除 1 条记忆")).toBeTruthy();
  expect(hidden).toEqual([["mem_aaaaaaaaaaaaaaaaaaaa"]]);
  expect(calls.filter((c) => c.url.includes("/forget"))).toHaveLength(1);
});

test("撤销按原样重建，公共知识库标记不丢", async () => {
  const view = render(<Toaster />);
  let refreshed = 0;
  await deleteWithUndo(
    [note({ shared: true, subject: "[知识库] 规范" })],
    async () => void refreshed++,
    () => {},
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "撤销" }));
  });
  await waitFor(() =>
    expect(
      calls.some((c) => c.method === "POST" && !c.url.includes("/forget")),
    ).toBe(true),
  );
  const create = calls.find(
    (c) => c.method === "POST" && !c.url.includes("/forget"),
  );
  expect(create?.body).toMatchObject({
    kind: "preference",
    subject: "[知识库] 规范",
    content: "用户喜欢喝冰美式，不加糖。",
    shared: true,
  });
  await waitFor(() => expect(refreshed).toBe(2));
});

test("删除失败：放开隐藏、报错、不给撤销", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "boom" }, { status: 500 }),
    {
      preconnect: originalFetch.preconnect,
    },
  ) as typeof fetch;
  const view = render(<Toaster />);
  // 前面用例的提示（8 秒）还在模块级的提示栈里，所以比较数量而不是断言为 0。
  const before = view.queryAllByRole("button", { name: "撤销" }).length;
  const hidden: (string[] | null)[] = [];
  let refreshed = 0;
  await deleteWithUndo(
    [note()],
    async () => void refreshed++,
    (ids) => hidden.push(ids),
  );
  expect(hidden).toEqual([["mem_aaaaaaaaaaaaaaaaaaaa"], null]);
  expect(refreshed).toBe(0);
  await waitFor(() =>
    expect(
      view.container.querySelector('.glass-toast[data-kind="error"]'),
    ).toBeTruthy(),
  );
  expect(view.queryAllByRole("button", { name: "撤销" }).length).toBe(before);
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
