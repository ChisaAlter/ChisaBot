import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";
import {
  SHAPES,
  type ShapeGeometry,
  shapePath,
} from "@/lib/agents/avatar-shapes";

/** 形象头像的持续变形（DESIGN.md §81）：全局一个 rAF、只动在动的、看不见就停、回弹、不重渲染。 */
let morph: typeof import("@/lib/agents/avatar-morph");
let shapeMod: typeof import("@/components/agents/shape-avatar");
let perf: typeof import("@/lib/perf-mode");
let activity: typeof import("@/lib/agents/bot-activity");

let queue = new Map<number, (now: number) => void>();
let nextId = 1;
let clock = 0;
const scheduler = {
  request: (callback: (now: number) => void) => {
    const id = nextId++;
    queue.set(id, callback);
    return id;
  },
  cancel: (id: number) => {
    queue.delete(id);
  },
};
function tick(frames = 1) {
  for (let i = 0; i < frames; i++) {
    clock += 16.7;
    const callbacks = [...queue.values()];
    queue = new Map();
    for (const callback of callbacks) callback(clock);
  }
}

type FakeObserver = {
  callback: IntersectionObserverCallback;
  observed: Set<Element>;
};
let observers: FakeObserver[] = [];
function setIntersecting(element: Element, isIntersecting: boolean) {
  for (const observer of observers)
    if (observer.observed.has(element))
      observer.callback(
        [{ target: element, isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
    class {
      record: FakeObserver;
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, observed: new Set() };
        observers.push(this.record);
      }
      observe(element: Element) {
        this.record.observed.add(element);
      }
      unobserve(element: Element) {
        this.record.observed.delete(element);
      }
      disconnect() {
        this.record.observed.clear();
      }
    };
  morph = await import("@/lib/agents/avatar-morph");
  shapeMod = await import("@/components/agents/shape-avatar");
  perf = await import("@/lib/perf-mode");
  activity = await import("@/lib/agents/bot-activity");
});
afterAll(async () => {
  morph.setMorphSchedulerForTests(null);
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  queue = new Map();
  observers = [];
  morph.setMorphSchedulerForTests(scheduler);
  setHidden(false);
});
afterEach(() => {
  cleanup();
  perf.setPerfMode(false);
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function fakeTarget() {
  const element = document.createElement("div");
  document.body.append(element);
  const painted: ShapeGeometry[] = [];
  const base = SHAPES.round;
  return {
    element,
    painted,
    base,
    target: {
      element,
      base: () => base,
      paint: (g: ShapeGeometry) => painted.push(g),
    },
  };
}

describe("morph loop", () => {
  test("idle produces zero frames and never starts the loop", () => {
    const { target, painted } = fakeTarget();
    const handle = morph.attachMorph(target);
    handle.setIntensity(0);
    tick(60);
    expect(morph.morphLoopRunning()).toBe(false);
    expect(morph.morphStats.frames).toBe(0);
    expect(painted.length).toBe(0);
  });

  test("starts on an active avatar, one shared loop for many, stops when all spring back", () => {
    const a = fakeTarget();
    const b = fakeTarget();
    const ha = morph.attachMorph(a.target);
    const hb = morph.attachMorph(b.target);
    ha.setIntensity(morph.MORPH_INTENSITY.working);
    hb.setIntensity(morph.MORPH_INTENSITY.thinking);
    expect(queue.size).toBe(1);
    tick(30);
    expect(morph.morphStats.frames).toBe(30);
    expect(a.painted.length).toBe(30);
    expect(b.painted.length).toBe(30);
    expect(morph.morphActiveCount()).toBe(2);
    ha.setIntensity(0);
    hb.setIntensity(0);
    tick(240);
    expect(morph.morphActiveCount()).toBe(0);
    expect(morph.morphLoopRunning()).toBe(false);
    const frames = morph.morphStats.frames;
    tick(30);
    expect(morph.morphStats.frames).toBe(frames);
  });

  test("springs back to exactly its own shape", () => {
    const { target, painted, base } = fakeTarget();
    const handle = morph.attachMorph(target);
    handle.setIntensity(1);
    tick(90);
    const mid = painted.at(-1) as ShapeGeometry;
    expect(shapePath(mid)).not.toBe(shapePath(base));
    // 果冻 + 流动波，偏离仍然有上限。
    for (let i = 0; i < base.radii.length; i++)
      expect(Math.abs(mid.radii[i] / base.radii[i] - 1)).toBeLessThanOrEqual(
        0.15,
      );
    handle.setIntensity(0);
    tick(240);
    expect(painted.at(-1)).toBe(base);
  });

  test("pauses while the tab is hidden and resumes when it is shown", () => {
    const { target } = fakeTarget();
    morph.attachMorph(target).setIntensity(1);
    tick(5);
    setHidden(true);
    expect(morph.morphLoopRunning()).toBe(false);
    const frames = morph.morphStats.frames;
    tick(30);
    expect(morph.morphStats.frames).toBe(frames);
    setHidden(false);
    expect(morph.morphLoopRunning()).toBe(true);
    tick(1);
    expect(morph.morphStats.frames).toBe(frames + 1);
  });

  test("skips an offscreen avatar and stops the loop when none is visible", () => {
    const a = fakeTarget();
    morph.attachMorph(a.target).setIntensity(1);
    tick(3);
    setIntersecting(a.element, false);
    tick(1);
    expect(morph.morphLoopRunning()).toBe(false);
    const painted = a.painted.length;
    tick(30);
    expect(a.painted.length).toBe(painted);
    setIntersecting(a.element, true);
    tick(2);
    expect(a.painted.length).toBe(painted + 2);
  });
});

describe("ShapeAvatar morph", () => {
  test("a working avatar morphs by setAttribute without re-rendering React", () => {
    let commits = 0;
    const view = render(
      <Profiler id="ava" onRender={() => commits++}>
        <shapeMod.ShapeAvatar color="blue" shape="round" size={32} working />
      </Profiler>,
    );
    const path = view.container.querySelector("path") as SVGPathElement;
    const before = path.getAttribute("d");
    expect(morph.morphActiveCount()).toBe(1);
    const settled = commits;
    act(() => tick(45));
    expect(path.getAttribute("d")).not.toBe(before);
    expect(commits).toBe(settled);
  });

  test("an idle avatar does not register", () => {
    render(<shapeMod.ShapeAvatar color="blue" shape="round" size={32} />);
    tick(10);
    expect(morph.morphActiveCount()).toBe(0);
    expect(morph.morphStats.frames).toBe(0);
  });

  test("intensity: working > thinking > selected > idle", () => {
    expect(shapeMod.morphLevelOf(true, true, true)).toBe("working");
    expect(shapeMod.morphLevelOf(true, true, false)).toBe("thinking");
    expect(shapeMod.morphLevelOf(true, false, false)).toBe("selected");
    expect(shapeMod.morphLevelOf(false, false, false)).toBe("idle");
    const i = morph.MORPH_INTENSITY;
    expect(
      i.working > i.thinking && i.thinking > i.selected && i.selected > i.idle,
    ).toBe(true);
  });

  test("performance mode: no morph, back to its own shape", () => {
    const view = render(
      <shapeMod.ShapeAvatar color="blue" shape="round" size={32} working />,
    );
    expect(morph.morphActiveCount()).toBe(1);
    act(() => perf.setPerfMode(true));
    expect(morph.morphActiveCount()).toBe(0);
    expect(morph.morphLoopRunning()).toBe(false);
    expect(view.container.querySelector("path")?.getAttribute("d")).toBe(
      shapePath(SHAPES.round),
    );
  });
});

describe("states", () => {
  test("done hops (body moves up) then settles back to rest", () => {
    const { target, base } = fakeTarget();
    const poses: { ty: number }[] = [];
    const geos: ShapeGeometry[] = [];
    const handle = morph.attachMorph({
      ...target,
      paint: (g, pose) => {
        geos.push(g);
        poses.push(pose);
      },
    });
    handle.setState({
      selected: false,
      thinking: false,
      working: false,
      done: true,
    });
    tick(20);
    expect(Math.min(...poses.map((p) => p.ty))).toBeLessThan(-3);
    handle.setState(morph.IDLE_STATE);
    tick(400);
    expect(morph.morphActiveCount()).toBe(0);
    expect(geos.at(-1)).toBe(base);
    expect(poses.at(-1)).toEqual(morph.REST_POSE);
  });

  test("working rotates and moves the eyes; selected looks forward", () => {
    const { target } = fakeTarget();
    const faces: { x: number; rot: number }[] = [];
    const handle = morph.attachMorph({
      ...target,
      paint: (g, pose) => faces.push({ x: g.face.x, rot: pose.rot }),
    });
    handle.setState({
      selected: false,
      thinking: false,
      working: true,
      done: false,
    });
    tick(180);
    const xs = faces.map((f) => f.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(2);
    expect(Math.max(...faces.map((f) => Math.abs(f.rot)))).toBeGreaterThan(1);
  });

  test("state changes are springs, not cuts: the first frame after a switch stays close", () => {
    const { target } = fakeTarget();
    const paths: string[] = [];
    const handle = morph.attachMorph({
      ...target,
      paint: (g) => paths.push(shapePath(g)),
    });
    handle.setState({
      selected: false,
      thinking: false,
      working: true,
      done: false,
    });
    tick(1);
    const first = paths[0];
    expect(first).toBeDefined();
    // 一帧之后只走了一小步：权重从 0 起，不是直接满幅。
    const r = (d: string) => Number(d.slice(1).split(" ")[0]);
    expect(Math.abs(r(first) - r(shapePath(SHAPES.round)))).toBeLessThan(1.5);
  });
});

describe("activityOf", () => {
  const user = { id: "u", role: "user", content: "hi" } as const;
  test("not busy is null", () => {
    expect(activity.activityOf([user], false)).toBeNull();
  });
  test("busy with no tool running is thinking", () => {
    expect(
      activity.activityOf(
        [user, { id: "a", role: "assistant", content: "…" }],
        true,
      ),
    ).toBe("thinking");
  });
  test("an unanswered tool call is working; answered falls back to thinking", () => {
    const call = {
      id: "a",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "t1",
          type: "function",
          function: { name: "x", arguments: "{}" },
        },
      ],
    } satisfies Message;
    expect(activity.activityOf([user, call], true)).toBe("working");
    expect(
      activity.activityOf(
        [
          user,
          call,
          { id: "r", role: "tool", content: "ok", toolCallId: "t1" },
        ],
        true,
      ),
    ).toBe("thinking");
  });
});

describe("round 3 (review 16:17)", () => {
  const moodOf = (view: ReturnType<typeof render>) =>
    view.container.querySelector("svg")?.getAttribute("data-mood");

  test("done only when the whole turn ends: working → thinking → null", () => {
    const view = render(
      <shapeMod.ShapeAvatar color="blue" shape="round" size={28} working />,
    );
    expect(moodOf(view)).toBe("working");
    // 工具跑完、回到在想：不是做完了。
    view.rerender(
      <shapeMod.ShapeAvatar color="blue" shape="round" size={28} thinking />,
    );
    expect(moodOf(view)).not.toBe("done");
    expect(
      view.container.querySelector("svg")?.getAttribute("data-activity"),
    ).toBe("thinking");
    // 整轮结束：做完了。
    view.rerender(
      <shapeMod.ShapeAvatar color="blue" shape="round" size={28} />,
    );
    expect(moodOf(view)).toBe("done");
  });

  test("a thinking-only turn also ends in done", () => {
    const view = render(
      <shapeMod.ShapeAvatar color="blue" shape="round" size={28} thinking />,
    );
    expect(moodOf(view)).not.toBe("done");
    view.rerender(
      <shapeMod.ShapeAvatar color="blue" shape="round" size={28} />,
    );
    expect(moodOf(view)).toBe("done");
  });

  function sample(
    size: number | undefined,
    state: Partial<import("@/lib/agents/avatar-morph").MorphState>,
    frames = 300,
  ) {
    const { target } = fakeTarget();
    const out: { x: number; y: number; rot: number; ty: number; r: number }[] =
      [];
    const handle = morph.attachMorph({
      ...target,
      size: size === undefined ? undefined : () => size,
      paint: (g, pose) =>
        out.push({
          x: g.face.x,
          y: g.face.y,
          rot: pose.rot,
          ty: pose.ty,
          r: Number(shapePath(g).slice(1).split(" ")[0]),
        }),
    });
    handle.setState({ ...morph.IDLE_STATE, ...state });
    tick(frames);
    handle.detach();
    const range = (k: "x" | "y" | "rot" | "ty" | "r") =>
      Math.max(...out.map((o) => o[k])) - Math.min(...out.map((o) => o[k]));
    return { out, range };
  }

  test("small avatars move more: 28px has bigger flow, rotation and eye travel than 48px", () => {
    const small = sample(28, { thinking: true });
    const big = sample(48, { thinking: true });
    expect(small.range("rot")).toBeGreaterThan(big.range("rot") * 1.5);
    expect(small.range("x")).toBeGreaterThan(big.range("x") * 2);
    expect(small.range("r")).toBeGreaterThan(big.range("r") * 1.3);
  });

  test("thinking and selected differ in motion: thinking tilts and looks up, selected bounces", () => {
    const think = sample(28, { thinking: true });
    const sel = sample(28, { selected: true }, 200);
    const eyeUp = (o: { y: number }[]) =>
      o.slice(60).reduce((a, b) => a + b.y, 0) / (o.length - 60);
    expect(eyeUp(think.out)).toBeLessThan(eyeUp(sel.out) - 2);
    expect(think.range("rot")).toBeGreaterThan(sel.range("rot") * 1.5);
    expect(Math.min(...sel.out.map((o) => o.ty))).toBeLessThan(-3);
  });

  test("selected calms down after a few seconds and the loop stops while still selected", () => {
    const { target } = fakeTarget();
    const handle = morph.attachMorph(target);
    handle.setState({ ...morph.IDLE_STATE, selected: true });
    tick(30);
    expect(morph.morphLoopRunning()).toBe(true);
    tick(60 * (morph.SELECTED_CALM_S + 4));
    expect(morph.morphActiveCount()).toBe(0);
    expect(morph.morphLoopRunning()).toBe(false);
    handle.detach();
  });

  test("pauses on window blur and resumes on focus", async () => {
    const { target } = fakeTarget();
    const handle = morph.attachMorph(target);
    handle.setState({ ...morph.IDLE_STATE, working: true });
    tick(3);
    const original = document.hasFocus;
    document.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(morph.morphLoopRunning()).toBe(false);
    const frames = morph.morphStats.frames;
    tick(10);
    expect(morph.morphStats.frames).toBe(frames);
    document.hasFocus = original;
    window.dispatchEvent(new Event("focus"));
    expect(morph.morphLoopRunning()).toBe(true);
    handle.detach();
  });

  test("BotAvatar follows the published live activity, and cleans up on agent switch and unmount", async () => {
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { BotAvatar } = await import("@/components/agents/bot-avatar");
    const { botAvatarsQueryOptions } = await import("@/lib/agents/avatars");
    const client = new QueryClient({
      defaultOptions: {
        queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
      },
    });
    client.setQueryData(botAvatarsQueryOptions().queryKey, {
      a1: { kind: "shape", shape: "round", color: "blue" },
      a2: { kind: "shape", shape: "tile", color: "red" },
    } as never);
    const ui = (id: string) => (
      <QueryClientProvider client={client}>
        <BotAvatar agentId={id} decorative name="x" size={28} />
      </QueryClientProvider>
    );
    const view = render(ui("a1"));
    const svg = () => view.container.querySelector("svg");
    expect(svg()?.getAttribute("data-activity")).toBe("idle");
    let stop: () => void = () => {};
    act(() => {
      stop = activity.publishBotActivity("a1", "working");
    });
    expect(svg()?.getAttribute("data-activity")).toBe("working");
    expect(morph.morphActiveCount()).toBe(1);
    // 换到别的机器人：不再跟着 a1 的状态。
    view.rerender(ui("a2"));
    expect(svg()?.getAttribute("data-activity")).not.toBe("working");
    expect(svg()?.getAttribute("data-activity")).not.toBe("thinking");
    act(() => stop());
    view.rerender(ui("a1"));
    expect(svg()?.getAttribute("data-mood")).not.toBe("working");
    act(() => {
      stop = activity.publishBotActivity("a1", "thinking");
    });
    expect(svg()?.getAttribute("data-activity")).toBe("thinking");
    view.unmount();
    act(() => stop());
    expect(morph.morphActiveCount()).toBe(0);
  });
});
