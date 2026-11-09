export function conversationTables(sql: {
  unsafe(
    query: string,
  ): PromiseLike<Array<{ current?: string | null; legacy?: string | null }>>;
}): Promise<{ threads: string; events: string }>;
