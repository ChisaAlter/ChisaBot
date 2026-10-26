import { expect, test } from "bun:test";
import { openForActivityJump } from "@/lib/computers/auto-watch";

/**
 * CB-101：「在活动里看」打开计算机不多压 history。抽屉走手动打开的同一个入口（showPanels），
 * 切到「计算机」只用 replace。
 */
test("jump opens the drawer through showPanels and switches to the computer with replace", () => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) };
  try {
    const calls: unknown[] = [];
    const navigate = ((options: unknown) => {
      calls.push(options);
      return Promise.resolve();
    }) as never;
    openForActivityJump({ watching: false, navigate });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ replace: true });
    const search = (calls[0] as { search: (p: Record<string, unknown>) => unknown }).search;
    expect(search({ agent: "a" })).toEqual({ agent: "a", watch: true });

    // 已经在「计算机」上：不改地址。
    openForActivityJump({ watching: true, navigate });
    expect(calls).toHaveLength(1);
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
});
