import { expect, test } from "bun:test";
import {
  isSkyWeatherUrl,
  noteSkyFrame,
  SKY_FADE_HOLD_MS,
  SKY_FRAME_MS,
  type SkyFadeClock,
  skyFadeHolding,
  wakeSkyOnWeather,
} from "@/lib/sky-fade";

/*
 * 天空换场景的交叉渐变要一口气画完：
 *  - 引擎跳过的那一拍（draws = 0）不能让天空睡着；
 *  - 天气数据到手时先叫醒天空，再交给引擎。
 */

const clock = (wakeUntil = 0): SkyFadeClock => ({ wakeUntil, fadeSince: null });

test("渐变中引擎跳过一拍（draws = 0）照样续命", () => {
  const c = clock(1000);
  noteSkyFrame(c, 2, 1000); // 渐变开始
  expect(c.fadeSince).toBe(1000);
  noteSkyFrame(c, 0, 1500); // 引擎这一拍什么都没画
  expect(c.fadeSince).toBe(1000);
  expect(c.wakeUntil).toBe(1500 + SKY_FRAME_MS * 3);
  expect(skyFadeHolding(c, 1600)).toBe(true);
});

test("没有渐变时 draws = 0 不续命，天空照常睡", () => {
  const c = clock(1000);
  noteSkyFrame(c, 0, 2000);
  expect(c.wakeUntil).toBe(1000);
  expect(c.fadeSince).toBeNull();
  expect(skyFadeHolding(c, 2000)).toBe(false);
});

test("只画一层（draws = 1）= 渐变画完，清掉、不再续命", () => {
  const c = clock(1000);
  noteSkyFrame(c, 2, 1000);
  noteSkyFrame(c, 1, 3500);
  expect(c.fadeSince).toBeNull();
  expect(skyFadeHolding(c, 3500)).toBe(false);
  const before = c.wakeUntil;
  noteSkyFrame(c, 0, 3600);
  expect(c.wakeUntil).toBe(before);
});

test("醒着的期限过了但渐变还在半路：照样允许出帧（帧被主线程拖慢时也不会停在半路）", () => {
  const c = clock(1000);
  noteSkyFrame(c, 2, 1000);
  // 上一帧之后隔了 400ms 才轮到下一帧，wakeUntil（1000 + 198）早过了
  expect(c.wakeUntil).toBeLessThan(1400);
  expect(skyFadeHolding(c, 1400)).toBe(true);
});

test("最多撑 8 秒：超过上限不再续命", () => {
  const c = clock(0);
  noteSkyFrame(c, 2, 1000);
  const late = 1000 + SKY_FADE_HOLD_MS + 1;
  const before = c.wakeUntil;
  noteSkyFrame(c, 2, late);
  noteSkyFrame(c, 0, late + 10);
  expect(c.wakeUntil).toBe(before);
  expect(skyFadeHolding(c, late)).toBe(false);
});

test("只认 open-meteo 的天气 / 空气质量请求", () => {
  expect(isSkyWeatherUrl("https://api.open-meteo.com/v1/forecast?x=1")).toBe(
    true,
  );
  expect(
    isSkyWeatherUrl("https://air-quality-api.open-meteo.com/v1/air-quality"),
  ).toBe(true);
  expect(isSkyWeatherUrl("https://gibs.earthdata.nasa.gov/x")).toBe(false);
});

test("天气数据到手：先叫醒天空，再把数据交给引擎", async () => {
  const log: string[] = [];
  let release: () => void = () => {};
  const slowBody = new ReadableStream<Uint8Array>({
    start(ctrl) {
      // 响应头先到，body 晚一点才到
      release = () => {
        log.push("body 到了");
        ctrl.enqueue(
          new TextEncoder().encode('{"current":{"weather_code":3}}'),
        );
        ctrl.close();
      };
    },
  });
  const base = async () => {
    log.push("响应头到了");
    return new Response(slowBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const fetch = wakeSkyOnWeather(base, () => log.push("叫醒天空"));
  const engine = fetch("https://api.open-meteo.com/v1/forecast?latitude=1")
    .then((r) => r.json())
    .then((j) => log.push(`引擎拿到天气 ${j.current.weather_code}`));
  await new Promise((r) => setTimeout(r, 5));
  release();
  await engine;
  expect(log).toEqual([
    "响应头到了",
    "叫醒天空",
    "body 到了",
    "叫醒天空",
    "引擎拿到天气 3",
  ]);
});

test("不是天气请求：原样转交，不叫醒", async () => {
  let woke = 0;
  const res = new Response(null, { status: 204 });
  const fetch = wakeSkyOnWeather(
    async () => res,
    () => woke++,
  );
  expect(await fetch("https://gibs.earthdata.nasa.gov/tile")).toBe(res);
  expect(woke).toBe(0);
});

test("body 读到一半失败：叫醒天空，错误照样交给引擎（引擎会退回默认天气）", async () => {
  let woke = 0;
  const broken = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.error(new Error("网络断了"));
    },
  });
  const fetch = wakeSkyOnWeather(
    async () => new Response(broken, { status: 200 }),
    () => woke++,
  );
  await expect(
    fetch(new URL("https://api.open-meteo.com/v1/forecast")),
  ).rejects.toThrow("网络断了");
  expect(woke).toBe(2);
});
