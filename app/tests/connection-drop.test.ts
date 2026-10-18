import { expect, test } from "bun:test";
import {
  CONNECTION_LOST_REASON,
  decideSendWatchdogAction,
  isConnectionDrop,
  isHonestSendFailureReason,
  raceSendWatchdog,
  reportBudgetEvent,
  SEND_HANG_REASON,
  SEND_REPLY_HANG_REASON,
  SEND_REPLY_WATCHDOG_MS,
  SEND_UNREACHABLE_REASON,
  SEND_WATCHDOG_MS,
  settleDroppedTurn,
  storedTurnAnswered,
} from "../src/lib/copilot/connection-drop";
import { friendlyStopReason } from "../src/lib/copilot/stopped-turn";

test("browser-side stream failures are connection drops, not model errors", () => {
  expect(isConnectionDrop(new TypeError("network error"))).toBe(true);
  expect(isConnectionDrop(new TypeError("Failed to fetch"))).toBe(true);
  expect(isConnectionDrop(new TypeError("Load failed"))).toBe(true);
  expect(isConnectionDrop(new Error("HTTP 502: <html>"))).toBe(true);
  expect(isConnectionDrop(new Error("HTTP 524: timeout"))).toBe(true);
  expect(isConnectionDrop(new Error("net::ERR_HTTP2_PROTOCOL_ERROR"))).toBe(
    true,
  );
  expect(isConnectionDrop(new Error("net::ERR_TUNNEL_CONNECTION_FAILED"))).toBe(
    true,
  );
  expect(isConnectionDrop(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toBe(
    true,
  );
  expect(isConnectionDrop(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(true);
});

test("a user stop, an HTTP refusal or a model error is not a connection drop", () => {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  expect(isConnectionDrop(abort)).toBe(false);
  expect(isConnectionDrop(new Error("HTTP 409: Thread already running"))).toBe(
    false,
  );
  expect(isConnectionDrop(new Error("HTTP 401: Unauthorized"))).toBe(false);
  expect(
    isConnectionDrop(
      new Error("ClinePass: Error 429: Daily free limit reached"),
    ),
  ).toBe(false);
  expect(isConnectionDrop(undefined)).toBe(false);
});

test("the lost-connection sentence does not blame the model", () => {
  expect(CONNECTION_LOST_REASON).not.toContain("模型");
  expect(SEND_UNREACHABLE_REASON).not.toContain("模型");
  expect(SEND_UNREACHABLE_REASON).toContain("没发出去");
  // 服务器写来的 RUN_ERROR（上游真的连不上）仍然说模型。
  expect(friendlyStopReason("fetch failed")).toContain("模型");
});

const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

test("server still running → continuing, without reading the stored turn", async () => {
  let reads = 0;
  const clock = fakeClock();
  const outcome = await settleDroppedTurn({
    running: async () => true,
    answered: async () => {
      reads++;
      return false;
    },
    ...clock,
  });
  expect(outcome).toBe("continuing");
  expect(reads).toBe(0);
});

test("server unreachable for a while (restart) then idle with an answer → finished", async () => {
  const clock = fakeClock();
  const replies: Array<boolean | null> = [null, null, null, false];
  const outcome = await settleDroppedTurn({
    running: async () =>
      replies.length ? (replies.shift() as boolean | null) : false,
    answered: async () => true,
    ...clock,
  });
  expect(outcome).toBe("finished");
  expect(clock.now()).toBe(6_000);
});

test("server idle and the turn has no answer → lost", async () => {
  const outcome = await settleDroppedTurn({
    running: async () => false,
    answered: async () => false,
    ...fakeClock(),
  });
  expect(outcome).toBe("lost");
});

test("never reachable → unreachable on the short budget, not the restart budget", async () => {
  const clock = fakeClock();
  const outcome = await settleDroppedTurn({
    running: async () => {
      throw new Error("offline");
    },
    answered: async () => true,
    deadlineMs: 75_000,
    unreachableMs: 10_000,
    ...clock,
  });
  expect(outcome).toBe("unreachable");
  expect(clock.now()).toBeLessThanOrEqual(10_000);
  expect(clock.now()).toBeGreaterThan(0);
});

test("once the server has been seen, keep the long restart budget", async () => {
  const clock = fakeClock();
  // false + answered null = saw server, then stay unreachable until restart deadline.
  let n = 0;
  const outcome = await settleDroppedTurn({
    running: async () => {
      n += 1;
      return n === 1 ? false : null;
    },
    answered: async () => null,
    deadlineMs: 12_000,
    unreachableMs: 4_000,
    ...clock,
  });
  expect(outcome).toBe("lost");
  expect(clock.now()).toBeGreaterThan(4_000);
  expect(clock.now()).toBeLessThanOrEqual(12_000);
});

test("stored turn counts as answered only when it ends with a plain reply", () => {
  const base = [
    { id: "u0", role: "user", content: "早" },
    { id: "a0", role: "assistant", content: "早上好" },
    { id: "u1", role: "user", content: "装 Node.js" },
  ];
  expect(storedTurnAnswered(base, "u1")).toBe(false);
  const midTool = [
    ...base,
    {
      id: "a1",
      role: "assistant",
      content: "我先装。",
      toolCalls: [{ id: "c" }],
    },
    { id: "t1", role: "tool", content: "{}" },
  ];
  expect(storedTurnAnswered(midTool, "u1")).toBe(false);
  expect(
    storedTurnAnswered(
      [...midTool, { id: "a2", role: "assistant", content: "装好了。" }],
      "u1",
    ),
  ).toBe(true);
  expect(
    storedTurnAnswered(
      [
        ...midTool,
        {
          id: "a2",
          role: "assistant",
          content: [{ type: "text", text: "装好了" }],
        },
      ],
      "u1",
    ),
  ).toBe(true);
  expect(storedTurnAnswered(base, "missing")).toBe(false);
});

test("send hang sentence tells the person to resend, not that the model failed", () => {
  expect(SEND_HANG_REASON).toContain("没发出去");
  expect(SEND_HANG_REASON).not.toContain("模型");
  expect(SEND_WATCHDOG_MS).toBeGreaterThan(5_000);
  expect(SEND_WATCHDOG_MS).toBeLessThan(30_000);
});

test("raceSendWatchdog: run finishes first → done", async () => {
  const afterMs = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
  };
  const run = Promise.resolve("ok");
  const outcome = await raceSendWatchdog(run, { afterMs, timeoutMs: 50 });
  expect(outcome).toBe("done");
});

test("raceSendWatchdog: timeout wins when run never settles", async () => {
  let t = 0;
  const afterMs = async (ms: number) => void (t += ms);
  const run = new Promise<void>(() => {});
  const outcome = await raceSendWatchdog(run, { afterMs, timeoutMs: 12_000 });
  expect(outcome).toBe("timeout");
  expect(t).toBe(12_000);
});

test("raceSendWatchdog: a rejected run still counts as done (error path owns the message)", async () => {
  const afterMs = async () => {
    await new Promise((r) => setTimeout(r, 50));
  };
  const run = Promise.reject(new Error("boom"));
  // Prevent unhandled rejection noise.
  void run.catch(() => undefined);
  const outcome = await raceSendWatchdog(run, { afterMs, timeoutMs: 12_000 });
  expect(outcome).toBe("done");
});

test("reply hang sentence says the message was sent, not that it failed to leave", () => {
  expect(SEND_REPLY_HANG_REASON).toContain("已经发出去");
  expect(SEND_REPLY_HANG_REASON).not.toContain("没发出去");
  expect(SEND_REPLY_WATCHDOG_MS).toBeGreaterThan(SEND_WATCHDOG_MS);
  expect(SEND_REPLY_WATCHDOG_MS).toBeLessThanOrEqual(300_000);
});

test("raceSendWatchdog: second (reply) bound still times out a hung run", async () => {
  let t = 0;
  const afterMs = async (ms: number) => void (t += ms);
  const run = new Promise<void>(() => {});
  const outcome = await raceSendWatchdog(run, {
    afterMs,
    timeoutMs: SEND_REPLY_WATCHDOG_MS,
  });
  expect(outcome).toBe("timeout");
  expect(t).toBe(SEND_REPLY_WATCHDOG_MS);
});

test("reportBudgetEvent POSTs whitelist code and swallows network errors", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  reportBudgetEvent("SEND_UNREACHABLE", ((url, init) => {
    calls.push({ url: String(url), init });
    return Promise.reject(new Error("offline"));
  }) as typeof fetch);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("/api/ops/budget");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    code: "SEND_UNREACHABLE",
  });
});

test("decideSendWatchdogAction: run done → proceed (never fake hang)", () => {
  expect(
    decideSendWatchdogAction({ firstRace: "done", persisted: false }),
  ).toEqual({ kind: "proceed" });
});

test("decideSendWatchdogAction: timeout + not persisted → hang (catches fake success)", () => {
  const d = decideSendWatchdogAction({
    firstRace: "timeout",
    persisted: false,
  });
  expect(d.kind).toBe("hang");
  if (d.kind === "hang") {
    expect(d.reason).toBe(SEND_HANG_REASON);
    expect(d.budget).toBe("SEND_HANG");
    expect(isHonestSendFailureReason(d.reason)).toBe(true);
  }
});

test("decideSendWatchdogAction: timeout + persist check failed (null) → hang", () => {
  expect(
    decideSendWatchdogAction({ firstRace: "timeout", persisted: null }).kind,
  ).toBe("hang");
});

test("decideSendWatchdogAction: timeout + persisted + reply timeout → reply_hang", () => {
  const d = decideSendWatchdogAction({
    firstRace: "timeout",
    persisted: true,
    replyRace: "timeout",
  });
  expect(d.kind).toBe("reply_hang");
  if (d.kind === "reply_hang") {
    expect(d.reason).toBe(SEND_REPLY_HANG_REASON);
    expect(isHonestSendFailureReason(d.reason)).toBe(true);
  }
});

test("decideSendWatchdogAction: timeout + persisted + reply done → proceed", () => {
  expect(
    decideSendWatchdogAction({
      firstRace: "timeout",
      persisted: true,
      replyRace: "done",
    }),
  ).toEqual({ kind: "proceed" });
});

test("honest failure reasons never look like send success", () => {
  for (const reason of [
    SEND_HANG_REASON,
    SEND_REPLY_HANG_REASON,
    SEND_UNREACHABLE_REASON,
    CONNECTION_LOST_REASON,
  ]) {
    expect(isHonestSendFailureReason(reason)).toBe(true);
  }
  expect(isHonestSendFailureReason("发送成功")).toBe(false);
});
