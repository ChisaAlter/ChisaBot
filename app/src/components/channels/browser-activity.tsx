import { PendingApprovals } from "@/components/approvals/inline-approval";
import { ActivityJumpButton } from "@/components/computer/activity-jump-button";
import type { VisibleChatItem } from "./chat-messages";
import { ToolLine } from "./tool-line";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;
export type BrowserGroup = {
  kind: "browser";
  id: string;
  steps: BrowserStep[];
};
export type TranscriptItem = VisibleChatItem | BrowserGroup;

const labels: Record<string, string> = {
  computer_navigate: "打开了页面",
  computer_read: "读取了页面",
  computer_snapshot: "检查了页面",
  computer_click: "点击了页面",
  computer_type: "填写了字段",
  computer_key: "按下了按键",
  computer_scroll: "滚动了页面",
};

/** Group adjacent browsing steps without moving messages or hiding requests for human help. */
export function groupBrowserSteps(
  items: readonly VisibleChatItem[],
): TranscriptItem[] {
  const grouped: TranscriptItem[] = [];
  for (const item of items) {
    if (
      item.kind !== "tool" ||
      !Object.hasOwn(labels, item.toolCall.function.name)
    ) {
      grouped.push(item);
      continue;
    }
    const last = grouped.at(-1);
    if (last?.kind === "browser") last.steps.push(item);
    else grouped.push({ kind: "browser", id: item.id, steps: [item] });
  }
  return grouped;
}

function objectOf(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function browserStepDetails(step: BrowserStep) {
  const result = objectOf(step.result);
  const args = objectOf(step.toolCall.function.arguments);
  const navigation = step.toolCall.function.name === "computer_navigate";
  const rawUrl = navigation ? (result.url ?? args.url) : undefined;
  let url: URL | undefined;
  try {
    if (typeof rawUrl === "string") {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        url = parsed;
    }
  } catch {
    /* A partial streaming URL is not a link yet. */
  }
  const failed =
    result.ok === false ||
    result.refused === true ||
    step.result?.startsWith("Error:") === true;
  return {
    label: labels[step.toolCall.function.name],
    href: url?.href,
    title:
      navigation && typeof result.title === "string" && result.title.trim()
        ? result.title
        : url?.hostname,
    failed,
    reason: typeof result.reason === "string" ? result.reason : undefined,
    visited: navigation && result.ok === true,
    pending: step.result === undefined,
  };
}

export function BrowserActivity({
  group,
  active,
}: {
  group: BrowserGroup;
  active: boolean;
}) {
  const steps = group.steps.map((step) => ({
    id: step.id,
    toolCall: step.toolCall,
    ...browserStepDetails(step),
  }));
  const pages = steps.filter((step) => step.visited).length;
  const issues = steps.filter((step) => step.failed).length;
  const running = active && steps.some((step) => step.pending);
  // The folded line draws its own steps, so a waiting approval gets its card beside it, not inside.
  return (
    <>
      <ToolLine
        label={
          running
            ? "正在浏览…"
            : pages
              ? `浏览了 ${pages} ${pages === 1 ? "页" : "页"}`
              : "浏览器活动"
        }
        detail={issues ? `${issues} 项问题` : undefined}
        running={running}
      >
        <ol className="space-y-2 py-1">
          {steps.map((step) => (
            <li key={step.id} className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-muted-foreground">
                  {step.label}
                </span>
                {step.href ? (
                  <a
                    href={step.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
                  >
                    {step.title ?? step.href}
                  </a>
                ) : null}
                <ActivityJumpButton
                  name={step.toolCall.function.name}
                  toolCallId={step.toolCall.id}
                />
                {step.pending && (
                  <span className="text-muted-foreground">
                    {active ? "进行中" : "未完成"}
                  </span>
                )}
              </div>
              {step.failed && (
                <p className="mt-0.5 text-destructive">
                  {step.reason ?? "此步骤无法完成。"}
                </p>
              )}
            </li>
          ))}
        </ol>
      </ToolLine>
      <PendingApprovals
        toolCallIds={group.steps.map((step) => step.toolCall.id)}
      />
    </>
  );
}
