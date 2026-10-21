import { randomUUID } from "node:crypto";
import {
  type DeviceApprovalView,
  type DeviceCapabilities,
  type DeviceOperation,
  type DeviceToServer,
  type DeviceView,
  OPERATION_LABEL,
  type ServerToDevice,
  capabilityFor,
} from "../../../shared/devices";
import { TOOL_STOPPED_ZH } from "../confirmations/context";
import { isMobilePlatform, MOBILE_ONLINE_WINDOW_MS } from "./pairing";
import { outsideRoots, outsideRootsNote } from "./roots";
import { type DevicePatch, type DeviceRecord, type DeviceStore, fullAccessActive } from "./store";

/** 和 store.ts MAX_ROOTS 一致。 */
const MAX_ALLOWED_ROOTS = 20;

/** 0.1.8 之前的客户端只有这些操作；更新的操作要看 hello.features。 */
const LEGACY_OPERATIONS = new Set<DeviceOperation>([
  "system_info", "shell", "list_files", "read_file", "write_file", "screenshot", "input", "open", "clipboard_read", "clipboard_write",
]);

/**
 * 在线设备的中转站（docs/pc-node.md §5）。
 *
 * PC 主动连进来（WebSocket，出站），服务器只是把机器人的调用转给它并等结果。三道闸都在这里：
 * 撤销 / 紧急停止 / 能力开关（off 拒绝，ask 先审批），然后先写审计再发调用。
 * PC 端还会按自己那份配置再检查一遍，两边任何一边说不就不执行。
 */

export class DeviceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceRefusedError";
  }
}

export type DeviceSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
};

type Connection = {
  deviceId: string;
  ownerUserId: string;
  socket: DeviceSocket;
  pending: Map<string, Pending>;
  lastTouch: number;
  ip: string | null;
  /** hello.features（0.1.8 起）；旧客户端为 null。 */
  features: Set<string> | null;
};

type Approval = {
  view: DeviceApprovalView;
  ownerUserId: string;
  resolve: (decision: { approved: boolean; by: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
  opening?: Promise<void>;
};

type Screenshot = { deviceId: string; png: Buffer; at: number };

export type InvokeInput = {
  device: DeviceRecord;
  operation: DeviceOperation;
  args: Record<string, unknown>;
  /** 发起者：机器人（默认），或在网页上点「测试连接」的人。 */
  bot: { id: string; name: string | null };
  actorType?: "bot" | "user";
  summary: string;
  timeoutMs?: number;
  /** Only this invocation is cancelled when its run stops. */
  signal?: AbortSignal;
  /** 改文件类操作的改动预览（unified diff），放进审批卡片。 */
  diff?: string | null;
};

/**
 * 本地 agent / 权限档位（server/src/local-agents/，docs/local-agents.md）挂进来的扩展点：
 * 不认识的节点消息交给它；能力是「允许」的操作先问它在不在档位之内（之外改成审批）。
 */
export type DeviceHubExtension = {
  onMessage?(record: DeviceRecord, message: { type: string } & Record<string, unknown>): Promise<void> | void;
  onHello?(record: DeviceRecord): Promise<void> | void;
  gate?(record: DeviceRecord, operation: DeviceOperation, args: Record<string, unknown>): Promise<string | null> | string | null;
};

type HubStore = Pick<DeviceStore, "get" | "touch" | "update" | "audit" | "finishAudit"> &
  Partial<Pick<DeviceStore, "seedRoots">>;

function unref(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && timer && "unref" in timer)
    (timer as { unref: () => void }).unref();
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 审批偏好 + 聊天里的确认卡片（server/src/confirmations，DESIGN.md §58）。「询问」能力：偏好是「直接做」就不问；
 * 否则照旧在电脑上弹窗，网页聊天里同时出一张卡片，两边谁先决定都算。
 */
export type DeviceConfirmLink = {
  linkable(): boolean;
  /**
   * auto = 审批偏好「直接做」；full = 这个机器人开了「完全访问」（输入框权限，§97：连允许文件夹以外的路径也直接加进去）；ask = 问。
   * 只在策略已经是「询问」时调用：关闭的能力、紧急停止、管理员身份运行这些硬限制在这之前就拒绝了，完全访问放不开它们。
   */
  before(input: { ownerUserId: string; botId: string; operation: string; operationLabel: string; summary: string; args: unknown }): Promise<"auto" | "ask" | "full">;
  opened(input: {
    approvalId: string;
    ownerUserId: string;
    botId: string;
    deviceName: string;
    operationLabel: string;
    summary: string;
    args: unknown;
    /** 写文件 / 补丁的改动预览（unified diff），卡片里着色显示。 */
    diff?: string | null;
    expiresAt: string;
  }): Promise<void>;
  closed(approvalId: string, decision: "approve" | "deny" | "expired", by: string): Promise<void>;
};
/** 聊天里有卡片时等得久一点（和别的确认卡片一样 10 分钟）。 */
const CHAT_APPROVAL_TTL_MS = 10 * 60_000;

export function createDeviceHub(options: {
  store: HubStore;
  confirm?: DeviceConfirmLink;
  approvalTtlMs?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
}) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const approvalTtlMs = options.approvalTtlMs ?? 120_000;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  const connections = new Map<string, Connection>();
  const approvals = new Map<string, Approval>();
  const screenshots = new Map<string, Screenshot>();
  let confirm = options.confirm;
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let extension: DeviceHubExtension | null = null;

  function send(connection: Connection | undefined, message: ServerToDevice) {
    if (!connection) return false;
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function view(record: DeviceRecord): DeviceView {
    const { tokenHash: _omit, ...rest } = record;
    // 手机不连 /agent/ws：最近一次会话校验（网关约每 30 秒一次）在窗口内就算在线。
    const online = isMobilePlatform(record.platform)
      ? !record.revoked && !!record.lastSeenAt && Date.now() - Date.parse(record.lastSeenAt) < MOBILE_ONLINE_WINDOW_MS
      : connections.has(record.id);
    const full = fullAccessActive(record, now());
    const features = connections.get(record.id)?.features;
    return {
      ...rest,
      online,
      fullAccess: full,
      fullAccessUntil: full ? record.fullAccessUntil : null,
      fullAccessRemainingMs: full && record.fullAccessUntil ? Date.parse(record.fullAccessUntil) - now() : null,
      features: features ? [...features] : null,
    };
  }

  /** 完全访问到期时：写审计、把新配置推给设备（设备自己也按剩余时间倒数）。 */
  function scheduleExpiry(record: DeviceRecord) {
    const previous = expiryTimers.get(record.id);
    if (previous) clearTimeout(previous);
    expiryTimers.delete(record.id);
    if (!fullAccessActive(record, now()) || !record.fullAccessUntil) return;
    const ms = Date.parse(record.fullAccessUntil) - now();
    if (ms > 2_000_000_000) return; // 「永久」或超过 setTimeout 上限：不排
    const timer = setTimeout(async () => {
      expiryTimers.delete(record.id);
      const fresh = await store.get(record.id).catch(() => null);
      if (!fresh || fresh.fullAccessUntil !== record.fullAccessUntil) return;
      await store
        .audit({
          deviceId: record.id,
          ownerUserId: record.ownerUserId,
          actorType: "system",
          actorId: null,
          actorName: "系统",
          action: "full_access_expired",
          summary: "完全访问已到期，恢复按能力开关和允许的文件夹执行。",
          outcome: "succeeded",
          detail: null,
          durationMs: null,
        })
        .catch(() => {});
      await pushConfig(record.id);
    }, Math.max(0, ms) + 500);
    unref(timer);
    expiryTimers.set(record.id, timer);
  }

  async function pushConfig(deviceId: string) {
    const record = await store.get(deviceId);
    if (record) scheduleExpiry(record);
    const connection = connections.get(deviceId);
    if (!connection) return;
    if (record) send(connection, { type: "config", device: view(record) });
  }

  /**
   * 把允许的文件夹以外的那个文件夹加进去（批准时、或机器人完全访问时），写审计，再推配置给 PC。
   * 成功返回 true，否则返回拒绝的原因。
   */
  async function addOutsideRoot(record: DeviceRecord, folder: string, by: string): Promise<true | string> {
    const roots = record.allowedRoots;
    if (roots.some((root) => root.toLowerCase() === folder.toLowerCase())) return true;
    if (roots.length >= MAX_ALLOWED_ROOTS)
      return `允许的文件夹已经有 ${roots.length} 个（上限 ${MAX_ALLOWED_ROOTS}），没法再加 ${folder}。请到 设置 → 设备 → 这台设备 删掉不用的文件夹。`;
    const updated = await store.update(record.id, { allowedRoots: [...roots, folder] });
    if (!updated || !updated.allowedRoots.some((root) => root.toLowerCase() === folder.toLowerCase())) return `没能把 ${folder} 加入允许的文件夹。`;
    await store.audit({
      deviceId: record.id,
      ownerUserId: record.ownerUserId,
      actorType: "user",
      actorId: null,
      actorName: by,
      action: "roots_added",
      summary: `${by === "完全访问自动" ? "机器人完全访问时自动" : "批准时"}加入允许的文件夹：${folder}`,
      outcome: "succeeded",
      detail: null,
      durationMs: null,
    });
    // config 和 call 走同一条 WebSocket、按顺序处理：PC 先拿到新文件夹，再收到调用。
    await pushConfig(record.id);
    return true;
  }

  function dropConnection(connection: Connection, reason: string) {
    if (connections.get(connection.deviceId) === connection)
      connections.delete(connection.deviceId);
    for (const [id, pending] of connection.pending) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new Error(reason));
      connection.pending.delete(id);
    }
  }

  function keepScreenshot(deviceId: string, base64: string): string {
    const id = randomUUID();
    screenshots.set(id, { deviceId, png: Buffer.from(base64, "base64"), at: now() });
    // 只留最近 30 张、30 分钟内的。
    const cutoff = now() - 30 * 60_000;
    for (const [key, shot] of screenshots)
      if (shot.at < cutoff || screenshots.size > 30) screenshots.delete(key);
    return id;
  }

  async function applyLocalConfig(
    connection: Connection,
    message: Extract<DeviceToServer, { type: "set_config" }>,
  ) {
    const patch: DevicePatch = {};
    if (message.name !== undefined) patch.name = message.name;
    if (message.capabilities) patch.capabilities = message.capabilities;
    if (message.allowedRoots) patch.allowedRoots = message.allowedRoots;
    if (message.paused !== undefined) patch.paused = message.paused;
    // PC 本机只能关闭完全访问（拒绝开启 / 托盘关闭），永远不能打开。
    if (message.fullAccess === "off") patch.fullAccessUntil = null;
    const before = await store.get(connection.deviceId);
    const after = await store.update(connection.deviceId, patch);
    if (!before || !after) return;
    await store.audit({
      deviceId: connection.deviceId,
      ownerUserId: connection.ownerUserId,
      actorType: "device",
      actorId: connection.deviceId,
      actorName: "PC 客户端",
      action: patch.paused !== undefined && patch.paused !== before.paused
        ? patch.paused
          ? "kill_switch_on"
          : "kill_switch_off"
        : message.fullAccess === "off" && before.fullAccessUntil
          ? "full_access_off"
          : "config_changed",
      summary: describeChange(before, after),
      outcome: "succeeded",
      detail: null,
      durationMs: null,
    });
    if (patch.paused === true) cancelAllFor(connection.deviceId, "已在 PC 上紧急停止。");
    await pushConfig(connection.deviceId);
  }

  function cancelAllFor(deviceId: string, reason: string) {
    const connection = connections.get(deviceId);
    if (connection) {
      for (const [id, pending] of connection.pending) {
        send(connection, { type: "cancel", id });
        clearTimeout(pending.timer);
        pending.cleanup?.();
        pending.reject(new DeviceRefusedError(reason));
        connection.pending.delete(id);
      }
    }
    for (const [id, approval] of approvals) {
      if (approval.view.deviceId !== deviceId) continue;
      decideInternal(id, false, "system");
    }
  }

  function decideInternal(id: string, approved: boolean, by: string) {
    const approval = approvals.get(id);
    if (!approval) return false;
    approvals.delete(id);
    clearTimeout(approval.timer);
    approval.cleanup?.();
    const decision = by === "expired" ? "expired" : approved ? "approve" : "deny";
    send(connections.get(approval.view.deviceId), { type: "approval_closed", id, decision });
    approval.resolve({ approved, by });
    // A stop may arrive while the chat card is still being inserted. Close it after that insert,
    // otherwise a late insert would leave a cancelled invocation's card pending.
    void Promise.resolve(approval.opening)
      .then(() => confirm?.closed(id, decision, by))
      .catch(() => {});
    return true;
  }

  function requestApproval(
    record: DeviceRecord,
    input: InvokeInput,
    onCreated?: (id: string) => void,
  ): Promise<{ approved: boolean; by: string }> {
    if (input.signal?.aborted) return Promise.resolve({ approved: false, by: "aborted" });
    const id = randomUUID();
    onCreated?.(id);
    const createdAt = now();
    const chat = input.actorType !== "user" && (confirm?.linkable() ?? false);
    const ttlMs = chat ? Math.max(approvalTtlMs, CHAT_APPROVAL_TTL_MS) : approvalTtlMs;
    const view: DeviceApprovalView = {
      id,
      deviceId: record.id,
      deviceName: record.name,
      botId: input.bot.id,
      botName: input.bot.name,
      operation: input.operation,
      summary: input.summary,
      diff: input.diff ?? null,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + ttlMs).toISOString(),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => decideInternal(id, false, "expired"), ttlMs);
      unref(timer);
      const onAbort = () => decideInternal(id, false, "aborted");
      const approval: Approval = {
        view, ownerUserId: record.ownerUserId, resolve, timer,
        cleanup: () => input.signal?.removeEventListener("abort", onAbort),
      };
      approvals.set(id, approval);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) { onAbort(); return; }
      send(connections.get(record.id), {
        type: "approval_request",
        id,
        operation: input.operation,
        summary: input.summary,
        botName: input.bot.name,
        expiresAt: view.expiresAt,
        diff: view.diff ?? null,
        // PC 的时钟可能和服务器不一致，所以同时给出按服务器时钟算的剩余毫秒数，PC 用它倒数。
        remainingMs: ttlMs,
      });
      if (chat && confirm && approvals.has(id))
        approval.opening = confirm
          .opened({
            approvalId: id,
            ownerUserId: record.ownerUserId,
            botId: input.bot.id,
            deviceName: record.name,
            operationLabel: OPERATION_LABEL[input.operation] ?? input.operation,
            summary: input.summary,
            args: input.args,
            diff: view.diff ?? null,
            expiresAt: view.expiresAt,
          })
          .catch((error) => console.warn(JSON.stringify({ type: "device-confirm-card-failed", reason: errorText(error) })));
    });
  }

  return {
    view,
    isOnline: (deviceId: string) => connections.has(deviceId),
    /** 在线设备是否支持某个操作（旧客户端只支持最初的 10 个）。离线返回 false。 */
    supports(deviceId: string, operation: DeviceOperation) {
      const connection = connections.get(deviceId);
      if (!connection) return false;
      return connection.features ? connection.features.has(operation) : LEGACY_OPERATIONS.has(operation);
    },
    scheduleExpiry,
    pushConfig,
    onlineCount: () => connections.size,

    /** PC 连上（令牌已验证）。返回给 WebSocket 适配器的回调。 */
    attach(record: DeviceRecord, socket: DeviceSocket, ip: string | null) {
      const previous = connections.get(record.id);
      if (previous) {
        dropConnection(previous, "设备在别处重新连接。");
        try {
          previous.socket.close(4000, "replaced");
        } catch {}
      }
      const connection: Connection = {
        deviceId: record.id,
        ownerUserId: record.ownerUserId,
        socket,
        pending: new Map(),
        lastTouch: now(),
        ip,
        features: null,
      };
      connections.set(record.id, connection);
      scheduleExpiry(record);
      void store.touch(record.id, { ip });
      send(connection, {
        type: "welcome",
        device: view(record),
        serverTime: new Date(now()).toISOString(),
      });
      // 重连时把还在等的审批补发过去。
      for (const approval of approvals.values()) {
        if (approval.view.deviceId !== record.id) continue;
        send(connection, {
          type: "approval_request",
          id: approval.view.id,
          operation: approval.view.operation,
          summary: approval.view.summary,
          botName: approval.view.botName,
          expiresAt: approval.view.expiresAt,
          diff: approval.view.diff ?? null,
          remainingMs: Math.max(0, Date.parse(approval.view.expiresAt) - now()),
        });
      }
      const ping = setInterval(() => send(connection, { type: "ping" }), 25_000);
      unref(ping as unknown as ReturnType<typeof setTimeout>);

      return {
        onMessage: async (raw: string) => {
          let message: DeviceToServer;
          try {
            message = JSON.parse(raw);
          } catch {
            return;
          }
          if (!message || typeof message !== "object") return;
          if (now() - connection.lastTouch > 60_000) {
            connection.lastTouch = now();
            void store.touch(record.id, { ip: connection.ip });
          }
          switch (message.type) {
            case "hello": {
              const { suggestedRoots, features, ...facts } = message;
              if (Array.isArray(features)) connection.features = new Set(features.filter((f) => typeof f === "string").slice(0, 200));
              await store.touch(record.id, { ip: connection.ip, ...facts });
              // PC 0.1.7 起带上默认文件夹（桌面 / 文档 / 下载）；只在列表为空、从没被人改过时采用。
              if (Array.isArray(suggestedRoots) && store.seedRoots)
                await store.seedRoots(record.id, suggestedRoots).catch(() => false);
              await pushConfig(record.id);
              void Promise.resolve(extension?.onHello?.(record)).catch(() => {});
              return;
            }
            case "result": {
              const pending = connection.pending.get(String(message.id));
              if (!pending) return;
              connection.pending.delete(String(message.id));
              clearTimeout(pending.timer);
              pending.cleanup?.();
              if (message.ok) pending.resolve(message.result);
              else
                pending.reject(
                  new DeviceRefusedError(
                    typeof message.error === "string" && message.error
                      ? message.error.slice(0, 600)
                      : "PC 端执行失败。",
                  ),
                );
              return;
            }
            case "approval": {
              const approval = approvals.get(String(message.id));
              if (approval && approval.view.deviceId === record.id)
                decideInternal(String(message.id), message.decision === "approve", "device");
              return;
            }
            case "set_config":
              await applyLocalConfig(connection, message);
              return;
            case "local_audit":
              await store.audit({
                deviceId: record.id,
                ownerUserId: record.ownerUserId,
                actorType: "device",
                actorId: record.id,
                actorName: "PC 客户端",
                action: String(message.action ?? "local").slice(0, 64),
                summary: message.summary ? String(message.summary) : null,
                outcome: String(message.outcome ?? "succeeded").slice(0, 32),
                detail: null,
                durationMs: null,
              });
              return;
            default:
              if (extension?.onMessage)
                await Promise.resolve(extension.onMessage(record, message as unknown as { type: string } & Record<string, unknown>)).catch((error) =>
                  console.warn("device extension message failed", error),
                );
              return;
          }
        },
        onClose: () => {
          clearInterval(ping);
          dropConnection(connection, "设备已断开连接。");
          void store.touch(record.id, { ip: connection.ip }).catch(() => {});
        },
      };
    },

    /** 撤销：通知 PC 并断开。 */
    kick(deviceId: string) {
      const connection = connections.get(deviceId);
      if (!connection) return;
      cancelAllFor(deviceId, "设备已被撤销。");
      send(connection, { type: "revoked" });
      dropConnection(connection, "设备已被撤销。");
      try {
        connection.socket.close(4401, "revoked");
      } catch {}
    },

    cancelAllFor,

    /**
     * 网页上设备页的直接请求（设备主人本人发起，不是机器人）：查看运行中的命令、结束一个后台命令。
     * 不走能力开关和审批（这是主人管理自己的设备），离线 / 旧客户端直接报错。
     */
    async direct(record: DeviceRecord, operation: DeviceOperation, args: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
      const connection = connections.get(record.id);
      if (!connection) throw new DeviceRefusedError("这台设备当前离线。");
      if (!(connection.features ? connection.features.has(operation) : LEGACY_OPERATIONS.has(operation)))
        throw new DeviceRefusedError("这台设备上的客户端版本太旧，不支持这个操作。");
      const id = randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          connection.pending.delete(id);
          reject(new DeviceRefusedError("设备没有及时回应。"));
        }, timeoutMs);
        unref(timer);
        connection.pending.set(id, { resolve, reject, timer });
        if (!send(connection, { type: "call", id, operation, args, botName: null, timeoutMs })) {
          clearTimeout(timer);
          connection.pending.delete(id);
          reject(new DeviceRefusedError("无法把请求发送到设备。"));
        }
      });
    },

    setExtension(next: DeviceHubExtension | null) {
      extension = next;
    },

    /** 给在线设备发一条扩展协议消息（本地 agent）。离线返回 false。 */
    sendRaw(deviceId: string, message: { type: string } & Record<string, unknown>) {
      const connection = connections.get(deviceId);
      if (!connection) return false;
      try {
        connection.socket.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },

    /** 走同一套审批（PC 弹窗 + 网页 / 手机「等待你审批」卡片），给本地 agent 的启动和档位之外的操作用。 */
    requestUserApproval(
      record: DeviceRecord,
      input: { bot: { id: string; name: string | null }; operation: DeviceOperation; summary: string },
      onCreated?: (approvalId: string) => void,
    ) {
      return requestApproval(record, { device: record, operation: input.operation, args: {}, bot: input.bot, summary: input.summary }, onCreated);
    },

    listApprovals(ownerUserId: string | null): DeviceApprovalView[] {
      return [...approvals.values()]
        .filter((a) => ownerUserId === null || a.ownerUserId === ownerUserId)
        .map((a) => a.view);
    },

    approvalOwner(id: string) {
      return approvals.get(id)?.ownerUserId ?? null;
    },

    decide(id: string, approved: boolean, by: string) {
      return decideInternal(id, approved, by);
    },

    setConfirm(link: DeviceConfirmLink) {
      confirm = link;
    },

    screenshot(deviceId: string, id: string): Buffer | null {
      const shot = screenshots.get(id);
      return shot && shot.deviceId === deviceId ? shot.png : null;
    },

    /**
     * 机器人调用设备。所有检查都在发出调用之前；审计行先写（requested），结束时改成结果。
     */
    async invoke(input: InvokeInput): Promise<unknown> {
      const record = input.device;
      const capability = capabilityFor(input.operation, input.args);
      const full = fullAccessActive(record, now());
      let policy = full ? "allow" : capability ? (record.capabilities as DeviceCapabilities)[capability] : "allow";
      // git push 总要人点头（完全访问除外）：推送是对外可见、难撤回的操作。
      if (!full && policy === "allow" && input.operation === "git" && input.args.subcommand === "push") policy = "ask";
      // 权限档位（docs/local-agents.md）：档位之外的操作，能力是「允许」也改成先审批；从不放宽。完全访问开着时不再收紧。
      if (!input.signal?.aborted && !full && policy === "allow" && extension?.gate) {
        const reason = await Promise.resolve(extension.gate(record, input.operation, input.args)).catch(() => "档位检查失败");
        if (reason) {
          policy = "ask";
          input = { ...input, summary: `${input.summary}（${reason}）` };
        }
      }
      // 允许的文件夹之外的路径：照样审批（「允许」也改成问），批准后把文件夹加进去再执行（roots.ts）。
      const outside = !full && policy !== "off" ? outsideRoots(record.platform, record.allowedRoots, input.operation, input.args) : null;
      if (outside) {
        policy = "ask";
        input = { ...input, summary: `${input.summary}（${outsideRootsNote(outside)}）` };
      }
      const started = now();
      const auditId = await store.audit({
        deviceId: record.id,
        ownerUserId: record.ownerUserId,
        actorType: input.actorType ?? "bot",
        actorId: input.bot.id,
        actorName: input.bot.name,
        action: input.operation,
        summary: input.summary,
        outcome: "requested",
        detail: null,
        durationMs: null,
      });
      const finish = (outcome: string, detail?: string | null) =>
        store.finishAudit(auditId, { outcome, detail: detail ?? null, durationMs: now() - started });
      const refuse = async (outcome: string, message: string): Promise<never> => {
        await finish(outcome, message);
        throw new DeviceRefusedError(message);
      };

      if (input.signal?.aborted) return refuse("cancelled", TOOL_STOPPED_ZH);
      if (record.revoked) return refuse("refused", "这台设备已被撤销。");
      if (record.paused) return refuse("refused", "这台设备已紧急停止，所有远程操作都被拒绝。");
      if (policy === "off")
        return refuse(
          "refused",
          `「${OPERATION_LABEL[input.operation]}」能力在这台设备上是关闭的。请到 设置 → 设备 打开。`,
        );
      if (!connections.has(record.id)) return refuse("offline", "这台设备当前离线。");
      if (input.args.elevated === true && !full)
        return refuse("refused", "管理员身份运行只在「完全访问」模式下可用。用户可以在 设置 → 设备 → 这台设备 → 权限 里打开完全访问。");
      {
        const connection = connections.get(record.id);
        const supported = connection?.features ? connection.features.has(input.operation) : LEGACY_OPERATIONS.has(input.operation);
        if (!supported)
          return refuse(
            "refused",
            `这台设备上的 ChisaBot 客户端（${record.clientVersion ?? "旧版"}）还不支持「${OPERATION_LABEL[input.operation] ?? input.operation}」。请把 ChisaBot PC 更新到 0.1.8 或更新版本（服务器节点重新运行安装命令即可）。`,
          );
      }

      let approvalNote: string | null = null;
      const preference =
        policy === "ask" && confirm && input.actorType !== "user"
          ? await confirm
              .before({
                ownerUserId: record.ownerUserId,
                botId: input.bot.id,
                operation: input.operation,
                operationLabel: OPERATION_LABEL[input.operation] ?? input.operation,
                summary: input.summary,
                args: input.args,
              })
              .catch(() => "ask" as const)
          : "ask";
      if (input.signal?.aborted) return refuse("cancelled", TOOL_STOPPED_ZH);
      if (policy === "ask" && preference === "auto" && !outside) {
        approvalNote = "按审批偏好直接执行";
      } else if (policy === "ask" && preference === "full") {
        // 机器人完全访问（输入框权限）：不问，直接做；允许的文件夹以外就先把文件夹加进去（和批准时一样，写审计）。
        approvalNote = "机器人完全访问，直接执行";
        if (outside) {
          const fresh = await store.get(record.id);
          if (input.signal?.aborted) return refuse("cancelled", TOOL_STOPPED_ZH);
          if (!fresh || fresh.revoked || fresh.paused) return refuse("refused", "设备已停止或被撤销。");
          const added = await addOutsideRoot(fresh, outside.folder, "完全访问自动");
          if (added !== true) return refuse("refused", added);
          approvalNote = `${approvalNote}；已把 ${outside.folder} 加入允许的文件夹`;
        }
      } else if (policy === "ask") {
        const decision = await requestApproval(record, input);
        if (input.signal?.aborted || decision.by === "aborted") return refuse("cancelled", TOOL_STOPPED_ZH);
        const who = decision.by === "device" ? "PC 上" : decision.by === "expired" ? "" : "网页上";
        if (!decision.approved)
          return refuse(
            decision.by === "expired" ? "expired" : "denied",
            decision.by === "expired"
              ? "审批超时（2 分钟内无人处理），操作未执行。"
              : `用户在${who}拒绝了这次操作。`,
          );
        approvalNote = `已在${who}批准`;
        // 审批期间配置可能变了（例如按了紧急停止）。
        const fresh = await store.get(record.id);
        if (input.signal?.aborted) return refuse("cancelled", TOOL_STOPPED_ZH);
        if (!fresh || fresh.revoked || fresh.paused)
          return refuse("refused", "审批期间设备已停止或被撤销。");
        if (outside) {
          const added = await addOutsideRoot(fresh, outside.folder, who ? `${who}批准` : "批准");
          if (added !== true) return refuse("refused", added);
          approvalNote = `${approvalNote}；已把 ${outside.folder} 加入允许的文件夹`;
        }
      }

      if (input.signal?.aborted) return refuse("cancelled", TOOL_STOPPED_ZH);
      const connection = connections.get(record.id);
      if (!connection) return refuse("offline", "这台设备当前离线。");
      const id = randomUUID();
      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? defaultTimeoutMs, 1_000), 15 * 60_000);
      try {
        let result = await new Promise<unknown>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            if (!connection.pending.delete(id)) return;
            cleanup();
            send(connection, { type: "cancel", id });
            reject(new DeviceRefusedError(TOOL_STOPPED_ZH));
          };
          const timer = setTimeout(() => {
            if (!connection.pending.delete(id)) return;
            cleanup();
            send(connection, { type: "cancel", id });
            reject(new DeviceRefusedError(`PC 端 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果。`));
          }, timeoutMs);
          unref(timer);
          connection.pending.set(id, { resolve, reject, timer, cleanup });
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) { onAbort(); return; }
          const sent = send(connection, {
            type: "call",
            id,
            operation: input.operation,
            args: input.args,
            botName: input.bot.name,
            timeoutMs,
          });
          if (!sent) {
            cleanup();
            connection.pending.delete(id);
            reject(new DeviceRefusedError("无法把调用发送到设备。"));
          }
        });
        if (input.signal?.aborted) throw new DeviceRefusedError(TOOL_STOPPED_ZH);
        if (
          input.operation === "screenshot" &&
          result &&
          typeof result === "object" &&
          typeof (result as { base64?: unknown }).base64 === "string"
        ) {
          const { base64, ...rest } = result as { base64: string } & Record<string, unknown>;
          const shot = keepScreenshot(record.id, base64);
          result = {
            ...rest,
            screenshotId: shot,
            url: `/api/devices/${record.id}/screenshots/${shot}`,
            bytes: Math.round((base64.length * 3) / 4),
          };
        }
        const diff = result && typeof result === "object" && typeof (result as { diff?: unknown }).diff === "string" ? (result as { diff: string }).diff : "";
        await finish("succeeded", [full ? "完全访问" : null, approvalNote, diff ? diff.slice(0, 900) : null].filter(Boolean).join("\n") || null);
        return result;
      } catch (error) {
        const message = errorText(error);
        await finish(input.signal?.aborted ? "cancelled" : /超时|没有返回/.test(message) ? "timeout" : "failed", [approvalNote, message].filter(Boolean).join("；"));
        throw error instanceof DeviceRefusedError ? error : new DeviceRefusedError(message);
      }
    },
  };
}

export type DeviceHub = ReturnType<typeof createDeviceHub>;

export function describeChange(before: DeviceRecord, after: DeviceRecord): string {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`名称：${before.name} → ${after.name}`);
  if (before.paused !== after.paused) parts.push(after.paused ? "紧急停止：开" : "紧急停止：关");
  for (const key of Object.keys(after.capabilities) as (keyof DeviceCapabilities)[]) {
    if (before.capabilities[key] !== after.capabilities[key])
      parts.push(`${key}：${before.capabilities[key]} → ${after.capabilities[key]}`);
  }
  if (before.allowedRoots.join("|") !== after.allowedRoots.join("|"))
    parts.push(`允许的文件夹：${after.allowedRoots.length} 个`);
  if (before.botIds.slice().sort().join("|") !== after.botIds.slice().sort().join("|"))
    parts.push(`可用机器人：${after.botIds.length} 个`);
  return parts.join("；") || "无变化";
}
