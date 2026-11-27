import {
  type BrowserActionRiskAssessment,
  assessBrowserActionRisk,
  matchBlockedOrigin,
} from "../../../shared/browser-companion";
import type {
  BrowserPermissionTier,
  BrowserSnapshotElement,
} from "../types/protocol";
import type { TabGroupSnapshot } from "./tab-group-manager";

/**
 * 扩展后台指令安全守卫（纯函数层）：
 * 1. 显式 tabId 严格标签组隔离：只能访问 Bot 受控标签组内或当前已附着的标签页，绝不触碰组外用户标签；
 * 2. 黑名单标签页零劫持：对黑名单站点任何操作一律拒绝；若当前活跃页为黑名单站点而 Bot 要导航到安全站点，
 *    强制隔离新开受控标签页，绝不对原黑名单标签页收组或挂接 CDP；
 * 3. `browser_navigate({ newTab: true })` 前置校验目标 URL 黑名单，拒绝后再绝不打开标签页。
 */

export interface TabScopeCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkExplicitTabScope(
  explicitTabId: number,
  snapshot: Pick<
    TabGroupSnapshot,
    "attached" | "activeTab" | "controlledTabIds"
  >,
): TabScopeCheckResult {
  if (snapshot.controlledTabIds.includes(explicitTabId)) {
    return { allowed: true };
  }
  if (snapshot.attached && snapshot.activeTab?.tabId === explicitTabId) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `安全隔离：标签页 #${explicitTabId} 不在当前 Bot 标签组内且未被用户附着，禁止访问或操控组外标签页。`,
  };
}

export interface NavigationTargetPlan {
  ok: boolean;
  mode: "reuse_tab" | "open_new_tab" | "deny";
  targetTabId?: number;
  reason?: string;
}

/**
 * 为 `browser_navigate` 规划安全的目标标签页策略：
 * - 先校验目标 URL 黑名单（无论 newTab 与否），命中则直接拒绝（绝不先开标签）；
 * - 若显式指定 tabId，必须通过标签组隔离校验，且该指定标签页本身不能处于黑名单中；
 * - 若未显式指定 tabId 且当前候选标签页处于黑名单（如 chrome://settings 或密码管理器），
 *   绝不对其收组或挂接 CDP，改为强制打开全新的安全受控标签页。
 */
export function planSafeNavigationTarget(input: {
  targetUrl: string;
  newTab: boolean;
  explicitTabId: number | null;
  candidateTabId: number | null;
  candidateCurrentUrl: string | null;
  tabGroupSnapshot: Pick<
    TabGroupSnapshot,
    "attached" | "activeTab" | "controlledTabIds"
  >;
  blockedDomains: readonly string[];
}): NavigationTargetPlan {
  const destBlocked = matchBlockedOrigin(input.targetUrl, input.blockedDomains);
  if (destBlocked.blocked) {
    return { ok: false, mode: "deny", reason: destBlocked.reason };
  }

  if (input.newTab) {
    return { ok: true, mode: "open_new_tab" };
  }

  if (input.explicitTabId !== null) {
    const scope = checkExplicitTabScope(
      input.explicitTabId,
      input.tabGroupSnapshot,
    );
    if (!scope.allowed) {
      return { ok: false, mode: "deny", reason: scope.reason };
    }
    const sourceBlocked = matchBlockedOrigin(
      input.candidateCurrentUrl,
      input.blockedDomains,
    );
    if (sourceBlocked.blocked) {
      return {
        ok: false,
        mode: "deny",
        reason: `当前指定标签页处于受保护或黑名单站点（${sourceBlocked.rule}），禁止接管或劫持该标签页导航。`,
      };
    }
    return { ok: true, mode: "reuse_tab", targetTabId: input.explicitTabId };
  }

  if (input.candidateTabId === null) {
    return { ok: true, mode: "open_new_tab" };
  }

  const currentBlocked = matchBlockedOrigin(
    input.candidateCurrentUrl,
    input.blockedDomains,
  );
  if (currentBlocked.blocked) {
    // 当前活跃页为黑名单/系统页：严禁对其收组或挂接 CDP，改为新开干净标签页承载本次安全导航
    return { ok: true, mode: "open_new_tab" };
  }

  return { ok: true, mode: "reuse_tab", targetTabId: input.candidateTabId };
}

/**
 * 统一本地二次纵深防御风控评估：
 * 同时覆盖目标 URL（如 browser_navigate 的 args.url）与当前页面 URL（防止在黑名单页上执行任意动作）。
 */
export function evaluateLocalCallRisk(input: {
  tier: BrowserPermissionTier;
  operation: string;
  action?: string;
  targetUrl?: string | null;
  currentTabUrl?: string | null;
  explicitTabId?: number | null;
  element?: BrowserSnapshotElement | null;
  key?: string | null;
  submit?: boolean;
  blockedDomains: readonly string[];
}): BrowserActionRiskAssessment {
  // 1. 若明确指定了 tabId 或属于非导航操作，检查当前标签页 URL 是否在黑名单
  if (
    input.currentTabUrl &&
    (input.operation !== "browser_navigate" || input.explicitTabId !== null)
  ) {
    const curBlocked = matchBlockedOrigin(
      input.currentTabUrl,
      input.blockedDomains,
    );
    if (curBlocked.blocked) {
      return {
        decision: "deny",
        category: "blocked_origin",
        locked: true,
        matched: curBlocked.rule,
        reason: curBlocked.reason,
      };
    }
  }

  // 2. 委托 shared/browser-companion.ts 的唯一风控判定函数
  return assessBrowserActionRisk({
    tier: input.tier,
    operation: input.operation,
    action: input.action,
    url: input.targetUrl ?? input.currentTabUrl ?? undefined,
    element: input.element,
    key: input.key,
    submit: input.submit,
    blockedDomains: input.blockedDomains,
  });
}
