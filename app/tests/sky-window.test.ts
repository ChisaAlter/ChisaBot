import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createSkyWindow } from "@/lib/sky-window";

/*
 * 天空引擎拿到的是代理过的 window。window 自己的方法要绑回 window，构造函数不能 bind，
 * 否则 window.Date.now()、window.Promise.resolve() 会因为静态方法丢失而报错。
 */

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

/** 模拟浏览器：rAF / setTimeout 脱离 window 调用就报 Illegal invocation。 */
function fakeWindow() {
  const win = {
    devicePixelRatio: 2,
    Date,
    Promise,
    Float32Array,
    requestAnimationFrame(this: unknown, cb: (t: number) => void) {
      if (this !== win) throw new TypeError("Illegal invocation");
      cb(16);
      return 1;
    },
    setTimeout(this: unknown, cb: () => void) {
      if (this !== win) throw new TypeError("Illegal invocation");
      cb();
      return 2;
    },
  };
  return win;
}

/** 引擎的写法：脚本里通过形参 window 访问全局。 */
function runAsEngine<T>(win: object, body: string): T {
  return new Function("window", body)(win) as T;
}

test("Date.now(), new Date() and Promise.resolve() still work through the sky window", async () => {
  const sky = createSkyWindow(fakeWindow(), 0.6);
  const now = runAsEngine<number>(sky, "return window.Date.now();");
  expect(typeof now).toBe("number");
  expect(Math.abs(now - Date.now())).toBeLessThan(1000);

  const d = runAsEngine<Date>(sky, "return new window.Date(0);");
  expect(d).toBeInstanceOf(Date);
  expect(d.getTime()).toBe(0);

  const p = runAsEngine<Promise<number>>(
    sky,
    "return window.Promise.resolve(7);",
  );
  expect(await p).toBe(7);

  const arr = runAsEngine<Float32Array>(
    sky,
    "return new window.Float32Array(3);",
  );
  expect(arr.length).toBe(3);
});

test("requestAnimationFrame and setTimeout are bound to the real window", () => {
  const sky = createSkyWindow(fakeWindow(), 0.6);
  let frame = -1;
  const id = runAsEngine<number>(
    sky,
    "const raf = window.requestAnimationFrame; return raf((t) => { window.__t = t; });",
  );
  expect(id).toBe(1);
  frame = (sky as unknown as { __t: number }).__t;
  expect(frame).toBe(16);

  let ran = false;
  const st = sky.setTimeout;
  st(() => {
    ran = true;
  });
  expect(ran).toBe(true);
  // 同一个方法每次拿到的是同一个函数（removeEventListener 之类不受影响）
  expect(sky.requestAnimationFrame).toBe(sky.requestAnimationFrame);
});

test("devicePixelRatio is capped at 1 and scaled; writes go to the real window", () => {
  const win = fakeWindow();
  const sky = createSkyWindow(win, 0.6);
  expect(sky.devicePixelRatio).toBeCloseTo(0.6);
  (sky as unknown as { hark: string }).hark = "engine";
  expect((win as unknown as { hark: string }).hark).toBe("engine");
});

test("the real browser window keeps working through the proxy", async () => {
  const sky = createSkyWindow(window, 0.6);
  expect(typeof sky.Date.now()).toBe("number");
  expect(await sky.Promise.resolve(1)).toBe(1);
  expect(new sky.Date(5).getTime()).toBe(5);
  await new Promise<void>((resolve) => {
    sky.requestAnimationFrame(() => resolve());
  });
});
