/**
 * 共享契约直接委托层：全部风控判定、域名黑名单与会话状态机逻辑直接来自 shared/browser-companion.ts（唯一真相源）。
 */

export {
  assessBrowserActionRisk,
  type BrowserActionRiskAssessment,
  type BrowserActionRiskInput,
  type BrowserCompanionEvent,
  type BrowserCompanionSession,
  type BrowserCompanionState,
  canCompanionBotAct,
  createInitialBrowserCompanionSession,
  matchBlockedOrigin,
  normalizeBlockedDomainRule,
  normalizeBlockedDomains,
  reduceBrowserCompanionSession,
} from "../../../shared/browser-companion";

import { matchBlockedOrigin } from "../../../shared/browser-companion";

export function getBlockedUrlReason(
  rawUrl: string | null | undefined,
  blockedDomains: readonly string[] = [],
): string | null {
  const result = matchBlockedOrigin(rawUrl, blockedDomains);
  return result.blocked ? result.reason : null;
}
