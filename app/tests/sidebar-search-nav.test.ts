import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  holdMessageInView,
  isMessageHeld,
  isRowInView,
  MESSAGE_HOLD_RELEASE_EVENT,
} from "@/lib/channels/focus-message";
import {
  activeSearchIndex,
  cleanSearchSnippet,
  clearSearchActive,
  moveSearchActive,
  nextSearchIndex,
  openSearchActive,
  SEARCH_ACTIVE_ATTR,
  SEARCH_RESULTS_ID,
  SNIPPET_IMAGE_ZH,
  searchHitWhen,
  searchResultItems,
} from "@/lib/sidebar-search-nav";

function mount(count: number) {
  document.body.innerHTML = "";
  const box = document.createElement("div");
  box.id = SEARCH_RESULTS_ID;
  box.setAttribute("role", "listbox");
  const clicks: number[] = [];
  for (let i = 0; i < count; i++) {
    // 和左栏一样：option 外壳里包着真正的链接。
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    const a = document.createElement("a");
    a.href = `/channel/c${i}`;
    a.textContent = `hit ${i}`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      clicks.push(i);
    });
    option.appendChild(a);
    box.appendChild(option);
  }
  document.body.appendChild(box);
  return clicks;
}

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
afterAll(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("nextSearchIndex (CB-106)", () => {
  test("wraps and starts from the ends", () => {
    expect(nextSearchIndex(-1, 1, 3)).toBe(0);
    expect(nextSearchIndex(-1, -1, 3)).toBe(2);
    expect(nextSearchIndex(0, 1, 3)).toBe(1);
    expect(nextSearchIndex(2, 1, 3)).toBe(0);
    expect(nextSearchIndex(0, -1, 3)).toBe(2);
    expect(nextSearchIndex(7, 1, 3)).toBe(0);
    expect(nextSearchIndex(0, 1, 0)).toBe(-1);
  });
});

describe("sidebar search keyboard highlight (CB-106)", () => {
  test("ArrowDown/Up move one visible highlight with aria ids", () => {
    mount(3);
    const first = moveSearchActive(1);
    const items = searchResultItems();
    expect(items).toHaveLength(3);
    expect(first).toBe(items[0].id);
    expect(items[0].hasAttribute(SEARCH_ACTIVE_ATTR)).toBe(true);
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    moveSearchActive(1);
    expect(activeSearchIndex(items)).toBe(1);
    expect(
      items.filter((i) => i.hasAttribute(SEARCH_ACTIVE_ATTR)),
    ).toHaveLength(1);
    moveSearchActive(-1);
    moveSearchActive(-1);
    expect(activeSearchIndex(items)).toBe(2);
    clearSearchActive();
    expect(activeSearchIndex(items)).toBe(-1);
    // 每个 option 一直带 aria-selected：没高亮的是 false，不是没有。
    for (const item of items)
      expect(item.getAttribute("aria-selected")).toBe("false");
  });

  test("items are the listbox's role=option wrappers, not stray links", () => {
    mount(2);
    const stray = document.createElement("a");
    stray.href = "/elsewhere";
    document.getElementById(SEARCH_RESULTS_ID)?.appendChild(stray);
    const items = searchResultItems();
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.getAttribute("role")).toBe("option");
    const id = moveSearchActive(1);
    expect(document.getElementById(id ?? "")?.getAttribute("role")).toBe(
      "option",
    );
    expect(
      document.getElementById(id ?? "")?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("Enter opens the highlighted link; single result opens without highlight", () => {
    let clicks = mount(3);
    expect(openSearchActive()).toBe(false);
    moveSearchActive(1);
    moveSearchActive(1);
    expect(openSearchActive()).toBe(true);
    expect(clicks).toEqual([1]);
    clicks = mount(1);
    expect(openSearchActive()).toBe(true);
    expect(clicks).toEqual([0]);
  });

  test("no results: nothing to move or open", () => {
    mount(0);
    expect(moveSearchActive(1)).toBeUndefined();
    expect(openSearchActive()).toBe(false);
  });

  test("search field wires combobox aria, IME guard and keys", () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        "../src/components/layout/sidebar-search-field.tsx",
      ),
      "utf8",
    );
    expect(src).toContain('role="combobox"');
    expect(src).toContain("aria-activedescendant");
    expect(src).toContain("isComposing");
    expect(src).toContain("229");
    expect(src).toContain("ArrowDown");
    expect(src).toContain("openSearchActive");
  });

  test("hit rows show bot name and time meta", () => {
    const src = readFileSync(
      join(import.meta.dir, "../src/components/app-sidebar/app-sidebar.tsx"),
      "utf8",
    );
    expect(src).toContain('data-testid="search-hit-meta"');
    expect(src).toContain("botName");
    expect(src).toContain(`id={SEARCH_RESULTS_ID}`);
  });
});

describe("result row text (CB-106 r2)", () => {
  test("time reads 「最近活动 8分钟前」", () => {
    const rel = new Intl.RelativeTimeFormat("zh-CN", {
      numeric: "auto",
    }).format(-8, "minute");
    expect(searchHitWhen(rel)).toBe("最近活动 8分钟前");
    expect(searchHitWhen(undefined)).toBeUndefined();
  });

  test("markdown images in the snippet show as 「[图片]」 and the highlight follows", () => {
    const raw = "看图 ![截图](https://x.test/a.png) 然后 关键 词";
    const at = raw.indexOf("关键");
    const out = cleanSearchSnippet(raw, { start: at, end: at + 2 });
    expect(out.snippet).toBe(`看图 ${SNIPPET_IMAGE_ZH} 然后 关键 词`);
    expect(out.snippet.slice(out.highlight?.start, out.highlight?.end)).toBe(
      "关键",
    );
    expect(cleanSearchSnippet("前面 ![半截](https://x.test/a").snippet).toBe(
      `前面 ${SNIPPET_IMAGE_ZH}`,
    );
    expect(cleanSearchSnippet("两张 ![](a) ![b](c)").snippet).toBe(
      `两张 ${SNIPPET_IMAGE_ZH} ${SNIPPET_IMAGE_ZH}`,
    );
    expect(cleanSearchSnippet("没有图").snippet).toBe("没有图");
  });

  test("the row uses both helpers; results are a listbox of options", () => {
    const src = readFileSync(
      join(import.meta.dir, "../src/components/app-sidebar/app-sidebar.tsx"),
      "utf8",
    );
    expect(src).toContain("cleanSearchSnippet(hit.snippet, hit.highlight)");
    expect(src).toContain("searchHitWhen(");
    expect(src).toContain('role="listbox"');
    expect(src.match(/role="option"/g)?.length).toBe(3);
  });
});

/**
 * 假的 ResizeObserver + 一段聊天：目标上面的图片在 7 秒里陆续加载（每张把目标往下推），
 * 贴底逻辑每次都想滚回底部。钉住期间目标离顶部的距离不变，8 秒时仍在视野里；人一滚就放开。
 */
class FakeResizeObserver {
  static all = new Set<FakeResizeObserver>();
  constructor(private cb: ResizeObserverCallback) {
    FakeResizeObserver.all.add(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    FakeResizeObserver.all.delete(this);
  }
  static fire() {
    for (const o of FakeResizeObserver.all)
      o.cb([], o as unknown as ResizeObserver);
  }
}

function chat() {
  document.body.innerHTML = "";
  const scroller = document.createElement("div");
  scroller.setAttribute("data-slot", "message-scroller-viewport");
  const content = document.createElement("div");
  content.setAttribute("data-slot", "message-scroller-content");
  const target = document.createElement("div");
  target.dataset.messageId = "qa-c2-m75";
  content.appendChild(target);
  scroller.appendChild(content);
  document.body.appendChild(scroller);
  const view = 700;
  const box = { above: 4000, below: 3000 };
  const max = () => box.above + 40 + box.below - view;
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(max(), v));
    },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: view }) as DOMRect;
  target.getBoundingClientRect = () =>
    ({ top: box.above - top, bottom: box.above - top + 40 }) as DOMRect;
  const offset = () => box.above - top;
  /** 一张图片加载完：目标上面多出 h 像素（或下面）；然后像贴底那样滚到最底。 */
  const imageLoads = (h: number, where: "above" | "below") => {
    box[where] += h;
    FakeResizeObserver.fire();
    scroller.scrollTop = max(); // 第三方滚动容器的「跟着底部」
    scroller.dispatchEvent(new Event("scroll"));
  };
  return {
    scroller,
    target,
    offset,
    imageLoads,
    max,
    setTop: (v: number) => (top = v),
  };
}

describe("deep-link hold (CB-106 r2)", () => {
  const RealRO = globalThis.ResizeObserver;
  beforeAll(() => {
    globalThis.ResizeObserver =
      FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterAll(() => {
    globalThis.ResizeObserver = RealRO;
  });

  test("images loading over 7s never pull the target away; still in view at 8s", () => {
    const c = chat();
    c.setTop(4000 - 330); // 定位：目标在视口中间
    const release = holdMessageInView(c.target, c.scroller);
    expect(isMessageHeld(c.scroller)).toBe(true);
    const want = c.offset();
    // 0.4s … 6.9s 陆续加载的图片，上下都有。
    const loads: [number, number, "above" | "below"][] = [
      [400, 260, "above"],
      [1500, 900, "below"],
      [2600, 480, "above"],
      [4500, 1200, "below"],
      [4800, 320, "above"],
      [5900, 700, "above"],
      [6900, 1500, "below"],
    ];
    for (const [, h, where] of loads) {
      c.imageLoads(h, where);
      expect(Math.abs(c.offset() - want)).toBeLessThanOrEqual(1);
      expect(isRowInView(c.target)).toBe(true);
    }
    // 8 秒：仍然钉着、仍在视野里。
    expect(isMessageHeld(c.scroller)).toBe(true);
    expect(isRowInView(c.target)).toBe(true);
    release();
    expect(isMessageHeld(c.scroller)).toBe(false);
  });

  test("the person scrolling releases the hold; after that 贴底 works again", () => {
    const c = chat();
    c.setTop(4000 - 330);
    holdMessageInView(c.target, c.scroller);
    c.scroller.dispatchEvent(new Event("wheel"));
    expect(isMessageHeld(c.scroller)).toBe(false);
    c.imageLoads(500, "below");
    expect(c.scroller.scrollTop).toBe(c.max());
  });

  test("sending a message releases the hold (submit, Enter in the composer, or the event)", () => {
    for (const how of ["submit", "enter", "event"] as const) {
      const c = chat();
      c.setTop(4000 - 330);
      holdMessageInView(c.target, c.scroller);
      if (how === "submit") {
        const form = document.createElement("form");
        document.body.appendChild(form);
        form.dispatchEvent(new Event("submit", { bubbles: true }));
      } else if (how === "enter") {
        const box = document.createElement("textarea");
        document.body.appendChild(box);
        box.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      } else {
        window.dispatchEvent(new Event(MESSAGE_HOLD_RELEASE_EVENT));
      }
      expect(isMessageHeld(c.scroller)).toBe(false);
    }
  });

  test("no fixed refocus delays; transcript yields to the hold", () => {
    const find = readFileSync(
      join(import.meta.dir, "../src/components/channels/message-find.tsx"),
      "utf8",
    );
    expect(find).toContain("holdMessageInView(");
    expect(find).not.toMatch(/REFOCUS|350|2200/);
    const transcript = readFileSync(
      join(import.meta.dir, "../src/components/channels/chat-transcript.tsx"),
      "utf8",
    );
    expect(transcript).toContain("isMessageHeld(element)");
    expect(transcript).toContain("if (held()) return;");
  });
});

describe("IME Esc does not close the mobile drawer (CB-106 r2)", () => {
  test("isImeEscape detects isComposing and keyCode 229", async () => {
    const { isImeEscape } = await import("@/components/ui/sidebar");
    expect(
      isImeEscape(new KeyboardEvent("keydown", { key: "Escape", isComposing: true })),
    ).toBe(true);
    expect(
      isImeEscape(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229 } as KeyboardEventInit)),
    ).toBe(true);
    expect(isImeEscape(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
    expect(isImeEscape(undefined)).toBe(false);
  });

  test("sheet onOpenChange cancels escape-key while composing", () => {
    const src = readFileSync(
      join(import.meta.dir, "../src/components/ui/sidebar.tsx"),
      "utf8",
    );
    expect(src).toContain('details?.reason === "escape-key" && isImeEscape(details.event)');
    expect(src).toContain("details.cancel?.()");
  });
});
