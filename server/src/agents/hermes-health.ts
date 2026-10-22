/**
 * A secret-free look at the host Hermes bridge.
 *
 * The bridge exposes `GET /health` next to `/ag-ui` without a token: it reports only whether the
 * child agent initialised, whether host tools registered and whether the run ledger is usable. That
 * is what the settings page and the optional ops-health entry read. The token and the run
 * capability are deliberately not involved, so a probe can never touch the tool gateway or start a
 * turn.
 *
 * Every failure becomes a fixed Chinese sentence: the underlying error may name an internal host or
 * an upstream body, and this value is rendered in the product.
 */

export type HermesHealthCheck = {
  ok: boolean | null;
  configured: boolean;
  reachable?: boolean;
  healthy?: boolean;
  initialized?: boolean;
  hostTools?: boolean;
  persistentState?: boolean;
  generation?: number;
  sessions?: number;
  error?: string;
};

/** The bridge's health endpoint, derived from the configured AG-UI URL. */
export function hermesHealthUrl(agUiUrl: string): string | null {
  try {
    const url = new URL(agUiUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // `.../ag-ui` is the run endpoint; its sibling is the health endpoint. This also keeps a path
    // prefix, so a bridge mounted under `/hermes/ag-ui` probes `/hermes/health`.
    const base = url.pathname.replace(/\/ag-ui\/?$/u, "").replace(/\/$/u, "");
    return `${url.origin}${base}/health`;
  } catch {
    return null;
  }
}

function numberField(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Ask the bridge how it is doing. Never throws and never returns the response body.
 *
 * `ok` mirrors the bridge's own verdict, which already covers the child process, initialisation,
 * the registered host tool surface and the persistent ledger. `reachable` distinguishes "the
 * process answered and is not ready" from "nothing answered".
 */
export async function probeHermesHealth(
  agUiUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<HermesHealthCheck> {
  const endpoint = hermesHealthUrl(agUiUrl);
  if (!endpoint)
    return {
      ok: false,
      configured: true,
      reachable: false,
      error: "Hermes 地址无效",
    };
  const call = options.fetch ?? fetch;
  try {
    const response = await call(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 4_000),
    });
    if (!response.ok)
      return {
        ok: false,
        configured: true,
        reachable: true,
        error: `Hermes 健康检查返回 HTTP ${response.status}`,
      };
    const body: unknown = await response.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        configured: true,
        reachable: true,
        error: "Hermes 返回的健康状态无法解析",
      };
    const fields = body as Record<string, unknown>;
    const ready = fields.ok === true;
    return {
      ok: ready,
      configured: true,
      reachable: true,
      healthy: fields.healthy === true,
      initialized: fields.initialized === true,
      hostTools: fields.hostTools === true,
      persistentState: fields.persistentState === true,
      ...(numberField(fields, "generation") === undefined
        ? {}
        : { generation: numberField(fields, "generation") }),
      ...(numberField(fields, "sessions") === undefined
        ? {}
        : { sessions: numberField(fields, "sessions") }),
      ...(ready ? {} : { error: "Hermes 桥接还没有就绪" }),
    };
  } catch {
    return {
      ok: false,
      configured: true,
      reachable: false,
      error: "连接不上 Hermes 桥接（可能没有启动或端口不对）",
    };
  }
}
