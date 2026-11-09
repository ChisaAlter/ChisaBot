/** Wire compatibility for installed agents; current callers use the canonical header names. */
const legacyHeaders: Record<string, string> = {
  "x-chisabot-agent-token": "x-openbot-agent-token",
  "x-chisabot-bot-id": "x-openbot-bot-id",
  "x-chisabot-computer-token": "x-openbot-computer-token",
  "x-chisabot-desktop-host-token": "x-openbot-desktop-host-token",
  "x-chisabot-dictation": "x-openbot-dictation",
};

export function readCompatibleHeader(headers: Headers, name: string): string | null {
  const canonical = name.toLowerCase();
  return headers.get(canonical) ?? (legacyHeaders[canonical] ? headers.get(legacyHeaders[canonical]) : null);
}

function installedAgentHeaders(values: Record<string, string>): Record<string, string> {
  const headers = { ...values };
  for (const [name, value] of Object.entries(values)) {
    if (legacyHeaders[name]) headers[legacyHeaders[name]] = value;
  }
  return headers;
}

export function managedAgentHeaders(token: string): Record<string, string> {
  return installedAgentHeaders({ "x-chisabot-agent-token": token });
}

export function computerHeaders(botId?: string, token?: string): Record<string, string> {
  return installedAgentHeaders({
    ...(botId ? { "x-chisabot-bot-id": botId } : {}),
    ...(token ? { "x-chisabot-computer-token": token } : {}),
  });
}
