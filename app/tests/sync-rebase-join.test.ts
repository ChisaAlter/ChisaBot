import { describe, expect, test } from "bun:test";
import { shouldCatchRunningOnRebase } from "../src/lib/copilot/use-conversation-sync";

/**
 * CB-005 / DESIGN.md §42.8：rebase 后不要因为服务器 running 还亮着就重连。
 */
describe("shouldCatchRunningOnRebase", () => {
  test("first observation of a running remote turn should connect", () => {
    expect(shouldCatchRunningOnRebase(null, true)).toBe(true);
  });

  test("after a local turn (previous exists) do not reconnect just because running is still true", () => {
    expect(shouldCatchRunningOnRebase({ seq: 1 }, true)).toBe(false);
  });

  test("idle never connects on rebase", () => {
    expect(shouldCatchRunningOnRebase(null, false)).toBe(false);
    expect(shouldCatchRunningOnRebase({ seq: 1 }, false)).toBe(false);
  });
});
