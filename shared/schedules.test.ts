import { describe, expect, test } from "bun:test";
import { classifyScheduleReply, failStreakShouldPause, formatWhen, formatWhenAbsolute, partitionScheduleList,
  scheduleLastLineZh,
  scheduleLastTone, type ScheduleView } from "./schedules";

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


describe("formatWhenAbsolute (FIX-09)", () => {
  test("persisted labels never say 今天/昨天", () => {
    const at = new Date("2026-10-17T13:00:00Z"); // 21:00 Asia/Shanghai
    const now = new Date("2026-10-17T14:00:00Z");
    const abs = formatWhenAbsolute(at, "Asia/Shanghai", now);
    expect(abs).not.toMatch(/今天|昨天|明天/);
    expect(abs).toMatch(/10月17日/);
    // live UI may still say 今天
    expect(formatWhen(at, "Asia/Shanghai", now)).toMatch(/今天/);
  });
});


describe("failStreakShouldPause (Track B)", () => {
  test("pauses only after N consecutive failures", () => {
    expect(failStreakShouldPause(["failed", "failed"], 3)).toBe(false);
    expect(failStreakShouldPause(["failed", "failed", "failed"], 3)).toBe(true);
    expect(failStreakShouldPause(["failed", "ok", "failed", "failed", "failed"], 3)).toBe(false);
    expect(failStreakShouldPause(["failed", "failed", "failed", "ok"], 3)).toBe(true);
  });
});


describe("partitionScheduleList (v0.1.34 non-tram re-verify)", () => {
  const base = (over: Partial<ScheduleView> & Pick<ScheduleView, "id" | "agentId" | "status">): ScheduleView => ({
    threadId: "t1",
    source: "web",
    title: over.id,
    instruction: "x",
    kind: "cron",
    cron: "0 9 * * *",
    runAt: null,
    timezone: "Asia/Shanghai",
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastResult: null,
    runCount: 0,
    createdAt: "2026-10-19T00:00:00Z",
    schedule: "每天 09:00",
    running: false,
    ...over,
  });

  test("needsAttention pulls failed/waiting/running; paused never auto-promoted", () => {
    const items = [
      base({ id: "a1", agentId: "bot1", status: "active", lastStatus: "ok" }),
      base({ id: "a2", agentId: "bot1", status: "active", lastStatus: "failed" }),
      base({ id: "a3", agentId: "bot1", status: "active", lastStatus: "waiting" }),
      base({ id: "p1", agentId: "bot1", status: "paused", lastStatus: "failed", title: "和 Claude 聊电车" }),
      base({ id: "d1", agentId: "gone", status: "done" }),
      base({ id: "o1", agentId: "gone", status: "paused" }),
    ];
    const part = partitionScheduleList(items, ["bot1"]);
    expect(part.needsAttention.map((s) => s.id).sort()).toEqual(["a2", "a3"]);
    expect(part.activeRest.map((s) => s.id)).toEqual(["a1"]);
    expect(part.paused.map((s) => s.id).sort()).toEqual(["o1", "p1"]);
    // paused tram stays in paused — never moved to activeRest / needsAttention as active
    expect(part.activeRest.every((s) => s.status === "active")).toBe(true);
    expect(part.orphanLive.map((s) => s.id)).toEqual(["o1"]);
    expect(part.orphanEnded.map((s) => s.id)).toEqual(["d1"]);
    expect(part.orphanAll.map((s) => s.id).sort()).toEqual(["d1", "o1"]);
  });

  test("empty bot set treats everyone as orphan when bots loaded empty", () => {
    const items = [base({ id: "x", agentId: "bot1", status: "active" })];
    const part = partitionScheduleList(items, []);
    expect(part.orphanLive).toHaveLength(1);
  });
});

describe("scheduleLastLineZh (dogfood paused waiting)", () => {
  const base = (over: Partial<ScheduleView> = {}): ScheduleView => ({
    id: "s1",
    agentId: "bot1",
    threadId: "t1",
    source: "web",
    title: "和 Claude 聊电车",
    instruction: "x",
    kind: "cron",
    cron: "0 9 * * *",
    runAt: null,
    timezone: "Asia/Shanghai",
    status: "paused",
    nextRunAt: null,
    lastRunAt: "2026-10-18T12:00:00Z",
    lastStatus: "waiting",
    lastResult: null,
    runCount: 1,
    createdAt: "2026-10-18T00:00:00Z",
    schedule: "每天 09:00",
    running: false,
    ...over,
  });

  test("paused + waiting is reframed, not actionable hang", () => {
    const line = scheduleLastLineZh(base(), "16小时前");
    expect(line).toContain("暂停前在等确认");
    expect(line).toContain("已暂停，不会自动继续");
    expect(line).not.toContain("打开对话处理");
    expect(scheduleLastTone(base())).toBeNull();
  });

  test("active waiting keeps open-thread prompt", () => {
    const line = scheduleLastLineZh(base({ status: "active" }), "刚");
    expect(line).toContain("在等你确认");
    expect(line).toContain("打开对话处理");
    expect(scheduleLastTone(base({ status: "active" }))).toBe("waiting");
  });
});
