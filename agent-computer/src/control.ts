import type {
  ComputerControlState,
  HandoffRequest,
  HandoffSource,
} from "../../shared/computer-control";
import {
  createActionBarrier,
  type ExpiredLease,
  type Release,
} from "./action-barrier";
import type { ControlStore, StoredControl } from "./control-store";
export type ControlState = ComputerControlState;
export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}
export class ControlRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ControlRequestError";
  }
}
export class SnapshotRequiredError extends Error {
  constructor() {
    super("Take a fresh browser snapshot after handback before acting.");
    this.name = "SnapshotRequiredError";
  }
}
export const NO_SECRET_PENDING = "Nothing is waiting for a secret.";
export const HELP_REQUEST_TTL_MS = 10 * 60 * 1000;
export const SECRET_REQUEST_TTL_MS = HELP_REQUEST_TTL_MS;
/**
 * How long a person may keep the wheel without doing anything before it goes back to the Bot.
 *
 * A waiting request had a ten-minute deadline from the start; a *taken* one had none, so a closed tab
 * or a forgotten handback locked the Bot out of its own browser until somebody remembered. Every
 * human click, key and scroll pushes this deadline forward (see `noteHumanActivity`), so it is an
 * idle limit rather than a limit on how long a sign-in may take.
 */
export const HUMAN_HOLD_TTL_MS = 60 * 60 * 1000;
export const HUMAN_HAS_CONTROL =
  "A person has control or has been asked to take control. Wait for them to hand it back before acting.";
export const TAKE_CONTROL_FIRST =
  "Take control before driving the computer yourself.";
type Options = {
  store?: ControlStore;
  invalidateSnapshot?: () => void;
  drainTimeoutMs?: number;
  /** Default deadline for one admitted action (see action-barrier.ts). */
  actionLeaseMs?: number;
  /** An admitted action ran past its lease and the barrier gave it back on its own. */
  onLeaseExpired?: (lease: ExpiredLease) => void;
  /** Taking control timed out waiting for these. Logged so the next stuck take names its cause. */
  onDrainTimeout?: (holders: ExpiredLease[]) => void;
};

/** Request identity is durable; secret values never enter this state machine. */
export function createControl(
  now: () => string = () => new Date().toISOString(),
  options: Options = {},
) {
  const barrier = createActionBarrier({
    leaseMs: options.actionLeaseMs,
    onExpired: options.onLeaseExpired,
  });
  const restored = options.store?.load();
  const data: StoredControl = restored ?? {
    version: 1,
    holder: "bot",
    since: now(),
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    requests: [],
    aliases: {},
  };
  let secret:
    | { label: string; ref: string; snapshotId?: number; requestedAt: string }
    | undefined;
  let storageError: Error | undefined;
  /** Last time a person actually drove the browser; keeps a taken hold from expiring under them. */
  let lastHumanActivityAt = 0;
  const current = () =>
    data.requests.find((r) => r.id === data.currentRequestId);
  const active = (request: HandoffRequest | undefined) =>
    request?.status === "waiting" || request?.status === "taken";
  function persist() {
    // Keep the current identity and the latest 32 terminal records. Their aliases expire together.
    const cutoff = Date.parse(now()) - 30 * 24 * 60 * 60 * 1000;
    const keep = data.requests
      .filter(
        (r) =>
          r.id === data.currentRequestId || Date.parse(r.updatedAt) >= cutoff,
      )
      .slice(-33);
    const ids = new Set(keep.map((r) => r.id));
    data.requests = keep;
    data.aliases = Object.fromEntries(
      Object.entries(data.aliases)
        .filter(([, id]) => ids.has(id))
        .slice(-256),
    );
    if (storageError) throw storageError;
    try {
      options.store?.save(structuredClone(data));
    } catch (error) {
      storageError = new Error(
        "The handoff state could not be saved. Computer actions are disabled until storage is repaired.",
        { cause: error },
      );
      barrier.close();
      throw storageError;
    }
  }
  function finish(
    request: HandoffRequest,
    status: "completed" | "cancelled" | "expired" | "interrupted",
    interruption?: string,
  ) {
    request.status = status;
    request.updatedAt = now();
    request.finishedAt = request.updatedAt;
    delete request.expiresAt;
    if (interruption) request.interruption = interruption;
  }
  function syncAdmission() {
    if (active(current()) || data.holder === "human" || data.recoveryRequired)
      barrier.close();
    else barrier.open();
  }
  function expire() {
    if (storageError) throw storageError;
    const request = current();
    if (
      request?.status === "waiting" &&
      request.expiresAt &&
      Date.parse(now()) > Date.parse(request.expiresAt)
    ) {
      finish(request, "expired");
      persist();
      syncAdmission();
    }
    /*
     * A taken hold expires only after an idle hour. The request's deadline is pushed forward by
     * `noteHumanActivity` on every human click, key and scroll, so somebody working through a login
     * or a 2FA flow keeps the wheel; somebody who closed the tab does not hold it for eight hours.
     */
    if (
      request?.status === "taken" &&
      data.holder === "human" &&
      request.expiresAt &&
      Date.parse(now()) > Date.parse(request.expiresAt)
    ) {
      finish(request, "expired");
      data.holder = "bot";
      data.since = now();
      data.resumeSnapshotRequired = true;
      data.recoveryRequired = false;
      secret = undefined;
      options.invalidateSnapshot?.();
      persist();
      syncAdmission();
    }
    if (
      secret &&
      Date.parse(now()) - Date.parse(secret.requestedAt) > SECRET_REQUEST_TTL_MS
    )
      secret = undefined;
  }
  /**
   * A person just clicked, typed or scrolled. Keep the hold alive without writing on every keystroke:
   * one persist a minute is enough for an hour-long idle deadline.
   */
  function noteHumanActivity() {
    expire();
    const request = current();
    if (data.holder !== "human" || request?.status !== "taken") return;
    const at = Date.parse(now());
    if (at - lastHumanActivityAt < 60_000) return;
    lastHumanActivityAt = at;
    request.updatedAt = new Date(at).toISOString();
    request.expiresAt = new Date(at + HUMAN_HOLD_TTL_MS).toISOString();
    persist();
  }
  function get(requestId?: string): ControlState {
    expire();
    const request = requestId
      ? data.requests.find((r) => r.id === requestId)
      : current();
    if (requestId && !request)
      throw new ControlRequestError("That handoff request was not found.", 404);
    const live = current();
    return {
      holder: data.holder,
      since: data.since,
      requested: live?.status === "waiting",
      reason: active(live) ? live?.reason : undefined,
      request: request ? { ...request } : undefined,
      transitioning:
        (active(live) || data.holder === "human" || data.recoveryRequired) &&
        barrier.pending() > 0,
      resumeSnapshotRequired: data.resumeSnapshotRequired,
      ...(secret
        ? {
            secretWanted: secret.label,
            secretRef: secret.ref,
            secretSnapshotId: secret.snapshotId,
          }
        : {}),
    };
  }
  function intended(id: string): HandoffRequest {
    expire();
    const request = current();
    if (!request || request.id !== id)
      throw new ControlRequestError(
        "That request is no longer the current handoff.",
        409,
      );
    return request;
  }
  function interrupt(reason: string): ControlState {
    const request = current();
    // Recovery is for a page a person was driving: what they left it as is unknown until someone
    // looks. A request nobody took left the page exactly as the Bot had it, and holding the Bot
    // until a person "checks" a page no person touched stranded it asking for control it had.
    // 2026-10-13：interrupt 只在浏览器本身没了的时候被调用（停止、重置、换了浏览器/进程重启），
    // 那个人在操作的页面已经不存在，没有什么可「检查」的。以前这里仍然置 recoveryRequired，
    // 而它既不出现在 GET /control 里、也只有「再接管一次再交还」才能清掉：部署时有人正接管着，
    // 机器人此后所有命令和网页操作都被「A person has control」拒绝，用户却看到控制权在机器人手里。
    // 现在只要求机器人先拍一张新快照（resumeSnapshotRequired，下面照旧设置）。
    if (request && active(request)) finish(request, "interrupted", reason);
    data.recoveryRequired = false;
    data.holder = "bot";
    data.since = now();
    data.resumeSnapshotRequired = true;
    secret = undefined;
    options.invalidateSnapshot?.();
    persist();
    syncAdmission();
    return get();
  }
  // A persisted active request names a page in a previous process. Never call that completion.
  // 旧版本留下的 recoveryRequired（见 interrupt）也一并解开：进程是新的，浏览器也是新的。
  if (
    restored &&
    (active(current()) || data.holder === "human" || data.recoveryRequired)
  )
    interrupt(
      "The computer process restarted; the previous page was interrupted. Request help again to continue.",
    );
  // 进程重启（部署、浏览器回收）而没有人接管过时，页面没有被人动过，不要求 BOT 先拍快照；旧的元素编号
  // 已经随会话一起作废，点击/输入仍会因为编号过期而要求重新拍快照。
  syncAdmission();

  function rememberAlias(toolCallId: string, requestId: string) {
    Object.defineProperty(data.aliases, toolCallId, {
      value: requestId,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return {
    get,
    requestHelp(
      reason: unknown,
      toolCallId?: string,
      source: HandoffSource = "model",
    ): ControlState {
      expire();
      if (
        toolCallId !== undefined &&
        (!toolCallId.trim() || toolCallId.length > 200)
      )
        throw new ControlRequestError(
          "The tool call id must be a nonempty string of at most 200 characters.",
        );
      const previous =
        toolCallId && Object.hasOwn(data.aliases, toolCallId)
          ? data.aliases[toolCallId]
          : undefined;
      if (previous) return get(previous);
      const existing = current();
      if (active(existing) || data.holder === "human") {
        if (toolCallId && existing) {
          rememberAlias(toolCallId, existing.id);
          persist();
        }
        return get();
      }
      barrier.close(); // Before any persistence or awaited browser operation.
      const at = now();
      const request: HandoffRequest = {
        id: crypto.randomUUID(),
        toolCallId,
        reason:
          typeof reason === "string" && reason.trim()
            ? reason.trim().slice(0, 500)
            : "The assistant needs a person to continue.",
        source,
        status: "waiting",
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(Date.parse(at) + HELP_REQUEST_TTL_MS).toISOString(),
      };
      data.currentRequestId = request.id;
      data.requests.push(request);
      if (toolCallId) rememberAlias(toolCallId, request.id);
      persist();
      return get();
    },
    async take(requestId: string): Promise<ControlState> {
      const request = intended(requestId);
      if (request.status === "taken" && data.holder === "human") return get();
      if (request.status !== "waiting")
        throw new ControlRequestError(
          "That request is no longer waiting for control.",
          409,
        );
      barrier.close();
      // Never await here from requestHelp: a navigation detector still owns its action lease.
      try {
        await barrier.drain(options.drainTimeoutMs);
      } catch (error) {
        try {
          options.onDrainTimeout?.(barrier.holders());
        } catch {
          // Diagnostics only.
        }
        throw error;
      }
      const after = intended(requestId);
      if (after.status === "taken" && data.holder === "human") return get();
      if (after.status !== "waiting")
        throw new ControlRequestError(
          "That request is no longer waiting for control.",
          409,
        );
      after.status = "taken";
      after.updatedAt = now();
      after.expiresAt = new Date(
        Date.parse(now()) + HUMAN_HOLD_TTL_MS,
      ).toISOString();
      lastHumanActivityAt = Date.parse(now());
      data.holder = "human";
      data.since = now();
      secret = undefined;
      persist();
      return get();
    },
    release(requestId: string): ControlState {
      const request = intended(requestId);
      if (request.status === "completed" && data.holder === "bot") return get();
      if (
        data.holder !== "human" ||
        (request.status !== "taken" && request.status !== "cancelled")
      )
        throw new ControlRequestError(
          "That request is no longer held by a person.",
          409,
        );
      if (request.status === "taken") finish(request, "completed");
      data.holder = "bot";
      data.since = now();
      data.resumeSnapshotRequired = true;
      data.recoveryRequired = false;
      secret = undefined;
      options.invalidateSnapshot?.();
      persist();
      syncAdmission();
      return get();
    },
    cancel(requestId: string): ControlState {
      const request = intended(requestId);
      if (request.status === "cancelled") return get();
      if (!active(request))
        throw new ControlRequestError("That request is no longer active.", 409);
      finish(request, "cancelled");
      persist();
      syncAdmission();
      return get();
    },
    interrupt,
    snapshotTaken() {
      if (
        data.holder === "bot" &&
        data.resumeSnapshotRequired &&
        !active(current())
      ) {
        data.resumeSnapshotRequired = false;
        persist();
      }
    },
    assertBotMayAct(browserMutation = false) {
      expire();
      if (data.holder === "human" || active(current()) || data.recoveryRequired)
        throw new ControlError(HUMAN_HAS_CONTROL);
      if (browserMutation && data.resumeSnapshotRequired)
        throw new SnapshotRequiredError();
    },
    admitBotAction(
      browserMutation = false,
      label = "action",
      leaseMs?: number,
    ): Release {
      this.assertBotMayAct(browserMutation);
      return barrier.enter(label, leaseMs);
    },
    /** What is holding admission now (path and age). Diagnostics; never secrets. */
    admittedActions(): ExpiredLease[] {
      return barrier.holders();
    },
    humanMayDrive(): boolean {
      expire();
      return data.holder === "human" && barrier.pending() === 0;
    },
    noteHumanActivity,
    requestSecret(input: {
      label?: unknown;
      ref?: unknown;
      snapshotId?: unknown;
    }): ControlState {
      if (typeof input.ref !== "string" || !input.ref.trim())
        throw new ControlRequestError(
          "Say which field the value goes in, using a ref from your snapshot.",
        );
      secret = {
        label:
          typeof input.label === "string" && input.label.trim()
            ? input.label.trim().slice(0, 500)
            : "the value this page is asking for",
        ref: input.ref.trim(),
        snapshotId:
          typeof input.snapshotId === "number" ? input.snapshotId : undefined,
        requestedAt: now(),
      };
      return get();
    },
    pendingSecret(): { ref: string; snapshotId?: number } | null {
      expire();
      return secret ? { ref: secret.ref, snapshotId: secret.snapshotId } : null;
    },
    secretSupplied() {
      secret = undefined;
    },
  };
}
export type Control = ReturnType<typeof createControl>;
