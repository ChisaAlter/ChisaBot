import { defineRegistry, useBoundProp } from "@json-render/react";
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconCheck,
  IconCircleCheck,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import { Component, type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { jsonRenderCatalog, normaliseTone } from "../../../../../shared/json-render/catalog";
import { Chart, Gauge, HeatStrip, Ring, SparkSvg, Sparkline } from "./charts";
import {
  Accordion,
  Avatar,
  Carousel,
  Clock,
  Countdown,
  DeltaChip,
  Hero,
  IconTile,
  KeyValue,
  RelativeTime,
  RichIcon,
  SafeImg,
  Status,
  StatusDot,
  Tabs,
  TimeText,
  Timeline,
} from "./rich";
import { ActionArea, choiceState, useChoiceScope, useLiveValue, useRichActions } from "./rich-context";
import { Products } from "./products";
import { safeHttp, safeHttps, splitDotted, trendOfText } from "./rich-utils";
import { LinkCard } from "@/components/rich-previews/link-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * json-render 组件实现（Skyglass，DESIGN.md §9–§11）。目录（属性、说明）在 shared/json-render/catalog.ts，
 * 这里只负责长相：所有样式都是 styles.css 里的 `.jr-*` 类，亮色 / 暗色都由令牌决定。
 *
 * 只渲染纯文本：没有 dangerouslySetInnerHTML，图片只接受 https，链接由 open_link 动作在新标签页打开。
 */

const text = (value: unknown) =>
  value === null || value === undefined ? "" : String(value);

/** 一行带「·」的说明：每项不拆开，只在「·」处换行（DESIGN.md §77.3）。 */
function DottedText({ text: value }: { text: string }) {
  const parts = splitDotted(value);
  if (!parts) return <>{value}</>;
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string.
        <span key={index}>
          {index > 0 ? " · " : ""}
          <span className="jr-text-seg">{part}</span>
        </span>
      ))}
    </>
  );
}

const BUTTON_VARIANT = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  danger: "destructive",
} as const;

const ALERT_ICON = {
  info: IconInfoCircle,
  success: IconCircleCheck,
  warn: IconAlertTriangle,
  danger: IconX,
} as const;

/** 语义色类名：.jr-tone-*（styles.css 里定义 --tone / --tone-soft）。default 不加。 */
const toneOf = (tone: unknown) => {
  const t = normaliseTone(tone);
  return t === "default" ? undefined : `jr-tone-${t}`;
};

/**
 * 大数字拆成「数字 + 单位」：单位小一号、淡一点（26.9℃ → 26.9 + ℃，2.9 km/h → 2.9 + km/h）。
 * 只在数字打头、后面跟着不含数字的短单位时拆；「10月13日」「$82,407」之类原样。
 */
export function splitMetricValue(value: string): { num: string; unit: string } {
  const m = value.trim().match(/^([+\-−]?[$¥€£₿]?\s?\d[\d,]*(?:\.\d+)?)\s*([^\d\s][^\d]{0,9})?$/u);
  if (!m || !m[2]) return { num: value.trim(), unit: "" };
  return { num: m[1], unit: m[2].trim() };
}

/**
 * 数字永远一行：放不下就把字号往小调（最小 13px），绝不把「26.9℃」折成两行（DESIGN.md §29）。
 * 每次尺寸变化先回到样式表里的字号再量，所以卡片变宽时字会长回去。
 */
function FitLine({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = "";
      let size = Number.parseFloat(getComputedStyle(el).fontSize) || 24;
      while (el.scrollWidth > el.clientWidth + 0.5 && size > 13) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);
  return (
    <div className={className} ref={ref}>
      {children}
    </div>
  );
}

/** 窄表格的简表：日期写短（10月13日 / 2026-10-13 → 10/13）；数值列里 ℃ 写成 °，省出宽度。 */
export function shortDate(value: string): string {
  return value
    .replace(/^\d{4}[-/年.](\d{1,2})[-/月.](\d{1,2})日?/u, (_, m, d) => `${Number(m)}/${Number(d)}`)
    .replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/gu, (_, m, d) => `${Number(m)}/${Number(d)}`)
    .replace(/\s+/g, " ")
    .trim();
}

/** 简表数值：℃ / °C 写成 °，「29.0 / 22.9」去掉斜杠两边的空格。 */
export function compactValue(value: string): string {
  return shortDate(value)
    .replace(/\s*(?:℃|°\s*C\b)/gu, "°")
    .replace(/(\d)\s*\/\s*(?=[\d+\-−])/gu, "$1/");
}

const looksNumeric = (value: string) => /^[\s+\-−$¥€£₿]*\d/u.test(value) && !/[月日年]/u.test(value);

/**
 * 表格在窄容器（< 440px，容器查询）里换成简表：第一列（第二列是文字时连同第二列）叠成左边一格，
 * 其余列靠右、各占一列、不折行。宽容器照常是表格。两份 DOM 都在，样式表按容器宽度只显示一份。
 */
function CompactRows({
  columns,
  rows,
}: {
  columns: { key: string; label: string; align?: string | null }[];
  rows: Record<string, unknown>[];
}) {
  if (!columns.length) return null;
  const [first, second, ...others] = columns;
  const secondIsText =
    Boolean(second) &&
    columns.length >= 3 &&
    rows.some((row) => text(row?.[second.key]).trim() !== "") &&
    rows.every((row) => !looksNumeric(text(row?.[second.key])));
  const after = secondIsText ? others : [second, ...others].filter(Boolean);
  // 靠右最多 3 列；再多的列折进左边第二行（「最大风速 17.7 km/h」），不让整张表横向滚动。
  const rest = after.slice(0, 3);
  const extra = after.slice(3);
  return (
    // biome-ignore lint/a11y/useSemanticElements: 模型生成的表格用 div 渲染，用 ARIA 表格角色保住语义
    <div className="jr-rows" role="table" style={{ "--jr-rest": String(rest.length) } as CSSProperties}>
      {/* biome-ignore lint/a11y/useFocusableInteractive: 表格行 / 列头角色只表达语义，不是交互控件 */}
      {/* biome-ignore lint/a11y/useSemanticElements: 模型生成的表格用 div 渲染，用 ARIA 表格角色保住语义 */}
      <div className="jr-rows-h" role="row">
        {/* biome-ignore lint/a11y/useFocusableInteractive: 表格行 / 列头角色只表达语义，不是交互控件 */}
        {/* biome-ignore lint/a11y/useSemanticElements: 模型生成的表格用 div 渲染，用 ARIA 表格角色保住语义 */}
        <span role="columnheader">{secondIsText ? `${first.label} · ${second.label}` : first.label}</span>
        {rest.map((column) => (
          // biome-ignore lint/a11y/useFocusableInteractive: 表格行 / 列头角色只表达语义，不是交互控件
          // biome-ignore lint/a11y/useSemanticElements: 模型生成的表格用 div 渲染，用 ARIA 表格角色保住语义
          <span key={column.key} role="columnheader">
            {column.label}
          </span>
        ))}
      </div>
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows carry no identity of their own.
        // biome-ignore lint/a11y/useSemanticElements: 模型生成的表格用 div 渲染，用 ARIA 表格角色保住语义
        // biome-ignore lint/a11y/useFocusableInteractive: 表格行 / 列头角色只表达语义，不是交互控件
        <div className="jr-rows-r" key={index} role="row">
          {/* biome-ignore lint/a11y/useSemanticElements: 模型生成的表格用 div 渲染，用 ARIA 表格角色保住语义 */}
          <span className="jr-rows-p" role="cell">
            <span className="jr-rows-t">{shortDate(text(row?.[first.key]))}</span>
            {(() => {
              const sub = [
                secondIsText ? text(row?.[second.key]) : "",
                ...extra.map((column) => (text(row?.[column.key]) ? `${column.label} ${compactValue(text(row?.[column.key]))}` : "")),
              ].filter(Boolean);
              return sub.length ? <span className="jr-rows-s">{sub.join(" · ")}</span> : null;
            })()}
          </span>
          {rest.map((column) => (
            // biome-ignore lint/a11y/useSemanticElements: 模型生成的表格用 div 渲染，用 ARIA 表格角色保住语义
            <span className="jr-rows-v" key={column.key} role="cell" title={`${column.label} ${text(row?.[column.key])}`}>
              <span className="jr-rows-x">{compactValue(text(row?.[column.key]))}</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * 每个节点各自一个错误边界：一个组件画不出来时只跳过它自己（开发者控制台留记录），整张界面照常显示。
 * 以前任何一个节点抛错都会冒到 ToolRenderBoundary，整张卡变成红色的「render_ui 无法绘制」。
 */
class NodeBoundary extends Component<{ type: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("[json-render] 跳过画不出来的节点", this.props.type, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export const { registry: jsonRenderRegistry } = defineRegistry(jsonRenderCatalog, {
  components: {
    Card: ({ props, children }) => (
      <section className={cn("jr-card jr-el", normaliseTone(props.tone) !== "default" && `is-${normaliseTone(props.tone)} ${toneOf(props.tone)}`)}>
        {props.title || props.description ? (
          <header className={cn("jr-card-h", props.icon && "has-icon")}>
            {props.icon ? (
              <span className={cn("jr-card-ic", toneOf(props.tone ?? "accent") ?? "jr-tone-accent")}>
                <RichIcon className="size-4" name={props.icon} />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              {props.title ? <h3>{props.title}</h3> : null}
              {props.description ? <p>{props.description}</p> : null}
            </div>
          </header>
        ) : null}
        <div className="jr-card-b">{children}</div>
      </section>
    ),
    Stack: ({ props, children }) => (
      <div
        className={cn(
          "jr-stack jr-el",
          props.direction === "horizontal" ? "is-row" : "is-col",
          `gap-${props.gap ?? "md"}`,
          props.align && `align-${props.align}`,
          props.justify && `justify-${props.justify}`,
          (props.wrap ?? props.direction === "horizontal") && "is-wrap",
        )}
      >
        {children}
      </div>
    ),
    Grid: ({ props, children }) => (
      <div
        className={cn("jr-grid jr-el", `gap-${props.gap ?? "md"}`)}
        style={{ "--jr-cols": String(props.columns ?? 2) } as CSSProperties}
      >
        {children}
      </div>
    ),
    Heading: ({ props }) => {
      const level = props.level ?? 2;
      const Tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
      return (
        <Tag className={cn("jr-heading jr-el", `is-l${level}`, props.icon && "has-icon")}>
          {props.icon ? <RichIcon className="jr-heading-ic" name={props.icon} /> : null}
          {props.text}
        </Tag>
      );
    },
    Text: ({ props }) => (
      <p
        className={cn(
          "jr-text jr-el",
          props.tone && props.tone !== "default" && `is-${props.tone}`,
          props.size === "sm" && "is-sm",
          props.weight && props.weight !== "normal" && `is-${props.weight}`,
        )}
      >
        <DottedText text={text(props.text)} />
      </p>
    ),
    Metric: ({ props }) => {
      const { num, unit } = splitMetricValue(text(props.value));
      const live = useLiveValue(num);
      const tinted = props.variant === "tinted";
      const tone = normaliseTone(props.tone);
      const trend = props.trend ?? (props.delta ? trendOfText(props.delta) : undefined);
      const sparkTone = props.trend === "up" ? "success" : props.trend === "down" ? "danger" : tone !== "default" ? tone : undefined;
      return (
        <ActionArea
          className={cn("jr-metric jr-el", tinted && `is-tinted ${toneOf(tone === "default" ? "accent" : tone)}`, props.spark && "has-spark")}
          item={props}
          label={props.label}
        >
          <div className="jr-metric-k" title={props.label}>
            {props.icon ? <RichIcon className="jr-metric-ic" name={props.icon} /> : null}
            <span className="truncate">{props.label}</span>
          </div>
          <FitLine className={cn("jr-metric-v", !tinted && tone !== "default" && `is-${tone}`, live.flash && "jr-flash")}>
            {live.shown}
            {unit ? <span className="jr-metric-u">{unit}</span> : null}
          </FitLine>
          {props.delta || props.caption ? (
            <div className="jr-metric-d">
              {props.delta ? (
                <span className={cn("jr-delta-chip", trend === "up" ? "jr-tone-success" : trend === "down" ? "jr-tone-danger" : undefined)}>
                  {trend === "up" ? <span aria-hidden>{"▲"}</span> : trend === "down" ? <span aria-hidden>{"▼"}</span> : null}
                  <span className="truncate">{props.delta.replace(/^[▲▼]\s*/, "")}</span>
                </span>
              ) : null}
              {props.caption ? <span className="jr-metric-cap truncate">{props.caption}</span> : null}
            </div>
          ) : null}
          {props.spark ? <SparkSvg className="jr-metric-spark" data={props.spark} height={28} tone={sparkTone} /> : null}
        </ActionArea>
      );
    },
    Table: ({ props }) => {
      const columns = Array.isArray(props.columns) ? props.columns : [];
      const rows = (Array.isArray(props.rows) ? props.rows : []) as Record<string, unknown>[];
      return (
        <div className="jr-tbl jr-el">
          {props.caption ? <div className="jr-tbl-cap">{props.caption}</div> : null}
          <div className="jr-table-wrap">
            <table className="jr-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.key} className={column.align ? `is-${column.align}` : undefined} scope="col">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows carry no identity of their own.
                  <tr key={index}>
                    {columns.map((column) => (
                      <td key={column.key} className={column.align ? `is-${column.align}` : undefined}>
                        {text(row?.[column.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CompactRows columns={columns} rows={rows} />
        </div>
      );
    },
    List: ({ props }) => {
      const Tag = props.ordered ? "ol" : "ul";
      const items = Array.isArray(props.items) ? props.items : [];
      const media = items.some((item) => safeHttps(item?.image));
      return (
        <Tag className={cn("jr-list jr-el", props.ordered && "is-ordered", media && "has-media")}>
          {items.map((item, index) => {
            const linked = Boolean(safeHttp(item.href));
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: items carry no identity of their own.
              <li className={cn("jr-list-item", toneOf(item.tone))} key={index} style={{ "--jr-i": String(index) } as CSSProperties}>
                <ActionArea affordance="none" className="jr-list-row" item={item} label={item.title}>
                  {props.ordered ? <span className="jr-list-n">{index + 1}</span> : null}
                  {safeHttps(item.image) ? (
                    <span className="jr-list-thumb">
                      <SafeImg alt="" src={item.image} />
                    </span>
                  ) : item.icon ? (
                    <span className={cn("jr-list-ic", toneOf(item.tone ?? "accent") ?? "jr-tone-accent")}>
                      <RichIcon className="size-4" name={item.icon} />
                    </span>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="jr-list-t">
                      {item.title}
                      {item.badge ? <span className={cn("jr-list-badge", toneOf(item.tone ?? "accent") ?? "jr-tone-accent")}>{item.badge}</span> : null}
                    </div>
                    {item.description ? <div className="jr-list-s">{item.description}</div> : null}
                  </div>
                  {item.meta || item.time ? (
                    <div className="jr-list-m">
                      {item.meta ? <span>{item.meta}</span> : null}
                      {item.time ? <TimeText value={item.time} /> : null}
                    </div>
                  ) : null}
                  {linked ? <IconArrowUpRight aria-hidden className="jr-list-go" /> : null}
                </ActionArea>
              </li>
            );
          })}
        </Tag>
      );
    },
    Badge: ({ props }) => (
      <ActionArea
        affordance="inline"
        className={cn("jr-badge jr-el", normaliseTone(props.tone) !== "default" && `is-${normaliseTone(props.tone)} ${toneOf(props.tone)}`)}
        item={props}
      >
        {props.dot || props.pulse ? <StatusDot pulse={props.pulse} tone={props.tone ?? "success"} /> : null}
        {props.icon ? <RichIcon className="size-3.5" name={props.icon} /> : null}
        <span>{props.text}</span>
      </ActionArea>
    ),
    Button: ({ props, emit }) => {
      const actions = useRichActions();
      const scope = useChoiceScope();
      const [copied, setCopied] = useState(false);
      useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
      }, [copied]);
      const href = safeHttp(props.href);
      // 互斥选项（CB-090）：只在对话里、带 ask 的 choice 按钮上生效；右栏面板和普通按钮照旧。
      const asChoice = Boolean(scope && props.choice === true && props.ask && actions.ask && !href);
      const choice = asChoice && scope ? choiceState(scope.picked, props.ask) : { picked: false, locked: false };
      return (
        <Button
          aria-pressed={asChoice ? choice.picked : undefined}
          className={cn("jr-button jr-el", copied && "is-copied", asChoice && "is-choice", choice.picked && "is-picked")}
          data-choice={asChoice ? (choice.picked ? "picked" : choice.locked ? "locked" : "open") : undefined}
          disabled={(props.disabled ?? false) || choice.locked}
          onClick={async () => {
            if (asChoice && scope) {
              if (!props.ask || !scope.pick(props.ask)) return;
            } else if (href) actions.openLink(href);
            else if (props.ask && actions.ask) actions.ask(props.ask);
            else if (props.copy && (await actions.copy(props.copy))) setCopied(true);
            emit("press");
          }}
          onKeyDown={(event) => {
            if (!asChoice) return;
            const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
            const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
            if (!forward && !backward) return;
            const root = event.currentTarget.closest(".jr-surface") ?? event.currentTarget.parentElement;
            if (!root) return;
            const peers = Array.from(
              root.querySelectorAll<HTMLButtonElement>(".jr-button.is-choice:not(:disabled)"),
            );
            const idx = peers.indexOf(event.currentTarget);
            if (idx === -1 || peers.length < 2) return;
            event.preventDefault();
            const nextIdx = (idx + (forward ? 1 : -1) + peers.length) % peers.length;
            peers[nextIdx]?.focus();
          }}
          size="sm"
          title={href ?? undefined}
          type="button"
          variant={BUTTON_VARIANT[props.variant ?? "primary"]}
        >
          {copied || choice.picked ? <IconCheck aria-hidden className="size-4" /> : props.icon ? <RichIcon className="size-4" name={props.icon} /> : null}
          {copied ? "已复制" : props.label}
          {href ? <IconArrowUpRight aria-hidden className="size-3.5 opacity-70" /> : null}
        </Button>
      );
    },
    Input: ({ props, bindings }) => {
      const id = useId();
      const [value, setValue] = useBoundProp<string | number | null | undefined>(
        props.value,
        bindings?.value,
      );
      const shown = value === null || value === undefined ? "" : String(value);
      return (
        <div className="jr-field jr-el">
          <label className="jr-label" htmlFor={id}>
            {props.label}
          </label>
          {props.multiline ? (
            <Textarea
              className="jr-control"
              id={id}
              onChange={(event) => setValue(event.target.value)}
              placeholder={props.placeholder ?? undefined}
              value={shown}
            />
          ) : (
            <Input
              className="jr-control"
              id={id}
              onChange={(event) =>
                setValue(
                  props.type === "number" && event.target.value !== ""
                    ? Number(event.target.value)
                    : event.target.value,
                )
              }
              placeholder={props.placeholder ?? undefined}
              type={props.type ?? "text"}
              value={shown}
            />
          )}
          {props.helper ? <div className="jr-helper">{props.helper}</div> : null}
        </div>
      );
    },
    Select: ({ props, bindings }) => {
      const id = useId();
      const [value, setValue] = useBoundProp<string | null | undefined>(props.value, bindings?.value);
      const options = (Array.isArray(props.options) ? props.options : []).filter(Boolean).map((option) =>
        typeof option === "string" ? { label: option, value: option } : option,
      );
      return (
        <div className="jr-field jr-el">
          <label className="jr-label" htmlFor={id}>
            {props.label}
          </label>
          <select
            className="jr-select"
            id={id}
            onChange={(event) => setValue(event.target.value)}
            value={value ?? ""}
          >
            <option disabled value="">
              {props.placeholder ?? "请选择"}
            </option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    },
    Checkbox: ({ props, bindings }) => {
      const id = useId();
      const [checked, setChecked] = useBoundProp<boolean | null | undefined>(
        props.checked,
        bindings?.checked,
      );
      return (
        <div className="jr-check jr-el">
          <Checkbox checked={checked === true} id={id} onCheckedChange={(next) => setChecked(next === true)} />
          <label htmlFor={id}>
            <span className="jr-check-t">{props.label}</span>
            {props.description ? <span className="jr-check-s">{props.description}</span> : null}
          </label>
        </div>
      );
    },
    Alert: ({ props }) => {
      const raw = normaliseTone(props.tone ?? "info");
      const tone = raw === "default" || raw === "accent" ? "info" : raw;
      const Icon = ALERT_ICON[tone as keyof typeof ALERT_ICON] ?? IconInfoCircle;
      const action = props.actionLabel && (safeHttp(props.href) || props.ask || props.copy);
      return (
        <div className={cn("jr-alert jr-el", `is-${tone}`, `jr-tone-${tone}`)} role={tone === "danger" ? "alert" : "status"}>
          {props.icon ? <RichIcon className="jr-alert-ic size-[18px]" name={props.icon} /> : <Icon aria-hidden className="jr-alert-ic size-[18px]" />}
          <div className="min-w-0 flex-1">
            {props.title ? <div className="jr-alert-t">{props.title}</div> : null}
            <div className="jr-alert-m">{props.message}</div>
          </div>
          {action ? (
            <ActionArea affordance="inline" className="jr-alert-act" item={props}>
              {props.actionLabel}
            </ActionArea>
          ) : null}
        </div>
      );
    },
    Progress: ({ props }) => {
      const value = Math.max(0, Math.min(100, Number(props.value) || 0));
      return (
        <div className="jr-progress jr-el">
          {props.label ? (
            <div className="jr-progress-k">
              <span>{props.label}</span>
              <span>{props.valueText ?? `${Math.round(value)}%`}</span>
            </div>
          ) : null}
          <div
            aria-label={props.label ?? "进度"}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={value}
            className={cn("jr-progress-track", normaliseTone(props.tone) !== "default" && `is-${normaliseTone(props.tone)} ${toneOf(props.tone)}`)}
            role="progressbar"
          >
            <div className="jr-progress-bar" style={{ width: `${value}%` }} />
          </div>
        </div>
      );
    },
    Image: ({ props }) => {
      const safe = typeof props.src === "string" && /^https:\/\//i.test(props.src);
      return (
        <figure className={cn("jr-image jr-el", props.aspect && props.aspect !== "auto" && "has-aspect")}
          style={
            props.aspect && props.aspect !== "auto"
              ? ({ "--jr-aspect": props.aspect.replace(":", " / ") } as CSSProperties)
              : undefined
          }
        >
          {safe ? (
            <ActionArea className="jr-image-a" item={{ href: props.href }}>
              <img alt={props.alt} decoding="async" loading="lazy" referrerPolicy="no-referrer" src={props.src} />
            </ActionArea>
          ) : (
            <div className="jr-image-blocked">{"图片地址不安全，已隐藏"}</div>
          )}
          {props.caption ? <figcaption>{props.caption}</figcaption> : null}
        </figure>
      );
    },
    Separator: ({ props }) =>
      props.label ? (
        <div className="jr-sep-l jr-el">
          <span>{props.label}</span>
        </div>
      ) : (
        <hr className="jr-sep jr-el" />
      ),
    Sparkline: ({ props }) => <Sparkline data={props.data} height={props.height} label={props.label} tone={props.tone} value={props.value} />,
    Chart: ({ props }) => (
      <Chart
        caption={props.caption}
        data={props.data}
        height={props.height}
        kind={props.kind}
        labels={props.labels}
        series={props.series}
        tone={props.tone}
        unit={props.unit}
      />
    ),
    Ring: ({ props }) => (
      <Ring caption={props.caption} center={props.center} label={props.label} segments={props.segments} size={props.size} tone={props.tone} value={props.value} />
    ),
    Gauge: ({ props }) => (
      <Gauge dangerAt={props.dangerAt} label={props.label} max={props.max} min={props.min} tone={props.tone} unit={props.unit} value={props.value} warnAt={props.warnAt} />
    ),
    HeatStrip: ({ props }) => (
      <HeatStrip caption={props.caption} label={props.label} labels={props.labels} rows={props.rows} tone={props.tone} values={props.values} />
    ),
    Hero: ({ props }) => <Hero {...props} />,
    Avatar: ({ props }) => <Avatar {...props} />,
    // 和正文链接卡同一个组件（2026-10-29）：模型写了的字段优先，缺的图 / 标题 / 站点名用 /api/link-preview 补。
    Link: ({ props }) => (
      <LinkCard
        className="jr-el"
        description={props.description}
        image={props.image}
        meta={props.meta}
        title={props.title}
        url={props.url}
      />
    ),
    Icon: ({ props }) => <IconTile label={props.label} name={props.name} size={props.size} tone={props.tone} />,
    Status: ({ props }) => <Status {...props} />,
    Delta: ({ props }) => <DeltaChip invert={props.invert} label={props.label} trend={props.trend} value={props.value} />,
    Tabs: ({ props, children }) => (
      <Tabs tabs={props.tabs} variant={props.variant}>
        {children}
      </Tabs>
    ),
    Products: ({ props }) => <Products columns={props.columns} items={props.items} />,
    Carousel: ({ props, children }) => <Carousel itemWidth={props.itemWidth}>{children}</Carousel>,
    Timeline: ({ props }) => <Timeline items={props.items} />,
    KeyValue: ({ props }) => <KeyValue columns={props.columns} items={props.items} />,
    Accordion: ({ props, children }) => (
      <Accordion icon={props.icon} open={props.open} summary={props.summary} title={props.title}>
        {children}
      </Accordion>
    ),
    Countdown: ({ props }) => (
      <Countdown caption={props.caption} doneText={props.doneText} label={props.label} showSeconds={props.showSeconds} target={props.target} />
    ),
    Clock: ({ props }) => <Clock label={props.label} showDate={props.showDate} showSeconds={props.showSeconds} timezone={props.timezone} />,
    RelativeTime: ({ props }) => <RelativeTime prefix={props.prefix} time={props.time} />,
  },
  /*
   * 动作的真正实现在 render-ui-tool.tsx 里通过 JSONUIProvider 的 handlers 传入，因为它们要用到当前对话
   * （ConversationProvider）和这一张界面自己的状态。这里的占位只满足目录的类型要求，不会被调用。
   */
  actions: {
    send_message: async () => undefined,
    open_link: async () => undefined,
    copy_text: async () => undefined,
    refresh_panel: async () => undefined,
  },
});

/*
 * 原地给每个渲染器套上 NodeBoundary。原地改（而不是返回新对象），因为 json-render 用这个对象本身
 * 作为 WeakMap 的键记录目录元数据。
 */
for (const [type, Render] of Object.entries(jsonRenderRegistry)) {
  jsonRenderRegistry[type] = (props) => (
    <NodeBoundary type={type}>
      <Render {...props} />
    </NodeBoundary>
  );
}
