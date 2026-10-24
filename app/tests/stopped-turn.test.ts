import { describe, expect, test } from "bun:test";
import { stoppedReason, stoppedTurnSubscriber } from "../src/lib/copilot/stopped-turn";

/**
 * What a person is told when a turn ends and no answer came.
 *
 * The cases are the three things that actually arrive: the sentence the deployment's stall watchdog
 * wrote into the run, an error thrown in the browser, and nothing at all.
 */

describe("model errors in plain Chinese (2026-10-15)", () => {
  test("daily quota with retry hint", () => {
    const r = stoppedReason(new Error("Failed after 3 attempts. Last error: ClinePass: Error 429: Daily free limit reached on model xiaomi/mimo-v2.6-flash. Try again in 19h 51m"));
    expect(r).toBe("这个模型的额度用完了，约 19 小时 51 分钟后恢复。点输入框右下角的模型名，换一个模型再发。");
  });
  test("opencode-only free tier", () => {
    expect(stoppedReason("OpenCode Zen: OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.")).toContain("只能在 OpenCode");
  });
  test("rate limit, auth, context, timeout, network", () => {
    expect(stoppedReason("Error 429: Too Many Requests")).toContain("限流");
    expect(stoppedReason("401 Unauthorized")).toContain("密钥");
    expect(stoppedReason("prompt is too long: 300000 tokens > 200000 maximum")).toContain("太长");
    expect(stoppedReason("Request timed out")).toContain("太久");
    expect(stoppedReason("fetch failed")).toContain("连不上");
  });
  test("Chinese reasons pass through unchanged", () => {
    expect(stoppedReason("机器人超过 2 分钟没有回应，这一轮已结束。")).toBe("机器人超过 2 分钟没有回应，这一轮已结束。");
  });
  test("cancelled run reason is translated as an interruption rather than a raw English error", () => {
    expect(stoppedReason("This run was stopped.")).toContain("这一轮被中断了");
    expect(stoppedReason("This run was stopped.")).not.toContain("This run was stopped.");
  });
});

describe("the reason a turn ended", () => {
  test("passes on what ended the turn, in its own words", () => {
    expect(
      stoppedReason(
        "Risk Analyst stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      ),
    ).toBe("「Risk Analyst」2 分钟没有任何回应，这一轮已结束。再发一次试试；一直这样就换一个模型。");
  });

  test("reads an Error the same way, because a failed run carries one", () => {
    expect(
      stoppedReason(new Error("The endpoint refused the connection")),
    ).toBe("这一轮出错了：The endpoint refused the connection");
  });

  test("says so plainly when nothing was reported, rather than inventing a cause", () => {
    // This is the one moment a person has no other way to find out what went wrong, so a guess here
    // would be worse than an admission.
    expect(stoppedReason(undefined)).toBe(
      "机器人没有给出原因就停止了。",
    );
    expect(stoppedReason("")).toBe("机器人没有给出原因就停止了。");
    expect(stoppedReason("   ")).toBe("机器人没有给出原因就停止了。");
    expect(stoppedReason(new Error(""))).toBe(
      "机器人没有给出原因就停止了。",
    );
    expect(stoppedReason({ message: "not a string or an Error" })).toBe(
      "机器人没有给出原因就停止了。",
    );
  });
});

/**
 * 打开会话时历史事件会重放给订阅者（DESIGN.md §35.4）。一轮出错之后又正常回答过的会话，打开时顶上
 * 不能还挂着那条旧错误——它出现 / 消失会让聊天跳一截，而且说的也不是「上一轮」了。
 */
describe("the stopped notice across a replayed history", () => {
  const replay = (events: Array<"start" | "error" | "finish">) => {
    let shown: string | null = null;
    const sub = stoppedTurnSubscriber((reason) => {
      shown = reason;
    });
    for (const e of events) {
      if (e === "start") sub.onRunStartedEvent();
      if (e === "error") sub.onRunErrorEvent({ event: { message: "上游出错了" } });
    }
    return shown as string | null;
  };

  test("an error followed by a later turn is not shown", () => {
    expect(replay(["start", "error", "start", "finish", "start", "finish"])).toBeNull();
  });

  test("an error in the last turn is still shown", () => {
    expect(replay(["start", "finish", "start", "error"])).toBe("上游出错了");
  });

  test("the next turn starting clears it", () => {
    expect(replay(["start", "error", "start"])).toBeNull();
  });
});
