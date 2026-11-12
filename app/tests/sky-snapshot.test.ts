/**
 * lib/sky-snapshot.ts：天空宿主在出帧当下拷给液态玻璃的小快照。
 * 天空画布没有 preserveDrawingBuffer，帧外读 #gl 是全黑——所以只能在出帧的同一任务里拷。
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let mod: typeof import("../src/lib/sky-snapshot");
let draws = 0;
let realGetContext: PropertyDescriptor | undefined;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realGetContext = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value() {
      return { drawImage: () => draws++ };
    },
  });
  mod = await import("../src/lib/sky-snapshot");
});

afterAll(async () => {
  if (realGetContext)
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      realGetContext,
    );
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  mod.__resetSkySnapshotForTestOnly();
  draws = 0;
});

function glCanvas() {
  const c = document.createElement("canvas");
  c.width = 864;
  c.height = 540;
  return c;
}

describe("sky snapshot for liquid glass sampling", () => {
  test("nothing is copied while nobody (no liquid glass) subscribes", () => {
    expect(mod.captureSkySnapshot(glCanvas(), 1000)).toBe(false);
    expect(mod.getSkySnapshot()).toBeNull();
    expect(draws).toBe(0);
  });

  test("subscribed: copies a 1/8 snapshot in-frame and notifies; throttled to one per interval", () => {
    let notified = 0;
    mod.subscribeSkySnapshot(() => notified++);
    expect(mod.captureSkySnapshot(glCanvas(), 1000)).toBe(true);
    const snap = mod.getSkySnapshot();
    expect(snap?.canvas.width).toBe(108);
    expect(snap?.canvas.height).toBe(68);
    expect(notified).toBe(1);
    expect(
      mod.captureSkySnapshot(
        glCanvas(),
        1000 + mod.SKY_SNAPSHOT_INTERVAL_MS / 2,
      ),
    ).toBe(false);
    expect(
      mod.captureSkySnapshot(glCanvas(), 1000 + mod.SKY_SNAPSHOT_INTERVAL_MS),
    ).toBe(true);
    expect(notified).toBe(2);
    expect(mod.getSkySnapshot()?.version).toBe(2);
    // 尺寸变化后的补画（force）不受节流。
    expect(
      mod.captureSkySnapshot(
        glCanvas(),
        1000 + mod.SKY_SNAPSHOT_INTERVAL_MS + 1,
        true,
      ),
    ).toBe(true);
  });

  test("a throttled last frame asks the host to redraw once so the snapshot doesn't stop mid-fade", async () => {
    let redraws = 0;
    const gl = glCanvas();
    mod.subscribeSkySnapshot(() => {});
    mod.setSkySnapshotRedraw(() => {
      redraws++;
      mod.captureSkySnapshot(gl, performance.now());
    });
    const t = performance.now();
    expect(mod.captureSkySnapshot(gl, t)).toBe(true);
    expect(mod.captureSkySnapshot(gl, t + 10)).toBe(false); // 渐变最后一帧被节流
    await new Promise((r) => setTimeout(r, mod.SKY_SNAPSHOT_INTERVAL_MS + 80));
    expect(redraws).toBe(1);
    expect(mod.getSkySnapshot()?.version).toBe(2);
  });

  test("invalidate (sky turned off / resized) drops the old snapshot", () => {
    mod.subscribeSkySnapshot(() => {});
    mod.captureSkySnapshot(glCanvas(), 1000);
    mod.invalidateSkySnapshot();
    expect(mod.getSkySnapshot()).toBeNull();
  });

  test("the sky host copies right after the engine's draw, in the same frame", async () => {
    const src = await Bun.file(
      new URL("../src/components/sky-background.tsx", import.meta.url),
    ).text();
    expect(src).toMatch(
      /if \(sky\.draws > 0\) \{[\s\S]{0,400}captureSkySnapshot\(/,
    );
    expect(src).toContain("setSkySnapshotRedraw(drawSkyNow)");
  });
});
