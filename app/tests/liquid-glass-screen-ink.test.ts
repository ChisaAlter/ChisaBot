/**
 * 液态玻璃安装器的整屏墨色（DESIGN.md §10.6），在 happy-dom 里跑真的 installLiquidGlass：
 * 背景光栅换成一块可调灰度的假画布，面板给上假布局，验证
 * - 整屏一种墨，亮背景浅釉、真暗才深釉，0.40 / 0.50 迟滞；
 * - 用户自己的气泡跟着整屏墨色走；
 * - 后渲染的卡片当场挂上整屏墨色、并参与下一次判定；首屏一块面板都没有时也不会落空；
 * - 判定不写存储，旧版本存下的 chisabot-lg-ink 启动时清掉、也不再拿来预涂。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let gray = 200;
let installLiquidGlass: typeof import("../src/lib/liquid-glass").installLiquidGlass;
let LG_INK_STORAGE_KEY: string;
let uninstall: (() => void) | null = null;
const restores: Array<() => void> = [];

function fakeCtx(canvas: HTMLCanvasElement) {
  const grad = { addColorStop() {} };
  return {
    canvas,
    fillStyle: "",
    setTransform() {},
    fillRect() {},
    drawImage() {},
    putImageData() {},
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    getImageData(_x: number, _y: number, w: number, h: number) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        data[i + 3] = 255;
      }
      return { data, width: w, height: h };
    },
  };
}

function patch<T extends object, K extends keyof T>(
  obj: T,
  key: K,
  desc: PropertyDescriptor,
) {
  const prev = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { configurable: true, ...desc });
  restores.push(() => {
    if (prev) Object.defineProperty(obj, key, prev);
    else delete (obj as Record<PropertyKey, unknown>)[key as PropertyKey];
  });
}

beforeAll(async () => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1440,
    height: 900,
  });
  const contexts = new WeakMap<HTMLCanvasElement, ReturnType<typeof fakeCtx>>();
  patch(HTMLCanvasElement.prototype, "getContext", {
    value(this: HTMLCanvasElement) {
      let c = contexts.get(this);
      if (!c) {
        c = fakeCtx(this);
        contexts.set(this, c);
      }
      return c;
    },
  });
  // happy-dom 没有布局：每块面板按 data-rect 给位置，offsetParent 恒有。
  patch(HTMLElement.prototype, "offsetParent", {
    get() {
      return document.body;
    },
  });
  patch(Element.prototype, "getBoundingClientRect", {
    value(this: Element) {
      const [x, y, w, h] = (this.getAttribute("data-rect") ?? "0,0,0,0")
        .split(",")
        .map(Number);
      return {
        x,
        y,
        left: x,
        top: y,
        width: w,
        height: h,
        right: x + w,
        bottom: y + h,
        toJSON() {},
      } as DOMRect;
    },
  });
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const mod = await import("../src/lib/liquid-glass");
  installLiquidGlass = mod.installLiquidGlass;
  LG_INK_STORAGE_KEY = mod.LG_INK_STORAGE_KEY;
});

afterAll(async () => {
  for (const r of restores.reverse()) r();
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  gray = 200;
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.setAttribute("data-glass", "liquid");
  document.body.innerHTML = "";
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 侧栏、右栏、输入框、一张对话卡片、一个用户气泡。 */
function mountShell() {
  document.body.innerHTML = `
    <aside class="glass-side-card" data-rect="16,56,280,820"></aside>
    <aside class="rail-card" data-rect="1124,56,300,820"></aside>
    <main class="glass-main">
      <div class="jr-card" data-rect="340,180,700,100"></div>
      <div data-slot="message" data-align="end"><div data-slot="bubble" data-align="end">
        <div data-slot="bubble-content" id="user-bubble" data-rect="820,80,220,44"></div>
      </div></div>
      <div class="glass-composer" data-rect="330,800,780,80"></div>
    </main>`;
}

function inks(): string[] {
  return [
    ...document.querySelectorAll(
      '.glass-side-card, .rail-card, .jr-card, [data-slot="bubble-content"], .glass-composer',
    ),
  ].map((el) => el.getAttribute("data-lg-ink") ?? "light");
}

/** 让安装器重采一次（<html> 上被监听的属性变化 → refresh → 160ms 节流后采样）。 */
async function resample(g: number) {
  gray = g;
  const de = document.documentElement;
  de.setAttribute(
    "data-resizing",
    de.getAttribute("data-resizing") === "1" ? "0" : "1",
  );
  await wait(260);
}

describe("liquid glass installer: one ink for the whole screen", () => {
  test("bright backdrop stays light; a really dark one flips every panel (user bubble too) together", async () => {
    mountShell();
    uninstall = installLiquidGlass();
    await wait(260);
    expect(new Set(inks())).toEqual(new Set(["light"]));
    await resample(80); // 0.31
    expect(inks().every((i) => i === "dark")).toBe(true);
    expect(
      document.getElementById("user-bubble")?.getAttribute("data-lg-ink"),
    ).toBe("dark");
  });

  test("hysteresis: dark under 0.40, back to light only at ≥0.50; 0.45 keeps whichever it was", async () => {
    mountShell();
    uninstall = installLiquidGlass();
    await wait(260);
    await resample(115); // 0.45，上次浅 → 浅
    expect(new Set(inks())).toEqual(new Set(["light"]));
    await resample(97); // 0.38 → 深
    expect(new Set(inks())).toEqual(new Set(["dark"]));
    await resample(115); // 0.45，上次深 → 深
    expect(new Set(inks())).toEqual(new Set(["dark"]));
    await resample(125); // 0.49 → 仍深
    expect(new Set(inks())).toEqual(new Set(["dark"]));
    await resample(133); // 0.52 → 浅
    expect(new Set(inks())).toEqual(new Set(["light"]));
  });

  test("the decision is never persisted; a stale stored dark ink is cleared and not pre-painted", async () => {
    window.localStorage.setItem(LG_INK_STORAGE_KEY, "dark");
    mountShell();
    uninstall = installLiquidGlass();
    // 启动当下不再按旧存储预涂深釉。
    expect(new Set(inks())).toEqual(new Set(["light"]));
    expect(window.localStorage.getItem(LG_INK_STORAGE_KEY)).toBeNull();
    await resample(60);
    expect(new Set(inks())).toEqual(new Set(["dark"]));
    expect(window.localStorage.getItem(LG_INK_STORAGE_KEY)).toBeNull();
  });

  test("a late-rendered card takes the screen ink at once and joins the next sample", async () => {
    mountShell();
    uninstall = installLiquidGlass();
    await wait(260);
    await resample(70);
    expect(new Set(inks())).toEqual(new Set(["dark"]));
    const card = document.createElement("div");
    card.className = "jr-card";
    card.setAttribute("data-rect", "340,300,700,160");
    document.querySelector(".glass-main")?.appendChild(card);
    await wait(0); // MutationObserver 回调（微任务）
    expect(card.getAttribute("data-lg-ink")).toBe("dark");
    await wait(260);
    expect(card.style.getPropertyValue("--lg-density-k")).not.toBe("");
  });

  test("first sample is not lost when the panels render after the installer starts", async () => {
    uninstall = installLiquidGlass();
    await wait(260); // 首次采样时一块面板都没有
    gray = 60;
    mountShell();
    await wait(400);
    expect(new Set(inks())).toEqual(new Set(["dark"]));
    const side = document.querySelector<HTMLElement>(".glass-side-card");
    expect(side?.style.getPropertyValue("--lg-density-k")).not.toBe("");
  });

  test("dark scheme never sets the light-scheme dark-glaze attribute", async () => {
    document.documentElement.classList.add("dark");
    mountShell();
    uninstall = installLiquidGlass();
    await wait(260);
    expect(new Set(inks())).toEqual(new Set(["light"]));
    expect(window.localStorage.getItem(LG_INK_STORAGE_KEY)).toBeNull();
  });
});
