import { describe, expect, test } from "bun:test";
import { parseRunsParam } from "../src/schedules/service";

/** CB-106 P3：GET /api/schedules/:id?runs=N 的参数解析。 */
describe("parseRunsParam", () => {
  test("无效值回到默认 20", () => {
    for (const raw of [undefined, null, "", "-1", "0", "2.5", "abc", "1e3", " ", "NaN", "Infinity", "0x10"])
      expect(parseRunsParam(raw)).toBe(20);
  });
  test("有效整数照用，封顶 500", () => {
    expect(parseRunsParam("1")).toBe(1);
    expect(parseRunsParam("37")).toBe(37);
    expect(parseRunsParam("500")).toBe(500);
    expect(parseRunsParam("501")).toBe(500);
    expect(parseRunsParam("99999999999999999999")).toBe(20);
  });
});
