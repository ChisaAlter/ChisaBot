import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { ComputerControlButton } from "@/components/computer/computer-controls";
import { HandoffResumeNotice } from "@/components/computer/handoff-resume-notice";
import { controlStores } from "@/lib/computers/use-control";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-103 r2：HandoffResumeNotice 以前每秒自己 readControl，绕开了退避。现在聊天提示、按钮都订阅
 * 同一个 store：同时挂几个组件，/control 的请求数和只挂一个一样；连不上时也跟着退避。
 */
const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  controlStores.clear();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function server(status: number) {
  const reads: number[] = [];
  const state = { status };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/control") && (!init?.method || init.method === "GET"))
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
  const s = server(502);
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
  await act(() => Bun.sleep(3600));
  // 一个轮询源 + 退避：0、1、3 秒 → 最多 3 次。以前提示自己 1/s，两个提示就多 8 次。
  expect(s.reads.length).toBeGreaterThanOrEqual(2);
  expect(s.reads.length).toBeLessThanOrEqual(3);
}, 10_000);

for (const event of ["focus", "online"] as const) {
  test(`window ${event} re-reads right away instead of waiting out the backoff`, async () => {
    const s = server(502);
    render(<ComputerControlButton computerId={`bot-${event}`} />);
    await act(() => Bun.sleep(3200)); // 下一次要到 7 秒
    const before = s.reads.length;
    s.state.status = 200;
    await act(async () => {
      window.dispatchEvent(new Event(event));
      await Bun.sleep(50);
    });
    expect(s.reads.length).toBe(before + 1);
    expect(controlStores.get(`bot-${event}`)?.getSnapshot().state).toBe("none");
  }, 10_000);
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
