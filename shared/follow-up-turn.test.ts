import { describe, expect, test } from "bun:test";
import { buildWakeUpInstruction, readWakeUpTurn } from "./follow-up-turn";

describe("follow-up wake message", () => {
  test("round-trips reason and instruction", () => {
    const text = buildWakeUpInstruction({
      scheduledAt: "2026-11-04T06:42:13.759Z",
      reason: "云端服务器性能面板每小时自动刷新",
      instruction:
        "刷新面板 lp_53b7ba32：用 computer_run_command 读取 /proc/loadavg，然后 panel_update 提交新 state",
    });
    expect(readWakeUpTurn(text)).toEqual({
      scheduledAt: "2026-11-04T06:42:13.759Z",
      reason: "云端服务器性能面板每小时自动刷新",
      instruction:
        "刷新面板 lp_53b7ba32：用 computer_run_command 读取 /proc/loadavg，然后 panel_update 提交新 state",
    });
  });

  test("a follow-up with no instruction reads back with an empty one", () => {
    const text = buildWakeUpInstruction({
      scheduledAt: "2026-11-04T06:42:13.759Z",
      reason: "价格可能变了，看一眼",
    });
    expect(readWakeUpTurn(text)).toEqual({
      scheduledAt: "2026-11-04T06:42:13.759Z",
      reason: "价格可能变了，看一眼",
      instruction: "",
    });
  });

  test("text that merely opens like a wake message is not one", () => {
    expect(
      readWakeUpTurn(
        "You scheduled this follow-up for yourself on 2026-11-04. Your reason: 抄来的",
      ),
    ).toBeNull();
    expect(readWakeUpTurn("You scheduled this follow-up")).toBeNull();
    expect(readWakeUpTurn("hello")).toBeNull();
  });
});
