import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import {
  captureScrollAnchor,
  restoreScrollAnchor,
} from "@/lib/chat/tail-first-paint";
import { useTailFirstMount } from "@/lib/chat/use-tail-first-mount";
import { settleReactWork } from "./settle-react-work";

/**
 * QA #519 P2-1：点「显示更早的消息」后，正在看的那一行必须留在原地（几个像素内），
 * 不能先飞出屏幕再被钉回底部。scrollTop 为 0 时浏览器不做 overflow-anchor，
 * 所以这里用 JS 记下锚点、在 layout 里同步恢复，不依赖原生锚定。
 */

const ROW = 40;
const VIEW = 400;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Probe = {
  el: HTMLDivElement | null;
  top: number;
  writes: number[];
};

const box = (top: number, height: number): DOMRect =>
  ({
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 300,
    width: 300,
    height,
    toJSON() {
      return {};
    },
  }) as DOMRect;

function attachViewport(
  el: HTMLDivElement,
  probe: Probe,
  rowCount: () => number,
  viewportHeight = VIEW,
) {
  probe.el = el;
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => viewportHeight,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => rowCount() * ROW,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => probe.top,
    set: (value: number) => {
      probe.top = value;
      probe.writes.push(value);
    },
  });
  el.getBoundingClientRect = () => box(0, viewportHeight);
}

function Harness({
  total,
  probe,
  firstOffset = 0,
  viewportHeight = VIEW,
}: {
  total: number;
  probe: Probe;
  /** 在行前面垫一段（模拟「显示更早的消息」按钮占的高度）。 */
  firstOffset?: number;
  viewportHeight?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const startRef = useRef(0);
  const { startIndex, prependHistory, truncated } = useTailFirstMount(
    total,
    "prepend-anchor",
    ref,
    "m-0",
  );
  startRef.current = startIndex;
  const attach = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (!el) return;
    attachViewport(
      el,
      probe,
      () => el.querySelectorAll("[data-slot='message-scroller-item']").length,
      viewportHeight,
    );
    if (firstOffset) {
      Object.defineProperty(el, "scrollHeight", {
        configurable: true,
        get: () =>
          firstOffset +
          el.querySelectorAll("[data-slot='message-scroller-item']").length *
            ROW,
      });
    }
  };
  return (
    <div ref={attach}>
      {truncated ? (
        <button
          className="chat-history-more"
          onClick={prependHistory}
          type="button"
        >
          {"显示更早的消息"}
        </button>
      ) : null}
      {Array.from({ length: total - startIndex }, (_, i) => {
        const index = startIndex + i;
        return (
          <div
            data-message-id={`m-${index}`}
            data-slot="message-scroller-item"
            key={`m-${index}`}
            ref={(row) => {
              if (!row) return;
              row.getBoundingClientRect = () => {
                const y =
                  firstOffset + (index - startRef.current) * ROW - probe.top;
                return box(y, ROW);
              };
            }}
          />
        );
      })}
    </div>
  );
}

function rowOffset(probe: Probe, id: string): number {
  const row = probe.el?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  if (!row || !probe.el) throw new Error(`missing ${id}`);
  return row.getBoundingClientRect().top - probe.el.getBoundingClientRect().top;
}

function visibleAnchorId(probe: Probe): string {
  const anchor = captureScrollAnchor(probe.el!);
  if (!anchor?.id) throw new Error("no visible anchor");
  return anchor.id;
}

const pause = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settleReactWork();
  });

const rAF = () =>
  act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });

test("captureScrollAnchor picks the first visible row in the viewport", () => {
  const root = document.createElement("div");
  root.getBoundingClientRect = () => box(0, VIEW);
  for (const [id, top, hidden] of [
    ["a", -50, false],
    ["b", 20, false],
    ["hid", 30, true],
    ["c", 80, false],
  ] as const) {
    const row = document.createElement("div");
    row.dataset.slot = "message-scroller-item";
    row.setAttribute("data-message-id", id);
    if (hidden) {
      row.dataset.row = "activity";
      row.appendChild(document.createElement("div"));
    }
    row.getBoundingClientRect = () => box(top, hidden ? 0 : ROW);
    root.appendChild(row);
  }
  const anchor = captureScrollAnchor(root);
  expect(anchor?.id).toBe("b");
  expect(anchor?.offset).toBe(20);
});

test("restoreScrollAnchor moves scrollTop so the row keeps its offset", () => {
  const root = document.createElement("div");
  let top = 0;
  Object.defineProperty(root, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  root.getBoundingClientRect = () => box(0, VIEW);
  const row = document.createElement("div");
  row.setAttribute("data-message-id", "keep");
  row.getBoundingClientRect = () => box(800 - top, ROW);
  root.appendChild(row);
  const ok = restoreScrollAnchor(root, { id: "keep", node: row, offset: 16 });
  expect(ok).toBe(true);
  expect(top).toBe(784);
  expect(row.getBoundingClientRect().top).toBe(16);
});

async function clickMore(probe: Probe) {
  const button =
    probe.el?.querySelector<HTMLButtonElement>(".chat-history-more");
  expect(button).not.toBeNull();
  const id = visibleAnchorId(probe);
  const before = rowOffset(probe, id);
  probe.writes = [];
  act(() => {
    fireEvent.click(button!);
  });
  return { id, before };
}

test("clicking show-earlier at scrollTop 0 keeps the visible row in place", async () => {
  const probe: Probe = { el: null, top: 0, writes: [] };
  render(<Harness total={200} probe={probe} />);
  // 首帧会钉到底；这里模拟人先翻到顶再点按钮（QA 复现就是 scrollTop=0）。
  probe.top = 0;
  const { id, before } = await clickMore(probe);
  expect(Math.abs(rowOffset(probe, id) - before)).toBeLessThanOrEqual(2);
  await rAF();
  await pause();
  // 没有后续把视口钉到底或闪到别处：锚还在原处。
  expect(Math.abs(rowOffset(probe, id) - before)).toBeLessThanOrEqual(2);
  expect(probe.top).toBeGreaterThan(0);
});

test("clicking show-earlier mid-scroll keeps the visible row in place", async () => {
  const probe: Probe = { el: null, top: 0, writes: [] };
  render(<Harness total={200} probe={probe} />);
  probe.top = 220;
  const { id, before } = await clickMore(probe);
  expect(Math.abs(rowOffset(probe, id) - before)).toBeLessThanOrEqual(2);
  await rAF();
  expect(Math.abs(rowOffset(probe, id) - before)).toBeLessThanOrEqual(2);
});

test("clicking show-earlier while already at the bottom keeps the visible row in place", async () => {
  const probe: Probe = { el: null, top: 0, writes: [] };
  render(<Harness total={200} probe={probe} />);
  const height = probe.el!.scrollHeight;
  probe.top = height - VIEW;
  expect(probe.el!.scrollHeight - probe.top - VIEW).toBeLessThan(80);
  const { id, before } = await clickMore(probe);
  expect(Math.abs(rowOffset(probe, id) - before)).toBeLessThanOrEqual(2);
  await rAF();
  await pause();
  expect(Math.abs(rowOffset(probe, id) - before)).toBeLessThanOrEqual(2);
  // 长对话本来就在底部：恢复锚点后仍在底部（新内容加在上面，视口跟着垫高）。
  // 关键是中间没有先跳到 0。短内容「误钉到新底部」由下一条覆盖。
  expect(Math.min(...probe.writes, probe.top)).toBeGreaterThan(
    height - VIEW - 2,
  );
});

test("short content (scrollTop 0 and at bottom) stays on the same row, with no later jump", async () => {
  // 行高合计不够一屏：scrollTop=0 也算在底部。这是 QA 复现的场景。
  const probe: Probe = { el: null, top: 0, writes: [] };
  const shortView = 3000;
  render(
    <Harness
      firstOffset={136}
      probe={probe}
      total={200}
      viewportHeight={shortView}
    />,
  );
  // 真实浏览器里内容不够一屏时 scrollTop=scrollHeight 会被夹成 0。
  probe.top = 0;
  const { id, before } = await clickMore(probe);
  expect(before).toBe(136);
  expect(Math.abs(rowOffset(probe, id) - 136)).toBeLessThanOrEqual(2);
  await rAF();
  await pause();
  expect(Math.abs(rowOffset(probe, id) - 136)).toBeLessThanOrEqual(2);
  // 同步恢复只应写一次（或等价的最终值），不能先写到底再改回来。
  expect(probe.writes.length).toBeGreaterThan(0);
  expect(probe.writes.at(-1)).toBe(probe.top);
});
