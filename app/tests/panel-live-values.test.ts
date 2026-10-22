import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { KeptVisibleContext } from "@/lib/kept-visible";
import {
  everyText,
  latestLiveAt,
  liveFailures,
  liveKindText,
  LIVE_POLL_MIN_MS,
  livePollMs,
  liveStateValues,
  mergeLiveReadings,
  shouldPollLive,
  type LiveReading,
  type LiveSource,
  useLiveValues,
} from "@/lib/panels/live-values";

/**
 * 直连数据源的取值与合并（2026-10-22，docs/live-panel-sources.md 第 1 节）：
 * 读数合并、失败不覆盖上一个好值、折叠 / 不可见不轮询。
 */
const registered = !(globalThis as { document?: unknown }).document;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(cleanup);
afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (registered) await GlobalRegistrator.unregister();
});

function reading(ok: boolean, value: unknown, extra: Partial<LiveReading> = {}): LiveReading {
  return { ok, value, at: "2026-10-22T08:00:00.000Z", ms: 12, ...extra };
}

const SOURCE_A: LiveSource = {
  id: "src_a",
  kind: "http",
  name: "CoinGecko",
  intervalSec: 5,
  label: "api.coingecko.com/v3/simple/price",
};
const SOURCE_B: LiveSource = {
  id: "src_b",
  kind: "command",
  name: "本机 uptime",
  intervalSec: 30,
  label: "uptime -p",
};

describe("读数合并", () => {
  test("成功的一条整条替换", () => {
    const before = { src_a: reading(true, { price: 1 }) };
    const after = mergeLiveReadings(before, { src_a: reading(true, { price: 2 }, { at: "2026-10-22T08:00:05.000Z" }) });
    expect(after.src_a?.value).toEqual({ price: 2 });
    expect(after.src_a?.at).toBe("2026-10-22T08:00:05.000Z");
  });

  test("失败保留上一个好值，只改成失败并带上原因", () => {
    const before = { src_a: reading(true, { price: 1 }) };
    const after = mergeLiveReadings(before, {
      src_a: reading(false, undefined, { error: "连不上 api.coingecko.com。", ms: 3000 }),
    });
    expect(after.src_a).toMatchObject({
      ok: false,
      value: { price: 1 },
      error: "连不上 api.coingecko.com。",
      ms: 3000,
    });
    // 再成功一次就回到好值。
    expect(mergeLiveReadings(after, { src_a: reading(true, { price: 9 }) }).src_a?.value).toEqual({ price: 9 });
  });

  test("从没成功过的源失败：不产生空值，也不写进 live", () => {
    const after = mergeLiveReadings({}, { src_b: reading(false, undefined, { error: "命令失败。" }) });
    expect(after.src_b?.value).toBeUndefined();
    expect(after.src_b?.ok).toBe(false);
    expect(liveStateValues(after)).toEqual({});
  });

  test("坏数据 / 空响应不改变已有读数", () => {
    const before = { src_a: reading(true, 5) };
    expect(mergeLiveReadings(before, undefined)).toBe(before);
    expect(mergeLiveReadings(before, {})).toBe(before);
  });

  test("写进 state 的 live 只留有值的源，也只留现在还挂着的源", () => {
    const readings = {
      src_a: reading(true, { price: 1 }),
      src_b: reading(false, undefined, { error: "失败" }),
      src_gone: reading(true, 7),
    };
    expect(liveStateValues(readings)).toEqual({ src_a: { price: 1 }, src_gone: 7 });
    expect(liveStateValues(readings, [SOURCE_A])).toEqual({ src_a: { price: 1 } });
  });

  test("最近取数时间只看成功的那几条；失败原因列得出来", () => {
    const readings = {
      src_a: reading(true, 1, { at: "2026-10-22T08:00:00.000Z" }),
      src_b: reading(true, 2, { at: "2026-10-22T08:03:00.000Z" }),
      src_c: reading(false, 3, { at: "2026-10-22T09:00:00.000Z", error: "超时。" }),
    };
    expect(latestLiveAt(readings)).toBe("2026-10-22T08:03:00.000Z");
    expect(liveFailures(readings)).toEqual([{ id: "src_c", error: "超时。" }]);
    expect(latestLiveAt({})).toBeNull();
  });
});

describe("轮询条件与间隔", () => {
  test("最短间隔，最少 2 秒；没有源不轮询", () => {
    expect(LIVE_POLL_MIN_MS).toBe(2000);
    expect(livePollMs([SOURCE_A, SOURCE_B])).toBe(5000);
    expect(livePollMs([{ ...SOURCE_A, intervalSec: 1 }])).toBe(2000);
    expect(livePollMs([])).toBeNull();
    expect(livePollMs([{ ...SOURCE_A, intervalSec: 60 }])).toBe(60_000);
  });

  test("不可见 / 折叠 / 没有源都不轮询", () => {
    const base = { visible: true, active: true, panelId: "p1", sources: [SOURCE_A] };
    expect(shouldPollLive(base)).toBe(true);
    expect(shouldPollLive({ ...base, visible: false })).toBe(false);
    expect(shouldPollLive({ ...base, active: false })).toBe(false);
    expect(shouldPollLive({ ...base, sources: [] })).toBe(false);
    expect(shouldPollLive({ ...base, panelId: "" })).toBe(false);
  });

  test("间隔与种类的人话", () => {
    expect(everyText(5)).toBe("每 5 秒");
    expect(everyText(30)).toBe("每 30 秒");
    expect(everyText(300)).toBe("每 5 分钟");
    expect(everyText(3600)).toBe("每小时");
    expect(liveKindText("http")).toBe("网址");
    expect(liveKindText("command")).toBe("本机命令");
  });
});

describe("useLiveValues：可见 / 不折叠才取数", () => {
  const PANEL = { id: "p1", dataSources: [SOURCE_A] };
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          sources: { src_a: reading(true, { price: 42 }, { at: "2026-10-22T08:00:00.000Z" }) },
          refreshed: ["src_a"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  function Probe({ active }: { active: boolean }) {
    const live = useLiveValues(PANEL, active);
    return createElement(
      "div",
      null,
      createElement(
        "span",
        { "data-testid": "value", key: "value" },
        String((live.values.src_a as { price?: number } | undefined)?.price ?? ""),
      ),
      createElement("span", { "data-testid": "at", key: "at" }, live.at ?? ""),
      createElement("span", { "data-testid": "error", key: "error" }, live.error ?? ""),
    );
  }

  /** 可见性是 useKeptVisible 读的 context：provider 必须包在用 hook 的组件外面。 */
  function renderProbe(active: boolean, visible: boolean) {
    return render(
      createElement(KeptVisibleContext.Provider, { value: visible }, createElement(Probe, { active })),
    );
  }

  test("右栏藏着时不发请求", async () => {
    renderProbe(true, false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(calls).toBe(0);
  });

  test("卡片折叠时不发请求", async () => {
    renderProbe(false, true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(calls).toBe(0);
  });

  test("可见时立刻取一次，读数合并进 live", async () => {
    const view = renderProbe(true, true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(calls).toBe(1);
    expect(view.getByTestId("value").textContent).toBe("42");
    expect(view.getByTestId("at").textContent).toBe("2026-10-22T08:00:00.000Z");
    expect(view.getByTestId("error").textContent).toBe("");
  });
});
