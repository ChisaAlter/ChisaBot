import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  CONTROL_UNREACHABLE_ZH,
  readControlStatus,
} from "@/lib/computers/control";
import { SCREEN_USER_CONTROL_ZH } from "@/lib/computers/screen";
import { screenshotPollBlocked } from "@/lib/computers/screenshot-poll";
import {
  controlRetryDelay,
  createControlStore,
} from "@/lib/computers/use-control";

/**
 * CB-103：GET /control 的三态（无 / 直播 / 用户接管）加「连不上」。连不上（包括部署重启时 nginx 自己回的
 * 502 / 503 / 504）显示「暂时连不上电脑」、退避重试，不打 console.error；接管中不取图。
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body?: unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body === undefined ? "<html>502</html>" : JSON.stringify(body), {
      status,
      headers: { "content-type": body === undefined ? "text/html" : "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const base = {
  since: "2026-10-27T00:00:00.000Z",
  requested: false,
  transitioning: false,
  resumeSnapshotRequired: false,
};

describe("readControlStatus (CB-103)", () => {
  test("none / live / user_control come through with the control state", async () => {
    answer(200, { ...base, holder: "bot", state: "none" });
    expect((await readControlStatus("bot-1")).kind).toBe("none");
    answer(200, { ...base, holder: "bot", state: "live" });
    expect((await readControlStatus("bot-1")).kind).toBe("live");
    answer(200, { ...base, holder: "human", state: "user_control" });
    const taken = await readControlStatus("bot-1");
    expect(taken.kind).toBe("user_control");
  });

  test("an older server without state still reads the holder", async () => {
    answer(200, { ...base, holder: "human" });
    expect((await readControlStatus("bot-1")).kind).toBe("user_control");
  });

  test("state=unreachable keeps its reason", async () => {
    answer(200, { state: "unreachable", reason: "timeout" });
    expect(await readControlStatus("bot-1")).toEqual({
      kind: "unreachable",
      reason: "timeout",
    });
  });

  for (const status of [502, 503, 504]) {
    test(`nginx ${status} is unreachable, not an error`, async () => {
      answer(status);
      expect(await readControlStatus("bot-1")).toEqual({
        kind: "unreachable",
        reason: `gateway_${status}`,
      });
    });
  }

  test("a dropped connection is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect((await readControlStatus("bot-1")).kind).toBe("unreachable");
  });
});

describe("control store backs off and stays quiet (CB-103)", () => {
  test("retry delay doubles up to 15s", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(controlRetryDelay)).toEqual([
      0, 1000, 2000, 4000, 8000, 15000, 15000,
    ]);
  });

  test("a 502 shows 「暂时连不上电脑」, backs off, and never calls console.error", async () => {
    const calls = answer(502);
    const errors = spyOn(console, "error");
    const store = createControlStore("bot-backoff");
    const unsubscribe = store.subscribe(() => undefined, true);
    await Bun.sleep(3600);
    const snapshot = store.getSnapshot();
    unsubscribe();
    expect(snapshot.state).toBe("unreachable");
    expect(snapshot.problem).toBe(CONTROL_UNREACHABLE_ZH);
    expect(snapshot.problem).toBe("暂时连不上电脑");
    // 不退避的话 3.6 秒里是 4 次（0、1、2、3 秒）；退避后是 0、≥1、≥3 秒，最多 3 次。
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  }, 10_000);

  test("recovering clears the problem and reports the state", async () => {
    answer(502);
    const store = createControlStore("bot-recover");
    await store.refresh();
    expect(store.getSnapshot().state).toBe("unreachable");
    answer(200, { ...base, holder: "human", state: "user_control" });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({
      state: "user_control",
      problem: null,
    });
  });
});

describe("the card asks who holds the computer before it fetches a picture (CB-103)", () => {
  test("no picture until the control state is known", () => {
    expect(
      screenshotPollBlocked({
        expanded: false,
        driving: false,
        controlState: null,
        controlEnabled: true,
      }),
    ).toBe("pending");
  });
  test("user_control → no picture", () => {
    expect(
      screenshotPollBlocked({
        expanded: false,
        driving: false,
        controlState: "user_control",
        controlEnabled: true,
      }),
    ).toBe("user_control");
  });
  test("unreachable → no picture", () => {
    expect(
      screenshotPollBlocked({
        expanded: false,
        driving: false,
        controlState: "unreachable",
        controlEnabled: true,
      }),
    ).toBe("unreachable");
  });
  test("none and live → fetch", () => {
    for (const controlState of ["none", "live"] as const)
      expect(
        screenshotPollBlocked({
          expanded: false,
          driving: false,
          controlState,
          controlEnabled: true,
        }),
      ).toBeNull();
  });
  test("a settled card without control polling still fetches", () => {
    expect(
      screenshotPollBlocked({ expanded: false, driving: false, controlState: null }),
    ).toBeNull();
  });
  test("takeover copy", () => {
    expect(SCREEN_USER_CONTROL_ZH).toBe(
      "电脑由你控制中，暂停预览；活动记录照常更新",
    );
  });
});
