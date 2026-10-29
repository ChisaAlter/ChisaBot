import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memo } from "react";
import { ChannelPage } from "@/components/channels/channel-page";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import { useThreadActivity } from "@/lib/copilot/thread-activity";
import { settleReactWork } from "./settle-react-work";

/**
 * 关设置回聊天时聊天整页重画（2026-10-29，设置面板卡顿 PR3）：外壳跟着 pathname 重画，把 `ChannelPage`
 * 和下面的聊天列表、输入框带着重画一遍（props 一个没变）；`visible` 变回 true 时又因为 `useThreadActivity`
 * 读 `KeptVisibleContext` 让整个 `ChannelChat` 再画一遍。这里钉住：留着的聊天藏 / 露不让只订阅可见性的组件重画，
 * 回来时照样马上问一次变化戳。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(async () => {
  cleanup();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Addr = { id: string };
const same = (a: Addr, b: Addr) => a.id === b.id;

test("留着的聊天藏起来再回来：订阅可见性的聊天不重画，回来马上问一次变化戳", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  let renders = 0;
  const Chat = memo(function Chat({ id }: { id: string }) {
    renders++;
    useThreadActivity("bot_a", id);
    return <div data-testid="chat">{id}</div>;
  });
  const stage = (address: Addr | null) => (
    <KeepAliveStage
      address={address}
      renderKept={(kept) => <Chat id={kept.id} />}
      same={same}
    >
      {address ? null : <section>{"设置"}</section>}
    </KeepAliveStage>
  );
  try {
    const view = render(stage({ id: "thread_a" }));
    expect(renders).toBe(1);
    // 去设置：聊天藏起来。
    view.rerender(stage(null));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const atHide = calls.length;
    // 关设置：回到聊天。
    view.rerender(stage({ id: "thread_a" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(renders).toBe(1);
    expect(calls.length).toBeGreaterThan(atHide);
    expect(calls.at(-1)).toContain("/sync");
    view.unmount();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("聊天整页和聊天本身都 memo：外壳跟着地址重画时不带着它们重画", () => {
  expect((ChannelPage as unknown as { $$typeof: symbol }).$$typeof).toBe(
    Symbol.for("react.memo"),
  );
  const page = readFileSync(
    join(import.meta.dir, "../src/components/channels/channel-page.tsx"),
    "utf8",
  );
  expect(page).toContain("const ChannelBody = memo(function ChannelBody(");
  const activity = readFileSync(
    join(import.meta.dir, "../src/lib/copilot/thread-activity.ts"),
    "utf8",
  );
  expect(activity).toContain("useKeptVisibility()");
  expect(activity).not.toContain("useKeptVisible()");
});
