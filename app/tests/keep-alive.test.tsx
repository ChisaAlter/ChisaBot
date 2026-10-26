import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ReactNode, useEffect, useState } from "react";
import { KeepAliveStage, type KeptState } from "@/components/layout/keep-alive";
import { KeptVisibleContext, useBotOnScreen, useKeptVisible, useMarkBotHidden } from "@/lib/kept-visible";
import { useComputerControl } from "@/lib/computers/use-control";
import { settleReactWork } from "./settle-react-work";

/**
 * 切回机器人页总要「刷新一次」（2026-10-17，DESIGN.md §98）：聊天、设置、管理以前各有一个外壳，离开聊天 = 聊天卸载，
 * 回来 = 重新接入、回放、读历史（发送键闪成「停止」、气泡重排、右栏重载）。现在聊天由外壳留着：
 * 离开时只是藏起来，回来还是同一个实例。
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

function counterPage() {
  const log = { mounts: 0, unmounts: 0, states: [] as Array<{ id: string } & KeptState>, renders: 0 };
  function Page({ id, state }: { id: string; state: KeptState }) {
    const [instance] = useState(() => Math.random());
    log.renders++;
    log.states.push({ id, ...state });
    useEffect(() => {
      log.mounts++;
      return () => {
        log.unmounts++;
      };
    }, []);
    return <div data-instance={instance} data-testid="page">{id}</div>;
  }
  return { log, Page };
}

function stage(Page: (p: { id: string; state: KeptState }) => ReactNode, address: Addr | null, other?: string, idleVisible: boolean | ((kept: Addr) => boolean) = false, ttlMs?: number) {
  return (
    <KeepAliveStage
      address={address}
      idleVisible={idleVisible}
      renderKept={(kept, state) => <Page id={kept.id} state={state} />}
      same={same}
      {...(ttlMs ? { ttlMs } : {})}
    >
      {other ? <section data-testid="other">{other}</section> : null}
    </KeepAliveStage>
  );
}

test("离开聊天再回来：同一个实例，不卸载、不重新挂载", async () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  const instance = view.getByTestId("page").getAttribute("data-instance");
  expect(log.mounts).toBe(1);

  // 去设置：聊天藏起来（不可见、不可点、读屏跳过），设置盖在上面。
  view.rerender(stage(Page, null, "设置"));
  const kept = view.getByTestId("kept-page");
  expect(kept.getAttribute("data-visible")).toBe("false");
  expect(kept.hasAttribute("inert")).toBe(true);
  expect(kept.getAttribute("aria-hidden")).toBe("true");
  expect(kept.style.visibility).toBe("hidden");
  expect(view.getByTestId("route-layer").className).toContain("absolute");
  expect(view.getByTestId("other").textContent).toBe("设置");
  expect(log.states.at(-1)).toMatchObject({ id: "c1", visible: false });

  // 回来：还是那一个。
  view.rerender(stage(Page, { id: "c1" }));
  expect(log.mounts).toBe(1);
  expect(log.unmounts).toBe(0);
  expect(view.getByTestId("page").getAttribute("data-instance")).toBe(instance);
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe("true");
  expect(view.getByTestId("kept-page").hasAttribute("inert")).toBe(false);
  expect(view.getByTestId("route-layer").className).toContain("contents");
  // 回来一次，epoch 加一（聊天据此不把离开期间的地址变化当成用户操作）。
  expect(log.states.at(-1)).toMatchObject({ id: "c1", visible: true, epoch: 1 });
});

test("换一段对话：留着的换成新的那段（同一个位置，交给页面自己决定要不要重挂）", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, { id: "c2" }));
  expect(view.getByTestId("page").textContent).toBe("c2");
  expect(log.states.at(-1)).toMatchObject({ id: "c2", visible: true });
});

test("`/` 正在跳到聊天时，留着的聊天先露着（不空一下）", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, null, "设置"));
  view.rerender(stage(Page, null, undefined, true));
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe("true");
  expect(view.getByTestId("route-layer").className).toContain("contents");
  expect(log.mounts).toBe(1);
});

test("`/` 跳向的不是留着的那段（别的机器人 / 空聊天）：不露出来，免得闪一下别的对话", () => {
  const { Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, null, "设置"));
  view.rerender(stage(Page, null, undefined, (kept) => kept.id === "c2"));
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe("false");
  view.rerender(stage(Page, null, undefined, (kept) => kept.id === "c1"));
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe("true");
});

test("一开始就在别的页面：没有留着的聊天，路由照常画", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, null, "设置"));
  expect(view.queryByTestId("kept-page")).toBeNull();
  expect(view.getByTestId("other").textContent).toBe("设置");
  expect(log.mounts).toBe(0);
});

test("路由那一层是同一个元素：聊天留不留着，别的页面都不会重新挂载", () => {
  function Other() {
    const [instance] = useState(() => Math.random());
    return <i data-instance={instance} data-testid="o" />;
  }
  const make = (address: Addr | null) => (
    <KeepAliveStage address={address} renderKept={(k) => <b>{k.id}</b>} same={same} ttlMs={20}>
      <Other />
    </KeepAliveStage>
  );
  const view = render(make({ id: "c1" }));
  const first = view.getByTestId("o").getAttribute("data-instance");
  view.rerender(make(null));
  view.rerender(make({ id: "c1" }));
  expect(view.getByTestId("o").getAttribute("data-instance")).toBe(first);
});

test("藏够时间就放掉（不再一直问服务器）", async () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, null, "设置", false, 30));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(view.queryByTestId("kept-page")).toBeNull();
  expect(log.unmounts).toBe(1);
});

test("接线：聊天路由自己不画东西，外壳只有一个，设置 / 管理不再各画一个外壳", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");
  expect(src("routes/_authed/_app/channel/$channelId.tsx")).toContain("component: () => null");
  expect(src("routes/_authed.tsx")).toContain("<AuthedShell />");
  for (const file of ["routes/_authed/_app.tsx", "routes/_authed/settings/route.tsx", "routes/_authed/admin/route.tsx"]) {
    expect(src(file)).not.toContain("<GlassShell");
  }
  const shell = src("components/layout/authed-shell.tsx");
  expect(shell).toContain("<KeepAliveStage");
  // 右栏在设置里藏起来，不卸载。左栏没有模式切换了（CB-099），外壳不再带 mode。
  expect(shell).toContain("rightHidden=");
  expect(shell).not.toContain("mode=");
  // 藏着的聊天不改地址、不标已读、不登记左栏「⋯」。
  const page = src("components/channels/channel-page.tsx");
  expect(page).toContain("if (!visibleRef.current) return;");
  expect(page).toContain("if (unseen && visible)");
  // 2026-10-20：JSX 被格式化成了多行，断言改成允许换行（同一件事：藏起来时不登记）。
  expect(page).toMatch(/\{visible \?\s*\(\s*<RegisterBotChat/);
});

test("藏着的聊天读到「不在屏幕上」（轮询 / 画面据此停下），回来变回在", () => {
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useKeptVisible());
    return null;
  }
  const Page = () => <Probe />;
  const view = render(stage(Page, { id: "c1" }));
  expect(seen.at(-1)).toBe(true);
  view.rerender(stage(Page, null, "设置"));
  expect(seen.at(-1)).toBe(false);
  view.rerender(stage(Page, { id: "c1" }));
  expect(seen.at(-1)).toBe(true);
});

test("藏着的聊天登记它的机器人：全局的组件授权轮询为它停下", () => {
  const onScreen: boolean[] = [];
  function Global() {
    onScreen.push(useBotOnScreen("bot_a"));
    return null;
  }
  function Chat({ hidden }: { hidden: boolean }) {
    useMarkBotHidden("bot_a", hidden);
    return null;
  }
  const view = render(<><Global /><Chat hidden={false} /></>);
  expect(onScreen.at(-1)).toBe(true);
  view.rerender(<><Global /><Chat hidden /></>);
  expect(onScreen.at(-1)).toBe(false);
  view.rerender(<><Global /><Chat hidden={false} /></>);
  expect(onScreen.at(-1)).toBe(true);
  view.rerender(<><Global /><Chat hidden /></>);
  view.unmount();
  const again = render(<Global />);
  expect(onScreen.at(-1)).toBe(true);
  again.unmount();
});

test("计算机控制权：只剩藏着的订阅者时不再每秒问，回来马上补读", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ holder: "agent" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  function Control() {
    useComputerControl("bot_ctl");
    return null;
  }
  try {
    const view = render(<KeptVisibleContext.Provider value={true}><Control /></KeptVisibleContext.Provider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });
    const visibleCalls = calls.length;
    expect(visibleCalls).toBeGreaterThanOrEqual(2);
    view.rerender(<KeptVisibleContext.Provider value={false}><Control /></KeptVisibleContext.Provider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const atHide = calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });
    expect(calls.length).toBe(atHide);
    view.rerender(<KeptVisibleContext.Provider value={true}><Control /></KeptVisibleContext.Provider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(calls.length).toBeGreaterThan(atHide);
    view.unmount();
  } finally {
    globalThis.fetch = realFetch;
  }
}, 10_000);

test("接线：藏着的东西不轮询（§98.3）", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");
  expect(src("components/layout/keep-alive.tsx")).toContain("<KeptVisibleContext.Provider value={visible}>");
  expect(src("components/layout/glass-shell.tsx")).toContain("<KeptVisibleContext.Provider value={!rightHidden}>");
  expect(src("components/computer/preview-visibility.ts")).toContain("return visible && kept;");
  expect(src("lib/computers/tabs.ts")).toContain("const poll = pollWanted && kept;");
  expect(src("components/panels/live-panels.tsx")).toContain("if (!onScreen) return false;");
  for (const f of ["lib/copilot/gallery-tools.tsx", "lib/copilot/sandboxed-tools.tsx"]) expect(src(f)).toContain("useBotOnScreen(declared)");
  expect(src("components/channels/channel-page.tsx")).toContain("useMarkBotHidden(agentId, !visible)");
  expect(src("components/computer/handoff-resume-notice.tsx")).toContain("if (!ready || !onScreen) return;");
  expect(src("lib/copilot/thread-activity.ts")).toContain("if (onScreen) kickRef.current();");
  expect(src("lib/copilot/thread-activity.ts")).toContain("onScreenRef.current ? SYNC_INTERVAL_MS : HIDDEN_SYNC_INTERVAL_MS");
  // 手机抽屉在导航开始前收起（不是新左栏挂上之后的 effect 里），否则透明抽屉盖住页面。
  expect(src("components/layout/glass-shell.tsx")).toContain('router.subscribe("onBeforeNavigate"');
});

test("藏起来那一刻浏览器挪了藏着的滚动容器：还原成离开前的位置（§98.5）", async () => {
  function Scroller() {
    return <div data-slot="message-scroller-viewport" data-testid="scroller" style={{ overflowY: "auto", height: 100 }}><div style={{ height: 1000 }} /></div>;
  }
  const page = () => <Scroller />;
  const view = render(stage(page, { id: "c1" }));
  const scroller = view.getByTestId("scroller");
  scroller.scrollTop = 500;
  scroller.dispatchEvent(new Event("scroll"));
  view.rerender(stage(page, null, "设置"));
  // 浏览器自己挪了（没有脚本调用）：收到 scroll 时还原。
  scroller.scrollTop = 432;
  scroller.dispatchEvent(new Event("scroll"));
  expect(scroller.scrollTop).toBe(500);
  view.rerender(stage(page, { id: "c1" }));
  expect(scroller.scrollTop).toBe(500);
});
