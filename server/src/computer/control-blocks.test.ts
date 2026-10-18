import { describe, expect, test } from "bun:test";
import { isUnattendedInitiator, suspendsOnHumanControl } from "./control-blocks";

describe("suspendsOnHumanControl (FIX-02)", () => {
  test("chat / no initiator does not suspend", () => {
    expect(suspendsOnHumanControl(undefined)).toBe(false);
    expect(suspendsOnHumanControl({ kind: "person" })).toBe(false);
  });

  test("schedule and im are unattended and do not suspend", () => {
    expect(suspendsOnHumanControl({ kind: "routine", id: "schedule:sch_1" })).toBe(false);
    expect(suspendsOnHumanControl({ kind: "routine", id: "im:conn_1" })).toBe(false);
    expect(isUnattendedInitiator({ kind: "routine", id: "schedule:sch_1" })).toBe(true);
    expect(isUnattendedInitiator({ kind: "routine", id: "im:conn_1" })).toBe(true);
  });

  test("live panel does not suspend", () => {
    expect(suspendsOnHumanControl({ kind: "routine", id: "lp_abc" })).toBe(false);
  });

  test("other routines still suspend", () => {
    expect(suspendsOnHumanControl({ kind: "routine", id: "workflow:wf_1" })).toBe(true);
    expect(isUnattendedInitiator({ kind: "routine", id: "workflow:wf_1" })).toBe(false);
  });
});


// FIX-13 / FIX-14：挂起 turn 吞掉记忆 / 面板写入 — 由 #208 FIX-02 无人值守快失败解决。
// 回归：unattended initiator 碰到交还应 fail-fast，而不是挂死对话占住队列。
