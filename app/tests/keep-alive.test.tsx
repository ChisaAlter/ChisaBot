import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ReactNode, useEffect, useState } from "react";
import { KeepAliveStage, type KeptState, useKeptSlot } from "@/components/layout/keep-alive";
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

test("换一段对话：新的那段看得见，原来那段藏着留下（LRU，§98.6）", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, { id: "c2" }));
  const visible = view.getAllByTestId("kept-page").filter((el) => el.getAttribute("data-visible") === "true");
  expect(visible).toHaveLength(1);
  expect(visible[0].textContent).toBe("c2");
  expect(log.states.at(-1)).toMatchObject({ id: "c2", visible: true });
  expect(log.unmounts).toBe(0);
});

function pages(view: ReturnType<typeof render>) {
  return view.getAllByTestId("page").map((el) => ({ id: el.textContent, instance: el.getAttribute("data-instance") }));
}

test("A→B→A：切回最近看过的那段是同一个实例（不重挂、不重新解析），epoch 加一", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "a" }));
  const a = pages(view).find((p) => p.id === "a")?.instance;
  view.rerender(stage(Page, { id: "b" }));
  view.rerender(stage(Page, null, "设置"));
  view.rerender(stage(Page, { id: "c" }));
  view.rerender(stage(Page, { id: "a" }));
  expect(pages(view).find((p) => p.id === "a")?.instance).toBe(a);
  expect(log.mounts).toBe(3);
  expect(log.unmounts).toBe(0);
  const shown = view.getAllByTestId("kept-page").filter((el) => el.getAttribute("data-visible") === "true");
  expect(shown.map((el) => el.textContent)).toEqual(["a"]);
  expect(log.states.filter((s) => s.id === "a").at(-1)).toMatchObject({ visible: true, epoch: 1 });
});

test("藏着的那段：content-visibility 隐藏、不占位、不可点；外壳重渲时不跟着重画", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "a" }));
  view.rerender(stage(Page, { id: "b" }));
  const hidden = view.getAllByTestId("kept-page").find((el) => el.textContent === "a") as HTMLElement;
  expect(hidden.getAttribute("data-visible")).toBe("false");
  expect(hidden.style.getPropertyValue("content-visibility")).toBe("hidden");
  expect(hidden.style.position).toBe("absolute");
  expect(hidden.hasAttribute("inert")).toBe(true);
  const before = log.states.filter((s) => s.id === "a").length;
  for (let i = 0; i < 5; i++) view.rerender(stage(Page, { id: "b" }, `x${i}`));
  expect(log.states.filter((s) => s.id === "a").length).toBe(before);
});

test("最多留 4 段：第 5 段进来放掉最久没看的那段", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "a" }));
  for (const id of ["b", "c", "d"]) view.rerender(stage(Page, { id }));
  view.rerender(stage(Page, { id: "a" }));
  view.rerender(stage(Page, { id: "e" }));
  expect(pages(view).map((p) => p.id).sort()).toEqual(["a", "c", "d", "e"]);
  expect(log.unmounts).toBe(1);
});

test("同一段（keyOf 相同）地址别的部分变了：更新那段，不重挂", () => {
  type A = { id: string; settings?: boolean };
  const log: string[] = [];
  function P({ a }: { a: A }) {
    useEffect(() => {
      log.push(`mount ${a.id}`);
    }, []);
    return <span data-testid="p">{a.settings ? "s" : "-"}</span>;
  }
  const make = (address: A) => (
    <KeepAliveStage address={address} keyOf={(x) => x.id} renderKept={(k) => <P a={k} />} same={(x, y) => x.id === y.id && x.settings === y.settings}>
      {null}
    </KeepAliveStage>
  );
  const view = render(make({ id: "a" }));
  view.rerender(make({ id: "a", settings: true }));
  expect(view.getAllByTestId("p").map((el) => el.textContent)).toEqual(["s"]);
  expect(log).toEqual(["mount a"]);
});

test("元素预算：藏着的合计超了，从最久没看的开始提前放（大会话先走）", () => {
  function Big({ n }: { n: number }) {
    return (
      <div data-testid="page">
        {Array.from({ length: n }, (_, i) => (
          <i key={i} />
        ))}
      </div>
    );
  }
  const sizes: Record<string, number> = { a: 60, b: 5, c: 5 };
  const make = (address: Addr | null) => (
    <KeepAliveStage address={address} nodeBudget={40} renderKept={(k) => <Big n={sizes[k.id]} />} same={same}>
      {null}
    </KeepAliveStage>
  );
  const view = render(make({ id: "a" }));
  view.rerender(make({ id: "b" }));
  view.rerender(make({ id: "c" }));
  // a（60 个）超预算被放掉；b 小，留着。
  expect(view.getAllByTestId("kept-page")).toHaveLength(2);
});

test("每段各自计时：藏够 TTL 的放掉，看得见的不放", async () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "a" }, undefined, false, 30));
  view.rerender(stage(Page, { id: "b" }, undefined, false, 30));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(pages(view).map((p) => p.id)).toEqual(["b"]);
  expect(log.unmounts).toBe(1);
});

test("流式中切走再切回：藏着时状态照常更新（流不丢），切回后同一实例、内容已追上；贴底的滚到底", async () => {
  let push: (s: string) => void = () => {};
  function Stream({ id }: { id: string }) {
    const [text, setText] = useState("");
    useEffect(() => {
      if (id !== "a") return;
      push = (s) => setText((t) => t + s);
    }, [id]);
    return (
      <div data-testid={`scroller-${id}`} style={{ overflowY: "auto", height: 100 }}>
        <p data-testid={`text-${id}`}>{text}</p>
      </div>
    );
  }
  const make = (address: Addr | null) => (
    <KeepAliveStage address={address} renderKept={(k) => <Stream id={k.id} />} same={same}>
      {null}
    </KeepAliveStage>
  );
  const view = render(make({ id: "a" }));
  const scroller = view.getByTestId("scroller-a");
  // happy-dom 没有布局：用定义的属性模拟「贴着底」。
  let height = 1000;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 100 });
  scroller.scrollTop = 900;
  scroller.dispatchEvent(new Event("scroll"));
  await act(async () => push("你好"));
  view.rerender(make({ id: "b" }));
  await act(async () => push("，世界"));
  height = 1400;
  expect(view.getByTestId("text-a").textContent).toBe("你好，世界");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1600));
  });
  view.rerender(make({ id: "a" }));
  expect(view.getByTestId("scroller-a")).toBe(scroller);
  expect(view.getByTestId("text-a").textContent).toBe("你好，世界");
  expect(scroller.scrollTop).toBe(1400);
});

test("P3-3 接口：useKeptSlot 给出段的 key、被放掉时回调、页面自己接管滚动保存 / 还原", () => {
  const events: string[] = [];
  function Probe({ id }: { id: string }) {
    const slot = useKeptSlot();
    useEffect(() => {
      if (!slot) return;
      events.push(`key ${slot.slotKey}`);
      const off1 = slot.onEvict(() => events.push(`evict ${id}`));
      const off2 = slot.registerScroll({ save: () => `pos-${id}`, restore: (s) => events.push(`restore ${String(s)}`) });
      return () => {
        off1();
        off2();
      };
    }, [slot, id]);
    return null;
  }
  const make = (address: Addr) => (
    <KeepAliveStage address={address} keyOf={(a) => a.id} max={2} renderKept={(k) => <Probe id={k.id} />} same={same}>
      {null}
    </KeepAliveStage>
  );
  const view = render(make({ id: "a" }));
  view.rerender(make({ id: "b" }));
  view.rerender(make({ id: "a" }));
  expect(events).toContain("key a");
  expect(events).toContain("restore pos-a");
  view.rerender(make({ id: "c" }));
  // max=2：b 是最久没看的，被放掉。
  expect(events).toContain("evict b");
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

test("同一个机器人一段藏着、一段看着（LRU）：算在屏幕上；都藏着才算不在", () => {
  const onScreen: boolean[] = [];
  function Global() {
    onScreen.push(useBotOnScreen("bot_m"));
    return null;
  }
  function Chat({ hidden }: { hidden: boolean }) {
    useMarkBotHidden("bot_m", hidden);
    return null;
  }
  const view = render(<><Global /><Chat hidden /><Chat hidden={false} /></>);
  expect(onScreen.at(-1)).toBe(true);
  view.rerender(<><Global /><Chat hidden /><Chat hidden /></>);
  expect(onScreen.at(-1)).toBe(false);
  view.unmount();
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
  // CB-103 r2：提示不再自己轮询，改订阅共用的控制权 store；store 只在有看得见的订阅者时轮询。
  expect(src("components/computer/handoff-resume-notice.tsx")).toContain("useComputerControl(botId, ready)");
  expect(src("components/computer/handoff-resume-notice.tsx")).not.toContain("readControl(");
  expect(src("lib/computers/use-control.ts")).toContain("const onScreen = useKeptVisible();");
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
