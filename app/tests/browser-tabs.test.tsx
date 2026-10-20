import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { BookmarksBar, BookmarkStar } from "@/components/computer/bookmarks-bar";
import { TabStrip } from "@/components/computer/browser-tabs";
import { findBookmark, sameBookmarkUrl, siteMonogram } from "@/lib/browser-bookmarks";
import { parseTabsView, setTabsView } from "@/lib/computers/tabs";

/** 浏览器多标签 + 收藏夹（DESIGN.md §95）。 */

const realFetch = globalThis.fetch;
let calls: { url: string; method: string; body: unknown }[] = [];
let bookmarks = [
  { id: "b1", title: "必应", url: "https://www.bing.com/", position: 0 },
  { id: "b2", title: "GitHub", url: "https://github.com/", position: 1 },
];
const view = (activeId: string, n = 3) => ({
  running: true,
  max: 8,
  activeId,
  tabs: Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    url: i === 0 ? "https://a.test/" : `https://s${i}.test/`,
    title: `页面${i + 1}`,
    active: `t${i + 1}` === activeId,
  })),
});

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/human/tab")) {
      const b = body as { action: string; id?: string };
      if (b.action === "new") return json(view("t4", 4));
      if (b.action === "close") return json(view("t1", 2));
      return json(view(b.id ?? "t1"));
    }
    if (url === "/api/browser-bookmarks" && method === "GET") return json({ bookmarks, max: 100 });
    if (url === "/api/browser-bookmarks" && method === "POST") {
      const added = { id: "b9", title: "A", url: (body as { url: string }).url, position: 2 };
      bookmarks = [...bookmarks, added];
      return json({ bookmark: added });
    }
    if (url.startsWith("/api/browser-bookmarks/") && method === "DELETE") {
      bookmarks = bookmarks.filter((b) => !url.endsWith(b.id));
      return json({ ok: true });
    }
    return json({ ok: true });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  calls = [];
});
afterAll(() => {
  globalThis.fetch = realFetch;
  // 2026-10-20 清基线：注册过就要收回来，否则后面的文件会撞「Happy DOM has already been globally registered」。
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>
);

describe("helpers", () => {
  test("parseTabsView keeps only sane tabs and data: favicons", () => {
    const parsed = parseTabsView({
      running: true,
      max: 8,
      activeId: "t1",
      tabs: [
        { id: "t1", url: "https://a/", title: "A", active: true, favicon: "data:image/png;base64,AA" },
        { id: "t2", url: "https://b/", title: "B", favicon: "https://evil/x.png" },
        { nope: 1 },
      ],
    });
    expect(parsed?.tabs.length).toBe(2);
    expect(parsed?.tabs[0]?.favicon).toBe("data:image/png;base64,AA");
    expect(parsed?.tabs[1]?.favicon).toBeUndefined();
    expect(parseTabsView({ tabs: "x" })).toBeNull();
  });
  test("bookmark url comparison ignores # and trailing /", () => {
    expect(sameBookmarkUrl("https://a.test/x/", "https://a.test/x#top")).toBe(true);
    expect(findBookmark(bookmarks, "https://github.com")?.id).toBe("b2");
    expect(findBookmark(bookmarks, "about:blank")).toBeUndefined();
    expect(siteMonogram("百度", "https://www.baidu.com/").letter).toBe("百");
  });
});

describe("TabStrip", () => {
  test("shows tabs, highlights the active one; viewing-only cannot switch", async () => {
    setTabsView("botA", view("t2"));
    const ui = render(<TabStrip computerId="botA" driving={false} poll={false} />);
    const tabs = ui.getAllByRole("tab");
    expect(tabs.length).toBe(3);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(ui.queryByLabelText(/关闭标签页/)).toBeNull();
    fireEvent.click(tabs[0]?.querySelector("button") as HTMLElement);
    expect(calls.filter((c) => c.url.includes("/human/tab")).length).toBe(0);
    expect((ui.getByLabelText("新标签页") as HTMLButtonElement).disabled).toBe(true);
  });

  test("TabStrip is one keyboard tab stop: arrows move between tabs and activate them (2026-10-20)", async () => {
    setTabsView("botK", view("t1"));
    const ui = render(<TabStrip computerId="botK" driving poll={false} />);
    const tabs = ui.getAllByRole("tab") as HTMLElement[];
    // roving tabindex：只有选中那个在 Tab 顺序里，内部的主按钮不再单独占一个停靠点。
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect((tabs[0]?.querySelector("button") as HTMLButtonElement).tabIndex).toBe(-1);

    await act(async () => {
      fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });
    });
    expect(document.activeElement).toBe(tabs[1]);
    const switched = calls.find((call) => call.url.includes("/human/tab"));
    expect(switched?.body).toMatchObject({ action: "activate", id: "t2" });

    setTabsView("botK", view("t1"));
    const again = render(<TabStrip computerId="botK" driving poll={false} />);
    const list = again.getAllByRole("tab") as HTMLElement[];
    await act(async () => {
      fireEvent.keyDown(list[0] as HTMLElement, { key: "End" });
    });
    expect(document.activeElement).toBe(list[2]);
  });

  test("driving: switch, close and new go to /human/tab and update the strip", async () => {
    setTabsView("botB", view("t1"));
    const ui = render(<TabStrip computerId="botB" driving poll={false} />);
    await act(async () => {
      fireEvent.click(ui.getAllByRole("tab")[2]?.querySelector("button") as HTMLElement);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(calls.at(-1)?.body).toEqual({ action: "activate", id: "t3" });
    expect(ui.getAllByRole("tab")[2]?.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      fireEvent.click(ui.getByLabelText("新标签页"));
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(calls.at(-1)?.body).toEqual({ action: "new" });
    expect(ui.getAllByRole("tab").length).toBe(4);
    await act(async () => {
      fireEvent.click(ui.getByLabelText("关闭标签页「页面2」"));
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(calls.at(-1)?.body).toEqual({ action: "close", id: "t2" });
    expect(ui.getAllByRole("tab").length).toBe(2);
  });

  test("at the cap the + button is disabled", () => {
    setTabsView("botC", view("t1", 8));
    const ui = render(<TabStrip computerId="botC" driving poll={false} />);
    expect((ui.getByLabelText("新标签页") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("bookmarks", () => {
  test("bar lists bookmarks; clicking opens only while driving", async () => {
    const opened: [string, boolean][] = [];
    const ui = render(wrap(<BookmarksBar botId="botA" driving={false} onOpen={(url, n) => opened.push([url, n])} />));
    const chip = await ui.findByTitle(/GitHub/);
    fireEvent.click(chip);
    expect(opened).toEqual([]);
    expect(await ui.findByText(/接管控制后才能/)).toBeTruthy();
    cleanup();
    const driving = render(wrap(<BookmarksBar botId="botA" driving onOpen={(url, n) => opened.push([url, n])} />));
    fireEvent.click(await driving.findByTitle(/GitHub/));
    expect(opened).toEqual([["https://github.com/", false]]);
  });

  test("star adds and removes the current page", async () => {
    const ui = render(wrap(<BookmarkStar botId="botA" url="https://a.test/page" />));
    const star = await ui.findByLabelText("收藏此页");
    await act(async () => {
      fireEvent.click(star);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/browser-bookmarks")).toBe(true);
    expect(calls.some((c) => c.url === "/api/browser-bookmarks/sync/botA")).toBe(true);
    const on = await ui.findByLabelText("取消收藏");
    await act(async () => {
      fireEvent.click(on);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/browser-bookmarks/b9")).toBe(true);
  });
});
