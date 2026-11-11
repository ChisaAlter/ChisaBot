/** Canonical HTTP routes and envelope helpers for ChisaBot conversations. */
export const CONVERSATION_BASE = "/api/conversations";

export function isConversationPath(path: string): boolean {
  return (
    path === CONVERSATION_BASE || path.startsWith(`${CONVERSATION_BASE}/`)
  );
}

/** Read saved continuations without rewriting their signed assertion or original payload. */
export function runAssertionValue(forwarded: unknown): unknown {
  if (!forwarded || typeof forwarded !== "object") return undefined;
  return (forwarded as Record<string, unknown>).chisabotRun;
}

export function withoutRunAssertion(forwarded: Record<string, unknown>) {
  const { chisabotRun: _current, ...rest } = forwarded;
  return rest;
}

export function authenticationRequired() {
  return { chisabotAuthRequired: true as const };
}
