import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { ClaudeAuth, CloudWorkspaceView } from "../../../shared/cloud-cc";
import { ccApi, ccKeys, cloudWorkspaceQueryOptions } from "@/lib/cloud-cc";

/**
 * 云端 Claude 登录状态的自动复查（DESIGN.md §73.1，docs/cloud-claude-code.md §3.1）。
 *
 * 服务器把登录状态缓存在 chisabot_cloud_workspaces.claude_auth，只有节点重连、POST /claude/check 或服务器的定时复查才刷新。
 * 打开 Claude Code 页 / 设置 → 云端工作区、窗口重新获得焦点时，如果节点在线而缓存「未登录」或已经超过 STALE_MS，
 * 就在后台调一次 /claude/check（节流：同一时间只有一个，两次之间至少 THROTTLE_MS），不阻塞渲染。
 * 检查期间如果缓存是「未登录」且已经过期（不可信），页面显示安静的检查态，而不是先闪出「登录 Claude」。
 */
export const STALE_MS = 60_000;
export const THROTTLE_MS = 30_000;

type View = { node: { online: boolean } | null; claude: { loggedIn: boolean; checkedAt: string | null } } | null | undefined;

/** 缓存的登录状态是否过期（没有检查时间也算过期）。 */
export function authStale(claude: { checkedAt: string | null } | null | undefined, now: number): boolean {
  if (!claude?.checkedAt) return true;
  const at = Date.parse(claude.checkedAt);
  return !Number.isFinite(at) || now - at > STALE_MS;
}

/** 现在要不要去节点复查：节点在线，且缓存「未登录」或过期，且离上次尝试至少 THROTTLE_MS，且没有正在进行的检查。 */
export function shouldRecheck(view: View, now: number, lastAttemptAt: number | null, inFlight = false): boolean {
  if (inFlight || !view?.node?.online) return false;
  if (lastAttemptAt != null && now - lastAttemptAt < THROTTLE_MS) return false;
  return !view.claude.loggedIn || authStale(view.claude, now);
}

/** 页面是否该显示「正在检查」而不是「登录 Claude」：缓存未登录且不可信（过期），并且检查正在进行或马上会开始。 */
export function showChecking(view: View, now: number, lastAttemptAt: number | null, inFlight: boolean): boolean {
  if (!view?.node?.online || view.claude.loggedIn || !authStale(view.claude, now)) return false;
  return inFlight || shouldRecheck(view, now, lastAttemptAt, false);
}

// ── 全局（模块级）节流状态：Claude Code 页、左栏卡片、设置页同时挂载时只查一次 ──
let lastAttemptAt: number | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getInFlight = () => inFlight !== null;

/** 测试用：重置节流状态。 */
export function resetClaudeAuthRecheck() {
  lastAttemptAt = null;
  inFlight = null;
  emit();
}

/**
 * 需要时触发一次复查；返回是否真的发起了。`check` 默认是 POST /claude/check，测试可以替换。
 * 成功后只把新的 claude 写回缓存（不整页刷新）；失败安静吞掉（下一次聚焦 / 轮询再说）。
 * 检查期间缓存被别的路径（退出、手动重新检查）换过（`checkedAt` 不同）时，这份结果已经过时，不写回——
 * 否则刚退出的账号会被一次早就发出的自动检查改回「已登录」。
 */
export function maybeRecheckClaudeAuth(
  queryClient: QueryClient,
  now = Date.now(),
  check: () => Promise<{ claude: ClaudeAuth }> = ccApi.check,
): boolean {
  const view = queryClient.getQueryData<CloudWorkspaceView>(ccKeys.status);
  if (!shouldRecheck(view, now, lastAttemptAt, inFlight !== null)) return false;
  lastAttemptAt = now;
  const startedWith = view?.claude.checkedAt ?? null;
  inFlight = (async () => {
    try {
      const { claude } = await check();
      if (claude) {
        queryClient.setQueryData<CloudWorkspaceView>(ccKeys.status, (old) => {
          if (!old) return old;
          if ((old.claude.checkedAt ?? null) !== startedWith) return old;
          return { ...old, claude };
        });
      }
    } catch {
      // 节点刚好离线 / 超时：保留缓存值，按节流下次再试。
    } finally {
      inFlight = null;
      emit();
    }
  })();
  emit();
  return true;
}

/**
 * 在 Claude Code 页、设置 → 云端工作区里调用。返回 `checking`：缓存「未登录」但还不可信、正在（或马上）去节点确认，
 * 这时页面应显示安静的检查态。
 */
export function useClaudeAuthRecheck(): { checking: boolean } {
  const queryClient = useQueryClient();
  const status = useQuery(cloudWorkspaceQueryOptions());
  const busy = useSyncExternalStore(subscribe, getInFlight, getInFlight);
  const d = status.data;
  const online = !!d?.node?.online;
  const loggedIn = !!d?.claude.loggedIn;
  const checkedAt = d?.claude.checkedAt ?? null;

  // 打开页面、节点上下线、登录状态 / 检查时间变化时评估一次（15 秒轮询数据不变时不会重复触发）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: !!d / online / loggedIn / checkedAt 是刻意选的触发条件，15 秒轮询数据不变时不重复触发
  useEffect(() => {
    if (!d) return;
    maybeRecheckClaudeAuth(queryClient);
  }, [queryClient, !!d, online, loggedIn, checkedAt]);

  // 窗口重新获得焦点 / 切回标签页。
  useEffect(() => {
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      maybeRecheckClaudeAuth(queryClient);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [queryClient]);

  return { checking: showChecking(d, Date.now(), lastAttemptAt, busy) };
}
