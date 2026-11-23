import { IconAlertTriangle, IconChevronRight, IconInbox } from "@tabler/icons-react";
import type * as React from "react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { SmoothCollapse } from "@/components/ui/motion-primitives";
import { cn } from "@/lib/utils";

/**
 * Skyglass building blocks (DESIGN.md §11). Thin, class-based wrappers so a page reads as structure
 * and the look stays in styles.css. `PageShell` / `PageSection` / `PageRows` cover the common case;
 * reach for these when a page needs a card with a header, a grid of tiles, or a save bar.
 */

/** L1 glass card, radius 20. `interactive` lifts on hover; `dashed` is the empty-state variant. */
export function Card({
  className,
  interactive,
  dashed,
  ...props
}: React.ComponentProps<"div"> & { interactive?: boolean; dashed?: boolean }) {
  return (
    <div
      className={cn("sg-card", interactive && "is-interactive", dashed && "is-dashed", className)}
      data-slot="sg-card"
      data-surface="control"
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("sg-card-h", className)}>
      {icon ? <span className="sg-ico">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function CardBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("sg-card-b", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("sg-card-f", className)} {...props} />;
}

/** A 64px row inside a card: 40px icon/avatar · title (14/500) + subtitle (13) · trailing actions. */
export function ListRow({
  icon,
  title,
  sub,
  actions,
  className,
  ...props
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
} & Omit<React.ComponentProps<"div">, "title">) {
  return (
    <div className={cn("sg-lrow", className)} {...props}>
      {icon ? <span className="sg-lrow-ico">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <div className="sg-lrow-t">{title}</div>
        {sub ? <div className="sg-lrow-s">{sub}</div> : null}
      </div>
      {actions ? <div className="sg-lrow-a">{actions}</div> : null}
    </div>
  );
}

/** A settings row: title + description on the left, the control on the right (wraps on a phone). */
export function SettingRow({
  title,
  description,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("sg-srow", className)}>
      <div className="min-w-0 flex-1">
        <div className="sg-srow-t">{title}</div>
        {description ? <div className="sg-srow-s">{description}</div> : null}
      </div>
      {children ? <div className="sg-srow-c">{children}</div> : null}
    </div>
  );
}

/** Segmented filter on the left, search on the right; 16 below. */
export function Toolbar({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("sg-toolbar", className)} {...props} />;
}

/** 13px label · 32px value · 12px comparison. */
export function StatTile({
  label,
  value,
  delta,
  icon,
  tone,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "ok" | "warn" | "danger";
}) {
  return (
    <Card className="sg-stat">
      <div className="sg-stat-k">
        {icon}
        {label}
      </div>
      <div className={cn("sg-stat-v", tone && `is-${tone}`)}>{value}</div>
      {delta ? <div className="sg-stat-d">{delta}</div> : null}
    </Card>
  );
}

/** Dashed glass card · 52px icon tile · title · one sentence · primary action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("sg-empty", className)} dashed>
      <span className="sg-empty-ic">{icon ?? <IconInbox className="size-6" />}</span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </Card>
  );
}

/** Light-red glass: what failed, the next step (usually 重试), raw detail folded away. */
export function ErrorCard({
  title,
  description,
  detail,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <div className={cn("sg-errcard", className)} role="alert">
      <IconAlertTriangle className="sg-errcard-ic size-[18px]" />
      <div className="min-w-0 flex-1">
        <h4>{title}</h4>
        {description ? <p>{description}</p> : null}
        {action}
        {detail ? (
          <div className="mt-1.5 text-xs text-[var(--ink-3)]">
            <button
              aria-expanded={detailOpen}
              className="inline-flex cursor-pointer items-center gap-1 transition-colors duration-150 hover:text-[var(--ink-1)]"
              onClick={() => setDetailOpen((prev) => !prev)}
              type="button"
            >
              <IconChevronRight
                aria-hidden
                className={cn(
                  "size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none",
                  detailOpen && "rotate-90",
                )}
              />
              {"查看详情"}
            </button>
            <SmoothCollapse open={detailOpen}>
              <pre>{detail}</pre>
            </SmoothCollapse>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 未保存栏 (DESIGN.md §11): a pill floating at the bottom of the centre pane — pulsing dot, 有未保存的
 * 更改, 放弃 and an async 保存. Portalled into `.glass-main` so it stays put while the page scrolls.
 */
export function SaveBar({
  show,
  message = "有未保存的更改",
  children,
}: {
  show: boolean;
  message?: React.ReactNode;
  /** The buttons: a ghost 放弃 then the async 保存 (Button feedback="save"). */
  children: React.ReactNode;
}) {
  const host = typeof document === "undefined" ? null : document.querySelector(".glass-main");
  const bar = (
    <div
      aria-hidden={!show}
      aria-label={"未保存的更改"}
      className={cn("sg-savebar", show && "is-shown")}
      data-surface="elevated"
      role="region"
    >
      <span aria-hidden className="sg-savebar-pulse" />
      <span className="sg-savebar-msg">{message}</span>
      <span className="flex items-center gap-2">{children}</span>
    </div>
  );
  return host ? createPortal(bar, host) : bar;
}
