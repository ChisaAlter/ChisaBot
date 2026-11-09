import { expect, test } from "bun:test";
import {
  CONNECTION_LOST_REASON,
  decideSendWatchdogAction,
  isConnectionDrop,
  isHonestSendFailureReason,
  raceSendWatchdog,
  reportBudgetEvent,
  sendReachedServer,
  SEND_HANG_REASON,
  SEND_REPLY_HANG_REASON,
  SEND_REPLY_WATCHDOG_MS,
  SEND_UNREACHABLE_REASON,
  SEND_WATCHDOG_MS,
  settleDroppedTurn,
  storedTurnAnswered,
} from "../src/lib/conversations/connection-drop";
import { friendlyStopReason } from "../src/lib/conversations/stopped-turn";

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
  return { now: () => t, sleep: async (ms: number) => {
    t += ms;
  } };
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
  const afterMs = async (ms: number) => {
    t += ms;
  };
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

/*
 * 2026-10-20 真机：「运行命令」每次都在十几秒后失败，报 `signal is aborted without reason`。
 * 原因是看门狗按**总时长**算：浏览器里的 `computer_run_command` 跑着（最长 600 秒）期间聊天这头
 * 没有任何事件，12 秒一到就 stopAgent()，用不带 reason 的 abort 掐掉命令。下面钉住新语义：
 * 有进展不算挂起，静默满时限才算。
 */
test("raceSendWatchdog: progress keeps a long turn alive (a command runs inside it)", async () => {
  const afterMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let progress = Date.now();
  const beating = setInterval(() => {
    progress = Date.now();
  }, 10);
  const run = new Promise<void>((resolve) => setTimeout(resolve, 150));
  const outcome = await raceSendWatchdog(run, {
    afterMs,
    timeoutMs: 40,
    lastProgressAt: () => progress,
  });
  clearInterval(beating);
  // 40ms 的时限里一直在动，所以只有 run 先结束这一种结果。
  expect(outcome).toBe("done");
});

test("raceSendWatchdog: silence for the whole window still reports a hang", async () => {
  const afterMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let progress = Date.now();
  // 20ms 时还有一次进展；之后彻底安静，40ms 的静默从那一刻重新算。
  setTimeout(() => {
    progress = Date.now();
  }, 20);
  const run = new Promise<void>(() => {});
  const started = Date.now();
  const outcome = await raceSendWatchdog(run, {
    afterMs,
    timeoutMs: 40,
    lastProgressAt: () => progress,
  });
  expect(outcome).toBe("timeout");
  // 那次进展之后又静默满 40ms 才报，不是从头一刀切。
  expect(Date.now() - started).toBeGreaterThanOrEqual(55);
});

test("a stopped-by-the-client command is explained, not echoed as an English abort", () => {
  const reason = friendlyStopReason("signal is aborted without reason");
  expect(reason).toContain("这一轮被中断");
  expect(reason).not.toContain("aborted");
});

test("reply hang sentence says the message was sent, not that it failed to leave", () => {
  expect(SEND_REPLY_HANG_REASON).toContain("已经发出去");
  expect(SEND_REPLY_HANG_REASON).not.toContain("没发出去");
  expect(SEND_REPLY_WATCHDOG_MS).toBeGreaterThan(SEND_WATCHDOG_MS);
  expect(SEND_REPLY_WATCHDOG_MS).toBeLessThanOrEqual(300_000);
});

test("raceSendWatchdog: second (reply) bound still times out a hung run", async () => {
  let t = 0;
  const afterMs = async (ms: number) => {
    t += ms;
  };
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

test("decideSendWatchdogAction: timeout + persist check failed (null) → unverified, not hang", () => {
  /*
   * 证人缺席是「核实不了」不是「没到」：请求可能只是还在路上（订阅前静默 / 重启窗口），
   * 落地后服务端照常开跑、回答经同步落回屏幕——断言「没发出去」就成了挂着不撤的谎话。
   * 「可能没发出去」如实说不知道，由迟到对账在答案真出现时撤卡。
   */
  const d = decideSendWatchdogAction({
    firstRace: "timeout",
    persisted: null,
  });
  expect(d.kind).toBe("unverified");
  if (d.kind === "unverified") {
    expect(d.reason).toBe(SEND_UNREACHABLE_REASON);
    expect(d.budget).toBe("SEND_UNREACHABLE");
    expect(isHonestSendFailureReason(d.reason)).toBe(true);
  }
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

/*
 * 「明明 AI 都输出了」误报修复（发送看门狗双证人）：正在回答时发来的消息走 join/排队路径，
 * 只进服务端收件箱、不进 messages 表——单看落库会把「已排队」误判成「没发出去」。
 * 收件箱里读到这条 id 同样算「到了」；两个证人都缺席才算「不知道」（null，按没确认处理）。
 */
test("sendReachedServer: any witness confirming the message counts as reached", () => {
  expect(sendReachedServer({ stored: true, queued: null })).toBe(true);
  expect(sendReachedServer({ stored: false, queued: true })).toBe(true);
  expect(sendReachedServer({ stored: null, queued: true })).toBe(true);
});

test("sendReachedServer: both witnesses read, neither has it → genuinely not sent", () => {
  expect(sendReachedServer({ stored: false, queued: false })).toBe(false);
});

test("sendReachedServer: a missing witness downgrades a negative to unknown", () => {
  expect(sendReachedServer({ stored: false, queued: null })).toBeNull();
  expect(sendReachedServer({ stored: null, queued: false })).toBeNull();
  expect(sendReachedServer({ stored: null, queued: null })).toBeNull();
});

test("decideSendWatchdogAction: inbox-witnessed send takes the reply path, not hang", () => {
  const reached = sendReachedServer({ stored: false, queued: true });
  expect(
    decideSendWatchdogAction({
      firstRace: "timeout",
      persisted: reached,
      replyRace: "timeout",
    }).kind,
  ).toBe("reply_hang");
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
