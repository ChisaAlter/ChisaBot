import { createContext, type ReactNode, useContext, useMemo } from "react";

export type ConversationScope = {
  threadId: string;
  agentId: string;
  botId?: string;
};
const Scope = createContext<ConversationScope | null>(null);
export function ConversationScopeProvider({
  children,
  threadId,
  agentId,
  botId,
}: ConversationScope & { children: ReactNode }) {
  const value = useMemo<ConversationScope>(
    () =>
      botId === undefined
        ? { threadId, agentId }
        : { threadId, agentId, botId },
    [threadId, agentId, botId],
  );
  return <Scope.Provider value={value}>{children}</Scope.Provider>;
}
export function useConversationScope() {
  return useContext(Scope);
}
