import {
  BROWSER_COMPANION_OPERATIONS,
  type BrowserActionRiskAssessment,
  type CompanionExtensionConfig,
  type CompanionServerCommand,
  type CompanionStateReport,
} from "../../../shared/browser-companion";
import { BROWSER_EXTENSION_PLATFORM } from "../../../shared/devices";
import type {
  CompanionAuthRecord,
  PendingApprovalItem,
} from "../types/protocol";

/**
 * 扩展后台出站 WSS 客户端（连接 wss://<server>/api/devices/agent/ws）。
 *
 * 关键特性：
 * - 浏览器 MV3 原生 WebSocket 无法附带自定义请求头，连接 URL 携带 `?token=<cbd_...>`
 *   （服务端 `/api/devices/agent/ws` 同时兼容 `X-Device-Token` 头与 `?token=`，且 nginx 日志仅记 `$uri`）；
 *   若注入自定义 WebSocket 工厂（测试或非浏览器宿主），也同步提供 `X-Device-Token` 头；
 * - 25s 心跳保活 + 70s 静默看门狗 + 1s~30s 指数退避带抖动重连；
 * - 收到 `revoked` 或 4401 关闭码立即停止重连并通知上层清理会话；
 * - 内置本地纵深防御风控钩子 `evaluateLocalRisk`，直接委托 shared/browser-companion.ts 的 `assessBrowserActionRisk`；
 * - 完整处理服务端下发的 `companion_command`（detach / pause / resume / kill_switch / focus_tab / sync_config）。
 */

export const BROWSER_EXTENSION_FEATURES = BROWSER_COMPANION_OPERATIONS;

export type WsConnectionState = "offline" | "connecting" | "online" | "revoked";

export interface WsCallPayload {
  id: string;
  operation: string;
  args: Record<string, unknown>;
  botName: string | null;
  timeoutMs: number;
}

export interface CompanionCommandPayload {
  command: CompanionServerCommand;
  tabId?: number;
  reason?: string;
  config?: Partial<CompanionExtensionConfig>;
}

export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export type WebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => WsLike;

export interface CompanionWsClientOptions {
  getAuth: () => CompanionAuthRecord | null;
  getClientVersion: () => string;
  getCompanionState: () => CompanionStateReport;
  evaluateLocalRisk?: (
    call: WsCallPayload,
  ) => BrowserActionRiskAssessment | Promise<BrowserActionRiskAssessment>;
  onCall: (call: WsCallPayload, signal: AbortSignal) => Promise<unknown>;
  onCompanionCommand?: (cmd: CompanionCommandPayload) => void;
  onStateChange?: (state: WsConnectionState, error: string | null) => void;
  onApprovalRequest?: (item: PendingApprovalItem) => void;
  onApprovalClosed?: (id: string, decision: string) => void;
  onRemoteConfig?: (device: Record<string, unknown>) => void;
  onRevoked?: () => void;
  createWebSocket?: WebSocketFactory;
  heartbeatMs?: number;
  silenceMs?: number;
  backoffBaseMs?: number;
}

export function buildDeviceWsUrl(serverUrl: string, token: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/api/devices/agent/ws";
  url.search = "";
  url.searchParams.set("token", token);
  url.hash = "";
  return url.toString();
}

export function createCompanionWsClient(options: CompanionWsClientOptions) {
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const silenceMs = options.silenceMs ?? 70_000;
  const backoffBaseMs = options.backoffBaseMs ?? 1_000;

  let socket: WsLike | null = null;
  let state: WsConnectionState = "offline";
  let lastError: string | null = null;
  let stopped = true;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const runningCalls = new Map<string, AbortController>();

  function setState(next: WsConnectionState, error: string | null = null) {
    if (state === next && lastError === error) return;
    state = next;
    lastError = error;
    options.onStateChange?.(next, error);
  }

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function sendJson(payload: Record<string, unknown>): boolean {
    if (socket?.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function sendCompanionState(report?: CompanionStateReport): boolean {
    const data = report ?? options.getCompanionState();
    return sendJson({
      type: "companion_state",
      ...data,
    });
  }

  function sendApprovalDecision(
    id: string,
    decision: "approve" | "deny",
  ): boolean {
    return sendJson({
      type: "approval",
      id,
      decision,
    });
  }

  function armWatchdog(activeSocket: WsLike) {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (silenceMs <= 0) return;
    watchdogTimer = setTimeout(() => {
      if (socket !== activeSocket) return;
      lastError = "与服务器连接超时，正在重新连接…";
      try {
        activeSocket.close(4000, "silence_timeout");
      } catch {
        // 忽略关闭异常
      }
    }, silenceMs);
  }

  function cancelAllRunningCalls() {
    for (const controller of runningCalls.values()) {
      controller.abort();
    }
    runningCalls.clear();
  }

  function scheduleReconnect() {
    if (stopped || state === "revoked") return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const exp = Math.min(attempt, 5);
    const base = Math.min(30 * backoffBaseMs, backoffBaseMs * 2 ** exp);
    const jitter = Math.round(base * (0.15 * Math.random()));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, base + jitter);
  }

  async function handleCall(call: WsCallPayload) {
    const controller = new AbortController();
    runningCalls.set(call.id, controller);

    try {
      // 纵深防御：调用 shared/browser-companion.ts 的 assessBrowserActionRisk 进行二次本地校验
      if (options.evaluateLocalRisk) {
        const risk = await options.evaluateLocalRisk(call);
        if (risk.decision === "deny") {
          sendJson({
            type: "result",
            id: call.id,
            ok: false,
            error: risk.reason || "该页面或操作已被本地安全策略禁止。",
          });
          sendJson({
            type: "local_audit",
            action: call.operation,
            outcome: "denied",
            summary: risk.reason || "本地黑名单拒绝",
          });
          return;
        }
        const serverApproved = call.args._approved === true;
        if (risk.decision === "ask" && !serverApproved) {
          sendJson({
            type: "result",
            id: call.id,
            ok: false,
            error:
              risk.reason ||
              "该操作在当前权限档位下需要用户显式确认，本地安全护栏已拦截。",
          });
          sendJson({
            type: "local_audit",
            action: call.operation,
            outcome: "blocked_unapproved",
            summary: risk.reason || "未获确认的高危操作",
          });
          return;
        }
      }

      const result = await options.onCall(call, controller.signal);
      if (controller.signal.aborted) return;
      sendJson({
        type: "result",
        id: call.id,
        ok: true,
        result,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message =
        error instanceof Error ? error.message : String(error ?? "执行失败。");
      sendJson({
        type: "result",
        id: call.id,
        ok: false,
        error: message,
      });
    } finally {
      runningCalls.delete(call.id);
    }
  }

  function handleMessage(rawData: unknown) {
    if (typeof rawData !== "string") return;
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawData) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof msg.type === "string" ? msg.type : "";
    switch (type) {
      case "ping": {
        sendJson({ type: "pong" });
        return;
      }
      case "welcome": {
        attempt = 0;
        setState("online", null);
        if (msg.device && typeof msg.device === "object") {
          options.onRemoteConfig?.(msg.device as Record<string, unknown>);
        }
        sendCompanionState();
        return;
      }
      case "config": {
        if (msg.device && typeof msg.device === "object") {
          options.onRemoteConfig?.(msg.device as Record<string, unknown>);
        }
        return;
      }
      case "companion_command": {
        const command = typeof msg.command === "string" ? msg.command : "";
        if (
          command === "detach" ||
          command === "pause" ||
          command === "resume" ||
          command === "kill_switch" ||
          command === "focus_tab" ||
          command === "sync_config"
        ) {
          options.onCompanionCommand?.({
            command,
            ...(typeof msg.tabId === "number" ? { tabId: msg.tabId } : {}),
            ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}),
            ...(msg.config && typeof msg.config === "object"
              ? { config: msg.config as Partial<CompanionExtensionConfig> }
              : {}),
          });
        }
        return;
      }
      case "revoked": {
        stopped = true;
        cancelAllRunningCalls();
        clearTimers();
        setState("revoked", "该浏览器扩展已在服务端被撤销，请重新登录绑定。");
        try {
          socket?.close(4401, "revoked");
        } catch {
          // 忽略关闭异常
        }
        socket = null;
        options.onRevoked?.();
        return;
      }
      case "approval_request": {
        const id = typeof msg.id === "string" ? msg.id : "";
        if (!id) return;
        options.onApprovalRequest?.({
          id,
          operation:
            typeof msg.operation === "string" ? msg.operation : "browser_click",
          summary:
            typeof msg.summary === "string"
              ? msg.summary
              : "请确认该浏览器操作",
          botName: typeof msg.botName === "string" ? msg.botName : null,
          expiresAt:
            typeof msg.expiresAt === "string"
              ? msg.expiresAt
              : new Date(Date.now() + 120_000).toISOString(),
          ...(typeof msg.remainingMs === "number"
            ? { remainingMs: msg.remainingMs }
            : {}),
          source: "ws",
        });
        return;
      }
      case "approval_closed": {
        const id = typeof msg.id === "string" ? msg.id : "";
        const decision =
          typeof msg.decision === "string" ? msg.decision : "expired";
        if (id) options.onApprovalClosed?.(id, decision);
        return;
      }
      case "cancel": {
        const id = typeof msg.id === "string" ? msg.id : "";
        const ctrl = id ? runningCalls.get(id) : undefined;
        if (ctrl) {
          ctrl.abort();
          runningCalls.delete(id);
        }
        return;
      }
      case "call": {
        const id = typeof msg.id === "string" ? msg.id : "";
        const operation =
          typeof msg.operation === "string" ? msg.operation : "";
        if (!id || !operation) return;
        const args =
          msg.args && typeof msg.args === "object" && !Array.isArray(msg.args)
            ? (msg.args as Record<string, unknown>)
            : {};
        const botName = typeof msg.botName === "string" ? msg.botName : null;
        const timeoutMs =
          typeof msg.timeoutMs === "number" ? msg.timeoutMs : 30_000;
        void handleCall({ id, operation, args, botName, timeoutMs });
        return;
      }
      default:
        return;
    }
  }

  function connect() {
    if (stopped) return;
    const auth = options.getAuth();
    if (!auth) {
      setState("offline", null);
      return;
    }

    clearTimers();
    if (socket) {
      try {
        socket.close(1000, "reconnect");
      } catch {
        // 忽略旧连接关闭错误
      }
      socket = null;
    }

    setState("connecting", null);
    const wsUrl = buildDeviceWsUrl(auth.serverUrl, auth.deviceToken);
    const headers = { "X-Device-Token": auth.deviceToken };

    let activeSocket: WsLike;
    try {
      activeSocket = options.createWebSocket
        ? options.createWebSocket(wsUrl, { headers })
        : (new WebSocket(wsUrl) as unknown as WsLike);
    } catch (error) {
      setState(
        "offline",
        error instanceof Error ? error.message : "无法建立 WebSocket 连接。",
      );
      scheduleReconnect();
      return;
    }

    socket = activeSocket;
    armWatchdog(activeSocket);

    activeSocket.addEventListener("open", () => {
      if (socket !== activeSocket) return;
      armWatchdog(activeSocket);
      sendJson({
        type: "hello",
        platform: BROWSER_EXTENSION_PLATFORM,
        clientVersion: options.getClientVersion(),
        hostname: "Chrome / Edge Extension",
        features: [...BROWSER_EXTENSION_FEATURES],
      });
      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (socket !== activeSocket || activeSocket.readyState !== 1) return;
          sendJson({ type: "pong" });
        }, heartbeatMs);
      }
    });

    activeSocket.addEventListener("message", (event) => {
      if (socket !== activeSocket) return;
      armWatchdog(activeSocket);
      const data =
        event && typeof event === "object" && "data" in event
          ? (event as { data?: unknown }).data
          : undefined;
      handleMessage(data);
    });

    activeSocket.addEventListener("error", () => {
      if (socket !== activeSocket) return;
      lastError = "与 ChisaBot 服务器的实时连接中断，正在重连…";
    });

    activeSocket.addEventListener("close", (event) => {
      if (socket !== activeSocket) return;
      socket = null;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }

      const code =
        event && typeof event === "object" && "code" in event
          ? Number((event as { code?: unknown }).code)
          : 1006;

      if (code === 4401) {
        stopped = true;
        cancelAllRunningCalls();
        setState("revoked", "设备令牌已被撤销或失效，请重新登录。");
        options.onRevoked?.();
        return;
      }

      if (stopped) {
        setState("offline", null);
        return;
      }

      setState("offline", lastError ?? "连接已断开，正在自动重连…");
      scheduleReconnect();
    });
  }

  function start() {
    stopped = false;
    attempt = 0;
    connect();
  }

  function stop() {
    stopped = true;
    cancelAllRunningCalls();
    clearTimers();
    if (socket) {
      const s = socket;
      socket = null;
      try {
        s.close(1000, "client_stop");
      } catch {
        // 忽略关闭异常
      }
    }
    setState("offline", null);
  }

  function getState(): { state: WsConnectionState; error: string | null } {
    return { state, error: lastError };
  }

  return {
    start,
    stop,
    getState,
    sendCompanionState,
    sendApprovalDecision,
  };
}

export type CompanionWsClient = ReturnType<typeof createCompanionWsClient>;
