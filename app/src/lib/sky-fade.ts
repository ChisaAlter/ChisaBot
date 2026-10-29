/*
 * 天空节流器（components/sky-background.tsx）里跟「换场景渐变」有关的两件事，抽出来方便单元测试：
 *  1. 渐变画到一半时要一直醒着，直到画完（最多 SKY_FADE_HOLD_MS）；
 *  2. 天气数据到手时先叫醒天空，再把数据交给引擎。
 * 引擎本身（app/public/wallpaper_core.html）不改。
 */

export const SKY_FRAME_MS = 66; // ≤ 15fps
export const SKY_FADE_HOLD_MS = 8000; // 渐变还没画完就一直醒着，但最多撑这么久

export interface SkyFadeClock {
  /** 允许出帧到这个时间点（performance.now()）。 */
  wakeUntil: number;
  /** 这次渐变第一次被看到的时间；null = 现在没有渐变。 */
  fadeSince: number | null;
}

/** 渐变还在半路、也没超过上限：不管 wakeUntil 到没到，都该继续出帧。 */
export function skyFadeHolding(clock: SkyFadeClock, now: number): boolean {
  return clock.fadeSince !== null && now - clock.fadeSince < SKY_FADE_HOLD_MS;
}

/**
 * 引擎跑完一帧后调用。draws = 这一帧里 drawArrays 的次数：
 *  - ≥ 2：正在交叉渐变（旧天空 + 新天空各画一遍），记下开始时间，续命；
 *  - 1：只画了一层，渐变画完了（或者本来就没有），清掉；
 *  - 0：引擎这一拍跳过了（它自己有 31ms 的最小帧间隔），什么都没画。渐变还在半路，照样续命——
 *    以前这一拍既不续命也不清，醒着的期限恰好在这时到点，渐变就停在 75–80%，等下一次唤醒才接着画（看起来是一跳）。
 */
export function noteSkyFrame(
  clock: SkyFadeClock,
  draws: number,
  now: number,
): void {
  if (draws === 1) {
    clock.fadeSince = null;
    return;
  }
  if (draws >= 2 && clock.fadeSince === null) clock.fadeSince = now;
  if (skyFadeHolding(clock, now)) {
    clock.wakeUntil = Math.max(clock.wakeUntil, now + SKY_FRAME_MS * 3);
  }
}

export type SkyFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** 引擎取天气 / 空气质量走的是 open-meteo。 */
export function isSkyWeatherUrl(url: string): boolean {
  return url.includes("open-meteo.com");
}

/**
 * 包住引擎用的 fetch：天气数据真正到手（body 读完）的那一刻先叫醒天空，再把数据交给引擎。
 * 只在响应头回来时叫醒不够：body 慢的时候，数据到的时候天空已经睡着了，引擎改了天空却没有帧去画渐变，
 * 渐变就停在半路；下一次换场景接着这个半路的渐变画，第一帧就跳到 50–90%。
 * body 读失败（中途断网）时也叫醒一次再把错误交给引擎——引擎会退回默认天气，天空同样会变。
 */
export function wakeSkyOnWeather(base: SkyFetch, wake: () => void): SkyFetch {
  return async (input, init) => {
    const res = await base(input, init);
    if (!isSkyWeatherUrl(urlOf(input))) return res;
    wake();
    // 没有 body 的状态码不能再构造带 body 的 Response，原样交回去。
    if (res.status === 204 || res.status === 205 || res.status === 304)
      return res;
    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      wake();
      throw err;
    }
    wake();
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
