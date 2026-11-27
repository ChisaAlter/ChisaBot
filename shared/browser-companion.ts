/**
 * ChisaBot 浏览器伴侣扩展（Chrome / Edge MV3）的共享契约、权限策略与接管状态机唯一真相源。
 * 服务端（server/）、全端前端（app/）与浏览器扩展（browser-extension/）统一消费本模块。
 */

/** 三档浏览器权限：仅观察 / 谨慎操作（默认）/ 完全访问。 */
export const BROWSER_PERMISSION_TIERS = [
  "observe",
  "cautious",
  "full",
] as const;

export type BrowserPermissionTier = (typeof BROWSER_PERMISSION_TIERS)[number];

export const DEFAULT_BROWSER_PERMISSION_TIER: BrowserPermissionTier =
  "cautious";

export type BrowserPermissionInfo = {
  label: string;
  shortLabel: string;
  description: string;
  dangerous: boolean;
};

export const BROWSER_PERMISSION_INFO: Record<
  BrowserPermissionTier,
  BrowserPermissionInfo
> = {
  observe: {
    label: "仅观察",
    shortLabel: "仅观察",
    description:
      "允许读取页面正文、快照、滚动、悬停、截图和列出标签页；一切点击、填表、按键、导航和开关标签页均需先确认。",
    dangerous: false,
  },
  cautious: {
    label: "谨慎操作",
    shortLabel: "谨慎",
    description:
      "默认档位。普通浏览、点击和输入直接执行；遇到删除、清空、注销、重启、关机、提交、发布、发送、改密、付款等高危操作弹出确认卡。",
    dangerous: false,
  },
  full: {
    label: "完全访问",
    shortLabel: "完全",
    description:
      "除站点黑名单硬拒绝与付款购买强制确认外直接执行，全程写入设备审计日志。",
    dangerous: true,
  },
};

export function isBrowserPermissionTier(
  value: unknown,
): value is BrowserPermissionTier {
  return (
    typeof value === "string" &&
    (BROWSER_PERMISSION_TIERS as readonly string[]).includes(value)
  );
}

export function normalizeBrowserPermissionTier(
  value: unknown,
): BrowserPermissionTier {
  return isBrowserPermissionTier(value)
    ? value
    : DEFAULT_BROWSER_PERMISSION_TIER;
}

/** 浏览器伴侣扩展支持的设备操作集合（与 shared/devices.ts 中 DeviceOperation 对齐）。 */
export const BROWSER_COMPANION_OPERATIONS = [
  "browser_tabs",
  "browser_snapshot",
  "browser_read",
  "browser_navigate",
  "browser_click",
  "browser_hover",
  "browser_type",
  "browser_key",
  "browser_scroll",
  "browser_screenshot",
  "browser_control",
] as const;

export type BrowserCompanionOperation =
  (typeof BROWSER_COMPANION_OPERATIONS)[number];

const BROWSER_COMPANION_OPERATION_SET: ReadonlySet<string> = new Set(
  BROWSER_COMPANION_OPERATIONS,
);

export function isBrowserCompanionOperation(
  value: unknown,
): value is BrowserCompanionOperation {
  return typeof value === "string" && BROWSER_COMPANION_OPERATION_SET.has(value);
}

/** 受控标签组最多接管的标签页数量。 */
export const MAX_COMPANION_CONTROLLED_TABS = 8;

/** 浏览器接管会话的五个显式状态。 */
export const BROWSER_COMPANION_STATES = [
  "idle",
  "controlling",
  "yielded_to_human",
  "awaiting_approval",
  "detached",
] as const;

export type BrowserCompanionState = (typeof BROWSER_COMPANION_STATES)[number];

export function isBrowserCompanionState(
  value: unknown,
): value is BrowserCompanionState {
  return (
    typeof value === "string" &&
    (BROWSER_COMPANION_STATES as readonly string[]).includes(value)
  );
}

export type BrowserCompanionYieldReason =
  | "human_input"
  | "challenge"
  | "manual";

export type BrowserCompanionDetachReason =
  | "user_close_hud"
  | "user_toggle_off"
  | "sidepanel_closed"
  | "debugger_cancelled"
  | "kill_switch"
  | "remote_disconnect"
  | "tab_closed";

export type BrowserActionRiskDecision = "allow" | "ask" | "deny";

export type BrowserActionRiskCategory =
  | "safe"
  | "blocked_origin"
  | "purchase"
  | "write"
  | "high_risk";

export type BrowserActionRiskAssessment = {
  decision: BrowserActionRiskDecision;
  category: BrowserActionRiskCategory;
  reason: string;
  /** 为 true 表示安全底线锁定，任何权限档位（含 full）均不可绕过。 */
  locked?: boolean;
  /** 命中的规则、协议或关键词，供审计与确认卡片展示。 */
  matched?: string;
};

export type BrowserCompanionPendingApproval = {
  approvalId: string;
  operation: BrowserCompanionOperation;
  summary: string;
  category: Exclude<BrowserActionRiskCategory, "safe">;
  locked?: boolean;
};

/** 单一接管会话状态快照（纯函数状态机 `reduceBrowserCompanionSession` 的唯一状态对象）。 */
export type BrowserCompanionSession = {
  sessionId: string;
  deviceId: string | null;
  botId: string | null;
  botName: string | null;
  state: BrowserCompanionState;
  /** 是否处于当前页附着状态；detached 时恒为 false。 */
  attached: boolean;
  /** 是否已挂接会话级 chrome.debugger（CDP）；纯聊天未触发工具前为 false，detach/急停/断连恒为 false。 */
  debuggerAttached: boolean;
  /** 页内 HUD 光框与顶部胶囊是否可见；仅 controlling / yielded_to_human / awaiting_approval 为 true。 */
  hudVisible: boolean;
  /** Bot 当前是否实际持有操控锁；严格当且仅当 state === "controlling" 时为 true。 */
  botControlHeld: boolean;
  /** 真人接手后恢复控制时必须先重抓快照再执行写操作，防止陈旧 ref 误点。 */
  resumeSnapshotRequired: boolean;
  /** 是否被紧急停止锁定；为 true 时只能由用户显式重新 attach 解除。 */
  killSwitched: boolean;
  tabGroupId: number | null;
  activeTabId: number | null;
  tabCount: number;
  currentStepLabel: string | null;
  yieldReason: BrowserCompanionYieldReason | null;
  detachReason: BrowserCompanionDetachReason | null;
  pendingApproval: BrowserCompanionPendingApproval | null;
  allowRemoteDispatch: boolean;
  updatedAt: number;
};

export type BrowserCompanionEvent =
  | {
      type: "attach";
      tabId?: number | null;
      deviceId?: string | null;
      botId?: string | null;
      botName?: string | null;
      allowRemoteDispatch?: boolean;
      timestamp?: number;
    }
  | {
      type: "tool_start";
      botId?: string | null;
      botName?: string | null;
      tabId?: number | null;
      tabGroupId?: number | null;
      tabCount?: number;
      stepLabel?: string | null;
      timestamp?: number;
    }
  | {
      type: "tool_step";
      stepLabel?: string | null;
      tabId?: number | null;
      tabGroupId?: number | null;
      tabCount?: number;
      snapshotTaken?: boolean;
      operation?: BrowserCompanionOperation;
      timestamp?: number;
    }
  | {
      type: "human_input";
      reason?: string;
      timestamp?: number;
    }
  | {
      type: "challenge";
      reason?: string;
      timestamp?: number;
    }
  | {
      type: "approval_requested";
      approval: BrowserCompanionPendingApproval;
      stepLabel?: string | null;
      timestamp?: number;
    }
  | {
      type: "approval_resolved";
      approvalId: string;
      approved: boolean;
      /** 拒绝时是否同时结束本轮操控并回到 idle（默认 true）。 */
      endTurn?: boolean;
      stepLabel?: string | null;
      timestamp?: number;
    }
  | {
      type: "resume";
      stepLabel?: string | null;
      timestamp?: number;
    }
  | {
      type: "turn_complete";
      timestamp?: number;
    }
  | {
      type: "detach";
      reason?: BrowserCompanionDetachReason;
      timestamp?: number;
    }
  | {
      type: "kill_switch";
      timestamp?: number;
    }
  | {
      type: "remote_disconnect";
      timestamp?: number;
    };

export function createInitialBrowserCompanionSession(
  init: Partial<
    Pick<
      BrowserCompanionSession,
      | "sessionId"
      | "deviceId"
      | "botId"
      | "botName"
      | "activeTabId"
      | "allowRemoteDispatch"
      | "attached"
      | "updatedAt"
    >
  > = {},
): BrowserCompanionSession {
  const attached = init.attached ?? true;
  const activeTabId = attached ? (init.activeTabId ?? null) : null;
  return {
    sessionId: init.sessionId ?? "companion-session",
    deviceId: init.deviceId ?? null,
    botId: init.botId ?? null,
    botName: init.botName ?? null,
    state: attached ? "idle" : "detached",
    attached,
    debuggerAttached: false,
    hudVisible: false,
    botControlHeld: false,
    resumeSnapshotRequired: false,
    killSwitched: false,
    tabGroupId: null,
    activeTabId,
    tabCount: attached && activeTabId !== null ? 1 : 0,
    currentStepLabel: null,
    yieldReason: null,
    detachReason: attached ? null : "user_toggle_off",
    pendingApproval: null,
    allowRemoteDispatch: init.allowRemoteDispatch ?? false,
    updatedAt: init.updatedAt ?? 0,
  };
}

function clampTabCount(
  raw: number | undefined,
  fallback: number,
  minimum: number,
): number {
  const candidate =
    typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.min(
    MAX_COMPANION_CONTROLLED_TABS,
    Math.max(minimum, candidate),
  );
}

function detachSession(
  state: Readonly<BrowserCompanionSession>,
  reason: BrowserCompanionDetachReason,
  killSwitched: boolean,
  updatedAt: number,
): BrowserCompanionSession {
  return {
    ...state,
    state: "detached",
    attached: false,
    debuggerAttached: false,
    hudVisible: false,
    botControlHeld: false,
    resumeSnapshotRequired: false,
    killSwitched: killSwitched || state.killSwitched,
    tabGroupId: null,
    activeTabId: null,
    tabCount: 0,
    currentStepLabel: null,
    yieldReason: null,
    detachReason: reason,
    pendingApproval: null,
    updatedAt,
  };
}

/**
 * 纯函数接管会话状态机：严禁原地修改入参。
 *
 * 核心不变量：
 * 1. `botControlHeld === (state === "controlling")`；
 * 2. `yielded_to_human` 与 `awaiting_approval` 期间忽略任何 Bot 的 `tool_start`/`tool_step`；
 * 3. `resume` 仅能从 `yielded_to_human` 恢复，并强制置位 `resumeSnapshotRequired = true`；
 * 4. `detach` / `kill_switch` / `remote_disconnect` 从任意态立即释放操控锁、CDP 调试与 HUD；
 * 5. `kill_switch` 后仅用户显式 `attach` 可解除锁定回到 `idle`。
 */
export function reduceBrowserCompanionSession(
  state: Readonly<BrowserCompanionSession>,
  event: BrowserCompanionEvent,
): BrowserCompanionSession {
  const updatedAt = event.timestamp ?? state.updatedAt;

  switch (event.type) {
    case "attach": {
      const nextDeviceId =
        event.deviceId !== undefined ? event.deviceId : state.deviceId;
      const nextBotId = event.botId !== undefined ? event.botId : state.botId;
      const nextBotName =
        event.botName !== undefined ? event.botName : state.botName;
      const nextAllowRemote =
        event.allowRemoteDispatch !== undefined
          ? event.allowRemoteDispatch
          : state.allowRemoteDispatch;

      if (state.state === "detached" || state.state === "idle") {
        const nextTabId =
          event.tabId !== undefined ? event.tabId : state.activeTabId;
        const nextTabCount =
          nextTabId !== null ? clampTabCount(undefined, state.tabCount, 1) : 0;
        return {
          ...state,
          deviceId: nextDeviceId,
          botId: nextBotId,
          botName: nextBotName,
          allowRemoteDispatch: nextAllowRemote,
          state: "idle",
          attached: true,
          hudVisible: false,
          botControlHeld: false,
          killSwitched: false,
          detachReason: null,
          yieldReason: null,
          pendingApproval: null,
          activeTabId: nextTabId,
          tabCount: nextTabCount,
          updatedAt,
        };
      }

      // 已在控制/礼让/等待审批中时，仅更新元数据，绝不破坏当前锁或挂起态。
      return {
        ...state,
        deviceId: nextDeviceId,
        allowRemoteDispatch: nextAllowRemote,
        updatedAt,
      };
    }

    case "tool_start": {
      if (
        state.killSwitched ||
        !state.attached ||
        (state.state !== "idle" && state.state !== "controlling")
      ) {
        return { ...state };
      }

      const nextTabId =
        event.tabId !== undefined ? event.tabId : state.activeTabId;
      const nextTabGroupId =
        event.tabGroupId !== undefined ? event.tabGroupId : state.tabGroupId;
      return {
        ...state,
        state: "controlling",
        attached: true,
        debuggerAttached: true,
        hudVisible: true,
        botControlHeld: true,
        botId: event.botId !== undefined ? event.botId : state.botId,
        botName: event.botName !== undefined ? event.botName : state.botName,
        activeTabId: nextTabId,
        tabGroupId: nextTabGroupId,
        tabCount: clampTabCount(event.tabCount, state.tabCount, 1),
        currentStepLabel:
          event.stepLabel !== undefined
            ? event.stepLabel
            : (state.currentStepLabel ?? "正在操作页面"),
        yieldReason: null,
        detachReason: null,
        pendingApproval: null,
        updatedAt,
      };
    }

    case "tool_step": {
      if (state.state !== "controlling" || !state.botControlHeld) {
        return { ...state };
      }
      const clearedSnapshot =
        event.snapshotTaken === true || event.operation === "browser_snapshot";
      return {
        ...state,
        activeTabId:
          event.tabId !== undefined ? event.tabId : state.activeTabId,
        tabGroupId:
          event.tabGroupId !== undefined ? event.tabGroupId : state.tabGroupId,
        tabCount: clampTabCount(event.tabCount, state.tabCount, 1),
        currentStepLabel:
          event.stepLabel !== undefined
            ? event.stepLabel
            : state.currentStepLabel,
        resumeSnapshotRequired: clearedSnapshot
          ? false
          : state.resumeSnapshotRequired,
        updatedAt,
      };
    }

    case "human_input": {
      if (
        state.state !== "controlling" &&
        state.state !== "awaiting_approval" &&
        state.state !== "yielded_to_human"
      ) {
        return { ...state };
      }
      return {
        ...state,
        state: "yielded_to_human",
        botControlHeld: false,
        hudVisible: true,
        pendingApproval: null,
        yieldReason: "human_input",
        resumeSnapshotRequired: true,
        currentStepLabel: event.reason ?? "已暂停，等待你操作",
        updatedAt,
      };
    }

    case "challenge": {
      if (
        state.state !== "controlling" &&
        state.state !== "awaiting_approval" &&
        state.state !== "yielded_to_human"
      ) {
        return { ...state };
      }
      return {
        ...state,
        state: "yielded_to_human",
        botControlHeld: false,
        hudVisible: true,
        pendingApproval: null,
        yieldReason: "challenge",
        resumeSnapshotRequired: true,
        currentStepLabel: event.reason ?? "遇到验证或登录挑战，请人工完成",
        updatedAt,
      };
    }

    case "approval_requested": {
      if (state.state !== "controlling" || !state.botControlHeld) {
        return { ...state };
      }
      return {
        ...state,
        state: "awaiting_approval",
        botControlHeld: false,
        hudVisible: true,
        pendingApproval: { ...event.approval },
        currentStepLabel: event.stepLabel ?? event.approval.summary,
        updatedAt,
      };
    }

    case "approval_resolved": {
      if (
        state.state !== "awaiting_approval" ||
        !state.pendingApproval ||
        state.pendingApproval.approvalId !== event.approvalId
      ) {
        return { ...state };
      }

      if (event.approved) {
        return {
          ...state,
          state: "controlling",
          botControlHeld: true,
          hudVisible: true,
          pendingApproval: null,
          currentStepLabel:
            event.stepLabel !== undefined
              ? event.stepLabel
              : state.currentStepLabel,
          updatedAt,
        };
      }

      if (event.endTurn === false) {
        return {
          ...state,
          state: "controlling",
          botControlHeld: true,
          hudVisible: true,
          pendingApproval: null,
          currentStepLabel: event.stepLabel ?? "操作已拒绝，等待机器人继续",
          updatedAt,
        };
      }

      return {
        ...state,
        state: "idle",
        botControlHeld: false,
        hudVisible: false,
        pendingApproval: null,
        yieldReason: null,
        currentStepLabel: null,
        updatedAt,
      };
    }

    case "resume": {
      if (
        state.state !== "yielded_to_human" ||
        state.killSwitched ||
        !state.attached
      ) {
        return { ...state };
      }
      return {
        ...state,
        state: "controlling",
        debuggerAttached: true,
        hudVisible: true,
        botControlHeld: true,
        yieldReason: null,
        pendingApproval: null,
        resumeSnapshotRequired: true,
        currentStepLabel: event.stepLabel ?? "已交还控制，正在重新获取快照",
        updatedAt,
      };
    }

    case "turn_complete": {
      if (state.state !== "controlling") {
        return { ...state };
      }
      return {
        ...state,
        state: "idle",
        botControlHeld: false,
        hudVisible: false,
        currentStepLabel: null,
        pendingApproval: null,
        yieldReason: null,
        updatedAt,
      };
    }

    case "detach":
      return detachSession(
        state,
        event.reason ?? "user_close_hud",
        false,
        updatedAt,
      );

    case "kill_switch":
      return detachSession(state, "kill_switch", true, updatedAt);

    case "remote_disconnect":
      return detachSession(state, "remote_disconnect", false, updatedAt);
  }
}

export type CompanionBotActGate =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "kill_switched"
        | "detached"
        | "idle"
        | "yielded_to_human"
        | "awaiting_approval"
        | "snapshot_required";
    };

/**
 * 校验当前会话状态下 Bot 是否允许执行浏览器操作。
 * 供服务端路由器与扩展 Service Worker 双端共用。
 */
export function canCompanionBotAct(
  session: Readonly<BrowserCompanionSession>,
  options: { mutating?: boolean } = {},
): CompanionBotActGate {
  if (session.killSwitched) {
    return { allowed: false, reason: "kill_switched" };
  }
  if (session.state === "detached" || !session.attached) {
    return { allowed: false, reason: "detached" };
  }
  if (session.state === "yielded_to_human") {
    return { allowed: false, reason: "yielded_to_human" };
  }
  if (session.state === "awaiting_approval") {
    return { allowed: false, reason: "awaiting_approval" };
  }
  if (session.state === "idle" || !session.botControlHeld) {
    return { allowed: false, reason: "idle" };
  }
  if (options.mutating && session.resumeSnapshotRequired) {
    return { allowed: false, reason: "snapshot_required" };
  }
  return { allowed: true };
}

/* ============================================================================
 * 站点黑名单（协议 + 域名 + 路径前缀）与权限风险评估
 * ============================================================================ */

/** 内置硬禁止协议（此外任何非 http/https 协议均默认 fail-closed 拒绝）。 */
export const BUILTIN_BLOCKED_PROTOCOLS = [
  "chrome:",
  "edge:",
  "about:",
  "file:",
  "chrome-extension:",
  "chrome-untrusted:",
  "chrome-search:",
  "edge-extension:",
  "extension:",
  "moz-extension:",
  "devtools:",
  "view-source:",
  "javascript:",
  "data:",
  "blob:",
  "filesystem:",
  "brave:",
  "opera:",
  "vivaldi:",
] as const;

/** 内置硬禁止站点/扩展商店/常见密码管理器（不可通过用户配置或 full 档移除）。 */
export const BUILTIN_BLOCKED_DOMAINS = [
  // 浏览器扩展商店
  "chromewebstore.google.com",
  "chrome.google.com/webstore",
  "microsoftedge.microsoft.com/addons",
  "addons.mozilla.org",
  // 常见密码管理器
  "1password.com",
  "1password.eu",
  "1password.ca",
  "bitwarden.com",
  "bitwarden.eu",
  "lastpass.com",
  "dashlane.com",
  "keepersecurity.com",
  "keepersecurity.eu",
  "keepersecurity.com.au",
  "nordpass.com",
  "roboform.com",
  "enpass.io",
  "pass.proton.me",
  "passwords.google.com",
  "passwords.apple.com",
  "icloud.com/passwords",
  "authy.com",
] as const;

type ParsedOriginRule = {
  raw: string;
  hostname: string;
  pathPrefix: string | null;
};

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeHostname(rawHost: string): string | null {
  let host = rawHost.trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  // 去掉所有尾点（防止 `1password.com.` FQDN 绕过）。
  host = host.replace(/\.+$/, "");
  if (!host || host.startsWith(".") || host.includes("..")) return null;
  if (hasControlChar(host) || /\s/.test(host)) return null;
  try {
    const parsed = new URL(`https://${host}`);
    const canonical = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    return canonical || null;
  } catch {
    return null;
  }
}

function safeDecodePercentSequences(text: string): string {
  // 对合法 %XX 序列逐段解码（支持多字节 UTF-8），局部出现非法 %ZZ 时不放弃整条路径解码。
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%[0-9a-fA-F]{2}/g, (single) => {
        try {
          return decodeURIComponent(single);
        } catch {
          return single;
        }
      });
    }
  });
}

function normalizePathname(rawPathname: string): string {
  const decoded = safeDecodePercentSequences(rawPathname);
  const segments = decoded
    .toLowerCase()
    .replaceAll("\\", "/")
    .split("/");
  const resolved: string[] = [];
  for (const rawSegment of segments) {
    // 剥离每个路径段的 `;...` 矩阵参数（防止 `/addons;v=1/` 与 `/foo/..;x=1/addons` 绕过）。
    const semiIdx = rawSegment.indexOf(";");
    const segment = semiIdx >= 0 ? rawSegment.slice(0, semiIdx) : rawSegment;
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length === 0 ? "/" : `/${resolved.join("/")}`;
}

function parseBlockedRule(rawRule: string): ParsedOriginRule | null {
  const trimmed = rawRule.trim();
  if (!trimmed || hasControlChar(trimmed)) return null;

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      const hostname = normalizeHostname(parsed.hostname);
      if (!hostname) return null;
      const normalizedPath = normalizePathname(parsed.pathname);
      return {
        raw: trimmed,
        hostname,
        pathPrefix: normalizedPath === "/" ? null : normalizedPath,
      };
    } catch {
      return null;
    }
  }

  // 支持 `*.example.com` 或 `.example.com` 写法。
  candidate = candidate.replace(/^\*\./, "").replace(/^\.+/, "");
  if (!candidate || candidate === "*") return null;

  try {
    const parsed = new URL(`https://${candidate}`);
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) return null;
    const normalizedPath = normalizePathname(parsed.pathname);
    return {
      raw: trimmed,
      hostname,
      pathPrefix: normalizedPath === "/" ? null : normalizedPath,
    };
  } catch {
    return null;
  }
}

/** 规整单条用户自定义黑名单域名/路径规则；非法规则返回 null。 */
export function normalizeBlockedDomainRule(rawRule: string): string | null {
  const parsed = parseBlockedRule(rawRule);
  if (!parsed) return null;
  return parsed.pathPrefix
    ? `${parsed.hostname}${parsed.pathPrefix}`
    : parsed.hostname;
}

/** 规整并去重用户自定义黑名单列表。 */
export function normalizeBlockedDomains(
  domains: readonly unknown[] | null | undefined,
): string[] {
  if (!Array.isArray(domains)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of domains) {
    if (typeof item !== "string") continue;
    const normalized = normalizeBlockedDomainRule(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

const PARSED_BUILTIN_RULES: readonly ParsedOriginRule[] = BUILTIN_BLOCKED_DOMAINS
  .map((entry) => parseBlockedRule(entry))
  .filter((rule): rule is ParsedOriginRule => rule !== null);

function matchesParsedRule(
  hostname: string,
  pathname: string,
  rule: ParsedOriginRule,
): boolean {
  const hostMatched =
    hostname === rule.hostname || hostname.endsWith(`.${rule.hostname}`);
  if (!hostMatched) return false;
  if (!rule.pathPrefix) return true;
  return pathname === rule.pathPrefix || pathname.startsWith(`${rule.pathPrefix}/`);
}

export type BlockedOriginMatch =
  | { blocked: false }
  | { blocked: true; rule: string; reason: string };

/**
 * 判定给定 URL 是否命中受保护协议、内置硬禁止域名/路径或用户自定义黑名单。
 * 针对大小写、尾点（FQDN）、子域名、端口、百分号编码、路径遍历与非 http/https 协议做防绕过校验。
 */
export function matchBlockedOrigin(
  rawUrl: string | null | undefined,
  customBlockedDomains?: readonly string[],
): BlockedOriginMatch {
  if (typeof rawUrl !== "string") return { blocked: false };
  const trimmed = rawUrl.trim();
  if (!trimmed) return { blocked: false };

  if (hasControlChar(trimmed)) {
    return {
      blocked: true,
      rule: "control-char",
      reason: "页面地址包含控制字符，已禁止访问。",
    };
  }

  // 显式检查协议前缀（含大小写、view-source:、chrome:、edge:、about:、file:、javascript: 等）。
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  let parsedUrl: URL;
  if (schemeMatch) {
    const scheme = `${(schemeMatch[1] ?? "").toLowerCase()}:`;
    if (scheme !== "http:" && scheme !== "https:") {
      return {
        blocked: true,
        rule: scheme,
        reason: `禁止在受保护协议（${scheme}）页面上执行操作。`,
      };
    }
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      return {
        blocked: true,
        rule: "invalid-url",
        reason: "无法解析的页面地址，已按安全策略拒绝。",
      };
    }
  } else {
    // 兼容协议相对地址（//example.com）或无协议域名，避免跳过黑名单校验。
    const normalizedInput = trimmed.startsWith("//")
      ? `https:${trimmed}`
      : `https://${trimmed}`;
    try {
      parsedUrl = new URL(normalizedInput);
    } catch {
      return {
        blocked: true,
        rule: "invalid-url",
        reason: "无法解析的页面地址，已按安全策略拒绝。",
      };
    }
  }

  const protocol = parsedUrl.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return {
      blocked: true,
      rule: protocol,
      reason: `禁止在受保护协议（${protocol}）页面上执行操作。`,
    };
  }

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (!hostname) {
    return {
      blocked: true,
      rule: "invalid-host",
      reason: "无法识别页面主机名，已按安全策略拒绝。",
    };
  }

  const pathname = normalizePathname(parsedUrl.pathname);

  for (const rule of PARSED_BUILTIN_RULES) {
    if (matchesParsedRule(hostname, pathname, rule)) {
      return {
        blocked: true,
        rule: rule.raw,
        reason: `当前站点命中内置安全黑名单（${rule.raw}），禁止机器人访问或操作。`,
      };
    }
  }

  if (customBlockedDomains && customBlockedDomains.length > 0) {
    for (const rawCustom of customBlockedDomains) {
      const rule = parseBlockedRule(rawCustom);
      if (rule && matchesParsedRule(hostname, pathname, rule)) {
        return {
          blocked: true,
          rule: rule.raw,
          reason: `当前站点命中自定义黑名单（${rule.raw}），禁止机器人访问或操作。`,
        };
      }
    }
  }

  return { blocked: false };
}

export type BrowserRiskOperation =
  | BrowserCompanionOperation
  | "computer_navigate"
  | "computer_snapshot"
  | "computer_read"
  | "computer_click"
  | "computer_hover"
  | "computer_type"
  | "computer_key"
  | "computer_scroll"
  | "computer_screenshot"
  | "tab_open"
  | "tab_close"
  | "tab_activate"
  | (string & {});

export type BrowserActionElementContext = {
  role?: string;
  name?: string;
  label?: string;
  type?: string;
  ariaLabel?: string;
  title?: string;
};

export type BrowserActionRiskInput = {
  tier?: BrowserPermissionTier | string;
  operation: BrowserRiskOperation;
  /** 可选子动作（如 browser_tabs 的 "list" | "new" | "open" | "close" | "activate"，或 browser_control 的 "status" | "detach"）。 */
  action?: string;
  url?: string | null;
  element?: BrowserActionElementContext | null;
  key?: string | null;
  submit?: boolean;
  blockedDomains?: readonly string[];
};

const READ_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  "browser_snapshot",
  "computer_snapshot",
  "snapshot",
  "browser_read",
  "computer_read",
  "read",
  "browser_scroll",
  "computer_scroll",
  "scroll",
  "browser_hover",
  "computer_hover",
  "hover",
  "browser_screenshot",
  "computer_screenshot",
  "screenshot",
]);

const SAFE_TAB_ACTIONS: ReadonlySet<string> = new Set(["", "list", "get"]);

const SAFE_CONTROL_ACTIONS: ReadonlySet<string> = new Set([
  "status",
  "get",
  "detach",
  "pause",
  "yield",
  "stop",
  "hud_update",
]);

function isReadOnlyOperation(
  operation: string,
  action: string | undefined,
): boolean {
  const op = operation.trim().toLowerCase();
  const sub = (action ?? "").trim().toLowerCase();
  if (READ_ONLY_OPERATIONS.has(op)) return true;
  if (op === "browser_tabs" || op === "tabs") {
    return SAFE_TAB_ACTIONS.has(sub);
  }
  if (op === "browser_control") {
    return sub.length > 0 && SAFE_CONTROL_ACTIONS.has(sub);
  }
  return false;
}

function collectElementText(
  element: BrowserActionElementContext | null | undefined,
): string {
  if (!element) return "";
  return [element.name, element.label, element.ariaLabel, element.title]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .trim();
}

const INVISIBLE_CHAR_REGEX =
  /[\u00ad\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

function stripInvisibleChars(text: string): string {
  return text.replace(INVISIBLE_CHAR_REGEX, "");
}

function normalizeForChineseKeyword(text: string): string {
  // 折叠 Ant Design / Element Plus 等组件库在双字中文按钮中插入的空格/全角空格以及零宽字符。
  return stripInvisibleChars(text).replace(/\s+/g, "");
}

function normalizeForEnglishKeyword(text: string): string {
  return stripInvisibleChars(text)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

const PURCHASE_ZH_PATTERNS: readonly string[] = [
  "确认下单",
  "立即下单",
  "提交订单",
  "确认购买",
  "立即购买",
  "立即支付",
  "确认支付",
  "确认付款",
  "微信支付",
  "支付宝支付",
  "去结算",
  "去结账",
  "确认交易",
  "确认扣款",
  "付款",
  "支付",
  "购买",
  "买单",
  "下单",
  "结账",
  "结算",
  "转账",
  "汇款",
  "打款",
  "扣款",
  "充值",
  "续费",
  "订阅",
  "提现",
  "打赏",
  "收银台",
];

const PURCHASE_EN_REGEX =
  /\b(pay\s+now|confirm\s+payment|complete\s+payment|authorize\s+payment|make\s+payment|payment|pay|checkout|check\s+out|proceed\s+to\s+checkout|place\s+order|confirm\s+order|submit\s+order|order\s+now|complete\s+purchase|buy\s+now|purchase|buy|wire\s+transfer|bank\s+transfer|send\s+money|transfer\s+funds|transfer|subscribe|upgrade\s+plan|top\s+up|recharge|withdraw|donate|alipay|wechat\s+pay|apple\s+pay|google\s+pay|paypal|billing)\b/i;

function matchPurchaseKeyword(text: string): string | null {
  if (!text) return null;
  const compactZh = normalizeForChineseKeyword(text);
  for (const kw of PURCHASE_ZH_PATTERNS) {
    if (compactZh.includes(kw)) return kw;
  }
  const normalized = normalizeForEnglishKeyword(text);
  const enMatch = PURCHASE_EN_REGEX.exec(normalized);
  return enMatch ? enMatch[0] : null;
}

const HIGH_RISK_ZH_PATTERNS: readonly string[] = [
  "永久删除",
  "彻底删除",
  "确认删除",
  "修改密码",
  "更改密码",
  "重置密码",
  "设置密码",
  "改密",
  "重装系统",
  "恢复出厂",
  "强制关机",
  "重新启动",
  "退出登录",
  "清空回收站",
  "移到回收站",
  "移至废纸篓",
  "移交所有权",
  "转让所有权",
  "释放实例",
  "导出私钥",
  "重置密钥",
  "生成密钥",
  "删除",
  "清空",
  "清除",
  "销毁",
  "移除",
  "注销",
  "销户",
  "解绑",
  "停用",
  "封禁",
  "解散",
  "重启",
  "关机",
  "断电",
  "重装",
  "重置",
  "格式化",
  "擦除",
  "回滚",
  "提交",
  "发布",
  "发表",
  "发帖",
  "发送",
  "群发",
  "转发",
  "推送",
  "广播",
  "撤销",
  "吊销",
  "作废",
  "退订",
  "部署",
  "下线",
];

const HIGH_RISK_EN_REGEX =
  /\b(delete\s+account|close\s+account|cancel\s+account|delete\s+forever|delete\s+permanently|permanently\s+delete|confirm\s+delete|empty\s+trash|empty\s+bin|move\s+to\s+trash|move\s+to\s+bin|factory\s+reset|change\s+password|reset\s+password|update\s+password|transfer\s+ownership|revoke\s+token|revoke\s+key|export\s+private\s+key|shut\s+down|power\s+off|clear\s+all|send\s+email|send\s+message|delete|remove|destroy|purge|erase|wipe|format|reset|reinstall|rebuild|reboot|restart|shutdown|halt|terminate|deactivate|unregister|uninstall|revoke|submit|publish|send|post|reply|broadcast|deploy|drop|truncate)\b/i;

function matchHighRiskKeyword(text: string): string | null {
  if (!text) return null;
  const compactZh = normalizeForChineseKeyword(text);
  for (const kw of HIGH_RISK_ZH_PATTERNS) {
    if (compactZh.includes(kw)) return kw;
  }
  const normalized = normalizeForEnglishKeyword(text);
  const enMatch = HIGH_RISK_EN_REGEX.exec(normalized);
  return enMatch ? enMatch[0] : null;
}

function isSubmitKey(rawKey: string | null | undefined): boolean {
  if (typeof rawKey !== "string") return false;
  const normalized = rawKey.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === "enter" ||
    normalized === "return" ||
    normalized === "numpadenter" ||
    /(^|\+)(enter|return|numpadenter)$/.test(normalized)
  );
}

/**
 * 浏览器动作风险与权限档位判定纯函数。
 *
 * 优先级（从高到低）：
 * 1. 内置/自定义域名与受保护协议黑名单 -> `deny` (`blocked_origin`, `locked: true`)，全档位与读写均不可绕过；
 * 2. 只读操作（快照、读正文、滚动、悬停、截图、列标签、安全控制）-> `allow` (`safe`)；
 * 3. 付款/购买/转账/结账/下单类控件 -> `ask` (`purchase`, `locked: true`)，全档位（含 `full`）均不可绕过；
 * 4. `observe` 档 -> 一切写操作返回 `ask` (`write`)；
 * 5. `cautious` 档（默认）-> 高危语义词或 `submit` / `Enter` 提交返回 `ask` (`high_risk`)，其余普通写操作 `allow`；
 * 6. `full` 档 -> 除黑名单与付款外一律 `allow`。
 */
export function assessBrowserActionRisk(
  input: BrowserActionRiskInput,
): BrowserActionRiskAssessment {
  const tier = normalizeBrowserPermissionTier(input.tier);

  // 1. 站点黑名单 / 受保护协议（最高优先级，覆盖读写与全部档位）。
  const blocked = matchBlockedOrigin(input.url, input.blockedDomains);
  if (blocked.blocked) {
    return {
      decision: "deny",
      category: "blocked_origin",
      locked: true,
      matched: blocked.rule,
      reason: blocked.reason,
    };
  }

  // 2. 纯只读操作：三档均直接放行。
  if (isReadOnlyOperation(input.operation, input.action)) {
    return {
      decision: "allow",
      category: "safe",
      reason: "只读或观察类浏览器操作，允许直接执行。",
    };
  }

  const elementText = collectElementText(input.element);

  // 3. 付款/购买/转账/结账强制锁：任何档位（含 full）一律询问。
  const purchaseHit = matchPurchaseKeyword(elementText);
  if (purchaseHit) {
    return {
      decision: "ask",
      locked: true,
      category: "purchase",
      matched: purchaseHit,
      reason: `涉及付款/购买/转账类控件（命中「${purchaseHit}」），所有权限档位均必须先由你确认。`,
    };
  }

  // 4. 仅观察档：一切写操作（点击、填表、按键、导航、开关标签页等）必须确认。
  if (tier === "observe") {
    return {
      decision: "ask",
      category: "write",
      reason: "当前处于「仅观察」权限档位，页面交互、导航与标签变更均需你确认。",
    };
  }

  // 5. 谨慎操作档（默认）：拦截表单提交 / Enter 与高危语义控件。
  if (tier === "cautious") {
    if (input.submit === true) {
      return {
        decision: "ask",
        category: "high_risk",
        matched: "submit",
        reason: "谨慎操作档位下，填表并直接提交（submit）需要你确认。",
      };
    }

    if (isSubmitKey(input.key)) {
      return {
        decision: "ask",
        category: "high_risk",
        matched: input.key?.trim() || "Enter",
        reason: "谨慎操作档位下，按 Enter 键可能触发提交或发送，需要你确认。",
      };
    }

    const highRiskHit = matchHighRiskKeyword(elementText);
    if (highRiskHit) {
      return {
        decision: "ask",
        category: "high_risk",
        matched: highRiskHit,
        reason: `谨慎操作档位下，目标控件命中高危语义（${highRiskHit}），需要你确认。`,
      };
    }

    return {
      decision: "allow",
      category: "safe",
      reason: "谨慎操作档位下的常规浏览与页面交互，允许直接执行。",
    };
  }

  // 6. 完全访问档：黑名单与付款锁已在前面拦截，其余直接放行。
  return {
    decision: "allow",
    category: "safe",
    reason: "完全访问档位放行（仍写入设备审计日志）。",
  };
}

/* ============================================================================
 * 共享数据结构：快照、实时大卡、扩展配置、侧栏与 HUD 协议
 * ============================================================================ */

/** 与服务端 `SnapshotElement` / 云端 `aria-snapshot.ts` 同构的网页交互控件描述符。 */
export type BrowserSnapshotElement = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  type?: string;
  disabled?: boolean;
  checked?: boolean;
  options?: string[];
  /** 扩展内部定位用；服务端风险判定只信解析后的 role/name，不信任模型自报值。 */
  backendDOMNodeId?: number;
};

/** 网页无障碍树快照结果（带单调递增 snapshotId，防过期 ref 误点）。 */
export type BrowserSnapshotResult = {
  snapshotId: number;
  tabId?: number;
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
  capturedAt?: string;
  screenshotBase64?: string;
  untrusted?: string;
};

export type BrowserLiveCardSource = "extension" | "cloud";

/** 供扩展侧栏、网页、PC、手机端统一消费的「浏览器实时预览大卡」投影数据。 */
export type BrowserLiveCardPayload = {
  runKey: string;
  source: BrowserLiveCardSource;
  botId: string;
  botName: string;
  botAvatarUrl?: string | null;
  phaseBadge: string;
  stepLabel: string;
  tabTitle: string;
  tabUrl: string;
  tabId?: number | null;
  deviceId?: string | null;
  shotUrl?: string | null;
  running: boolean;
  state?: BrowserCompanionState;
  tabCount?: number;
};

/** 扩展端持久化与同步配置。 */
export type CompanionExtensionConfig = {
  tier: BrowserPermissionTier;
  blockedDomains: string[];
  allowRemoteDispatch: boolean;
  attachedTabId: number | null;
  tabGroupId: number | null;
  attached?: boolean;
  selectedBotId?: string | null;
  serverUrl?: string | null;
  deviceId?: string | null;
  maxControlledTabs?: number;
};

export const DEFAULT_COMPANION_EXTENSION_CONFIG: CompanionExtensionConfig = {
  tier: DEFAULT_BROWSER_PERMISSION_TIER,
  blockedDomains: [],
  allowRemoteDispatch: false,
  attachedTabId: null,
  tabGroupId: null,
  attached: true,
  selectedBotId: null,
  serverUrl: null,
  deviceId: null,
  maxControlledTabs: MAX_COMPANION_CONTROLLED_TABS,
};

export function normalizeCompanionExtensionConfig(
  raw: unknown,
): CompanionExtensionConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ...DEFAULT_COMPANION_EXTENSION_CONFIG,
      blockedDomains: [],
    };
  }
  const obj = raw as Record<string, unknown>;
  const attachedTabId =
    typeof obj.attachedTabId === "number" &&
    Number.isInteger(obj.attachedTabId) &&
    obj.attachedTabId >= 0
      ? obj.attachedTabId
      : null;
  const tabGroupId =
    typeof obj.tabGroupId === "number" &&
    Number.isInteger(obj.tabGroupId) &&
    obj.tabGroupId >= 0
      ? obj.tabGroupId
      : null;
  const maxControlledTabs =
    typeof obj.maxControlledTabs === "number" &&
    Number.isInteger(obj.maxControlledTabs) &&
    obj.maxControlledTabs >= 1
      ? Math.min(MAX_COMPANION_CONTROLLED_TABS, obj.maxControlledTabs)
      : MAX_COMPANION_CONTROLLED_TABS;

  return {
    tier: normalizeBrowserPermissionTier(obj.tier),
    blockedDomains: normalizeBlockedDomains(
      Array.isArray(obj.blockedDomains) ? obj.blockedDomains : undefined,
    ),
    allowRemoteDispatch: obj.allowRemoteDispatch === true,
    attachedTabId,
    tabGroupId,
    attached: typeof obj.attached === "boolean" ? obj.attached : true,
    selectedBotId:
      typeof obj.selectedBotId === "string" && obj.selectedBotId.trim()
        ? obj.selectedBotId.trim()
        : null,
    serverUrl:
      typeof obj.serverUrl === "string" && obj.serverUrl.trim()
        ? obj.serverUrl.trim()
        : null,
    deviceId:
      typeof obj.deviceId === "string" && obj.deviceId.trim()
        ? obj.deviceId.trim()
        : null,
    maxControlledTabs,
  };
}

export type CompanionSettingsPatch = Partial<
  Pick<
    CompanionExtensionConfig,
    | "tier"
    | "blockedDomains"
    | "allowRemoteDispatch"
    | "attachedTabId"
    | "tabGroupId"
    | "attached"
    | "selectedBotId"
  >
> & {
  paused?: boolean;
};

/** 服务端追踪的在线扩展标签页会话摘要（与设计方案 §3.1 对齐）。 */
export type CompanionTabSession = {
  sessionId: string;
  deviceId: string;
  botId: string | null;
  botName: string | null;
  tabGroupId: number | null;
  activeTabId: number | null;
  tabCount: number;
  state: BrowserCompanionState;
  currentStepLabel: string | null;
  allowRemoteDispatch: boolean;
  tier?: BrowserPermissionTier;
  blockedDomains?: string[];
  activeTabTitle?: string | null;
  activeTabUrl?: string | null;
  yieldReason?: BrowserCompanionYieldReason | null;
  updatedAt?: string;
};

/** 扩展通过 WSS `companion_state` 上报以及挂载于 `DeviceView.companionState` 的实时状态载荷。 */
export type CompanionStateReport = {
  sessionId?: string;
  state: BrowserCompanionState;
  tier: BrowserPermissionTier;
  blockedDomains?: string[];
  allowRemoteDispatch: boolean;
  attached: boolean;
  attachedTabId: number | null;
  activeTabId?: number | null;
  activeTabTitle?: string | null;
  activeTabUrl?: string | null;
  tabGroupId: number | null;
  tabCount: number;
  botId?: string | null;
  botName?: string | null;
  currentStepLabel?: string | null;
  yieldReason?: BrowserCompanionYieldReason | null;
  updatedAt?: string;
};

/** 服务端下发给扩展的控制命令类型。 */
export type CompanionServerCommand =
  | "detach"
  | "pause"
  | "resume"
  | "kill_switch"
  | "focus_tab"
  | "sync_config";

/** 扩展侧栏支持的六套主题与纯 CSS 三档材质。 */
export type CompanionThemeId =
  | "sky"
  | "aurora"
  | "porcelain"
  | "deepseek"
  | "claude"
  | "cossui";

export type CompanionMaterialMode = "glass" | "clear" | "solid";

export type CompanionAttachedTabContext = {
  tabId: number;
  url: string;
  title: string;
  windowId?: number | null;
  favIconUrl?: string | null;
  groupId?: number | null;
};

export type CompanionTabInfo = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  controlled: boolean;
  favIconUrl?: string | null;
  groupId?: number | null;
};

export type CompanionBootstrapBot = {
  id: string;
  name: string;
  title?: string | null;
  hidden?: boolean;
  avatarUrl?: string | null;
  description?: string | null;
};

/** `GET /api/devices/agent/companion/bootstrap` 响应契约。 */
export type CompanionBootstrapResponse = {
  user: {
    id: string;
    name: string;
    email?: string | null;
    role?: string;
    image?: string | null;
  };
  device: {
    id: string;
    name: string;
    platform: string;
    paused: boolean;
    revoked: boolean;
  };
  bots: CompanionBootstrapBot[];
  defaultBotId: string | null;
  config?: CompanionExtensionConfig;
  companionConfig?: CompanionExtensionConfig;
  appearance?: {
    theme?: CompanionThemeId | string;
    colorMode?: "light" | "dark" | "system";
    material?: CompanionMaterialMode;
  };
};

/** `GET /api/devices/extension/meta` 扩展安装包元数据契约。 */
export type CompanionExtensionDownloadMeta = {
  available: boolean;
  version: string | null;
  filename: string;
  bytes: number | null;
  sha256: string | null;
  downloadUrl: string;
};

/** Background Service Worker -> Content Script HUD 消息协议。 */
export type CompanionHudMessage =
  | {
      type: "HUD_UPDATE";
      state: BrowserCompanionState;
      botName: string;
      botAvatarUrl?: string | null;
      stepLabel: string | null;
      yieldReason?: BrowserCompanionYieldReason | null;
      tabCount?: number;
    }
  | { type: "HUD_HIDE_FOR_CAPTURE" }
  | { type: "HUD_RESTORE_AFTER_CAPTURE" }
  | { type: "HUD_SYNTHETIC_WINDOW"; durationMs: number }
  | { type: "HUD_REMOVE" };

/** Content Script HUD -> Background Service Worker 事件协议。 */
export type CompanionHudEvent =
  | { type: "HUD_USER_DETACH" }
  | { type: "HUD_USER_RESUME" }
  | {
      type: "HUD_HUMAN_INPUT";
      inputKind: "mousedown" | "keydown" | "wheel";
    };
