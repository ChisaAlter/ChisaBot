import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { friendlyError } from "@/lib/chat/friendly-error";
import type { ThreadActivity } from "@/lib/conversations/bot-thread";
import { createJoinBackoff } from "@/lib/conversations/join-backoff";
import { resetStoredSyncs } from "@/lib/conversations/thread-messages";
import {
  reconcileDecision,
  snapshotAnchors,
  useConversationSync,
} from "@/lib/conversations/use-conversation-sync";

/*
 * 2026-11-09 线上「无限循环」：1500+ 条的长对话，一轮结束（或模型 403）后浏览器每 ~3 秒 POST 一次
 * /connect，每次拉 ~411 KB；点「重试」后消息没发出去，看门狗连着强制解锁三次。
 *
 * 根因：一轮结束后的顺序核对（reconcile）拿服务器的整份历史去比这台手里的消息——这台手里只有接入
 * 快照封顶的最近 400 条，于是更早的几百条用户消息永远「缺」，每次都合并式重接；重接拿回来的还是那
 * 400 条，接完又核对、又缺、又接……没有退避，页面藏到后台也照样转。
 */

type Row = { id: string; role: string; content: string };
const history = (count: number): Row[] =>
  Array.from({ length: count }, (_, at) => ({
    id: `m${at}`,
    role: at % 2 === 0 ? "user" : "assistant",
    content: `第 ${at} 条`,
  }));
const CAP = 400;

let originalFetch: typeof fetch;
let stored: Row[] = [];
beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      messages: stored,
      version: `v${stored.length}`,
      cursor: `c${stored.length}`,
      start: 0,
    })) as never;
});
afterAll(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

type Subscriber = { onRunFinalized?: () => void; onRunFailed?: () => void };
function setup(rows: Row[], config: { hang?: boolean } = {}) {
  stored = rows;
  resetStoredSyncs();
  const subscribers: Subscriber[] = [];
  const agent = {
    isRunning: false,
    // 一轮结束后这台手里是服务器发来的封顶快照：最近 400 条。
    messages: rows.slice(-CAP) as Row[],
    subscribe(subscriber: Subscriber) {
      subscribers.push(subscriber);
      return { unsubscribe() {} };
    },
    detachActiveRun: async () => {
      detached++;
      release?.();
    },
  };
  let detached = 0;
  let release: (() => void) | undefined;
  const connects: { snapshotAfter?: string[] }[] = [];
  // 假的 connect：和服务器一样只回最近 400 条，跑完触发 onRunFinalized（SDK 的 connect 也会）。
  const connect = async (options: { snapshotAfter?: string[] }) => {
    connects.push(options);
    agent.isRunning = true;
    if (config.hang)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    else await Promise.resolve();
    agent.isRunning = false;
    for (const subscriber of subscribers) subscriber.onRunFinalized?.();
  };
  const onActivity = (_next: (activity: ThreadActivity) => void) => () => {};
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useConversationSync(
        "t-loop",
        agent as never,
        connect as never,
        onActivity,
        {
          liveTail: true,
        },
      ),
    { wrapper },
  );
  const finishOwnRun = () =>
    act(() => {
      for (const subscriber of subscribers) subscriber.onRunFinalized?.();
    });
  return {
    agent,
    connects,
    finishOwnRun,
    control: hook.result.current,
    detached: () => detached,
  };
}
const settle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

test("长对话一轮结束后闲着：不再一遍遍 connect（以前 30 秒 36 次）", async () => {
  const { connects, finishOwnRun } = setup(history(1552));
  await finishOwnRun();
  // 核对的定时器是 800ms；修之前每 ~0.85s 一次 connect，3 秒里至少 3 次。
  await settle(3_000);
  expect(connects).toHaveLength(0);
  cleanup();
});

test("别的设备在这段里说了新话：合并式接一次，只要锚点之后的快照，接完不再循环", async () => {
  const rows = history(1552);
  const { agent, connects, finishOwnRun } = setup(rows);
  // 别的设备刚发的那句：服务器有，这台没有。
  stored = [...rows, { id: "remote", role: "user", content: "另一台说的" }];
  await finishOwnRun();
  await settle(1_200);
  expect(connects).toHaveLength(1);
  expect(connects[0]!.snapshotAfter).toEqual(snapshotAnchors(agent.messages));
  // 假 connect 补不上（模拟快照里仍然没有）：同一个判断不再重接。
  await settle(3_000);
  expect(connects).toHaveLength(1);
  cleanup();
});

test("核对判断只看这台手里那一段", () => {
  const server = history(1552);
  const local = server.slice(-CAP);
  expect(reconcileDecision(local, server)).toBeNull();
  const withRemote = [...server, { id: "x", role: "user", content: "" }];
  expect(reconcileDecision(local, withRemote)?.action).toBe("merge");
  // 两边都有的用户消息先后不一致：重建。
  const swapped = [...server];
  const a = swapped.length - 2;
  const b = swapped.length - 4;
  [swapped[a], swapped[b]] = [swapped[b]!, swapped[a]!];
  expect(reconcileDecision(local, swapped)?.action).toBe("rebuild");
});

test("重接退避：没有进展的连续重接 1s、2s、4s……封顶 30s；有进展清零", () => {
  const backoff = createJoinBackoff();
  let now = 10_000;
  expect(backoff.wait(now)).toBe(0);
  const waits: number[] = [];
  for (let at = 0; at < 8; at++) {
    backoff.started(now);
    const wait = backoff.wait(now);
    waits.push(wait);
    now += wait;
  }
  expect(waits).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
  ]);
  backoff.progressed();
  expect(backoff.wait(now)).toBe(0);
});

test("一分钟内 connect 次数：坏掉的判断条件一直成立时也被退避压住", async () => {
  let now = 50_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const backoff = createJoinBackoff();
    let joins = 0;
    // 每 0.85 秒想重接一次（线上那种频率），持续 60 秒。
    for (let t = 0; t < 60_000; t += 850) {
      now = 50_000_000 + t;
      if (backoff.wait(now) === 0) {
        backoff.started(now);
        joins++;
      }
    }
    // 修之前 ≈ 71 次；退避后 1+1+1+1+1+1（0,1,3,7,15,31,61s）≈ 6 次。
    expect(joins).toBeLessThanOrEqual(7);
  } finally {
    clock.mockRestore();
  }
});

test("点重试时 sync 正在闲置重接：先断开它让路，不再把重试卡死", async () => {
  const rows = history(1552);
  const { agent, connects, finishOwnRun, control, detached } = setup(rows, {
    hang: true,
  });
  stored = [...rows, { id: "remote", role: "user", content: "另一台说的" }];
  await finishOwnRun();
  await settle(1_200);
  // sync 的合并式接入挂着（长对话里线上就是这样：一个接一个，agent.isRunning 一直是 true）。
  expect(connects).toHaveLength(1);
  expect(agent.isRunning).toBe(true);
  expect(control.current.idleJoinInFlight()).toBe(true);
  await act(() => control.current.yieldForSend());
  expect(detached()).toBe(1);
  expect(agent.isRunning).toBe(false);
  expect(control.current.idleJoinInFlight()).toBe(false);
  cleanup();
});

test("模型 403 未订阅：中文说清楚是套餐问题，不再只说「这一轮没有收到回答」", () => {
  const raw =
    "ClinePass: Error 403: the user is not subscribed to required model plan";
  const friendly = friendlyError(raw);
  expect(friendly.title).toBe("这个模型需要 ClinePass 对应套餐");
  expect(friendly.hint).toContain("换一个模型");
  expect(friendly.retryable).toBe(true);
  expect(friendlyError("Error 403: not subscribed to this plan").title).toBe(
    "这个模型需要对应的订阅套餐",
  );
  expect(friendlyError("HTTP 403 Forbidden").title).toBe(
    "模型服务商拒绝了这次请求（403）",
  );
  // 地区限制的 403 仍然按地区说。
  expect(friendlyError("403 unsupported_country_region").title).toBe(
    "模型服务商不支持服务器所在地区",
  );
});
