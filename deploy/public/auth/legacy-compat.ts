/** Upgrade boundary for already-installed gateway clients and persisted sessions. */
export const LEGACY_SESSION_COOKIE = "__Host-openbot_session";

export function clientAddress(headers: Headers): string {
  return (
    headers.get("X-ChisaBot-Client") ||
    headers.get("X-OpenBot-Client") ||
    "unknown"
  );
}

/** Cached application bundles still use this bit to recognize gateway authentication failures. */
export function legacyAuthRequired(): { openbotAuthRequired: true } {
  return { openbotAuthRequired: true };
}

export function applyLegacyAuthEnvironment(
  env: Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("OPENBOT_") || value === undefined) continue;
    const canonical = "CHISABOT_" + key.slice(8);
    if (env[canonical] === undefined) env[canonical] = value;
  }
}
