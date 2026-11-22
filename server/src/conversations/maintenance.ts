import { accessSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readDshMaintenanceRoot } from "../config";
import { ConversationMaintenanceError, isQuiescing } from "../runtime/quiesce";

export { ConversationMaintenanceError };

export const MAINTENANCE_PROBE_CACHE_TTL_MS = 500;

type ProbeOutcome = "open" | "closed" | "error";

type ProbeCacheEntry = {
  outcome: ProbeOutcome;
  expiresAt: number;
};

const MAX_PROBE_CACHE_ENTRIES = 16;
const probeCache = new Map<string, ProbeCacheEntry>();
const inflightProbes = new Map<string, Promise<ProbeOutcome>>();

export type MaintenanceProbeOptions = {
  ttlMs?: number;
  now?: () => number;
  accessFn?: (path: string) => Promise<void>;
};

export function clearMaintenanceProbeCache(): void {
  probeCache.clear();
  inflightProbes.clear();
}

function setCachedProbe(markerPath: string, entry: ProbeCacheEntry): void {
  probeCache.delete(markerPath);
  probeCache.set(markerPath, entry);
  if (probeCache.size <= MAX_PROBE_CACHE_ENTRIES) return;
  const oldest = probeCache.keys().next().value;
  if (oldest !== undefined) probeCache.delete(oldest);
}

function interpretOutcome(outcome: ProbeOutcome): boolean {
  if (outcome === "open") return false;
  if (outcome === "closed") return true;
  throw new ConversationMaintenanceError();
}

/**
 * 异步无阻塞探测维护标记（`fs/promises.access` + 500ms 极短缓存 + 并发合并）。
 * 严格保持 fail-closed 语义：`ENOENT` → 开放；文件存在 → 关闭；任何其他权限/IO 异常 → 拒绝。
 */
export async function conversationAdmissionClosedAsync(
  options: MaintenanceProbeOptions = {},
): Promise<boolean> {
  if (isQuiescing()) return true;
  const root = readDshMaintenanceRoot();
  if (!root) return false;
  const markerPath = join(resolve(root), ".maintenance");
  const ttlMs = options.ttlMs ?? MAINTENANCE_PROBE_CACHE_TTL_MS;
  const nowFn = options.now ?? Date.now;
  const now = nowFn();
  const cached = probeCache.get(markerPath);
  if (ttlMs > 0 && cached && now < cached.expiresAt) {
    return interpretOutcome(cached.outcome);
  }
  const existing = inflightProbes.get(markerPath);
  if (existing) {
    return interpretOutcome(await existing);
  }
  const probeAccess = options.accessFn ?? ((path: string) => access(path));
  const pending = (async (): Promise<ProbeOutcome> => {
    try {
      await probeAccess(markerPath);
      return "closed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "open";
      return "error";
    }
  })();
  inflightProbes.set(markerPath, pending);
  try {
    const outcome = await pending;
    if (ttlMs > 0) {
      setCachedProbe(markerPath, { outcome, expiresAt: nowFn() + ttlMs });
    }
    return interpretOutcome(outcome);
  } finally {
    if (inflightProbes.get(markerPath) === pending) {
      inflightProbes.delete(markerPath);
    }
  }
}

export async function assertConversationAdmissionOpenAsync(
  options: MaintenanceProbeOptions = {},
): Promise<void> {
  if (await conversationAdmissionClosedAsync(options)) {
    throw new ConversationMaintenanceError();
  }
}

/** The updater closes admission before draining and backing up the persistent runtime volume. */
export function conversationAdmissionClosed(): boolean {
  if (isQuiescing()) return true;
  const root = readDshMaintenanceRoot();
  if (!root) return false;
  try {
    accessSync(join(resolve(root), ".maintenance"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ConversationMaintenanceError();
  }
}

export function assertConversationAdmissionOpen(): void {
  if (conversationAdmissionClosed()) throw new ConversationMaintenanceError();
}
