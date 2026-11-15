import { useExternalConnection } from "@/hooks";
import { IconDeviceDesktop } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useComputerControl } from "@/lib/computers/use-control";

/** The same ownership action appears in chat, the computer sidebar, and the full-size viewer. */
export function ComputerControlButton({
  computerId,
  onTakeControl,
}: {
  computerId: string;
  onTakeControl?: () => void;
}) {
  const { control, busy, problem, change } = useComputerControl(computerId);
  const human = control?.holder === "human";
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={human ? "default" : "outline"}
        disabled={busy || !control || control.transitioning}
        aria-busy={busy || control?.transitioning}
        onClick={async () => {
          if (await change?.(human ? "release" : "take")) {
            if (!human) onTakeControl?.();
          }
        }}
      >
        {human ? "交还" : "接管控制"}
      </Button>
      {control?.transitioning ? (
        <span className="text-xs text-muted-foreground" role="status">
          {"正在完成当前操作…"}
        </span>
      ) : null}
      {problem ? (
        <span className="max-w-64 text-xs text-destructive" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Whether this Bot's computer needs the person right now (a takeover request, a secret, an
 * interrupted step, or the person already holding control). Each new prompt opens the computer
 * pane once; closing it stays a real dismissal. Shared by the old inline controls and the v3
 * top-bar chip (DESIGN-v3 §3.4), so the auto-open rule lives in one place.
 */
export function useComputerAttention(
  computerId: string | undefined,
  onOpenChange: (open: boolean) => void,
): boolean {
  const { control } = useComputerControl(computerId ?? "", Boolean(computerId));
  const needsYou = Boolean(
    control &&
      (control.requested ||
        control.holder === "human" ||
        control.request?.status === "interrupted" ||
        control.secretWanted !== undefined),
  );
  const promptKey = needsYou
    ? `${computerId}:${control?.secretWanted ?? control?.request?.id ?? "human"}`
    : null;
  useExternalConnection(promptKey, () => {
    onOpenChange(true);
  });
  return needsYou;
}

export function ComputerChatControls({
  computerId,
  open,
  onOpenChange,
}: {
  computerId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { control } = useComputerControl(computerId ?? "", Boolean(computerId));
  const needsYou = Boolean(
    control &&
      (control.requested ||
        control.holder === "human" ||
        control.request?.status === "interrupted" ||
        control.secretWanted !== undefined),
  );
  const promptKey = needsYou
    ? `${computerId}:${control?.secretWanted ?? control?.request?.id ?? "human"}`
    : null;
  // Surface each new prompt once; closing the Computer remains a real dismissal.
  useExternalConnection(promptKey, () => {
    onOpenChange(true);
  });
  return (
    <div className="flex items-start gap-1.5">
      <Button
        size="sm"
        variant={open ? "secondary" : "ghost"}
        aria-label={open ? "关闭计算机" : "打开计算机"}
        aria-expanded={open}
        disabled={!computerId}
        onClick={() => onOpenChange(!open)}
      >
        <IconDeviceDesktop className="size-4" />
        {"计算机"}
        {needsYou ? (
          <span
            className="size-2 rounded-full bg-amber-500"
            role="img"
            aria-label={"需要你"}
          />
        ) : null}
      </Button>
      {computerId ? (
        <ComputerControlButton
          computerId={computerId}
          onTakeControl={() => onOpenChange(true)}
        />
      ) : null}
    </div>
  );
}
