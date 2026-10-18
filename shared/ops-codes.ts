/**
 * Stable ops / observability event codes (PRD-P1-02).
 *
 * Grep production logs for `"code":"OPS_…"` or `"code":"SEND_…"`. Keep codes SHORT, STABLE, and
 * free of secrets or SQL. Prefer these over free-form English when a failure should enter an
 * error budget. Adding a code is cheap; renaming one is a breaking change for monitors.
 */
export const OPS_CODES = {
  /** Aggregated admin health reported overall failure. */
  HEALTH_DEGRADED: "OPS_HEALTH_DEGRADED",
  /** Database ping failed inside /api/admin/health. */
  HEALTH_DB: "OPS_HEALTH_DB",
  /** Magpie was configured but unreachable. */
  HEALTH_MAGPIE: "OPS_HEALTH_MAGPIE",
  /** Computer node was configured but /health failed. */
  HEALTH_COMPUTER: "OPS_HEALTH_COMPUTER",
  /** Post-deploy smoke suite failed a hard check (version / capabilities / aggregate). */
  SMOKE_HARD_FAIL: "OPS_SMOKE_HARD_FAIL",
  /** Admin model round-trip smoke failed (advisory unless STRICT_MODEL_SMOKE=1). */
  SMOKE_MODEL_FAIL: "OPS_SMOKE_MODEL_FAIL",
  /** Chat send never reached the server (tunnel / offline). */
  SEND_UNREACHABLE: "SEND_UNREACHABLE",
  /** Send hung: run neither persisted nor finished within send watchdog. */
  SEND_HANG: "SEND_HANG",
  /** Message persisted but reply never finished within reply watchdog. */
  SEND_REPLY_HANG: "SEND_REPLY_HANG",
  /** Live computer stream dropped without a clean close. */
  STREAM_DISCONNECT: "STREAM_DISCONNECT",
  /** Outbound fetch refused by SSRF / egress floor. */
  SSRF_DENIED: "SSRF_DENIED",
} as const;

export type OpsCode = (typeof OPS_CODES)[keyof typeof OPS_CODES];

/** One greppable JSON line for ops dashboards. Never put secrets or SQL in `fields`. */
export function opsLogLine(
  code: OpsCode,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const body: Record<string, unknown> = { type: "ops", code };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body[key] = value;
  }
  return JSON.stringify(body);
}
