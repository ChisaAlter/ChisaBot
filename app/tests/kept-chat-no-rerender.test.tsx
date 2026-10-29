import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { memo } from "react";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import { useThreadActivity } from "@/lib/copilot/thread-activity";
import { useKeptVisibility } from "@/lib/kept-visible";
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

// #403 审查 c：新挂上的聊天第一次渲染读到的「看不看得见」要是这一次的，不能是上一页留下的「藏着」，
// 否则提交后它变成「看得见」，`useThreadActivity` 当成「刚回来」马上多问一次变化戳（刚打开的聊天本来就在读对话）。
for (const how of [
  "藏够时间卸载后再打开别的聊天",
  "藏着时直接换到另一段聊天",
] as const) {
  test(`${how}：新聊天第一次就读到「看得见」，不多问一次变化戳`, async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const firstRead: Record<string, boolean> = {};
    function Chat({ id }: { id: string }) {
      const visibility = useKeptVisibility();
      if (!(id in firstRead)) firstRead[id] = visibility.get();
      useThreadActivity("bot_a", id);
      return <div data-testid="chat">{id}</div>;
    }
    const stage = (address: Addr | null) => (
      <KeepAliveStage
        address={address}
        renderKept={(kept) => <Chat id={kept.id} key={kept.id} />}
        same={same}
        ttlMs={how === "藏够时间卸载后再打开别的聊天" ? 20 : 60_000}
      >
        {address ? null : <section>{"设置"}</section>}
      </KeepAliveStage>
    );
    try {
      const view = render(stage({ id: "thread_a" }));
      expect(firstRead.thread_a).toBe(true);
      // 去设置：聊天藏起来（卸载的那种要等过了 ttl）。
      view.rerender(stage(null));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
      if (how === "藏够时间卸载后再打开别的聊天")
        expect(view.queryByTestId("chat")).toBeNull();
      const before = calls.length;
      // 打开另一段聊天。
      view.rerender(stage({ id: "thread_b" }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      expect(view.getByTestId("chat").textContent).toBe("thread_b");
      expect(firstRead.thread_b).toBe(true);
      // 刚挂上的聊天按 2 秒的节奏等下一次，不会马上问。
      expect(
        calls.slice(before).filter((url) => url.includes("/sync")),
      ).toEqual([]);
      view.unmount();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("thread-activity 只订阅可见性，不读会让整段聊天重画的 KeptVisibleContext", () => {
  // 真渲染的重画计数在 kept-chat-real-render.test.tsx；这里只防有人把订阅换回 context。
  const activity = readFileSync(
    join(import.meta.dir, "../src/lib/copilot/thread-activity.ts"),
    "utf8",
  );
  expect(activity).toContain("useKeptVisibility()");
  expect(activity).not.toContain("useKeptVisible()");
});
