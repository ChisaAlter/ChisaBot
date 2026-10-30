import { IconChevronDown, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { Children, type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { normaliseTone } from "../../../../../shared/json-render/catalog";
import { cn } from "@/lib/utils";
import { iconFor } from "./icons";
import { ActionArea, type ItemAction, LiveText, useNow } from "./rich-context";
import { emptyMarkProps, InitialMark } from "./initial-mark";
import { countdownParts, hueOf, itemTime, relativeTick, relativeTime, safeHttps, trendOfText } from "./rich-utils";

/**
 * 富组件（DESIGN.md §32）：媒体与身份、结构、实时。图表在 charts.tsx，可点 / 实时的底层在 rich-context.tsx。
 * 只画纯文本；图片只认 https、链接只认 http(s)，都在新标签页打开。
 */

const toneClass = (tone: unknown) => `jr-tone-${normaliseTone(tone)}`;

/** 图标：认不出的名字不画。 */
export function RichIcon({ name, className }: { name: unknown; className?: string }) {
  const Icon = iconFor(name);
  return Icon ? <Icon aria-hidden className={className} /> : null;
}

/** 图片：加载失败就整块收起（不留破图）。 */
export function SafeImg({ src, alt, className, onFail }: { src: unknown; alt: string; className?: string; onFail?: () => void }) {
  const url = safeHttps(src);
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new address gets a fresh try.
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) return null;
  return (
    <img
      alt={alt}
      className={className}
      decoding="async"
      loading="lazy"
      onError={() => {
        setFailed(true);
        onFail?.();
      }}
      referrerPolicy="no-referrer"
      src={url}
    />
  );
}

export function Hero(props: {
  title: string;
  subtitle?: string | null;
  eyebrow?: string | null;
  image?: string | null;
  icon?: string | null;
  tone?: unknown;
  value?: string | number | null;
} & ItemAction) {
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = Boolean(safeHttps(props.image)) && !imageFailed;
  return (
    <ActionArea className={cn("jr-hero jr-el", toneClass(props.tone ?? "accent"), hasImage ? "has-image" : "is-gradient")} item={props} label={props.title}>
      {hasImage ? <SafeImg alt="" className="jr-hero-img" onFail={() => setImageFailed(true)} src={props.image} /> : null}
      <div aria-hidden className="jr-hero-shade" />
      <div className="jr-hero-body">
        {props.eyebrow || props.icon ? (
          <div className="jr-hero-eyebrow">
            <RichIcon className="size-3.5" name={props.icon} />
            {props.eyebrow ? <span>{props.eyebrow}</span> : null}
          </div>
        ) : null}
        <div className="jr-hero-row">
          <div className="min-w-0 flex-1">
            <div className="jr-hero-title">{props.title}</div>
            {props.subtitle ? <div className="jr-hero-sub">{props.subtitle}</div> : null}
          </div>
          {props.value !== null && props.value !== undefined && props.value !== "" ? (
            <LiveText className="jr-hero-value" value={String(props.value)} />
          ) : null}
        </div>
      </div>
    </ActionArea>
  );
}

export function AvatarFace({ name, src, size = "md", shape = "circle", status }: { name: string; src?: string | null; size?: string; shape?: string; status?: unknown }) {
  const [failed, setFailed] = useState(false);
  const url = safeHttps(src);
  return (
    <span
      className={cn("jr-avatar-face", `is-${size}`, shape === "square" && "is-square")}
      {...(url && !failed ? {} : emptyMarkProps(name))}
      style={{ "--jr-hue": String(hueOf(name)) } as CSSProperties}
    >
      {url && !failed ? (
        <img alt="" decoding="async" loading="lazy" onError={() => setFailed(true)} referrerPolicy="no-referrer" src={url} />
      ) : (
        <span aria-hidden><InitialMark kind="person" name={name} /></span>
      )}
      {status ? <i className={cn("jr-avatar-status", toneClass(status))} /> : null}
    </span>
  );
}

export function Avatar(props: { name: string; src?: string | null; subtitle?: string | null; size?: "sm" | "md" | "lg" | null; shape?: "circle" | "square" | null; status?: unknown } & ItemAction) {
  return (
    <ActionArea affordance="inline" className="jr-avatar jr-el" item={props} label={props.name}>
      <AvatarFace name={props.name} shape={props.shape ?? "circle"} size={props.size ?? "md"} src={props.src} status={props.status} />
      <span className="jr-avatar-t">
        <span className="jr-avatar-n">{props.name}</span>
        {props.subtitle ? <span className="jr-avatar-s">{props.subtitle}</span> : null}
      </span>
    </ActionArea>
  );
}

export function IconTile({ name, tone, size, label }: { name: string; tone?: unknown; size?: "sm" | "md" | "lg" | null; label?: string | null }) {
  return (
    <span className={cn("jr-icon jr-el", toneClass(tone ?? "accent"), `is-${size ?? "md"}`)}>
      <span className="jr-icon-chip">
        <RichIcon className="jr-icon-svg" name={name} />
      </span>
      {label ? <span className="jr-icon-label">{label}</span> : null}
    </span>
  );
}

export function StatusDot({ tone, pulse }: { tone?: unknown; pulse?: boolean | null }) {
  return <i aria-hidden className={cn("jr-dot", toneClass(tone), pulse && "is-pulse")} />;
}

export function Status(props: { label: string; tone?: unknown; detail?: string | null; pulse?: boolean | null } & ItemAction) {
  const tone = normaliseTone(props.tone);
  const word = { success: "正常", warn: "注意", danger: "异常", default: "", accent: "", info: "" }[tone];
  return (
    <ActionArea affordance="inline" className="jr-status jr-el" item={props} label={props.label}>
      <StatusDot pulse={props.pulse} tone={tone} />
      <span className="jr-status-t">{props.label}</span>
      {word ? <span className="sr-only">{word}</span> : null}
      {props.detail ? <LiveText className="jr-status-d" value={props.detail} /> : null}
    </ActionArea>
  );
}

export function DeltaChip({ value, trend, invert, label }: { value: string | number; trend?: "up" | "down" | "flat" | null; invert?: boolean | null; label?: string | null }) {
  const direction = trend ?? trendOfText(value);
  const good = direction === "flat" ? "default" : (direction === "up") !== Boolean(invert) ? "success" : "danger";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "■";
  const text = String(value).replace(/^[▲▼↑↓]\s*/, "");
  return (
    <span className={cn("jr-delta jr-el", toneClass(good))}>
      <span aria-hidden className="jr-delta-a">{arrow}</span>
      <LiveText value={text} />
      {label ? <span className="jr-delta-k">{label}</span> : null}
      <span className="sr-only">{direction === "up" ? "上涨" : direction === "down" ? "下跌" : "持平"}</span>
    </span>
  );
}

export function Tabs({ tabs, variant, children }: { tabs: string[]; variant?: "tabs" | "segmented" | null; children?: ReactNode }) {
  const panes = Children.toArray(children);
  const labels = (Array.isArray(tabs) ? tabs : []).slice(0, Math.max(1, panes.length));
  const [active, setActive] = useState(0);
  const id = useId();
  const current = Math.min(active, Math.max(0, panes.length - 1));
  return (
    <div className={cn("jr-tabs jr-el", variant === "tabs" ? "is-tabs" : "is-segmented")}>
      <div aria-label="切换" className="jr-tabs-bar" role="tablist" style={{ "--jr-tab-count": String(labels.length), "--jr-tab-i": String(current) } as CSSProperties}>
        {variant === "tabs" ? null : <span aria-hidden className="jr-tabs-thumb" />}
        {labels.map((label, i) => (
          <button
            aria-controls={`${id}-p${i}`}
            aria-selected={i === current}
            className={cn("jr-tab", i === current && "is-on")}
            id={`${id}-t${i}`}
            // biome-ignore lint/suspicious/noArrayIndexKey: tabs are positional.
            key={i}
            onClick={() => setActive(i)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") setActive((i + 1) % labels.length);
              if (event.key === "ArrowLeft") setActive((i - 1 + labels.length) % labels.length);
            }}
            role="tab"
            tabIndex={i === current ? 0 : -1}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      <div aria-labelledby={`${id}-t${current}`} className="jr-tabs-pane" id={`${id}-p${current}`} key={current} role="tabpanel">
        {panes[current] ?? null}
      </div>
    </div>
  );
}

export function Carousel({ itemWidth, children }: { itemWidth?: "sm" | "md" | "lg" | null; children?: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const update = () => {
    const el = track.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure once on mount; the observer keeps it current.
  useEffect(() => {
    update();
    const el = track.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const go = (direction: number) => {
    const el = track.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: "smooth" });
  };
  return (
    <div className={cn("jr-carousel jr-el", `is-${itemWidth ?? "md"}`, edges.start && "at-start", edges.end && "at-end")}>
      <div className="jr-carousel-track" onScroll={update} ref={track}>
        {Children.map(children, (child) => (
          <div className="jr-carousel-item">{child}</div>
        ))}
      </div>
      <button aria-label="上一组" className="jr-carousel-nav is-prev" disabled={edges.start} onClick={() => go(-1)} type="button">
        <IconChevronLeft className="size-4" />
      </button>
      <button aria-label="下一组" className="jr-carousel-nav is-next" disabled={edges.end} onClick={() => go(1)} type="button">
        <IconChevronRight className="size-4" />
      </button>
    </div>
  );
}

/** 时间文字：ISO 时间显示成相对时间（会自己走），其他原样。 */
export function TimeText({ value, className }: { value: string; className?: string }) {
  const isIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.trim());
  if (!isIso) return <span className={className}>{value}</span>;
  return <RelativeTimeText className={className} item time={value} />;
}

function RelativeTimeText({ time, prefix, className, item }: { time: string; prefix?: string | null; className?: string; item?: boolean }) {
  const tick = relativeTick(time) >= 600_000 ? 600 : relativeTick(time) >= 60_000 ? 60 : 15;
  const now = useNow(tick);
  const at = Date.parse(time);
  return (
    <time className={className} dateTime={time} title={Number.isFinite(at) ? new Date(at).toLocaleString("zh-CN") : undefined}>
      {prefix ? `${prefix} ` : ""}
      {item ? itemTime(time, now) : relativeTime(time, now)}
    </time>
  );
}

export function RelativeTime({ time, prefix }: { time: string; prefix?: string | null }) {
  return <RelativeTimeText className="jr-reltime jr-el" prefix={prefix} time={time} />;
}

export function Timeline({ items }: { items: ({ title: string; time?: string | null; description?: string | null; tone?: unknown; icon?: string | null } & ItemAction)[] }) {
  return (
    <ol className="jr-timeline jr-el">
      {(Array.isArray(items) ? items : []).map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items carry no identity of their own.
        <li className={cn("jr-tl-item", toneClass(item.tone))} key={i} style={{ "--jr-i": String(i) } as CSSProperties}>
          <span aria-hidden className={cn("jr-tl-node", item.icon && iconFor(item.icon) && "has-icon")}>
            <RichIcon className="size-3" name={item.icon} />
          </span>
          <ActionArea affordance="inline" className="jr-tl-body" item={item} label={item.title}>
            <div className="jr-tl-head">
              <span className="jr-tl-title">{item.title}</span>
              {item.time ? <TimeText className="jr-tl-time" value={item.time} /> : null}
            </div>
            {item.description ? <div className="jr-tl-desc">{item.description}</div> : null}
          </ActionArea>
        </li>
      ))}
    </ol>
  );
}

export function KeyValue({ items, columns }: { items: ({ label: string; value: string | number; tone?: unknown; icon?: string | null; mono?: boolean | null } & ItemAction)[]; columns?: number | null }) {
  return (
    <div className={cn("jr-kv jr-el", columns === 2 && "is-2")}>
      {(Array.isArray(items) ? items : []).map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items carry no identity of their own.
        <ActionArea affordance="inline" className="jr-kv-row" item={item} key={i} label={item.label}>
          <span className="jr-kv-k">
            <RichIcon className="size-3.5 shrink-0" name={item.icon} />
            <span>{item.label}</span>
          </span>
          <span className={cn("jr-kv-v", normaliseTone(item.tone) !== "default" && `jr-ink ${toneClass(item.tone)}`, item.mono && "is-mono")}>
            <LiveText value={String(item.value)} />
          </span>
        </ActionArea>
      ))}
    </div>
  );
}

export function Accordion({ title, summary, open, icon, children }: { title: string; summary?: string | null; open?: boolean | null; icon?: string | null; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(Boolean(open));
  const id = useId();
  return (
    <div className={cn("jr-acc jr-el", expanded && "is-open")}>
      <button aria-controls={id} aria-expanded={expanded} className="jr-acc-head" onClick={() => setExpanded((v) => !v)} type="button">
        <RichIcon className="size-4 shrink-0 text-[var(--ink-3)]" name={icon} />
        <span className="jr-acc-title">{title}</span>
        {summary ? <span className="jr-acc-sum">{summary}</span> : null}
        <IconChevronDown aria-hidden className="jr-acc-chev size-4" />
      </button>
      <div className="jr-acc-body" id={id} inert={!expanded || undefined}>
        <div className="jr-acc-inner">{children}</div>
      </div>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

export function Countdown({ target, label, doneText, showSeconds, caption }: { target: string; label?: string | null; doneText?: string | null; showSeconds?: boolean | null; caption?: string | null }) {
  const now = useNow(1);
  const parts = countdownParts(target, now);
  if (!parts) return <div className="jr-countdown jr-el is-bad">{"时间格式无法识别"}</div>;
  const seconds = showSeconds ?? parts.days === 0;
  const units: [number, string][] = [
    ...(parts.days > 0 ? ([[parts.days, "天"]] as [number, string][]) : []),
    [parts.hours, "时"],
    [parts.minutes, "分"],
    ...(seconds ? ([[parts.seconds, "秒"]] as [number, string][]) : []),
  ];
  const at = Date.parse(target);
  return (
    <div className={cn("jr-countdown jr-el", parts.done && "is-done")} role="timer" aria-live="off">
      {label ? <div className="jr-countdown-k">{label}</div> : null}
      {parts.done ? (
        <div className="jr-countdown-done">{doneText ?? "已到时间"}</div>
      ) : (
        <div className="jr-countdown-v">
          {units.map(([n, unit], i) => (
            <span className="jr-countdown-u" key={unit}>
              <b className={cn(i > 0 && "is-pad")}>{i === 0 ? String(n) : pad(n)}</b>
              <small>{unit}</small>
            </span>
          ))}
        </div>
      )}
      <div className="jr-countdown-cap">
        {caption ?? (Number.isFinite(at) ? new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "")}
      </div>
    </div>
  );
}

export function Clock({ timezone, label, showSeconds, showDate }: { timezone?: string | null; label?: string | null; showSeconds?: boolean | null; showDate?: boolean | null }) {
  const now = useNow(showSeconds ? 1 : 15);
  let time = "";
  let date = "";
  try {
    const zone = timezone || undefined;
    time = new Date(now).toLocaleTimeString("zh-CN", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: showSeconds ? "2-digit" : undefined, hour12: false });
    date = new Date(now).toLocaleDateString("zh-CN", { timeZone: zone, month: "numeric", day: "numeric", weekday: "short" });
  } catch {
    time = "时区无效";
  }
  return (
    <div className="jr-clock jr-el">
      {label ? <div className="jr-clock-k">{label}</div> : null}
      <div className="jr-clock-v">{time}</div>
      {showDate !== false && date ? <div className="jr-clock-d">{date}</div> : null}
    </div>
  );
}
