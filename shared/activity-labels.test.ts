import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_STALE_RUN_MS,
  activityStatusIsFailure,
  activityStatusZh,
} from "./activity-labels";

describe("activityStatusZh (PRD-P2-01/02)", () => {
  test("maps machine codes to Chinese", () => {
    expect(activityStatusZh("running")).toBe("运行中");
    expect(activityStatusZh("failed")).toBe("失败");
    expect(activityStatusZh("waiting for you")).toBe("等你处理");
    expect(activityStatusZh("succeeded")).toBe("已完成");
  });

  test("unknown codes pass through", () => {
    expect(activityStatusZh("brand-new-state")).toBe("brand-new-state");
  });

  test("failure detection", () => {
    expect(activityStatusIsFailure("failed")).toBe(true);
    expect(activityStatusIsFailure("running")).toBe(false);
    expect(ACTIVITY_STALE_RUN_MS).toBe(20 * 60 * 1000);
  });
});
