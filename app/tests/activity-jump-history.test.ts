import { expect, test } from "bun:test";
import { openForActivityJump } from "@/lib/computers/auto-watch";
import {
  panelSheetOpenSource,
  setPanelSheetOpen,
} from "@/lib/panels/rail-open";

/**
 * CB-101 第二阶段：「在活动里看」在窄屏走 openPanelSheet("user")（和手动点把手同一个入口），
 * 宽屏展开右栏并 push 一条 watch=true；已经在看计算机就不写 history。
 */
function withWidth<T>(wide: boolean, run: () => T): T {
  const g = globalThis as { window?: unknown };
  const previous = g.window;
  g.window = { matchMedia: () => ({ matches: wide }) };
  try {
    return run();
  } finally {
    g.window = previous;
  }
}

test("narrow: the jump opens the drawer through openPanelSheet (source=user)", () => {
  withWidth(false, () => {
    setPanelSheetOpen(false);
    const calls: string[] = [];
    openForActivityJump({
      watching: false,
      setWatching: (open) => calls.push(`set:${open}`),
    });
    // 抽屉经由唯一入口打开：来源是 user（压一条返回标记），不是 restore。
    expect(panelSheetOpenSource()).toBe("user");
    expect(calls).toEqual(["set:true"]);
    // 抽屉已经开着、也在看计算机：什么都不写。
    openForActivityJump({
      watching: true,
      setWatching: (open) => calls.push(`set:${open}`),
    });
    expect(calls).toEqual(["set:true"]);
    setPanelSheetOpen(false);
  });
});

test("wide: the jump expands the rail and switches to the computer once", () => {
  withWidth(true, () => {
    const calls: string[] = [];
    openForActivityJump({
      watching: false,
      setWatching: (open) => calls.push(`set:${open}`),
    });
    expect(calls).toEqual(["set:true"]);
    openForActivityJump({
      watching: true,
      setWatching: (open) => calls.push(`set:${open}`),
    });
    expect(calls).toEqual(["set:true"]);
  });
});
