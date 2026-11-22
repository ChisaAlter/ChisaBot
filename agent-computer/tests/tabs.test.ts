import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { startPageHtml } from "../src/start-page";
import {
  createTabMetadataCache,
  MAX_TABS,
  neighbourAfterClose,
  parseSavedTabs,
  readSavedTabs,
  savedTabsFrom,
  tabIdOf,
  tabTitle,
  writeSavedTabs,
} from "../src/tabs";

/** 浏览器多标签（DESIGN.md §95）：不碰浏览器的规则。 */
const page = (url: string, closed = false) => ({ url: () => url, isClosed: () => closed });

describe("tab rules", () => {
  test("ids are stable per page and never reused", () => {
    const a = page("https://a.test/");
    const b = page("https://b.test/");
    expect(tabIdOf(a)).toBe(tabIdOf(a));
    expect(tabIdOf(a)).not.toBe(tabIdOf(b));
    expect(tabIdOf(a)).toMatch(/^t\d+$/);
  });

  test("closing the active tab lands on its right neighbour, else the left", () => {
    const a = page("a");
    const b = page("b");
    const c = page("c");
    expect(neighbourAfterClose([a, b, c], b, b)).toBe(c);
    expect(neighbourAfterClose([a, b, c], c, c)).toBe(b);
    // 关的不是当前标签：当前不变
    expect(neighbourAfterClose([a, b, c], a, c)).toBe(c);
    // 已经关掉的不算
    expect(neighbourAfterClose([a, b, page("d", true)], b, b)).toBe(a);
  });

  test("titles: blank page is 新标签页, missing title is the host", () => {
    expect(tabTitle("about:blank", "")).toBe("新标签页");
    expect(tabTitle("https://x.example/p", "")).toBe("x.example");
    expect(tabTitle("https://x.example/p", "  Hello ")).toBe("Hello");
  });

  test("only real web pages are saved, capped, active remembered", () => {
    const saved = savedTabsFrom([
      { url: "about:blank", title: "", active: false },
      { url: "https://a.test/", title: "A", active: false },
      { url: "chrome-error://chromewebdata/", title: "", active: false },
      { url: "https://b.test/", title: "B", active: true },
    ]);
    expect(saved.tabs.map((t) => t.url)).toEqual(["https://a.test/", "https://b.test/"]);
    expect(saved.active).toBe(1);
    const many = savedTabsFrom(
      Array.from({ length: 30 }, (_, i) => ({ url: `https://s${i}.test/`, title: "", active: false })),
    );
    expect(many.tabs.length).toBe(MAX_TABS);
  });

  test("parse refuses garbage and bad urls", () => {
    expect(parseSavedTabs(null)).toBeNull();
    expect(parseSavedTabs({ tabs: "x" })).toBeNull();
    const parsed = parseSavedTabs({
      tabs: [{ url: "javascript:alert(1)" }, { url: "https://ok.test/", title: 5 }, 7],
      active: 9,
    });
    expect(parsed).toEqual({ tabs: [{ url: "https://ok.test/", title: "" }], active: 0 });
  });

  test("saved tabs round-trip through the profile directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tabs-"));
    try {
      expect(await readSavedTabs(dir)).toBeNull();
      await writeSavedTabs(dir, { tabs: [{ url: "https://a.test/", title: "A" }], active: 0 });
      expect(await readSavedTabs(dir)).toEqual({ tabs: [{ url: "https://a.test/", title: "A" }], active: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("start page links (= bookmarks)", () => {
  test("defaults are the original five", () => {
    const html = startPageHtml();
    for (const name of ["必应", "百度", "GitHub", "维基百科", "哔哩哔哩"]) expect(html).toContain(name);
  });
  test("user links are escaped and non-web links dropped", () => {
    const html = startPageHtml([
      { title: '<img src=x onerror="alert(1)">', url: "https://evil.test/?a=<b>&c=\"d\"" },
      { title: "JS", url: "javascript:alert(1)" },
    ]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("https://evil.test/?a=&lt;b&gt;&amp;c=&quot;d&quot;");
  });
});

describe("tab metadata cache", () => {
  test("caches title and favicon href across repeated reads on unchanged URL", async () => {
    const cache = createTabMetadataCache();
    let currentUrl = "https://example.test/page";
    let currentTitle = "Example Page";
    let currentIcon = "https://example.test/favicon.png";
    let titleReads = 0;
    let faviconReads = 0;
    const target = {
      url: () => currentUrl,
      isClosed: () => false,
    };
    const readers = {
      readTitle: async () => {
        titleReads += 1;
        return currentTitle;
      },
      readFaviconHref: async () => {
        faviconReads += 1;
        return currentIcon;
      },
    };

    const first = await cache.resolve(target, readers);
    const second = await cache.resolve(target, readers);
    expect(first).toEqual({
      url: "https://example.test/page",
      title: "Example Page",
      faviconHref: "https://example.test/favicon.png",
    });
    expect(second).toEqual(first);
    expect(titleReads).toBe(1);
    expect(faviconReads).toBe(1);

    // Load-complete invalidation with keepFavicon refreshes title only.
    currentTitle = "Loaded Title";
    cache.invalidate(target, { keepFavicon: true });
    const afterLoad = await cache.resolve(target, readers);
    expect(afterLoad.title).toBe("Loaded Title");
    expect(titleReads).toBe(2);
    expect(faviconReads).toBe(1);

    // Navigating to a new URL invalidates both title and favicon automatically.
    currentUrl = "https://other.test/next";
    currentTitle = "Other";
    currentIcon = "https://other.test/icon.ico";
    const afterNav = await cache.resolve(target, readers);
    expect(afterNav).toEqual({
      url: "https://other.test/next",
      title: "Other",
      faviconHref: "https://other.test/icon.ico",
    });
    expect(titleReads).toBe(3);
    expect(faviconReads).toBe(2);

    // Explicit delete drops cached entry.
    cache.delete(target);
    await cache.resolve(target, readers);
    expect(titleReads).toBe(4);
    expect(faviconReads).toBe(3);
  });

  test("skips favicon evaluation for about:blank and drops stale result if page navigates mid-read", async () => {
    const cache = createTabMetadataCache();
    let currentUrl = "about:blank";
    let faviconReads = 0;
    const blank = { url: () => currentUrl, isClosed: () => false };
    const blankRes = await cache.resolve(blank, {
      readTitle: async () => "",
      readFaviconHref: async () => {
        faviconReads += 1;
        return "https://never.test/favicon.ico";
      },
    });
    expect(blankRes.faviconHref).toBeNull();
    expect(faviconReads).toBe(0);

    // URL changes mid-evaluation: result must not poison the cache for the new URL.
    currentUrl = "https://first.test/";
    let titleReads = 0;
    await cache.resolve(blank, {
      readTitle: async () => {
        titleReads += 1;
        currentUrl = "https://second.test/";
        return "Stale First";
      },
      readFaviconHref: async () => null,
    });
    const fresh = await cache.resolve(blank, {
      readTitle: async () => {
        titleReads += 1;
        return "Real Second";
      },
      readFaviconHref: async () => "https://second.test/icon.png",
    });
    expect(titleReads).toBe(2);
    expect(fresh.title).toBe("Real Second");
    expect(fresh.faviconHref).toBe("https://second.test/icon.png");
  });
});

/**
 * 真浏览器（和 follows-popup 一样按需运行）：
 *   CHISABOT_COMPUTER_BROWSER=1 bun test tests/tabs.test.ts
 */
const asked = process.env.CHISABOT_COMPUTER_BROWSER === "1";
const site = asked
  ? Bun.serve({
      port: 0,
      fetch(request) {
        const name = new URL(request.url).pathname.slice(1) || "home";
        return new Response(`<!doctype html><title>${name.toUpperCase()}</title><p>${name}</p>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    })
  : null;
afterAll(() => site?.stop(true));

describe.skipIf(!asked)("tabs in a real browser", () => {
  test(
    "open 3, switch, close, cap, and restore after a restart",
    async () => {
      process.env.COMPUTER_BROWSER_MODE = "headless";
      const { createProfiles } = await import("../src/profiles");
      const root = await mkdtemp(join(tmpdir(), "tabs-browser-"));
      const profiles = createProfiles(root, () => {});
      const origin = `http://127.0.0.1:${site?.port}`;
      const bot = "tabsbot";
      try {
        const first = await profiles.page(bot);
        await first.goto(`${origin}/one`);
        const second = await profiles.openTab(bot);
        await second.goto(`${origin}/two`);
        const third = await profiles.openTab(bot);
        await third.goto(`${origin}/three`);
        let view = await profiles.tabs(bot);
        expect(view.tabs.map((t) => t.title)).toEqual(["ONE", "TWO", "THREE"]);
        expect(view.tabs.find((t) => t.active)?.title).toBe("THREE");
        expect(await profiles.page(bot)).toBe(third);

        const oneId = view.tabs[0]?.id as string;
        await profiles.activateTab(bot, oneId);
        expect(await profiles.page(bot)).toBe(first);

        // 关当前（ONE）→ 落到右边的 TWO
        await profiles.closeTab(bot, oneId);
        view = await profiles.tabs(bot);
        expect(view.tabs.map((t) => t.title)).toEqual(["TWO", "THREE"]);
        expect(view.tabs.find((t) => t.active)?.title).toBe("TWO");

        // 上限
        for (let i = view.tabs.length; i < MAX_TABS; i += 1) await profiles.openTab(bot);
        await expect(profiles.openTab(bot)).rejects.toThrow(/最多同时打开/);
        // 关掉多余的空白页，留 TWO / THREE，当前是 THREE
        view = await profiles.tabs(bot);
        for (const tab of view.tabs.filter((t) => t.url === "about:blank")) await profiles.closeTab(bot, tab.id);
        const threeId = (await profiles.tabs(bot)).tabs.find((t) => t.title === "THREE")?.id as string;
        await profiles.activateTab(bot, threeId);

        // 写盘有 800ms 防抖
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await profiles.stop(bot);
        const saved = await profiles.tabs(bot);
        expect(saved.running).toBe(false);
        expect(saved.tabs.map((t) => t.url)).toEqual([`${origin}/two`, `${origin}/three`]);

        // 重新启动：恢复两个标签，当前是 THREE
        await profiles.page(bot);
        const deadline = Date.now() + 20_000;
        let restored = await profiles.tabs(bot);
        while (Date.now() < deadline && restored.tabs.filter((t) => t.title === "TWO" || t.title === "THREE").length < 2) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          restored = await profiles.tabs(bot);
        }
        expect(restored.tabs.map((t) => t.title)).toEqual(["TWO", "THREE"]);
        expect(restored.tabs.find((t) => t.active)?.title).toBe("THREE");
      } finally {
        await profiles.closeAll();
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
