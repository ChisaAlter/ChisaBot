import { readFileSync } from "node:fs";

/**
 * Magpie (ghcr.io/yetone/magpie), the self-hosted model gateway ChisaBot routes its models
 * through, and its management console.
 *
 * Two things live here, both server-side only:
 *  - `status()`: a safe projection of Magpie's admin API (version, providers, readiness). Provider
 *    keys, caller keys and anything else Magpie holds never leave this module.
 *  - `proxy()`: the management console served under `MAGPIE_MOUNT` on ChisaBot's own origin, so
 *    an administrator signed in to ChisaBot can use it (embedded in 管理后台) without a second
 *    entry. The Magpie web key is injected here as an upstream cookie; the browser never sees it,
 *    and browser cookies/credentials never reach Magpie.
 */

export const MAGPIE_MOUNT = "/magpie-admin";

export type MagpieProviderStatus = {
  id: string;
  name: string;
  ready: boolean;
  enabled: boolean;
  /** Models this provider exposes through the gateway (the ones picked in Magpie). */
  models: number;
};

export type MagpieStatus = {
  configured: boolean;
  managementAvailable: boolean;
  reachable: boolean;
  version?: string;
  gatewayOn?: boolean;
  providers: MagpieProviderStatus[];
  checkedAt: number;
  error?: string;
};

export type MagpieService = {
  readonly configured: boolean;
  readonly managementAvailable: boolean;
  status(options?: { refresh?: boolean }): Promise<MagpieStatus>;
  /** `path` is everything after `MAGPIE_MOUNT`, including the leading slash. */
  proxy(request: Request, path: string): Promise<Response>;
  /** Called after a write through the console succeeded, e.g. to resync the model catalog. */
  onChange(listener: () => void): void;
};

const STATUS_CACHE_MS = 60_000;
const STATUS_TIMEOUT_MS = 6_000;
// /api/providers carries every provider's full model catalog (several MB with many providers).
const MAX_STATUS_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9\-._~]{16,256}$/u;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 200): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/u.test(value)
    ? value
    : undefined;
}

export function readMagpieWebKey(environment: NodeJS.ProcessEnv) {
  const file = environment.MAGPIE_WEB_KEY_FILE?.trim();
  let key = environment.MAGPIE_WEB_KEY?.trim();
  if (!key && file) {
    try {
      key = readFileSync(file, "utf8").trim();
    } catch {
      key = undefined;
    }
  }
  return key && KEY_PATTERN.test(key) ? key : undefined;
}

/** Upstream response headers worth keeping. Everything else (Set-Cookie included) is dropped. */
const PASS_RESPONSE = [
  "content-type",
  "content-disposition",
  "last-modified",
  "etag",
  "x-magpie-version",
];
const PASS_REQUEST = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "range",
];

/** Magpie's console calls `/api/…` from the root. Under the mount those calls must carry it. */
function rewriteAssetText(body: string) {
  return body.replace(/(["'`])\/api\//gu, `$1${MAGPIE_MOUNT}/api/`);
}

export function createMagpieService(options: {
  adminUrl?: string;
  webKey?: string;
  fetch?: typeof fetch;
}): MagpieService {
  const request = options.fetch ?? fetch;
  let admin: URL | undefined;
  try {
    if (options.adminUrl) {
      const parsed = new URL(options.adminUrl);
      if (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      )
        admin = parsed;
    }
  } catch {
    admin = undefined;
  }
  const key = options.webKey;
  const configured = Boolean(admin);
  const managementAvailable = Boolean(admin && key);
  // Magpie names its session cookie after the port it serves the console on.
  const cookieName = `magpie_web_${admin?.port || (admin?.protocol === "https:" ? "443" : "80")}`;
  const upstreamHost = `localhost:${admin?.port || "80"}`;
  const listeners = new Set<() => void>();

  let cached: MagpieStatus | undefined;
  let pending: Promise<MagpieStatus> | undefined;

  function upstreamHeaders(extra?: Headers) {
    const headers = new Headers();
    if (extra)
      for (const name of PASS_REQUEST) {
        const value = extra.get(name);
        if (value) headers.set(name, value);
      }
    headers.set("host", upstreamHost);
    if (key) headers.set("cookie", `${cookieName}=${key}`);
    return headers;
  }

  async function getJson(path: string): Promise<unknown> {
    const response = await request(new URL(path, admin), {
      headers: upstreamHeaders(new Headers({ accept: "application/json" })),
      redirect: "manual",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Magpie 管理密钥无效或未配置。"
          : `Magpie 返回 HTTP ${response.status}。`,
      );
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_STATUS_BYTES) throw new Error("Magpie 响应过大。");
    const body = await response.text();
    if (body.length > MAX_STATUS_BYTES) throw new Error("Magpie 响应过大。");
    return JSON.parse(body);
  }

  async function load(): Promise<MagpieStatus> {
    const base: MagpieStatus = {
      configured,
      managementAvailable,
      reachable: false,
      providers: [],
      checkedAt: Date.now(),
    };
    if (!admin) return { ...base, error: "未配置 Magpie 管理地址。" };
    if (!key)
      return {
        ...base,
        error: "ChisaBot 未配置 Magpie 管理密钥，无法读取提供方状态。",
      };
    try {
      const [settings, providers] = await Promise.all([
        getJson("/api/settings"),
        getJson("/api/providers"),
      ]);
      const rows =
        object(providers) && Array.isArray(providers.providers)
          ? providers.providers
          : [];
      return {
        ...base,
        reachable: true,
        version: object(settings) ? text(settings.version, 40) : undefined,
        gatewayOn:
          object(settings) && typeof settings.gatewayOn === "boolean"
            ? settings.gatewayOn
            : undefined,
        providers: rows.flatMap((row): MagpieProviderStatus[] => {
          if (!object(row)) return [];
          const id = text(row.id);
          if (!id) return [];
          const chosen = Array.isArray(row.chosen) ? row.chosen.length : 0;
          const exposed =
            typeof row.exposed === "number" && Number.isFinite(row.exposed)
              ? row.exposed
              : chosen;
          return [
            {
              id,
              name: text(row.name) ?? id,
              ready: row.ready === true,
              enabled: row.off !== true,
              models: Math.max(0, Math.trunc(Math.max(exposed, chosen))),
            },
          ];
        }),
      };
    } catch (error) {
      // Upstream prose can carry anything; only our own messages pass through.
      const message =
        error instanceof Error && /^Magpie /u.test(error.message)
          ? error.message
          : "无法连接 Magpie 管理接口。";
      return { ...base, error: message };
    }
  }

  return {
    configured,
    managementAvailable,
    onChange(listener) {
      listeners.add(listener);
    },
    async status(input = {}) {
      if (
        !input.refresh &&
        cached &&
        Date.now() - cached.checkedAt < STATUS_CACHE_MS
      )
        return structuredClone(cached);
      if (!pending)
        pending = load()
          .then((value) => {
            cached = value;
            return value;
          })
          .finally(() => {
            pending = undefined;
          });
      return structuredClone(await pending);
    },
    async proxy(incoming, path) {
      if (!admin || !key)
        return new Response("Magpie 管理未配置。", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      if (!path.startsWith("/") || path.startsWith("//") || /\\|%2e%2e|\.\.\//iu.test(path))
        return new Response("Bad path", { status: 400 });
      const method = incoming.method.toUpperCase();
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
      if (unsafe) {
        // Magpie does not check Origin itself, so the proxy does: same-origin writes only.
        const site = incoming.headers.get("sec-fetch-site");
        const origin = incoming.headers.get("origin");
        const host = incoming.headers.get("host");
        let sameOrigin = !origin;
        try {
          if (origin && host) sameOrigin = new URL(origin).host === host;
        } catch {
          sameOrigin = false;
        }
        if ((site && !["same-origin", "none"].includes(site)) || !sameOrigin)
          return new Response("Cross-site request refused", { status: 403 });
      }
      const source = new URL(incoming.url);
      const target = new URL(path + source.search, admin);
      let body: ArrayBuffer | undefined;
      if (unsafe) {
        const length = Number(incoming.headers.get("content-length") ?? 0);
        if (length > MAX_UPLOAD_BYTES)
          return new Response("Request too large", { status: 413 });
        body = await incoming.arrayBuffer();
        if (body.byteLength > MAX_UPLOAD_BYTES)
          return new Response("Request too large", { status: 413 });
      }
      let upstream: Response;
      try {
        upstream = await request(target, {
          method,
          headers: upstreamHeaders(incoming.headers),
          body,
          redirect: "manual",
          signal: incoming.signal,
        });
      } catch {
        return new Response("无法连接 Magpie 管理服务。", {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const headers = new Headers();
      for (const name of PASS_RESPONSE) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      const location = upstream.headers.get("location");
      if (location) {
        try {
          const next = new URL(location, target);
          if (next.origin === admin.origin)
            headers.set("location", `${MAGPIE_MOUNT}${next.pathname}${next.search}`);
        } catch {
          /* dropped */
        }
      }
      // Same-origin framing only. A CSP frame-ancestors also overrides the gateway's blanket
      // X-Frame-Options: DENY in every current browser, so the console can sit in 管理后台.
      headers.set("content-security-policy", "frame-ancestors 'self'");
      headers.set("x-frame-options", "SAMEORIGIN");
      headers.set("cache-control", "no-store");
      headers.set("referrer-policy", "same-origin");
      headers.set("x-content-type-options", "nosniff");
      if (unsafe && upstream.ok && /^\/api\//u.test(path))
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* a listener must never break the console */
          }
        }
      const type = upstream.headers.get("content-type") ?? "";
      if (
        method !== "HEAD" &&
        upstream.body &&
        /text\/html|javascript|text\/css/iu.test(type)
      ) {
        headers.delete("etag");
        return new Response(rewriteAssetText(await upstream.text()), {
          status: upstream.status,
          headers,
        });
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    },
  };
}

/** Where a one-click install puts Magpie: the `magpie` service on the shared `chisabot_magpie` network. */
export const MANAGED_MAGPIE_ADMIN_URL = "http://magpie:3430";
const MANAGED_RECHECK_MS = 3_000;
const MAX_MANAGED_STATE_BYTES = 64 * 1024;

/**
 * The Magpie service the server actually uses: the deployment's own configuration when it has one,
 * otherwise whatever the host's one-click install (deploy/updater/magpie.sh do_install) handed over.
 *
 *  - `MAGPIE_ADMIN_URL` set → exactly `createMagpieService` with the configured key, as before. A
 *    deployment that wired Magpie by hand (Haupt included) never looks at the updater's files.
 *  - Not set → the updater's read-only state directory (`CHISABOT_UPDATER_DIR/state`) is checked
 *    every few seconds: once `magpie.json` says a ChisaBot-managed Magpie is installed and
 *    `magpie-web.key` (mode 0400, owned by the API user) holds a valid key, the console and status
 *    page turn on against `MANAGED_MAGPIE_ADMIN_URL`. No restart: that is the whole point, since the
 *    person who clicked 「一键安装」 has no shell on the server.
 *
 * The admin URL is never read from the state file: a host file decides *whether* to enable the
 * console, not *where* the server sends its key.
 */
export function createAutoMagpieService(options: {
  environment: NodeJS.ProcessEnv;
  /** `CHISABOT_UPDATER_DIR` inside the container (requests/ + state/). */
  updaterDir?: string;
  fetch?: typeof fetch;
  now?: () => number;
}): MagpieService {
  const env = options.environment;
  const configuredUrl = env.MAGPIE_ADMIN_URL?.trim();
  if (configuredUrl)
    return createMagpieService({
      adminUrl: configuredUrl,
      webKey: readMagpieWebKey(env),
      fetch: options.fetch,
    });

  const now = options.now ?? Date.now;
  const stateDir = options.updaterDir?.trim()
    ? `${options.updaterDir.trim().replace(/\/+$/u, "")}/state`
    : "";
  const listeners = new Set<() => void>();
  const unconfigured = createMagpieService({ fetch: options.fetch });
  let current: MagpieService = unconfigured;
  let currentKey: string | undefined;
  let checkedAt = Number.NEGATIVE_INFINITY;

  function managedKey(): string | undefined {
    if (!stateDir) return undefined;
    try {
      const raw = readFileSync(`${stateDir}/magpie.json`, "utf8");
      if (raw.length > MAX_MANAGED_STATE_BYTES) return undefined;
      const state: unknown = JSON.parse(raw);
      if (!object(state) || state.managed !== true || state.installed !== true)
        return undefined;
      const key = readFileSync(`${stateDir}/magpie-web.key`, "utf8").trim();
      return KEY_PATTERN.test(key) ? key : undefined;
    } catch {
      return undefined;
    }
  }

  function resolve(): MagpieService {
    const at = now();
    if (at - checkedAt < MANAGED_RECHECK_MS) return current;
    checkedAt = at;
    const key = managedKey();
    if (key === currentKey) return current;
    currentKey = key;
    current = key
      ? createMagpieService({
          adminUrl: MANAGED_MAGPIE_ADMIN_URL,
          webKey: key,
          fetch: options.fetch,
        })
      : unconfigured;
    current.onChange(() => {
      for (const listener of listeners) listener();
    });
    // A gateway that just appeared (or went away) changes the model catalog's provider names.
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* never let a listener break the switch */
      }
    }
    return current;
  }

  return {
    get configured() {
      return resolve().configured;
    },
    get managementAvailable() {
      return resolve().managementAvailable;
    },
    onChange(listener) {
      listeners.add(listener);
    },
    status(input) {
      return resolve().status(input);
    },
    proxy(request, path) {
      return resolve().proxy(request, path);
    },
  };
}
