import { createContext, useContext, type ReactNode } from "react";

export type ConversationScope = { threadId: string; agentId: string; botId?: string };
const Scope = createContext<ConversationScope | null>(null);
export function ConversationScopeProvider({ children, ...scope }: ConversationScope & { children: ReactNode }) {
  return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}
export function useConversationScope() { return useContext(Scope); }
