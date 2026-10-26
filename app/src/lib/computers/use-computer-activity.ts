/**
 * 计算机活动记录（CB-101）：从服务端读，按需翻页，实时追加。
 *
 * 实时用 SSE（/activity/stream，cookie 认证）；断了就退回轮询——有进行中的步骤时 3 秒一次，
 * 否则 15 秒一次。服务端没有这个接口（老部署，404）时 `legacy` 为 true，界面退回浏览器内存里的旧记录。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { tryClient } from "@/lib/client";

export type ActivityStep = {
  id: string;
  seq: number;
  threadId: string | null;
  runId: string | null;
  toolCallId: string | null;
  actorKind: "agent" | "human";
  kind: string;
  status: "running" | "ok" | "failed" | "refused" | "timeout" | "cancelled";
  refusalReason: string | null;
  subject: string;
  detail: Record<string, unknown>;
  output: string | null;
  outputTruncated: boolean;
  hasFrame: boolean;
  turnPrompt: string | null;
  turnStatus: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

type Page = {
  steps: ActivityStep[];
  nextCursor: string | null;
  retentionDays: number;
};

export function compareSteps(a: ActivityStep, b: ActivityStep): number {
  const at = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  return at !== 0 ? at : b.seq - a.seq;
}

export function mergeSteps(
  current: ActivityStep[],
  incoming: ActivityStep[],
): ActivityStep[] {
  const byId = new Map(current.map((step) => [step.id, step]));
  for (const step of incoming) byId.set(step.id, step);
  return [...byId.values()].sort(compareSteps);
}

export type ComputerActivityState = {
  steps: ActivityStep[];
  /** 实时进来的新步骤 id（用来做淡入高亮），几秒后清掉。 */
  fresh: ReadonlySet<string>;
  loading: boolean;
  legacy: boolean;
  error: string | null;
  hasMore: boolean;
  retentionDays: number;
  loadMore: () => void;
  refresh: () => void;
};

const FRESH_MS = 2_400;

export function useComputerActivity(
  computerId: string,
  options: { threadId?: string; limit?: number } = {},
): ComputerActivityState {
  const [steps, setSteps] = useState<ActivityStep[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [legacy, setLegacy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState(90);
  const known = useRef(new Set<string>());
  const paged = useRef(false);
  const limit = options.limit ?? 50;
  const base = `/api/computers/${encodeURIComponent(computerId)}/activity`;
  const query = options.threadId
    ? `&thread=${encodeURIComponent(options.threadId)}`
    : "";

  const markFresh = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setFresh((previous) => new Set([...previous, ...ids]));
    setTimeout(() => {
      setFresh((previous) => {
        const next = new Set(previous);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, FRESH_MS);
  }, []);

  const absorb = useCallback(
    (incoming: ActivityStep[], live: boolean) => {
      const relevant = options.threadId
        ? incoming.filter((step) => step.threadId === options.threadId)
        : incoming;
      if (!relevant.length) return;
      const added = relevant
        .filter((step) => !known.current.has(step.id))
        .map((step) => step.id);
      for (const step of relevant) known.current.add(step.id);
      setSteps((current) => mergeSteps(current, relevant));
      if (live) markFresh(added);
    },
    [markFresh, options.threadId],
  );

  const fetchPage = useCallback(
    async (before: string | null) => {
      const response = await tryClient(
        `${base}?limit=${limit}${query}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
        {},
      );
      if (response.status === 404) {
        setLegacy(true);
        return null;
      }
      if (!response.ok) throw new Error("活动记录暂时读不到");
      return (await response.json()) as Page;
    },
    [base, limit, query],
  );

  const refresh = useCallback(() => {
    fetchPage(null)
      .then((page) => {
        if (!page) return;
        setError(null);
        setRetentionDays(page.retentionDays);
        // 首次加载不做高亮；之后的刷新（轮询）里新出现的才高亮。
        absorb(page.steps, known.current.size > 0);
        if (!paged.current) {
          paged.current = true;
          setCursor(page.nextCursor);
        }
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setLoading(false));
  }, [absorb, fetchPage]);

  const loadMore = useCallback(() => {
    if (!cursor) return;
    fetchPage(cursor)
      .then((page) => {
        if (!page) return;
        absorb(page.steps, false);
        setCursor(page.nextCursor);
      })
      .catch(() => undefined);
  }, [absorb, cursor, fetchPage]);

  useEffect(() => {
    known.current = new Set();
    paged.current = false;
    setSteps([]);
    setCursor(null);
    setLoading(true);
    setLegacy(false);
    refresh();
    // refresh 只随电脑 / 对话变化（base、query），所以这就是「换电脑 / 换对话时重来」。
  }, [refresh]);

  // 实时：SSE；不可用时轮询。
  const running = steps.some((step) => step.status === "running");
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (legacy || typeof EventSource === "undefined") return;
    const source = new EventSource(`${base}/stream`, { withCredentials: true });
    source.addEventListener("ready", () => setLive(true));
    source.addEventListener("step", (event) => {
      try {
        absorb(
          [JSON.parse((event as MessageEvent).data) as ActivityStep],
          true,
        );
      } catch {
        // 坏的一条不影响后面的。
      }
    });
    source.onerror = () => setLive(false);
    return () => {
      source.close();
      setLive(false);
    };
  }, [absorb, base, legacy]);

  useEffect(() => {
    if (legacy || live) return;
    const timer = setInterval(refresh, running ? 3_000 : 15_000);
    return () => clearInterval(timer);
  }, [legacy, live, refresh, running]);

  return {
    steps,
    fresh,
    loading,
    legacy,
    error,
    hasMore: cursor !== null,
    retentionDays,
    loadMore,
    refresh,
  };
}
