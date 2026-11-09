import { describe, expect, test } from "bun:test";
import { CHISABOT_EXTRAS, parseChisabotExtras } from "../src/config";

// 功能精简（DESIGN.md §74）：默认隐藏的功能由 CHISABOT_EXTRAS 重新打开。
describe("CHISABOT_EXTRAS", () => {
  test("不设 = 全部隐藏", () => {
    expect(parseChisabotExtras(undefined)).toEqual([]);
    expect(parseChisabotExtras("")).toEqual([]);
  });
  test("逗号 / 空格分隔，大小写不敏感，不认识的忽略", () => {
    expect(parseChisabotExtras("Workflows, plugins nope")).toEqual([
      "workflows",
      "plugins",
    ]);
  });
  test("all = 全部", () => {
    expect(parseChisabotExtras("all")).toEqual([...CHISABOT_EXTRAS]);
  });
});
