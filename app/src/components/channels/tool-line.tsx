import { type ReactNode, useState } from "react";
import { useToolActivityVisible } from "@/lib/chat/tool-activity";

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * While it is still running the text shimmers, which is the only signal that the Bot is working on
 * something with nothing to show yet.
 *
 * 调试模式下的工具输出（审查模块 7）：`output` 是工具原样返回的字，用等宽纯文本画，超过 OUTPUT_LIMIT 截掉并写明
 * 还剩多少字——以前整段当 markdown 交给 Streamdown，一万字的结果点开要卡 1.5 秒，`#`、`|` 还会被排成标题、表格。
 * 详情只在点开后才画（关着时不建这一大段 DOM）。
 */
export const OUTPUT_LIMIT = 4000;

/** 截到 OUTPUT_LIMIT 个字，并说明还剩多少没显示。 */
export function clipToolOutput(output: string, limit = OUTPUT_LIMIT): { text: string; hidden: number } {
  const chars = Array.from(output);
  if (chars.length <= limit) return { text: output, hidden: 0 };
  return { text: chars.slice(0, limit).join(""), hidden: chars.length - limit };
}

export function ToolLine({
  label,
  detail,
  running,
  refused,
  failed,
  output,
  children,
}: {
  /** What was done, in a couple of words: "搜索了 Slack", "已填写", "Read the page". */
  label: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /** 工具原样返回的字：点开后用纯文本画、过长截断。和 children 二选一（都给时先画 output）。 */
  output?: string;
  /** Shown when the line is expanded. Without it (and without `output`) the line is not expandable. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  /*
   * 过程行默认不画（DESIGN：聊天里只留结果）。需要用户动手的东西（审批、登录按钮、授权卡片）都画在
   * ToolLine 之外，所以这里返回 null 不会藏掉任何要用户处理的事。
   */
  const visible = useToolActivityVisible();
  if (!visible) return null;
  const tone = refused
    ? "text-destructive"
    : failed
      ? "text-amber-600 dark:text-amber-500"
      : "text-muted-foreground";

  const text = (
    <span
      className={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-sm ${tone} ${
        running ? "tool-line-running" : ""
      }`}
    >
      <span className="shrink-0">
        {refused ? `已阻止：${label}` : failed ? `${label}，无法工作` : label}
      </span>
      {detail ? <span className="truncate opacity-70">{detail}</span> : null}
    </span>
  );

  if (!children && !output) return <div className="my-1.5">{text}</div>;
  const clipped = output ? clipToolOutput(output) : null;

  return (
    <details className="tool-line my-1.5 min-w-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      {/*
       * Native <details> owns expansion because SDK tool renderers can be re-invoked independently
       * of this component's React state.
       */}
      <summary className="flex cursor-pointer list-none items-baseline gap-1.5">
        <span
          aria-hidden
          className="tool-line-chevron shrink-0 text-xs text-muted-foreground transition-transform"
        >
          ▸
        </span>
        {text}
      </summary>
      {/*
       * Headings are cut down to the size of the surrounding text. A tool result is markdown a
       * server wrote for a model, so its `#` is a section marker rather than a page title.
       */}
      {open ? (
        <div className="mt-2 max-h-80 overflow-auto border-l pl-3 text-xs [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
          {clipped ? (
            <>
              <pre className="whitespace-pre-wrap break-words font-mono" data-testid="tool-output">
                {clipped.text}
              </pre>
              {clipped.hidden ? (
                <p className="mt-1 text-muted-foreground">（还有 {clipped.hidden} 字没显示）</p>
              ) : null}
            </>
          ) : (
            children
          )}
        </div>
      ) : null}
    </details>
  );
}
