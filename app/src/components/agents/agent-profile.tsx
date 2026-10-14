import { BotDetailPane } from "@/components/bot-profile/detail-pane";

/**
 * The Bot beside a conversation. The same pane the standalone profile uses, so chat and the
 * profile route do not keep two layouts.
 */
export function AgentProfile({
  agentId,
  onOpenComputer,
}: {
  agentId: string;
  onOpenComputer?: () => void;
}) {
  return <BotDetailPane agentId={agentId} onOpenComputer={onOpenComputer} />;
}
