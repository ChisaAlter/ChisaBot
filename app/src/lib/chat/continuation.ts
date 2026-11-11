import type { ContinuationView } from "../../../../shared/confirmations";

export const continuationIsActive = (value?: ContinuationView) =>
  value?.state === "queued" || value?.state === "running";

export function continuationLabel(value: ContinuationView): string {
  switch (value.state) {
    case "queued":
      return "等待继续";
    case "running":
      return "继续处理中";
    case "failed":
      return "继续处理失败";
    case "completed":
      return "后续已完成";
  }
}

export function continuationError(
  value?: ContinuationView,
): string | undefined {
  if (value?.state !== "failed") return;
  return (
    value.error ||
    (value.retryable
      ? "后续处理未能开始，可以继续处理。"
      : "后续处理已停止，请在对话中核对结果后继续。")
  );
}
