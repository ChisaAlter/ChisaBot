/**
 * OpenBot → ChisaBot rename (0.1.75): every `OPENBOT_*` environment variable is now `CHISABOT_*`.
 * Deployments and installed clients set the old names, so copy each `OPENBOT_X` into `CHISABOT_X`
 * when the new one is unset. The new name always wins. Import this first in every entry point,
 * before any module reads `process.env`.
 */
export function applyLegacyEnvAliases(env: Record<string, string | undefined> = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("OPENBOT_") || value === undefined) continue;
    const renamed = `CHISABOT_${key.slice("OPENBOT_".length)}`;
    if (env[renamed] === undefined) env[renamed] = value;
  }
}

applyLegacyEnvAliases();
