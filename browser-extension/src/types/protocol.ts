/**
 * ChisaBot 浏览器伴侣扩展内部通信协议与领域类型。
 * 共享权限档位、状态机、风控模型、快照结构与设备平台常量统一复用 shared/browser-companion.ts 与 shared/devices.ts。
 */

import type {
  BrowserCompanionState,
  BrowserCompanionYieldReason,
  BrowserPermissionTier,
  BrowserSnapshotElement,
  BrowserSnapshotResult,
  CompanionMaterialMode,
  CompanionStateReport,
  CompanionThemeId,
} from "../../../shared/browser-companion";

export {
  BROWSER_COMPANION_OPERATIONS,
  BROWSER_PERMISSION_INFO,
  BROWSER_PERMISSION_TIERS,
  MAX_COMPANION_CONTROLLED_TABS,
  type BrowserActionRiskAssessment,
  type BrowserActionRiskInput,
  type BrowserCompanionEvent,
  type BrowserCompanionOperation,
  type BrowserCompanionSession,
  type BrowserCompanionState,
  type BrowserCompanionYieldReason,
  type BrowserLiveCardPayload,
  type BrowserPermissionTier,
  type BrowserSnapshotElement,
  type BrowserSnapshotResult,
  type CompanionExtensionConfig,
  type CompanionMaterialMode,
  type CompanionServerCommand,
  type CompanionStateReport,
  type CompanionThemeId,
} from "../../../shared/browser-companion";

export {
  BROWSER_EXTENSION_PLATFORM,
  isBrowserExtensionPlatform,
} from "../../../shared/devices";

export type ThemeId = CompanionThemeId;
export type MaterialId = CompanionMaterialMode;
export type ColorMode = "light" | "dark" | "system";

export interface AppearancePrefs {
  theme: ThemeId;
  material: MaterialId;
  colorMode: ColorMode;
}

export interface CompanionAuthRecord {
  serverUrl: string;
  deviceToken: string;
  deviceId: string;
  deviceName: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  enrolledAt: string;
}

export interface CompanionLocalSettings {
  tier: BrowserPermissionTier;
  blockedDomains: string[];
  allowRemoteDispatch: boolean;
  appearance: AppearancePrefs;
  selectedBotId: string | null;
  attachedByDefault: boolean;
}

export interface TabContextSummary {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  favIconUrl?: string;
  inBotGroup: boolean;
}

export interface BrowserLiveStep {
  id: string;
  toolName: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error" | "awaiting_approval";
  url?: string;
  tabId?: number;
  at: number;
}

export interface BrowserLiveCardState {
  runKey: string;
  source: "extension" | "cloud";
  botId: string;
  botName: string;
  botAvatarUrl?: string | null;
  phaseBadge: string;
  stepLabel: string;
  tabTitle: string;
  tabUrl: string;
  tabId?: number;
  shotDataUrl?: string;
  shotUrl?: string;
  running: boolean;
  steps: BrowserLiveStep[];
}

export interface PendingApprovalItem {
  id: string;
  operation: string;
  summary: string;
  botName: string | null;
  expiresAt: string;
  remainingMs?: number;
  locked?: boolean;
  category?: string;
  source: "ws" | "companion";
}

export interface BotSummary {
  id: string;
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
  isDefault?: boolean;
}

export interface ThreadSummary {
  id: string;
  botId: string;
  title: string;
  updatedAt?: string;
}

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  streaming?: boolean;
  liveCard?: BrowserLiveCardState;
  error?: string;
}

export interface CompanionRuntimeState {
  auth: CompanionAuthRecord | null;
  wsState: "offline" | "connecting" | "online" | "revoked";
  wsError: string | null;
  sessionState: BrowserCompanionState;
  attached: boolean;
  activeTab: TabContextSummary | null;
  controlledTabIds: number[];
  tabGroupId: number | null;
  tabGroupBotName: string | null;
  activeBotId: string | null;
  activeBotName: string | null;
  activeBotAvatarUrl: string | null;
  currentStepLabel: string | null;
  currentPhaseBadge: string | null;
  latestScreenshotDataUrl: string | null;
  latestScreenshotTabId: number | null;
  latestScreenshotUrl: string | null;
  latestScreenshotTitle: string | null;
  yieldReason: string | null;
  yieldReasonCode: BrowserCompanionYieldReason | null;
  pendingApprovals: PendingApprovalItem[];
  settings: CompanionLocalSettings;
}

export interface DetectedChisaBotTab {
  tabId: number;
  origin: string;
  title: string;
  authenticated: boolean;
  userName?: string;
}

/** Background -> Content Script HUD 消息 */
export type HudInboundMessage =
  | {
      type: "HUD_UPDATE";
      payload: {
        state: BrowserCompanionState;
        botName: string;
        botAvatarUrl?: string | null;
        stepLabel: string;
        yieldReason?: string | null;
      };
    }
  | { type: "HUD_REMOVE" }
  | { type: "HUD_SYNTHETIC_WINDOW"; durationMs: number }
  | { type: "HUD_HIDE_FOR_CAPTURE" }
  | { type: "HUD_RESTORE_AFTER_CAPTURE" };

/** Content Script HUD -> Background 消息 */
export type HudOutboundMessage =
  | {
      type: "HUD_HUMAN_INTERVENTION";
      kind: "mousedown" | "keydown" | "wheel";
    }
  | { type: "HUD_USER_RESUME" }
  | { type: "HUD_USER_ABORT" };

/** Side Panel -> Background RPC 消息 */
export type PanelRequestMessage =
  | { type: "PANEL_GET_STATE" }
  | { type: "PANEL_DETECT_TABS" }
  | { type: "PANEL_CLAIM_TAB"; tabId: number; origin: string }
  | {
      type: "PANEL_LOGIN_PASSWORD";
      serverUrl: string;
      username: string;
      password: string;
      remember?: boolean;
    }
  | {
      type: "PANEL_LOGIN_PAIRING";
      serverUrl: string;
      code: string;
    }
  | { type: "PANEL_LOGOUT" }
  | { type: "PANEL_SET_ATTACHED"; attached: boolean }
  | { type: "PANEL_FOCUS_TAB"; tabId: number }
  | { type: "PANEL_RESUME_CONTROL" }
  | { type: "PANEL_ABORT_CONTROL" }
  | {
      type: "PANEL_UPDATE_SETTINGS";
      patch: Partial<CompanionLocalSettings>;
    }
  | {
      type: "PANEL_SELECT_BOT";
      botId: string;
      botName: string;
      botAvatarUrl?: string | null;
    }
  | {
      type: "PANEL_DECIDE_APPROVAL";
      id: string;
      decision: "approve" | "deny";
    }
  | { type: "PANEL_BOOTSTRAP" }
  | {
      type: "PANEL_OPEN_THREAD";
      botId: string;
      channelId?: string;
      fresh?: boolean;
    }
  | {
      type: "PANEL_SEND_MESSAGE";
      botId: string;
      channelId?: string;
      text: string;
    }
  | { type: "PANEL_STOP_RUN"; botId: string; channelId?: string }
  | { type: "PANEL_OPEN_VOICE"; botId?: string };

/** Background -> Side Panel 广播事件 */
export type PanelPushMessage =
  | { type: "STATE_SNAPSHOT"; state: CompanionRuntimeState }
  | {
      type: "CHAT_STREAM_EVENT";
      channelId: string;
      event: Record<string, unknown>;
    }
  | {
      type: "LIVE_CARD_UPDATE";
      card: BrowserLiveCardState;
    };

export type {
  BrowserSnapshotElement as CompanionSnapshotElement,
  BrowserSnapshotResult as CompanionSnapshotResult,
  CompanionStateReport as CompanionWsStateReport,
};
