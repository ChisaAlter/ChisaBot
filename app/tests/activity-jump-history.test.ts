import { expect, test } from "bun:test";
import { openForActivityJump } from "@/lib/computers/auto-watch";

/**
 * CB-101：「在活动里看」和手动切到「计算机」走同一条路径：打开右栏/抽屉（showPanels，不写 history），
 * 没在看计算机时 setWatching(true)（push 一条 watch=true）；已经在看就不写 history。窄屏、桌面一样。
 */
for (const wide of [false, true]) {
  test(`jump = switching to the computer by hand (${wide ? "wide" : "narrow"})`, () => {
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: wide }),
    };
    try {
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
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
}
