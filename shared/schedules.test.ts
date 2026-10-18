import { describe, expect, test } from "bun:test";
import { classifyScheduleReply } from "./schedules";

describe("classifyScheduleReply (FIX-01)", () => {
  test("marks deferred confirm as waiting", () => {
    expect(
      classifyScheduleReply(
        "这一步属于「对外发消息」，要先经用户确认。已经在聊天和「待处理」里放了一张确认卡片（24 小时内有效）。用户点「确认」后会自动叫你接着做。现在不要换别的办法去做这一步；一两句话告诉用户你准备做什么、在等他确认。",
      ),
    ).toBe("waiting");
  });

  test("marks cannot-show-card as skipped", () => {
    expect(
      classifyScheduleReply(
        "这一步属于「对外发消息」，用户的审批偏好是「先问我」，但这一轮不在网页聊天里，弹不出确认卡片，所以没有执行。",
      ),
    ).toBe("skipped");
  });

  test("marks tunnel / hard failures as failed", () => {
    expect(classifyScheduleReply("浏览器打开失败：ERR_TUNNEL_CONNECTION_FAILED")).toBe("failed");
    expect(classifyScheduleReply("运行失败：something exploded")).toBe("failed");
    expect(classifyScheduleReply("没有执行：这台计算机现在由用户接管着。")).toBe("failed");
  });

  test("ordinary success stays ok", () => {
    expect(classifyScheduleReply("⏰ 该喝水了")).toBe("ok");
    expect(classifyScheduleReply("今天上海多云，气温 22℃。")).toBe("ok");
  });
});
