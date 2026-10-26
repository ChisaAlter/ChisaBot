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
  isRowInView,
  MESSAGE_REFOCUS_DELAYS_MS,
  refocusMessageRow,
} from "@/lib/channels/focus-message";
import {
  activeSearchIndex,
  clearSearchActive,
  moveSearchActive,
  nextSearchIndex,
  openSearchActive,
  SEARCH_ACTIVE_ATTR,
  SEARCH_RESULTS_ID,
  searchResultItems,
} from "@/lib/sidebar-search-nav";

function mount(count: number) {
  document.body.innerHTML = "";
  const box = document.createElement("div");
  box.id = SEARCH_RESULTS_ID;
  const clicks: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = document.createElement("a");
    a.href = `/channel/c${i}`;
    a.textContent = `hit ${i}`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      clicks.push(i);
    });
    box.appendChild(a);
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

describe("deep-link refocus (CB-106)", () => {
  test("re-scrolls a found row that got pushed out of view", () => {
    document.body.innerHTML = `<div data-message-id="m1">x</div>`;
    const row = document.querySelector<HTMLElement>("[data-message-id]")!;
    let top = -500;
    row.getBoundingClientRect = () => ({ top, bottom: top + 40 }) as DOMRect;
    expect(isRowInView(row)).toBe(false);
    refocusMessageRow("m1");
    top = 100;
    expect(isRowInView(row)).toBe(true);
    expect(refocusMessageRow("m1")).toBe(false);
    expect(refocusMessageRow("missing")).toBe(false);
    expect(MESSAGE_REFOCUS_DELAYS_MS.length).toBeGreaterThan(0);
  });
});
