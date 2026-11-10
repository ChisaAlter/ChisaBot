import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { ComputerControlButton } from "@/components/computer/computer-controls";
import { HandoffResumeNotice } from "@/components/computer/handoff-resume-notice";
import {
  type ControlClock,
  controlStores,
  setControlClock,
} from "@/lib/computers/use-control";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-103 r2：HandoffResumeNotice 以前每秒自己 readControl，绕开了退避。现在聊天提示、按钮都订阅
 * 同一个 store：同时挂几个组件，/control 的请求数和只挂一个一样；连不上时也跟着退避。
 *
 * 焦点 / 联网立刻再读的用例用假时钟：真时间下 1 秒轮询和退避定时器在 CPU 忙时会错开，
 * wake 清掉 failures 之后晚到的那一拍会再读一次（Expected 4 Received 5）。
 */
const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setControlClock(null);
  for (const store of [...controlStores.values()]) store.dispose();
  controlStores.clear();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<
    number,
    { at: number; fn: () => void; every?: number }
  >();
  const clock: ControlClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    setInterval: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn, every: ms });
      return seq;
    },
    clearInterval: (h) => void timers.delete(h as number),
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now += 100;
      for (const [id, t] of [...timers]) {
        if (t.at > now || !timers.has(id)) continue;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      await flush();
    }
  };
  return { clock, advance, flush };
}

function server(status: number, computerId?: string) {
  const reads: number[] = [];
  const state = { status };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const forThis =
      !computerId ||
      url.includes(`/computers/${encodeURIComponent(computerId)}/`);
    if (
      forThis &&
      url.includes("/control") &&
      (!init?.method || init.method === "GET")
    )
      reads.push(Date.now());
    if (state.status !== 200)
      return new Response("<html>bad gateway</html>", { status: state.status });
    return new Response(
      JSON.stringify({
        holder: "bot",
        state: "none",
        since: "2026-10-27T00:00:00.000Z",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { reads, state };
}

const agent = { messages: [], isRunning: false, setMessages: () => undefined };

test("two chat notices and a control button make one poll, and it backs off while unreachable", async () => {
  const c = fakeClock();
  setControlClock(c.clock);
  const s = server(502, "bot-1");
  render(
    <>
      <HandoffResumeNotice
        agent={agent}
        botId="bot-1"
        ready
        run={async () => undefined}
      />
      <HandoffResumeNotice
        agent={agent}
        botId="bot-1"
        ready
        run={async () => undefined}
      />
      <ComputerControlButton computerId="bot-1" />
    </>,
  );
  await act(() => c.flush());
  // 一个轮询源 + 退避：0、1、3 秒 → 3 次。以前提示自己 1/s，两个提示就多 8 次。
  await act(() => c.advance(3600));
  expect(s.reads.length).toBe(3);
});

for (const event of ["focus", "online"] as const) {
  test(`window ${event} re-reads right away instead of waiting out the backoff`, async () => {
    const c = fakeClock();
    setControlClock(c.clock);
    const id = `bot-${event}`;
    const s = server(502, id);
    render(<ComputerControlButton computerId={id} />);
    await act(() => c.flush());
    await act(() => c.advance(3000));
    expect(s.reads.length).toBe(3);
    const before = s.reads.length;
    s.state.status = 200;
    await act(async () => {
      window.dispatchEvent(new Event(event));
      await c.flush();
    });
    expect(s.reads.length).toBe(before + 1);
    expect(controlStores.get(id)?.getSnapshot().state).toBe("none");
  });
}

test("taken over (incl. ?watch=true): no 「画面正在大屏直播」 line", async () => {
  const { showCastingNotice } = await import(
    "@/components/computer/computer-panel"
  );
  expect(showCastingNotice(true, "user_control")).toBe(false);
  expect(showCastingNotice(true, "live")).toBe(true);
  expect(showCastingNotice(true, "none")).toBe(true);
  expect(showCastingNotice(false, "live")).toBe(false);
});
