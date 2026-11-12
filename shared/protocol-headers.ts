/** Canonical internal headers sent to managed Bots and browser computers. */
export function managedAgentHeaders(token: string): Record<string, string> {
  return { "x-chisabot-agent-token": token };
}

export function computerHeaders(
  botId?: string,
  token?: string,
): Record<string, string> {
  return {
    ...(botId ? { "x-chisabot-bot-id": botId } : {}),
    ...(token ? { "x-chisabot-computer-token": token } : {}),
  };
}
