/**
 * 面板的直连数据源取值（2026-10-22，docs/live-panel-sources.md 第 1 节）。
 *
 * 机器人给面板挂上数据源之后，值不再只靠「一小时一轮」的机器人回合：卡片可见、没折叠时，浏览器按
 * 最短的那个间隔问 `GET /api/live-panels/:id/live`，宿主只把过期的源取一遍，结果回填到规范里的
 * `{"$state": "/live/<id>"}`。卡片一折叠、右栏一藏、标签页一切走，轮询就停——没人在看就不取数。
 *
 * 读数在 json-render 的 state 里是 `{ live: { [sourceId]: value } }`；本文件只管取数与合并，
 * 写进 store 的是 `live-panels.tsx`（store.update，不重建仓库、不重挂组件）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "@/lib/client";
import { useKeptVisible } from "@/lib/kept-visible";

/** 一次读数（与 server/src/live-panels/source-types.ts 的 LivePanelSourceReading 一致）。 */
export type LiveReading = {
  ok: boolean;
  value: unknown;
  /** 失败原因（中文，服务器已抹掉密钥、截断）。成功时没有。 */
  error?: string;
  /** 取数完成的时刻（ISO）。 */
  at: string;
  /** 这一次用了多少毫秒。 */
  ms: number;
};

/** DTO 里的一个直连来源（`label` 是展示用：http 写 host + path，command 写命令原文）。 */
export type LiveSource = {
  id: string;
  kind: "http" | "command";
  name: string;
  intervalSec: number;
  label: string;
};

export type LiveSourceReadings = Record<string, LiveReading>;

/** 浏览器最快多久问一次：再快的源也不值得让右栏每半秒发一个请求。 */
export const LIVE_POLL_MIN_MS = 2_000;

function intervalOf(source: LiveSource): number {
  return Number.isFinite(source.intervalSec) && source.intervalSec > 0 ? source.intervalSec : 60;
}

/** 轮询间隔 = 最短的源间隔（至少 2 秒）；没有源 = 不轮询（null）。 */
export function livePollMs(sources: readonly LiveSource[]): number | null {
  if (sources.length === 0) return null;
  let shortest = Number.POSITIVE_INFINITY;
  for (const source of sources) shortest = Math.min(shortest, intervalOf(source));
  if (!Number.isFinite(shortest)) return null;
  return Math.max(LIVE_POLL_MIN_MS, Math.round(shortest * 1000));
}

/** 该不该轮询：有人在看（没被藏着、标签页在前台）、没折叠、有面板、有数据源。 */
export function shouldPollLive(options: {
  visible: boolean;
  active: boolean;
  panelId: string;
  sources: readonly LiveSource[];
}): boolean {
  return Boolean(options.visible && options.active && options.panelId && options.sources.length > 0);
}

/**
 * 把一次响应并进已有读数。
 *
 * 失败的一条不覆盖上一个好值：数值留在原位（数字不闪成空白），只把状态改成失败、带上原因，
 * 「数据来源…」里就能说清为什么；成功的一条整条替换。失败时若之前也没取到过值，`value` 仍是
 * undefined —— 写成 `{ live: { id: undefined } }` 会让组件丢数字，所以写 state 时只挑有值的。
 */
export function mergeLiveReadings(
  previous: LiveSourceReadings,
  incoming: LiveSourceReadings | undefined,
): LiveSourceReadings {
  if (!incoming || typeof incoming !== "object") return previous;
  let changed = false;
  const next: LiveSourceReadings = { ...previous };
  for (const [id, raw] of Object.entries(incoming)) {
    if (!raw || typeof raw !== "object") continue;
    const reading = raw as LiveReading;
    const prior = previous[id];
    const at = typeof reading.at === "string" && reading.at ? reading.at : new Date().toISOString();
    const ms = Number.isFinite(reading.ms) ? Math.max(0, Math.round(reading.ms)) : 0;
    if (reading.ok === true) {
      next[id] = { ok: true, value: reading.value, at, ms };
      changed = true;
      continue;
    }
    const error = typeof reading.error === "string" && reading.error.trim() ? reading.error.trim() : "取数失败。";
    next[id] = { ok: false, value: prior?.value, error, at, ms };
    changed = true;
  }
  return changed ? next : previous;
}

/**
 * 写进 json-render 的 `live`：只挑真有值的读数（失败但曾经取到过的保留旧值）。
 * 传了 `sources` 时只留现在还在的源，机器人删掉的数据源不会留在 state 里。
 */
export function liveStateValues(
  readings: LiveSourceReadings,
  sources?: readonly LiveSource[],
): Record<string, unknown> {
  const allowed = sources ? new Set(sources.map((source) => source.id)) : null;
  const out: Record<string, unknown> = {};
  for (const [id, reading] of Object.entries(readings)) {
    if (allowed && !allowed.has(id)) continue;
    if (reading.value === undefined) continue;
    out[id] = reading.value;
  }
  return out;
}

/** 最近一次成功取数的时刻（ISO）；一次都没成功是 null。 */
export function latestLiveAt(readings: LiveSourceReadings): string | null {
  let best = 0;
  let iso: string | null = null;
  for (const reading of Object.values(readings)) {
    if (!reading.ok) continue;
    const time = new Date(reading.at).getTime();
    if (Number.isFinite(time) && time >= best) {
      best = time;
      iso = reading.at;
    }
  }
  return iso;
}

/** 失败的那几条（「可能已过期」与「数据来源…」里的红字都用它）。 */
export function liveFailures(readings: LiveSourceReadings): { id: string; error: string }[] {
  return Object.entries(readings)
    .filter(([, reading]) => !reading.ok)
    .map(([id, reading]) => ({ id, error: reading.error ?? "取数失败。" }));
}

/** 卡片底部「名字 · 每 5 秒」里的那半句。 */
export function everyText(intervalSec: number): string {
  const seconds = Number.isFinite(intervalSec) && intervalSec > 0 ? Math.round(intervalSec) : 60;
  if (seconds < 60) return `每 ${seconds} 秒`;
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "每小时" : `每 ${hours} 小时`;
  }
  if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
}

/** 来源种类的人话：网址 / 本机命令。 */
export function liveKindText(kind: LiveSource["kind"]): string {
  return kind === "command" ? "本机命令" : "网址";
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "取数失败。";
}

/** 标签页在前台（页面隐藏时停轮询）。 */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return visible;
}

const NO_SOURCES: LiveSource[] = [];

export type LiveValues = {
  /** 每个源最近一次的读数（失败的保留上一个好值，`ok` 是 false）。 */
  readings: LiveSourceReadings;
  /** 写进 json-render 的 `live`：只有值。 */
  values: Record<string, unknown>;
  /** 最近一次成功取数的时刻。 */
  at: string | null;
  /** 整次请求失败（断网、接口 5xx）的原因；单个源的失败在 `readings` 里。 */
  error: string | null;
  /** 「立即取数」：POST /live/refresh，强制宿主重取这 3 个源。 */
  refresh: () => void;
  refreshing: boolean;
};

/**
 * 卡片可见、没折叠时轮询直连数据源。
 *
 * `active` 由卡片传：折叠了就是 false（折叠的卡片不渲染内容，也不该再取数）。
 * 可见性同时看 `useKeptVisible`（右栏被藏着）与标签页的 `visibilityState`；两者任一不满足就停。
 * 没折叠但面板切换（id 变了）时先清空上一张卡的读数。
 */
export function useLiveValues(
  panel: { id: string; dataSources?: readonly LiveSource[] } | null | undefined,
  active = true,
): LiveValues {
  const keptVisible = useKeptVisible();
  const pageVisible = usePageVisible();
  const sources = panel?.dataSources ?? NO_SOURCES;
  const panelId = panel?.id ?? "";
  const [readings, setReadings] = useState<LiveSourceReadings>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 换了一张面板：上一张的读数不能跟着漂过去。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 面板 id 变了要清空，effect 里读到的就是它。
  useEffect(() => {
    setReadings({});
    setError(null);
  }, [panelId]);

  const delay = livePollMs(sources);
  const enabled = shouldPollLive({ visible: keptVisible && pageVisible, active, panelId, sources });

  useEffect(() => {
    if (!enabled || delay === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const next = await client<LiveSourceReadings>(
          `/api/live-panels/${encodeURIComponent(panelId)}/live`,
          "sources",
          { fallback: "取数失败。", signal: controller.signal },
        );
        if (stopped) return;
        setReadings((previous) => mergeLiveReadings(previous, next));
        setError(null);
      } catch (problem) {
        if (stopped || controller.signal.aborted) return;
        // 整次失败：上一个好值原样留着（不写空值），只在「数据来源…」里说明。
        setError(errorText(problem));
      } finally {
        if (!stopped) timer = setTimeout(() => void tick(), delay);
      }
    };

    void tick();
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, delay, panelId]);

  const refresh = useCallback(() => {
    if (!panelId || refreshing) return;
    setRefreshing(true);
    const controller = new AbortController();
    void (async () => {
      try {
        const next = await client<LiveSourceReadings>(
          `/api/live-panels/${encodeURIComponent(panelId)}/live/refresh`,
          "sources",
          { method: "POST", fallback: "取数失败。", signal: controller.signal },
        );
        if (!mounted.current) return;
        setReadings((previous) => mergeLiveReadings(previous, next));
        setError(null);
      } catch (problem) {
        if (!mounted.current) return;
        setError(errorText(problem));
      } finally {
        if (mounted.current) setRefreshing(false);
      }
    })();
  }, [panelId, refreshing]);

  const values = useMemo(() => liveStateValues(readings, sources), [readings, sources]);

  return {
    readings,
    values,
    at: latestLiveAt(readings),
    error,
    refresh,
    refreshing,
  };
}
