import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { continuationLabel } from "@/lib/chat/continuation";
import type { ContinuationView } from "../../../../shared/confirmations";

/** Occupies the card's existing status/action slot; retry only reopens unadmitted work. */
export function ContinuationStatus({
  value,
  onRetry,
}: {
  value: ContinuationView;
  onRetry?: () => Promise<unknown>;
}) {
  const retry = useAsyncAction(async () => onRetry?.(), {
    errorToast: (error) => error.message,
  });
  return (
    <span
      className="inline-flex shrink-0 items-center"
      data-continuation={value.state}
    >
      {value.state === "failed" && value.retryable && onRetry ? (
        <Button
          feedback={{
            pending: "提交中…",
            success: "已排队",
            error: "提交失败",
          }}
          onClick={() => void retry.run()}
          size="sm"
          state={retry.state}
          variant="outline"
        >
          {"继续处理"}
        </Button>
      ) : (
        <span
          className={
            value.state === "failed"
              ? "text-destructive text-xs"
              : "text-muted-foreground text-xs"
          }
          role="status"
        >
          {continuationLabel(value)}
        </span>
      )}
    </span>
  );
}
