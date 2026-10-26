import { IconListDetails } from "@tabler/icons-react";
import { isComputerTool, requestActivityJump } from "./activity-jump";

/** 聊天里的工具调用 / 电脑步骤旁边的「在活动里看」（CB-101）。 */
export function ActivityJumpButton({
  name,
  toolCallId,
}: {
  name?: string;
  toolCallId?: string;
}) {
  if (!toolCallId || !isComputerTool(name)) return null;
  return (
    <button
      className="activity-jump-link"
      data-jump-activity={toolCallId}
      onClick={(event) => {
        event.stopPropagation();
        requestActivityJump(toolCallId);
      }}
      title="在计算机活动记录里查看这一步"
      type="button"
    >
      <IconListDetails aria-hidden className="size-3.5" />
      {"在活动里看"}
    </button>
  );
}
