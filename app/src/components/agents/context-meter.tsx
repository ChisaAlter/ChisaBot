import { Popover } from "@base-ui/react/popover";
import { IconMessagePlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModelCatalogEntry } from "../../../../shared/model-selection";
import { contextLevel, formatTokens, type ThreadContextReading, useThreadContext } from "@/lib/copilot/thread-context";
import { agentModelQueryOptions, modelCatalogQueryOptions } from "@/lib/model-selection/queries";
import { cn } from "@/lib/utils";

const tailOf = (id: string) => id.slice(id.lastIndexOf("/") + 1) || id;

/** 所选模型的上下文窗口：只信模型目录（Magpie / 网关返回的 context_window）；没有就是不知道。 */
function windowOf(modelId: string | undefined, models: readonly ModelCatalogEntry[] | undefined): number | undefined {
  if (!modelId || !models) return undefined;
  const exact = models.find((model) => model.id === modelId);
  if (exact?.contextWindow) return exact.contextWindow;
  return undefined;
}

const SOURCE_TEXT: Record<ThreadContextReading["source"], string> = {
  measured: "上次回复时模型返回的实测用量",
  "run-total": "按整轮累计用量折算（含工具步骤，可能偏大）",
  estimate: "按消息文字估算（不含系统提示与工具定义，可能偏小）",
};

/**
 * 小饼图（DESIGN.md §78.1）：外面一圈细轨道，里面按占用比例填一块扇形（从 12 点钟方向顺时针）。
 * 以前是一段弧线的圆环，紧挨着发送键，看起来像一直在转的加载圈；扇形是「装了多少」，不像在转。
 * 窗口未知时只画一圈虚线轨道（没有比例可画，不编一个）。
 */
function Ring({ ratio, level, unknown = false }: { ratio: number; level: "ok" | "warn" | "full"; unknown?: boolean }) {
  // 扇形 = 半径 r 的圆、描边宽 2r：描边的一段就是一块扇形。
  const r = 3.25;
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(1, ratio));
  return (
    <svg aria-hidden className={cn("context-ring", `is-${level}`, unknown && "is-unknown")} height="18" viewBox="0 0 18 18" width="18">
      <circle className="context-ring-track" cx="9" cy="9" fill="none" r="7.6" strokeWidth="1.3" />
      {unknown || shown <= 0 ? null : (
        <circle
          className="context-ring-bar"
          cx="9"
          cy="9"
          fill="none"
          r={r}
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - Math.max(shown, 0.04))}
          strokeWidth={r * 2}
          transform="rotate(-90 9 9)"
        />
      )}
    </svg>
  );
}

/**
 * 输入框工具栏里的「上下文」：当前对话已占用多少 token / 所选模型的上下文窗口（DESIGN.md §25）。
 * 平时只是一个小圆环；悬停给一句百分比，点开才是详情。
 *
 * 数字只有两个来源：服务器记下的实测用量，或服务器按消息文字做的估算（标「约」）。窗口大小只来自模型
 * 目录；目录里没有这个模型的窗口时不画圆环、不写分母，绝不拿一个猜的数字充数。
 */
export function ContextMeter({
  agentId,
  threadId,
  running,
  onNewTopic,
}: {
  agentId: string;
  threadId: string | undefined;
  running: boolean;
  /** 「开始新话题」：快满时在详情里给出；没有就只提示。 */
  onNewTopic?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  const state = useQuery(agentModelQueryOptions(agentId));
  const catalog = useQuery(modelCatalogQueryOptions());
  const context = useThreadContext(agentId, threadId, running);

  // 外部 BOT 的模型和用量都不归这里管：不显示。
  if (state.data && !state.data.available) return null;
  if (!threadId || context.isPending) return <span aria-hidden className="context-meter is-loading" />;
  if (!context.data?.available) return null;

  const reading = context.data.reading;
  const tokens = reading?.tokens ?? 0;
  const modelId = state.data?.model;
  const size = windowOf(modelId, catalog.data?.models);
  const ratio = size ? tokens / size : 0;
  const level = size ? contextLevel(ratio) : "ok";
  const approx = reading ? reading.source !== "measured" : false;
  const used = `${approx ? "约 " : ""}${formatTokens(tokens)}`;
  const percent = size ? Math.min(999, Math.round(ratio * 1000) / 10) : undefined;
  const label = size
    ? `上下文 已用 ${used} / ${formatTokens(size)}（${percent}%）`
    : `上下文 已用 ${used}（模型窗口未知）`;
  const otherModel = reading?.model && modelId && tailOf(reading.model) !== tailOf(modelId) ? reading.model : undefined;

  const tipText = size ? `上下文 ${percent}%` : `上下文 ${used}`;
  // CB-100c：圆环旁边直接写出读数（有窗口写百分比，没有写已用 token），不用悬停才知道是什么。
  const shortText = size ? `${Math.round(ratio * 100)}%` : `${approx ? "≈" : ""}${formatTokens(tokens)} tok`;

  return (
    <Popover.Root
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setTip(false);
      }}
      open={open}
    >
      <Tooltip onOpenChange={(next) => setTip(next && !open)} open={tip && !open}>
        <TooltipTrigger
          delay={300}
          render={
            <Popover.Trigger
              aria-label={label}
              className={cn("context-meter", `is-${level}`, running && "is-running")}
              type="button"
            />
          }
        >
          <Ring level={level} ratio={ratio} unknown={!size} />
          <span aria-hidden className="context-meter-text" data-testid="context-meter-text">
            {shortText}
          </span>
        </TooltipTrigger>
        <TooltipContent className="context-tip" side="top" sideOffset={8}>
          {tipText}
        </TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner align="end" className="isolate z-50" side="top" sideOffset={8}>
          <Popover.Popup className="context-popover">
            <div className="context-popover-head">
              <span className="context-popover-title">上下文</span>
              {size ? <span className={cn("context-popover-pct", `is-${level}`)}>{percent}%</span> : null}
            </div>
            {size ? (
              <div aria-hidden className="context-popover-bar">
                <span className={cn("context-popover-fill", `is-${level}`)} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
              </div>
            ) : null}
            <dl className="context-popover-grid">
              <dt>已用</dt>
              <dd>{approx ? "约 " : ""}{tokens.toLocaleString("zh-CN")} tokens</dd>
              {size ? (
                <>
                  <dt>剩余</dt>
                  <dd>{Math.max(0, size - tokens).toLocaleString("zh-CN")} tokens</dd>
                  <dt>窗口</dt>
                  <dd>{size.toLocaleString("zh-CN")} tokens</dd>
                </>
              ) : (
                <>
                  <dt>窗口</dt>
                  <dd className="text-muted">模型目录没有给出这个模型的上下文大小</dd>
                </>
              )}
              {reading?.inputTokens !== undefined ? (
                <>
                  <dt>输入 / 输出</dt>
                  <dd>
                    {reading.inputTokens.toLocaleString("zh-CN")} / {(reading.outputTokens ?? 0).toLocaleString("zh-CN")}
                    {reading.cachedInputTokens ? <span className="text-muted">（缓存命中 {formatTokens(reading.cachedInputTokens)}）</span> : null}
                  </dd>
                </>
              ) : null}
              {modelId ? (
                <>
                  <dt>模型</dt>
                  <dd className="truncate" title={modelId}>{tailOf(modelId)}</dd>
                </>
              ) : null}
            </dl>
            <p className="context-popover-note">
              {reading ? SOURCE_TEXT[reading.source] : "这个话题还没有消息"}
              {otherModel ? `；上次由 ${tailOf(otherModel)} 回答` : ""}
              {running ? "；本轮回复结束后更新" : ""}
            </p>
            {level !== "ok" ? (
              <div className={cn("context-popover-warn", `is-${level}`)}>
                <span>{level === "full" ? "上下文快满了，继续聊可能丢失前面的内容。" : "上下文已用了大半，长对话建议开个新话题。"}</span>
                {onNewTopic ? (
                  <button className="context-popover-action" onClick={onNewTopic} type="button">
                    <IconMessagePlus className="size-3.5" />
                    新话题
                  </button>
                ) : null}
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
