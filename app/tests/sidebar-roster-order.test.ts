import { describe, expect, test } from "bun:test";
import { sortSidebarRoster } from "../src/lib/agents/roster-order";

describe("sortSidebarRoster", () => {
  test("无主机器人时将置顶机器人排在前面，并按 pinnedAt 降序排列", () => {
    const input = [
      { id: "a", pinned: false, pinnedAt: null },
      { id: "b", pinned: true, pinnedAt: "2026-11-19T08:00:00.000Z" },
      { id: "c", pinned: false, pinnedAt: null },
      { id: "d", pinned: true, pinnedAt: "2026-11-19T09:00:00.000Z" },
    ];
    const result = sortSidebarRoster(input, null);
    expect(result.mainBot).toBeUndefined();
    expect(result.others.map((item) => item.id)).toEqual(["d", "b", "a", "c"]);
    expect(result.ordered.map((item) => item.id)).toEqual(["d", "b", "a", "c"]);
  });

  test("有主机器人时主机器人独占首位且不重复，其余置顶机器人按 pinnedAt 降序排在主机器人之后", () => {
    const input = [
      { id: "u1", pinned: false, pinnedAt: null },
      { id: "p1", pinned: true, pinnedAt: "2026-11-19T07:00:00.000Z" },
      { id: "main", pinned: true, pinnedAt: "2026-11-19T10:00:00.000Z" },
      { id: "p2", pinned: true, pinnedAt: "2026-11-19T09:30:00.000Z" },
      { id: "u2", pinned: false, pinnedAt: null },
    ];
    const result = sortSidebarRoster(input, "main");
    expect(result.mainBot?.id).toBe("main");
    expect(result.others.map((item) => item.id)).toEqual([
      "p2",
      "p1",
      "u1",
      "u2",
    ]);
    expect(result.ordered.map((item) => item.id)).toEqual([
      "main",
      "p2",
      "p1",
      "u1",
      "u2",
    ]);
  });

  test("缺少 pinnedAt 的置顶机器人排在有时间戳的置顶之后，且保持原始相对顺序", () => {
    const input = [
      { id: "legacy-1", pinned: true, pinnedAt: null },
      { id: "normal-1", pinned: false, pinnedAt: null },
      { id: "timed", pinned: true, pinnedAt: "2026-11-19T08:00:00.000Z" },
      { id: "legacy-2", pinned: true },
      { id: "normal-2", pinned: false, pinnedAt: null },
    ];
    const result = sortSidebarRoster(input, undefined);
    expect(result.ordered.map((item) => item.id)).toEqual([
      "timed",
      "legacy-1",
      "legacy-2",
      "normal-1",
      "normal-2",
    ]);
  });
});
