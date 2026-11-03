import { IconListDetails } from "@tabler/icons-react";
import { memo } from "react";
import { useToolActivityVisible } from "@/lib/chat/tool-activity";
import { isComputerTool, requestActivityJump } from "./activity-jump";

/** 聊天里的工具调用 / 电脑步骤旁边的「在活动里看」（CB-101）。 */
function ActivityJumpButtonImpl({
  name,
  toolCallId,
}: {
  name?: string;
  toolCallId?: string;
}) {
  /*
   * 「在活动里看」是过程行的附属物：工具步骤默认不画（ToolLine 同一个开关），步骤不画时只剩这一颗
   * 孤零零的链接挂在气泡外面——2026-11-03 用户报的「气泡外的思考内容」就是它。跟着开关一起藏；
   * 展开干活卡的步骤列表同样不画，那一处本来就是点开才见的过程细节。
   */
  const stepsVisible = useToolActivityVisible();
  if (!stepsVisible || !toolCallId || !isComputerTool(name)) return null;
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

/** 流式时父组件每个 token 都会重渲；props 没变就跳过（jank FIX-PLAN §5 / P2-1）。 */
ActivityJumpButtonImpl.displayName = "ActivityJumpButton";
export const ActivityJumpButton = memo(ActivityJumpButtonImpl);
