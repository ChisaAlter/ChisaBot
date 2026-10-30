import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useCallback, useRef } from "react";
import { initialMountedCount } from "@/lib/chat/tail-first-paint";
import { useTailFirstMount } from "@/lib/chat/use-tail-first-mount";
import { settleReactWork } from "./settle-react-work";

/**
 * jank P1-2：补行时别每批读 scrollHeight（每次都是整棵 transcript 的强制样式重算）。
 * 用一个假视口：行高固定 20px，scrollHeight 按挂着的行数算，每次读都计数。
 */

const ROW = 100;
const VIEWPORT = 400;
let nativeAnchor = true;
let realCss: PropertyDescriptor | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
  if (realCss) Object.defineProperty(globalThis, "CSS", realCss);
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function stubAnchor(supported: boolean) {
  nativeAnchor = supported;
  // happy-dom exposes `CSS` as a getter that builds a fresh object each read; replace the getter.
  realCss ??= Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      supports: (prop: string) => prop === "overflow-anchor" && nativeAnchor,
    },
  });
}

type Probe = { el: HTMLDivElement | null; reads: number; top: number };

function Harness({ total, probe }: { total: number; probe: Probe }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current = el;
      probe.el = el;
      if (!el) return;
      Object.defineProperty(el, "scrollHeight", {
        configurable: true,
        get: () => {
          probe.reads += 1;
          return el.children.length * ROW;
        },
      });
      Object.defineProperty(el, "clientHeight", {
        configurable: true,
        get: () => VIEWPORT,
      });
      Object.defineProperty(el, "scrollTop", {
        configurable: true,
        get: () => probe.top,
        set: (v: number) => {
          probe.top = v;
        },
      });
    },
    [probe],
  );
  const { startIndex, pending } = useTailFirstMount(total, "k", ref, "m-0");
  return (
    <div ref={attach} data-pending={pending ? "" : undefined}>
      {Array.from({ length: total - startIndex }, (_, i) => (
        <p key={`m-${startIndex + i}`} />
      ))}
    </div>
  );
}

async function untilFull(probe: Probe, total: number) {
  await waitFor(
    () => {
      expect(probe.el?.children.length).toBe(total);
      expect(probe.el?.hasAttribute("data-pending")).toBe(false);
    },
    { timeout: 3000 },
  );
  await act(async () => {
    await settleReactWork();
  });
}

test("at bottom with native anchoring: backfill reads scrollHeight once, then pins to bottom", async () => {
  stubAnchor(true);
  const total = 400;
  const probe: Probe = { el: null, reads: 0, top: 0 };
  render(<Harness total={total} probe={probe} />);
  expect(probe.el?.children.length).toBe(initialMountedCount(total));
  await untilFull(probe, total);
  // 以前每批一次（400 条 13 批）；现在只有补完钉底那一次。
  expect(probe.reads).toBeLessThanOrEqual(1);
  // 打开即在底部。
  expect(probe.top).toBe(total * ROW);
});

test("scrolled up with native anchoring: backfill reads nothing and leaves scrollTop to the browser", async () => {
  stubAnchor(true);
  const total = 400;
  const probe: Probe = { el: null, reads: 0, top: 0 };
  render(<Harness total={total} probe={probe} />);
  // 人往上滑了一点（还没到顶部的加速区）。
  probe.top = 500;
  act(() => {
    probe.el?.dispatchEvent(new Event("scroll"));
  });
  probe.reads = 0;
  await untilFull(probe, total);
  expect(probe.reads).toBe(0);
  expect(probe.top).toBe(500);
});

test("scrolled up without native anchoring: prepended rows keep the visible row in place", async () => {
  stubAnchor(false);
  const total = 400;
  const probe: Probe = { el: null, reads: 0, top: 0 };
  render(<Harness total={total} probe={probe} />);
  const before = probe.el?.children.length ?? 0;
  probe.top = 500;
  act(() => {
    probe.el?.dispatchEvent(new Event("scroll"));
  });
  await untilFull(probe, total);
  // 前插了 total - before 行，scrollTop 跟着垫同样高度：视口里那一行不动。
  expect(probe.top).toBe(500 + (total - before) * ROW);
});

test("short transcript mounts everything at once and never measures", async () => {
  stubAnchor(true);
  const probe: Probe = { el: null, reads: 0, top: 0 };
  render(<Harness total={20} probe={probe} />);
  await act(async () => {
    await settleReactWork();
  });
  expect(probe.el?.children.length).toBe(20);
  expect(probe.reads).toBe(0);
});
