// biome-ignore-all lint/style/noNonNullAssertion: indexes are bounded by the loop / length checks right above each access.
import { type CSSProperties, type PointerEvent, useId, useMemo, useRef, useState } from "react";
import { normaliseTone, type Tone } from "../../../../../shared/json-render/catalog";
import { cn } from "@/lib/utils";
import { LiveText } from "./rich-context";
import {
  gaugeTone,
  heatLevel,
  layoutSeries,
  monotonePath,
  ringSegments,
  sampleLabels,
  seriesTrend,
  shortNumber,
  toNumber,
  toSeries,
} from "./rich-utils";

/**
 * 轻量图表（DESIGN.md §32）：手写 SVG，不引图表库。宽度跟着容器走（viewBox + preserveAspectRatio="none"，
 * 线宽 non-scaling-stroke 不会被拉粗），圆点 / 悬停提示 / 坐标字是 HTML 叠在上面，所以不会被拉变形。
 * 颜色全部来自语义色令牌（.jr-tone-*），亮暗自动；挂载时从左往右展开，减少动态效果时直接出现。
 */

const VIEW_W = 300;
const SERIES_TONES: Tone[] = ["accent", "info", "warn"];

const toneClass = (tone: Tone) => `jr-tone-${tone}`;

/** 一条线 + 渐变面积（area=false 时只有线）。 */
function SeriesPaths({
  segments,
  height,
  gradientId,
  area,
}: {
  segments: { x: number; y: number }[][];
  height: number;
  gradientId: string;
  area: boolean;
}) {
  return (
    <>
      {segments.map((points, index) => {
        const line = monotonePath(points);
        if (!line) return null;
        const first = points[0]!;
        const last = points[points.length - 1]!;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity beyond their order.
          <g key={index}>
            {area && points.length > 1 ? (
              <path className="jr-c-area" d={`${line}L${last.x.toFixed(2)},${height}L${first.x.toFixed(2)},${height}Z`} fill={`url(#${gradientId})`} />
            ) : null}
            <path className="jr-c-line" d={line} fill="none" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </>
  );
}

function Gradient({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stopColor="currentColor" stopOpacity="0.32" />
      <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
    </linearGradient>
  );
}

/** 迷你走势线：Metric 的 spark 和 Sparkline 组件共用。tone 不给时按首尾涨跌自动绿 / 红。 */
export function SparkSvg({ data, tone, height = 32, className }: { data: unknown; tone?: unknown; height?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const values = useMemo(() => toSeries(data), [data]);
  const numeric = values.filter((v) => v !== null).length;
  if (numeric < 2) return null;
  const resolved: Tone = tone ? normaliseTone(tone) : (({ up: "success", down: "danger", flat: "accent" }) as const)[seriesTrend(values)];
  const { segments, x, y } = layoutSeries([values], VIEW_W, height, 3);
  const lastIndex = values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).pop() ?? 0;
  const lastValue = values[lastIndex] ?? 0;
  return (
    <div className={cn("jr-spark", toneClass(resolved), className)} style={{ height }}>
      <svg aria-hidden className="jr-c-svg" preserveAspectRatio="none" viewBox={`0 0 ${VIEW_W} ${height}`}>
        <defs>
          <Gradient id={`g${id}`} />
        </defs>
        <SeriesPaths area gradientId={`g${id}`} height={height} segments={segments[0] ?? []} />
      </svg>
      <span
        aria-hidden
        className="jr-c-dot is-end"
        style={{ left: `${(x(lastIndex) / VIEW_W) * 100}%`, top: `${(y(lastValue) / height) * 100}%` }}
      />
    </div>
  );
}

export function Sparkline({ data, tone, label, value, height }: { data: unknown; tone?: unknown; label?: string | null; value?: string | number | null; height?: number | null }) {
  return (
    <div className="jr-sparkline jr-el">
      {label ? <span className="jr-sparkline-k">{label}</span> : null}
      <SparkSvg className="jr-sparkline-c" data={data} height={height ?? 32} tone={tone} />
      {value !== null && value !== undefined && value !== "" ? <LiveText className="jr-sparkline-v" value={String(value)} /> : null}
    </div>
  );
}

type ChartSeries = { name: string; data: (number | null)[]; tone: Tone };

export function Chart({
  kind,
  labels,
  data,
  series,
  unit,
  height,
  tone,
  caption,
}: {
  kind?: "line" | "area" | "bar" | null;
  labels?: string[] | null;
  data?: unknown;
  series?: { name: string; data: unknown; tone?: unknown }[] | null;
  unit?: string | null;
  height?: number | null;
  tone?: unknown;
  caption?: string | null;
}) {
  const id = useId().replace(/:/g, "");
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const H = height ?? 140;
  const all: ChartSeries[] = useMemo(() => {
    if (Array.isArray(series) && series.length) {
      return series.slice(0, 3).map((s, i) => ({
        name: String(s?.name ?? `系列 ${i + 1}`),
        data: toSeries(s?.data),
        tone: s?.tone ? normaliseTone(s.tone) : i === 0 && tone ? normaliseTone(tone) : SERIES_TONES[i]!,
      }));
    }
    return [{ name: "", data: toSeries(data), tone: tone ? normaliseTone(tone) : "accent" }];
  }, [series, data, tone]);
  const count = Math.max(...all.map((s) => s.data.length), 0);
  const type = kind ?? "area";
  // 上下各留 16px 给坐标字（最高 / 最低），线和柱子不会压在字上。
  const layout = useMemo(() => layoutSeries(all.map((s) => s.data), VIEW_W, H, 16, type === "bar" ? 0 : null), [all, H, type]);
  if (count < (type === "bar" ? 1 : 2)) return null;
  const xLabels = Array.isArray(labels) ? labels : [];
  const pct = (i: number) => (count === 1 ? 50 : type === "bar" ? ((i + 0.5) / count) * 100 : (i / (count - 1)) * 100);
  const fmt = (v: number | null) => (v === null ? "—" : `${unit && /^[$¥€£₿]$/.test(unit) ? unit : ""}${shortNumber(v)}${unit && !/^[$¥€£₿]$/.test(unit) ? unit : ""}`);

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fx = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover(type === "bar" ? Math.min(count - 1, Math.floor(fx * count)) : Math.round(fx * (count - 1)));
  };

  // 窄卡里最多 3 个横轴刻度（首、中、尾），长标签（10/13 11:00）也不会挤在一起。
  const tickIndexes = sampleLabels(xLabels.length ? Math.min(xLabels.length, count) : 0, 3);
  const hoverLeft = hover === null ? 0 : pct(hover);

  return (
    <figure className="jr-chart jr-el" aria-label={caption ?? "图表"}>
      {all.length > 1 ? (
        <div className="jr-chart-legend">
          {all.map((s) => (
            <span className={cn("jr-chart-key", toneClass(s.tone))} key={s.name}>
              <i />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
      <div
        className="jr-chart-plot"
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
        onPointerMove={pick}
        ref={plotRef}
        style={{ height: H }}
      >
        <span className="jr-chart-y is-top">{fmt(layout.max)}</span>
        <span className="jr-chart-y is-bottom">{fmt(type === "bar" ? 0 : layout.min)}</span>
        {type === "bar" ? (
          <div className="jr-bars" style={{ "--jr-series": String(all.length) } as CSSProperties}>
            {Array.from({ length: count }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one column per data index.
              <div className={cn("jr-bar-col", hover === i && "is-hover")} key={i}>
                {all.map((s) => {
                  const v = s.data[i] ?? null;
                  const h = v === null ? 0 : Math.max(2, ((Math.max(0, v) - 0) / (layout.max || 1)) * 100);
                  return <span className={cn("jr-bar", toneClass(s.tone))} key={s.name} style={{ height: `${h}%` }} />;
                })}
              </div>
            ))}
          </div>
        ) : (
          <svg aria-hidden className="jr-c-svg jr-chart-svg" preserveAspectRatio="none" viewBox={`0 0 ${VIEW_W} ${H}`}>
            <defs>
              {all.map((s, i) => (
                <g className={toneClass(s.tone)} key={s.name}>
                  <Gradient id={`g${id}${i}`} />
                </g>
              ))}
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line className="jr-c-grid" key={f} vectorEffect="non-scaling-stroke" x1="0" x2={VIEW_W} y1={H * f} y2={H * f} />
            ))}
            {all.map((s, i) => (
              <g className={cn("jr-c-series", toneClass(s.tone))} key={s.name}>
                <SeriesPaths area={type === "area" && all.length === 1} gradientId={`g${id}${i}`} height={H} segments={layout.segments[i] ?? []} />
              </g>
            ))}
          </svg>
        )}
        {hover !== null ? (
          <>
            {type === "bar" ? null : <span aria-hidden className="jr-chart-cursor" style={{ left: `${hoverLeft}%` }} />}
            {type === "bar"
              ? null
              : all.map((s) => {
                  const v = s.data[hover];
                  if (v === null || v === undefined) return null;
                  return (
                    <span
                      aria-hidden
                      className={cn("jr-c-dot is-hover", toneClass(s.tone))}
                      key={s.name}
                      style={{ left: `${hoverLeft}%`, top: `${(layout.y(v) / H) * 100}%` }}
                    />
                  );
                })}
            <div
              className={cn("jr-chart-tip", hoverLeft > 60 && "is-left")}
              role="status"
              style={{ left: `${hoverLeft}%` }}
            >
              {xLabels[hover] ? <div className="jr-chart-tip-k">{xLabels[hover]}</div> : null}
              {all.map((s) => (
                <div className={cn("jr-chart-tip-v", toneClass(s.tone))} key={s.name}>
                  {all.length > 1 ? <i /> : null}
                  {all.length > 1 ? <span>{s.name}</span> : null}
                  <b>{fmt(s.data[hover] ?? null)}</b>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {tickIndexes.length ? (
        <div className="jr-chart-x" aria-hidden>
          {tickIndexes.map((i, n) => (
            <span
              className={cn(n === 0 && "is-first", n === tickIndexes.length - 1 && "is-last")}
              key={i}
              style={{ left: `${pct(i)}%` }}
            >
              {xLabels[i]}
            </span>
          ))}
        </div>
      ) : null}
      {caption ? <figcaption className="jr-chart-cap">{caption}</figcaption> : null}
    </figure>
  );
}

export function Ring({
  value,
  segments,
  label,
  center,
  caption,
  tone,
  size,
}: {
  value?: number | null;
  segments?: { label: string; value: number; tone?: unknown }[] | null;
  label?: string | null;
  center?: string | null;
  caption?: string | null;
  tone?: unknown;
  size?: "sm" | "md" | "lg" | null;
}) {
  const parts = Array.isArray(segments) && segments.length && (value === null || value === undefined) ? segments.slice(0, 6) : null;
  const single = parts ? null : Math.max(0, Math.min(100, Number(value) || 0));
  const singleTone = tone ? normaliseTone(tone) : "accent";
  const arcs = parts ? ringSegments(parts.map((p) => Number(p.value) || 0)) : [];
  const partTone = (i: number): Tone => (parts?.[i]?.tone ? normaliseTone(parts[i]!.tone) : (["accent", "info", "success", "warn", "danger", "default"] as Tone[])[i % 6]!);
  const total = parts?.reduce((a, p) => a + Math.max(0, Number(p.value) || 0), 0) ?? 0;
  const centerText = center ?? (single !== null ? `${Math.round(single)}%` : "");
  return (
    <div className={cn("jr-ring jr-el", `is-${size ?? "md"}`)}>
      <div className="jr-ring-fig">
        <svg aria-hidden className="jr-ring-svg" viewBox="0 0 36 36">
          <circle className="jr-ring-track" cx="18" cy="18" r="15.9155" />
          {single !== null ? (
            <circle
              className={cn("jr-ring-arc", toneClass(singleTone))}
              cx="18"
              cy="18"
              r="15.9155"
              strokeDasharray={`${single} ${100 - single}`}
            />
          ) : (
            arcs.map((arc) => {
              const length = Math.max(0, (arc.end - arc.start) * 100 - (arcs.length > 1 ? 1.2 : 0));
              return (
                <circle
                  className={cn("jr-ring-arc", toneClass(partTone(arc.index)))}
                  cx="18"
                  cy="18"
                  key={arc.index}
                  r="15.9155"
                  strokeDasharray={`${length} ${100 - length}`}
                  strokeDashoffset={-arc.start * 100}
                />
              );
            })
          )}
        </svg>
        {centerText ? (
          <div className="jr-ring-center">
            <LiveText className="jr-ring-v" value={centerText} />
            {label && size !== "sm" ? <span className="jr-ring-k">{label}</span> : null}
          </div>
        ) : null}
      </div>
      {parts || caption || (label && size === "sm") ? (
        <div className="jr-ring-side">
          {label && (size === "sm" || !centerText) ? <div className="jr-ring-title">{label}</div> : null}
          {parts ? (
            <ul className="jr-ring-legend">
              {parts.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: legend rows follow segment order.
                <li className={toneClass(partTone(i))} key={i}>
                  <i />
                  <span className="jr-ring-legend-k">{p.label}</span>
                  <span className="jr-ring-legend-v">{total > 0 ? `${Math.round(((Number(p.value) || 0) / total) * 100)}%` : ""}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {caption ? <div className="jr-ring-cap">{caption}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Gauge({
  value,
  min,
  max,
  label,
  unit,
  tone,
  warnAt,
  dangerAt,
}: {
  value: number;
  min?: number | null;
  max?: number | null;
  label?: string | null;
  unit?: string | null;
  tone?: unknown;
  warnAt?: number | null;
  dangerAt?: number | null;
}) {
  const lo = min ?? 0;
  const hi = max ?? 100;
  const v = toNumber(value) ?? 0;
  const share = hi === lo ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const resolved = normaliseTone(gaugeTone(v, warnAt, dangerAt, tone ? normaliseTone(tone) : "accent"));
  const display = `${Number.isInteger(v) ? v : Number(v.toFixed(1))}`;
  return (
    <div className={cn("jr-gauge jr-el", toneClass(resolved))}>
      <svg aria-hidden className="jr-gauge-svg" viewBox="0 0 120 66">
        <path className="jr-gauge-track" d="M10 60 A50 50 0 0 1 110 60" pathLength={100} />
        <path className="jr-gauge-arc" d="M10 60 A50 50 0 0 1 110 60" pathLength={100} strokeDasharray={`${share * 100} 100`} />
      </svg>
      <div className="jr-gauge-center">
        <span className="jr-gauge-v">
          <LiveText value={display} />
          {unit ? <span className="jr-metric-u">{unit}</span> : null}
        </span>
        {label ? <span className="jr-gauge-k">{label}</span> : null}
      </div>
      <div className="jr-gauge-ends" aria-hidden>
        <span>{shortNumber(lo)}</span>
        <span>{shortNumber(hi)}</span>
      </div>
    </div>
  );
}

export function HeatStrip({
  values,
  labels,
  rows,
  tone,
  label,
  caption,
}: {
  values: unknown;
  labels?: string[] | null;
  rows?: number | null;
  tone?: unknown;
  label?: string | null;
  caption?: string | null;
}) {
  const data = toSeries(values).slice(-371);
  const max = Math.max(0, ...data.filter((v): v is number => v !== null));
  const calendar = (rows ?? 1) > 1;
  const resolved = tone ? normaliseTone(tone) : "success";
  if (!data.length) return null;
  const tips = Array.isArray(labels) ? labels.slice(-data.length) : [];
  return (
    <div className={cn("jr-heat jr-el", toneClass(resolved))}>
      {label || caption ? (
        <div className="jr-heat-h">
          {label ? <span className="jr-heat-k">{label}</span> : null}
          {caption ? <span className="jr-heat-c">{caption}</span> : null}
        </div>
      ) : null}
      <div
        className={cn("jr-heat-grid", calendar ? "is-calendar" : "is-strip")}
        style={calendar ? ({ "--jr-heat-rows": String(rows) } as CSSProperties) : undefined}
      >
        {data.map((v, i) => (
          <span
            className={`jr-heat-cell is-l${heatLevel(v, max)}`}
            // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional.
            key={i}
            title={[tips[i], v === null ? "无数据" : String(v)].filter(Boolean).join(" · ")}
          />
        ))}
      </div>
    </div>
  );
}
