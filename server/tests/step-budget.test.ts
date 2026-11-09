import { describe, expect, test } from "bun:test";
import { withStepBudgetNote } from "../src/conversation-runtime";

describe("step budget note (§101)", () => {
  test("adds a wrap-up note to the last three tool results of a run only", () => {
    const turn = {};
    const out: unknown[] = [];
    for (let i = 0; i < 12; i++) out.push(withStepBudgetNote(`r${i}`, turn));
    expect(out.slice(0, 9).every((r) => !String(r).includes("系统提示"))).toBe(true);
    expect(String(out[9])).toContain("最多还能再调 2 次");
    expect(String(out[11])).toContain("最多还能再调 0 次");
    // 普通对象结果加 systemNote，别的不动
    expect((withStepBudgetNote({ ok: true }, turn) as { systemNote?: string }).systemNote).toContain("停止调用工具");
    // 另一轮重新计数
    expect(withStepBudgetNote("x", {})).toBe("x");
    // 没有 run 上下文：原样返回
    expect(withStepBudgetNote("y", undefined)).toBe("y");
  });
});
