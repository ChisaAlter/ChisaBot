import { inspectDshRuntime } from "../../../runtime/dsh/src/readiness.mjs";
import type { DshRuntimeTarget } from "./dsh-runtime";

export type DshHealthCheck = {
  ok: boolean;
  version?: string;
  protocol?: number;
  sessions?: number;
  running?: number;
  historyReadable?: boolean;
  checkedSessions?: number;
  error?: string;
};

/** Runtime settings and ops health share this probe; failures never expose connection addresses. */
export function createDshHealthProbe(options: {
  targetFor: (actorId: string) => Promise<DshRuntimeTarget>;
  recentSessionFor: (actorId: string) => Promise<string | null>;
}) {
  return async (actorId: string): Promise<DshHealthCheck> => {
    try {
      const signal = AbortSignal.timeout(7000);
      const [target, sessionId] = await Promise.all([
        options.targetFor(actorId),
        options.recentSessionFor(actorId),
      ]);
      const health = await inspectDshRuntime({
        target,
        ownerUserId: actorId,
        sessionIds: sessionId ? [sessionId] : [],
        signal,
      });
      return {
        ok: true,
        version: health.version,
        protocol: health.protocol,
        sessions: health.sessions,
        running: health.running,
        historyReadable: true,
        checkedSessions: health.watermarks.length,
      };
    } catch {
      return {
        ok: false,
        error: "DSH 执行内核或会话存储暂时不可用，请检查对应账号的 Host 日志。",
      };
    }
  };
}
