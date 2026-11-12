import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";

export function ConfirmationPages({
  pageNumber,
  previous,
  next,
}: {
  pageNumber: number;
  previous?: () => Promise<unknown>;
  next?: () => Promise<unknown>;
}) {
  const back = useAsyncAction(async () => previous?.(), {
    errorToast: (error) => error.message,
  });
  const forward = useAsyncAction(async () => next?.(), {
    errorToast: (error) => error.message,
  });
  if (!previous && !next) return null;
  const busy = back.state === "pending" || forward.state === "pending";
  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <span className="text-xs text-muted-foreground">第 {pageNumber} 页</span>
      <div className="flex gap-2">
        {previous ? (
          <Button
            size="sm"
            variant="outline"
            state={back.state}
            disabled={busy && back.state !== "pending"}
            feedback={{
              pending: "加载中…",
              success: "已加载",
              error: "加载失败",
            }}
            onClick={() => void back.run()}
          >
            上一页
          </Button>
        ) : null}
        {next ? (
          <Button
            size="sm"
            variant="outline"
            state={forward.state}
            disabled={busy && forward.state !== "pending"}
            feedback={{
              pending: "加载中…",
              success: "已加载",
              error: "加载失败",
            }}
            onClick={() => void forward.run()}
          >
            下一页
          </Button>
        ) : null}
      </div>
    </div>
  );
}
