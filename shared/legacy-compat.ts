/** Explicit current values take precedence; this never writes an installation's configuration. */
export function applyLegacyEnvAliases(env: Record<string, string | undefined> = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("OPENBOT_") || value === undefined) continue;
    const current = `CHISABOT_${key.slice("OPENBOT_".length)}`;
    if (env[current] === undefined) env[current] = value;
  }
}
