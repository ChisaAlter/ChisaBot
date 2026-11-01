import { useQuery } from "@tanstack/react-query";
import { BotAvatar } from "@/components/agents/bot-avatar";
import { botAvatarsQueryOptions } from "@/lib/agents/avatars";

/**
 * 对话里「在想 / 在干活」那一行前面的小标记（DESIGN.md §81）：机器人用的是形象头像时画 18px 的它自己
 * （实时状态由对话页发布，见 lib/agents/bot-activity.ts，会跟着在想 / 在干活变形）；其他头像照旧三个点。
 */
export function BotWorkMark({ agentId }: { agentId?: string }) {
  // 没有 agentId（测试、预览）时不碰 react-query：那里可能没有 QueryClientProvider。
  return agentId ? <ShapeMark agentId={agentId} /> : <Dots />;
}

function ShapeMark({ agentId }: { agentId: string }) {
  const avatars = useQuery(botAvatarsQueryOptions());
  if (avatars.data?.[agentId]?.kind !== "shape") return <Dots />;
  return (
    <span
      aria-hidden="true"
      className="chat-thinking-ava"
      data-testid="chat-thinking-avatar"
    >
      {/* decorative：旁边写着「思考中」；name="" 免得为了读屏的名字去拉机器人列表。 */}
      <BotAvatar agentId={agentId} decorative name="" size={18} />
    </span>
  );
}

function Dots() {
  return (
    <span aria-hidden="true" className="chat-thinking-dots">
      <i />
      <i />
      <i />
    </span>
  );
}
