/** Old gateways and persisted interrupt records remain readable during deployment upgrades. */
export function gatewayLoginRequired(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;
  return value.chisabotAuthRequired === true || value.openbotAuthRequired === true;
}

export function interruptWaitingKind(metadata: Record<string, unknown> | undefined): unknown {
  const waiting = metadata?.chisabotWaiting ?? metadata?.openbotWaiting;
  return waiting && typeof waiting === "object" ? (waiting as { kind?: unknown }).kind : undefined;
}
