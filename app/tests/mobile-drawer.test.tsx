import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Sidebar, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { settleReactWork } from "./settle-react-work";

/**
 * 手机尺寸左栏抽屉（Hark 手机端）：一层面板、右边一块压暗的遮罩、点遮罩关抽屉、玻璃最多一层。
 *
 * DOM 部分渲染真的 <Sidebar>（窄窗口下它是 Base UI 的 Sheet）；「几层玻璃」要看样式表，这里读 styles.css：
 * 抽屉里只有面板自己的 .glass 会模糊，里面的列表卡片 / 账号卡把旧玻璃层的变量关掉，遮罩不模糊。
 */

const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selector: string;
  body: string;
}

function rules(text: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  }
  return out;
}

const all = rules(css);
const blurs = (r: Rule) =>
  /(^|[;\s])backdrop-filter:\s*(?!\s|none)[^;]+/.test(r.body);
const DRAWER = /hk-drawer|\[data-mobile="true"\]/;

let originalMatchMedia: typeof window.matchMedia;

beforeAll(() => {
  GlobalRegistrator.register();
  originalMatchMedia = window.matchMedia;
  // 窄窗口：useIsMobile() 为真，<Sidebar> 渲染成抽屉。
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  window.matchMedia = originalMatchMedia;
  GlobalRegistrator.unregister();
});

function Opener() {
  const sidebar = useSidebar();
  return (
    <>
      <output>{sidebar.openMobile ? "open" : "closed"}</output>
      <button onClick={() => sidebar.setOpenMobile(true)} type="button">
        {"open"}
      </button>
    </>
  );
}

function renderDrawer() {
  const view = render(
    <SidebarProvider>
      <Sidebar>
        <section className="glass-card glass-side-card">
          <div className="side-search-row">{"search"}</div>
          <div className="glass-side-scroll">{"list"}</div>
        </section>
        <div className="glass-card acct-card">{"account"}</div>
      </Sidebar>
      <Opener />
    </SidebarProvider>,
  );
  act(() => {
    fireEvent.click(view.getByText("open"));
  });
  return view;
}

const drawer = () =>
  document.querySelector<HTMLElement>(
    '[data-slot="sidebar"][data-mobile="true"]',
  );
const overlay = () =>
  document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]');

test("the drawer is one panel: the only .glass layer is the panel itself", () => {
  renderDrawer();
  const panel = drawer();
  expect(panel).not.toBeNull();
  expect(panel?.classList.contains("glass")).toBe(true);
  expect(panel?.classList.contains("hk-drawer")).toBe(true);
  expect(panel?.querySelectorAll(".glass").length).toBe(0);
  // 列表、账号、关闭按钮都在同一块面板里。
  expect(panel?.querySelector(".glass-side-card")).not.toBeNull();
  expect(panel?.querySelector(".acct-card")).not.toBeNull();
  expect(
    panel?.querySelector('[data-testid="sidebar-drawer-close"]'),
  ).not.toBeNull();
});

test("an overlay dims the page next to the open drawer", () => {
  renderDrawer();
  const dim = overlay();
  expect(dim).not.toBeNull();
  expect(dim?.classList.contains("hk-drawer-overlay")).toBe(true);
});

test("clicking the overlay closes the drawer", async () => {
  const view = renderDrawer();
  expect(view.container.querySelector("output")?.textContent).toBe("open");
  const dim = overlay();
  expect(dim).not.toBeNull();
  await act(async () => {
    if (!dim) return;
    fireEvent.pointerDown(dim, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(dim, { button: 0 });
    fireEvent.pointerUp(dim, { button: 0, pointerType: "mouse" });
    fireEvent.mouseUp(dim, { button: 0 });
    fireEvent.click(dim, { button: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(view.container.querySelector("output")?.textContent).toBe("closed");
});

test("at most one blur layer: no drawer rule blurs, the inner cards and the overlay switch blur off", () => {
  // 抽屉自己的规则一条都不写模糊——唯一的模糊来自面板上的 .glass。
  expect(
    all
      .filter((r) => DRAWER.test(r.selector) && blurs(r))
      .map((r) => r.selector),
  ).toEqual([]);
  expect(all.some((r) => r.selector === ".glass" && blurs(r))).toBe(true);
  // 里面的卡片关掉旧三档玻璃层（它读 --lg-blur / --lg-surface / --lg-shadow）。
  const inner = all.find((r) =>
    r.selector.includes(".hk-drawer :is(.glass-side-card, .acct-card"),
  );
  expect(inner?.body).toMatch(/--lg-blur:\s*none/);
  expect(inner?.body).toMatch(/--lg-surface:\s*transparent/);
  expect(inner?.body).toMatch(/--lg-shadow:\s*none/);
  // 遮罩只压暗。
  const dim = all.find(
    (r) => r.selector === '[data-slot="sheet-overlay"].hk-drawer-overlay',
  );
  expect(dim?.body).toMatch(/backdrop-filter:\s*none/);
  expect(dim?.body).toMatch(/background:\s*rgba\(0, 0, 0, 0\.\d+\)/);
});

test("the drawer slides with transform only, 200ms, and not at all under reduced motion", () => {
  const base = all.find(
    (r) => r.selector === '[data-slot="sidebar"].hk-drawer',
  );
  expect(base?.body).toMatch(/transition-property:\s*transform;/);
  expect(base?.body).toMatch(/transition-duration:\s*200ms;/);
  expect(base?.body).toMatch(
    /border-radius:\s*0 var\(--hk-drawer-radius\) var\(--hk-drawer-radius\) 0;/,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-slot="sidebar"\]\.hk-drawer,\s*\[data-slot="sheet-overlay"\]\.hk-drawer-overlay \{\s*transition: none;/,
  );
  // 性能模式和减少透明度：不透明底、不模糊。
  const perf = all.find(
    (r) =>
      r.selector === 'html[data-perf="on"] [data-slot="sidebar"].hk-drawer',
  );
  expect(perf?.body).toMatch(/background:\s*var\(--hk-drawer-solid\)/);
  expect(perf?.body).toMatch(/backdrop-filter:\s*none/);
  expect(css).toMatch(
    /@media \(prefers-reduced-transparency: reduce\) \{\s*html \[data-slot="sidebar"\]\.hk-drawer \{\s*background: var\(--hk-drawer-solid\);\s*backdrop-filter: none;/,
  );
});
