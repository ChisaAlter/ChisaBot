import {
  computeQuotaProgress,
  formatQuotaLimit,
  formatTokenCount,
} from "@/lib/quotas";
import { cn } from "@/lib/utils";

type QuotaMetricBlockProps = {
  label: string;
  used: number;
  limit: number | null | undefined;
  unit?: string;
  detail?: string;
};

/** 展示单个配额指标的已用量、上限与进度条。 */
export function QuotaMetricBlock({
  label,
  used,
  limit,
  unit = "",
  detail,
}: QuotaMetricBlockProps) {
  const progress = computeQuotaProgress(used, limit);
  const barColorClass =
    progress.tone === "danger"
      ? "bg-destructive"
      : progress.tone === "warn"
        ? "bg-[var(--status-warning)]"
        : "bg-[var(--status-success)]";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="flex items-center gap-1.5 font-medium tabular-nums">
          <span>
            {`${formatTokenCount(used)}${unit} / ${formatQuotaLimit(limit, unit)}`}
          </span>
          {progress.exceeded ? (
            <span className="text-destructive text-xs">{"已达上限"}</span>
          ) : null}
        </span>
      </div>
      {progress.percent !== null ? (
        <div
          aria-label={label}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress.percent}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-200",
              barColorClass,
            )}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      ) : (
        <div
          aria-hidden="true"
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        />
      )}
      {detail ? (
        <p className="text-muted-foreground text-xs tabular-nums">{detail}</p>
      ) : null}
    </div>
  );
}
