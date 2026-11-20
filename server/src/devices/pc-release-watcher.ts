import { guardedFetch } from "../../../shared/net/guarded-fetch";
import { compareSemver } from "../../../shared/system-update";
import type { DeviceHub } from "./hub";

/**
 * 服务端 PC 客户端发布监听器（docs/online-update.md §2）：
 *
 * 桌面端已经与服务端维持长连接（/api/devices/agent/ws）。以前客户端只能每 30 分钟盲轮询一次
 * GitHub Releases，发版后最长要等半小时。由服务端统一用条件 GET（If-None-Match / If-Modified-Since）
 * 轻量监听 latest.yml（687 字节，304 为 0 字节；零在线桌面端时零请求），发现新版本后立刻通过
 * WebSocket 广播 `{ type: "check_update", version }` 唤醒所有落后版本的在线桌面端立即检查更新。
 *
 * 安全边界不变：服务端只推送「去检查更新」的提示信号，不传递下载 URL，桌面端依然完全走自身
 * build-config 的更新源与 Ed25519 验签（docs/pc-update-signing.md）。
 */

export const DEFAULT_PC_UPDATE_FEED_URL =
  "https://github.com/ChisaAlter/ChisaBot/releases/latest/download/latest.yml";
export const DEFAULT_PC_UPDATE_WATCH_INTERVAL_MS = 2 * 60_000;
const FIRST_CHECK_DELAY_MS = 15_000;
const MAX_FEED_BYTES = 64 * 1024;
const FEED_TIMEOUT_MS = 10_000;

export function normalizePcUpdateFeedUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_PC_UPDATE_FEED_URL;
  if (/^(off|0|false|none)$/iu.test(trimmed)) return "";
  if (/\.ya?ml(?:[?#].*)?$/iu.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/u, "")}/latest.yml`;
}

/** 从 electron-updater 的 latest.yml 提取顶层 version 字段（忽略缩进键与注释）。 */
export function parseLatestYmlVersion(yamlText: string): string | null {
  for (const rawLine of yamlText.split(/\r?\n/u)) {
    const match = /^version\s*:\s*['"]?v?([0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)['"]?\s*(?:#.*)?$/u.exec(
      rawLine,
    );
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export type PcReleaseCheckResult = {
  checked: boolean;
  version: string | null;
  changed: boolean;
  notified: number;
  skipped: number;
  totalOnline: number;
  error?: string;
};

export type PcReleaseWatcher = {
  readonly enabled: boolean;
  readonly feedUrl: string;
  getKnownLatestVersion(): string | null;
  checkNow(options?: {
    force?: boolean;
    reason?: string;
    deviceId?: string;
  }): Promise<PcReleaseCheckResult>;
  start(): void;
  stop(): void;
};

type WatcherFetch = (
  url: string,
  options: {
    maxBytes: number;
    timeoutMs: number;
    headers?: Record<string, string>;
  },
) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}>;

function higherVersion(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const cleanA = a?.trim() || null;
  const cleanB = b?.trim() || null;
  if (!cleanA) return cleanB;
  if (!cleanB) return cleanA;
  return compareSemver(cleanA, cleanB) >= 0 ? cleanA : cleanB;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

export function createPcReleaseWatcher(options: {
  hub: Pick<DeviceHub, "onlineCount" | "notifyUpdateAvailable">;
  feedUrl?: string;
  intervalMs?: number;
  runningVersion?: string | null;
  fetchFn?: WatcherFetch;
  logger?: Pick<Console, "warn" | "info">;
}): PcReleaseWatcher {
  const feedUrl =
    options.feedUrl === undefined
      ? DEFAULT_PC_UPDATE_FEED_URL
      : normalizePcUpdateFeedUrl(options.feedUrl);
  const intervalMs = options.intervalMs ?? DEFAULT_PC_UPDATE_WATCH_INTERVAL_MS;
  const enabled = Boolean(feedUrl);
  const fetchFn: WatcherFetch = options.fetchFn ?? guardedFetch;
  const runningVersion = options.runningVersion?.trim() || null;
  const logger = options.logger ?? console;

  let latestVersion: string | null = null;
  let lastNotifiedVersion: string | null = null;
  let etag: string | null = null;
  let lastModified: string | null = null;
  let inflight: Promise<PcReleaseCheckResult> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function getKnownLatestVersion(): string | null {
    return higherVersion(latestVersion, runningVersion);
  }

  async function runCheck(input?: {
    force?: boolean;
    reason?: string;
    deviceId?: string;
  }): Promise<PcReleaseCheckResult> {
    const force = Boolean(input?.force);
    const reason = input?.reason ?? "release_watch";
    const totalOnline = options.hub.onlineCount();

    if (!enabled) {
      const known = getKnownLatestVersion();
      if (force) {
        const res = options.hub.notifyUpdateAvailable({
          ...(known ? { version: known } : {}),
          reason,
          ...(input?.deviceId ? { deviceId: input.deviceId } : {}),
        });
        return {
          checked: false,
          version: known,
          changed: false,
          ...res,
        };
      }
      return {
        checked: false,
        version: known,
        changed: false,
        notified: 0,
        skipped: 0,
        totalOnline,
      };
    }

    if (!force && totalOnline === 0) {
      return {
        checked: false,
        version: getKnownLatestVersion(),
        changed: false,
        notified: 0,
        skipped: 0,
        totalOnline: 0,
      };
    }

    try {
      const headers: Record<string, string> = {
        accept: "text/yaml, text/plain, */*",
      };
      if (!force && etag) headers["if-none-match"] = etag;
      if (!force && lastModified) headers["if-modified-since"] = lastModified;

      const response = await fetchFn(feedUrl, {
        maxBytes: MAX_FEED_BYTES,
        timeoutMs: FEED_TIMEOUT_MS,
        headers,
      });

      if (response.status === 304) {
        const known = getKnownLatestVersion();
        if (force) {
          const res = options.hub.notifyUpdateAvailable({
            ...(known ? { version: known } : {}),
            reason,
            ...(input?.deviceId ? { deviceId: input.deviceId } : {}),
          });
          return {
            checked: true,
            version: known,
            changed: false,
            ...res,
          };
        }
        return {
          checked: true,
          version: known,
          changed: false,
          notified: 0,
          skipped: 0,
          totalOnline: options.hub.onlineCount(),
        };
      }

      if (response.status < 200 || response.status >= 300) {
        const error = `PC 更新源返回 HTTP ${response.status}`;
        if (force) {
          const known = getKnownLatestVersion();
          const res = options.hub.notifyUpdateAvailable({
            ...(known ? { version: known } : {}),
            reason,
            ...(input?.deviceId ? { deviceId: input.deviceId } : {}),
          });
          return {
            checked: true,
            version: known,
            changed: false,
            error,
            ...res,
          };
        }
        return {
          checked: true,
          version: getKnownLatestVersion(),
          changed: false,
          notified: 0,
          skipped: 0,
          totalOnline: options.hub.onlineCount(),
          error,
        };
      }

      if (response.headers.etag) etag = response.headers.etag;
      if (response.headers["last-modified"])
        lastModified = response.headers["last-modified"];

      const parsed = parseLatestYmlVersion(response.body.toString("utf8"));
      const previous = latestVersion;
      if (parsed && (!latestVersion || compareSemver(parsed, latestVersion) >= 0)) {
        latestVersion = parsed;
      }

      const known = getKnownLatestVersion();
      const changed =
        Boolean(parsed) &&
        (!previous || compareSemver(parsed, previous) > 0);
      const shouldBroadcast =
        force ||
        (Boolean(parsed) &&
          (!lastNotifiedVersion ||
            compareSemver(parsed, lastNotifiedVersion) > 0));

      if (shouldBroadcast) {
        const res = options.hub.notifyUpdateAvailable({
          ...(known ? { version: known } : {}),
          reason,
          ...(input?.deviceId ? { deviceId: input.deviceId } : {}),
        });
        if (parsed && (!lastNotifiedVersion || compareSemver(parsed, lastNotifiedVersion) > 0)) {
          lastNotifiedVersion = parsed;
        }
        return {
          checked: true,
          version: known,
          changed,
          ...res,
        };
      }

      return {
        checked: true,
        version: known,
        changed,
        notified: 0,
        skipped: 0,
        totalOnline: options.hub.onlineCount(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`pc release watch failed: ${message}`);
      const known = getKnownLatestVersion();
      if (force) {
        const res = options.hub.notifyUpdateAvailable({
          ...(known ? { version: known } : {}),
          reason,
          ...(input?.deviceId ? { deviceId: input.deviceId } : {}),
        });
        return {
          checked: true,
          version: known,
          changed: false,
          error: message,
          ...res,
        };
      }
      return {
        checked: true,
        version: known,
        changed: false,
        notified: 0,
        skipped: 0,
        totalOnline: options.hub.onlineCount(),
        error: message,
      };
    }
  }

  function checkNow(input?: {
    force?: boolean;
    reason?: string;
    deviceId?: string;
  }): Promise<PcReleaseCheckResult> {
    if (input?.force) return runCheck(input);
    if (inflight) return inflight;
    inflight = runCheck(input).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    enabled,
    feedUrl,
    getKnownLatestVersion,
    checkNow,
    start() {
      if (!enabled || intervalMs <= 0) return;
      this.stop();
      firstTimer = setTimeout(() => {
        firstTimer = null;
        void checkNow({ reason: "release_watch" });
      }, FIRST_CHECK_DELAY_MS);
      unrefTimer(firstTimer);
      pollTimer = setInterval(() => {
        void checkNow({ reason: "release_watch" });
      }, intervalMs);
      unrefTimer(pollTimer as unknown as ReturnType<typeof setTimeout>);
    },
    stop() {
      if (firstTimer) {
        clearTimeout(firstTimer);
        firstTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
