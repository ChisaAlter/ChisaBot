import { IconCreditCard, IconDeviceDesktop, IconPlugConnected, IconSend2, IconTrash } from "@tabler/icons-react";
import { CONFIRM_CATEGORY_INFO, type ConfirmCategory, type ConfirmRequestView } from "../../../../shared/confirmations";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/skyglass";
import { decideConfirmation } from "@/lib/confirmations";
import { agoText } from "@/lib/im";

export const CONFIRM_ICON: Record<ConfirmCategory, typeof IconSend2> = {
  message: IconSend2,
  delete: IconTrash,
  purchase: IconCreditCard,
  device: IconDeviceDesktop,
  admin: IconPlugConnected,
};

const STATUS_TEXT: Record<ConfirmRequestView["status"], string> = {
  pending: "等你确认",
  approved: "已确认",
  denied: "已取消",
  expired: "已过期",
  cancelled: "已停止",
};

/** 一张确认卡片的一行（DESIGN.md §58.3「最近的确认」、§71.1「待处理」）：等着的可以直接确认 / 取消。 */
export function ConfirmRow({ request, botName, onDecided }: { request: ConfirmRequestView; botName: string; onDecided: () => Promise<unknown> }) {
  const Icon = CONFIRM_ICON[request.category];
  const approve = useAsyncAction(async () => {
    await decideConfirmation(request.id, "approve");
    await onDecided();
  }, { errorToast: (error) => error.message });
  const deny = useAsyncAction(async () => {
    await decideConfirmation(request.id, "deny");
    await onDecided();
  }, { errorToast: (error) => error.message });
  return (
    <div className="im-row ap-row" data-testid="confirm-recent">
      <div className="im-row-main">
        <ListRow
          icon={
            <span className="ap-ico" data-category={request.category}>
              <Icon className="size-5" />
            </span>
          }
          sub={
            <span className="mem-by">{`${botName} · ${CONFIRM_CATEGORY_INFO[request.category].label}${request.target ? ` · ${request.target}` : ""} · ${agoText(request.createdAt)}`}</span>
          }
          title={request.title}
        />
      </div>
      {request.status === "pending" ? (
        <div className="flex flex-none gap-2">
          <Button feedback={{ pending: "确认中…", success: "已确认", error: "确认失败" }} onClick={() => void approve.run()} size="sm" state={approve.state}>
            {"确认"}
          </Button>
          <Button feedback="cancel" onClick={() => void deny.run()} size="sm" state={deny.state} variant="outline">
            {"取消"}
          </Button>
        </div>
      ) : (
        <span className="ap-status" data-status={request.status}>
          {STATUS_TEXT[request.status]}
        </span>
      )}
    </div>
  );
}
