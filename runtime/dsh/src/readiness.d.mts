export type DshReadiness = {
  ok: true; version: string; protocol: number; sessions: number; running: number;
  watermarks: { sessionId: string; cursor: number }[];
};
export function inspectDshRuntime(options: {
  target: { ownerUserId: string; connectionFile: string };
  ownerUserId: string;
  sessionIds?: string[];
  expected?: { protocol: number; runtimeVersion: string };
  signal: AbortSignal;
}): Promise<DshReadiness>;
