import { tryClient } from "@/lib/client";

/**
 * Handing control of a Bot's computer to a person, and back.
 *
 * Plain functions rather than factories, and every one of them fails closed. Nothing here is cached:
 * who holds the wheel is a fact about this second, and a stale copy of it would be worse than no
 * copy — it would show somebody a screen they cannot drive, or let them think they can.
 *
 * The reads answer `null` on failure rather than throwing. A panel that cannot say who is driving
 * should say nothing, not tear down the screen the person is looking at.
 */

export type { ComputerControlState as ControlState } from "../../../../shared/computer-control";
import type { ComputerControlState as ControlState } from "../../../../shared/computer-control";

const okListeners = new Set<(computerId: string) => void>();
/** 同一个 bot 的别的控制请求成功了：说明连得上，轮询不必再退避。 */
export function onControlRequestOk(listener: (computerId: string) => void) {
  okListeners.add(listener);
  return () => okListeners.delete(listener);
}
function noteOk(computerId: string) {
  for (const listener of okListeners) listener(computerId);
}

async function callControl(
  computerId: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ControlState | null> {
  const response = await tryClient(
    `/api/computers/${encodeURIComponent(computerId)}${path}`,
    { ...(body === undefined ? {} : { method: "POST", body }), signal },
  );
  if (!response.ok) return null;
  noteOk(computerId);
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || !("holder" in value)) return null;
  if (value.holder !== "bot" && value.holder !== "human") return null;
  return value as ControlState;
}

export function readControl(
  computerId: string,
  requestId?: string,
  signal?: AbortSignal,
) {
  return callControl(
    computerId,
    `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
    undefined,
    signal,
  );
}

/** CB-103：GET /control 的状态。`unreachable` 也包括网关自己给的 502 / 503 / 504 和断网。 */
export type ComputerControlKind =
  | "none"
  | "live"
  | "user_control"
  | "unreachable";

export type ControlRead =
  | { kind: Exclude<ComputerControlKind, "unreachable">; control: ControlState }
  | { kind: "unreachable"; reason: string }
  /** 服务器回了别的错误（403 / 404 …）：按「无」处理，不提示重连、不暂停输入。 */
  | { kind: "error" };

/** 连不上电脑时给人看的话。 */
export const CONTROL_UNREACHABLE_ZH = "暂时连不上电脑";

const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * 读「谁在掌舵」并带上三态（无 / 直播 / 用户接管）或「连不上」。从不抛错、从不打 console.error：
 * 部署重启那几秒 nginx 自己回 502，那是一种状态，不是要报警的错误。
 */
export async function readControlStatus(
  computerId: string,
  signal?: AbortSignal,
): Promise<ControlRead> {
  let response: Response;
  try {
    response = await tryClient(
      `/api/computers/${encodeURIComponent(computerId)}/control`,
      { signal },
    );
  } catch {
    return { kind: "unreachable", reason: "network" };
  }
  if (GATEWAY_STATUSES.has(response.status))
    return { kind: "unreachable", reason: `gateway_${response.status}` };
  if (!response.ok) return { kind: "error" };
  const value = (await response.json().catch(() => null)) as
    | (Partial<ControlState> & { state?: string; reason?: string })
    | null;
  if (!value || typeof value !== "object") return { kind: "error" };
  if (value.state === "unreachable")
    return { kind: "unreachable", reason: value.reason ?? "unknown" };
  if (value.holder !== "bot" && value.holder !== "human")
    return { kind: "error" };
  const control = value as ControlState;
  const kind =
    value.state === "live" ||
    value.state === "user_control" ||
    value.state === "none"
      ? value.state
      : control.holder === "human"
        ? "user_control"
        : "none";
  return { kind, control };
}

export async function takeControl(computerId: string, requestId?: string) {
  const id =
    requestId ??
    (
      await callControl(computerId, "/control/request", {
        reason: "我来接管浏览器。",
      })
    )?.request?.id;
  return id
    ? callControl(computerId, "/control/take", { requestId: id })
    : null;
}

export function releaseControl(computerId: string, requestId: string) {
  return callControl(computerId, "/control/release", { requestId });
}

export function cancelControl(computerId: string, requestId: string) {
  return callControl(computerId, "/control/cancel", { requestId });
}

/**
 * Supply a secret synchronously and never echo the value back to the UI.
 *
 * The one call here that reports why it failed, because a person is waiting on the answer and a
 * silent failure would leave them typing into something that is not listening.
 */
export async function supplySecret(
  computerId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/human/secret`,
      { method: "POST", body: { text } },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: body?.error ?? "That could not be entered." };
  } catch {
    return {
      ok: false,
      error: "The assistant's computer could not be reached.",
    };
  }
}

/**
 * Serializes human input requests without blocking the caller; ordering matters for typed secrets.
 */
let inputQueue: Promise<unknown> = Promise.resolve();

/**
 * Send one human input event. Returns immediately; delivery is ordered.
 */
export function sendHumanInput(
  computerId: string,
  kind: "click" | "type" | "key" | "scroll",
  body: Record<string, unknown>,
): void {
  inputQueue = inputQueue
    .then(() =>
      tryClient(`/api/computers/${computerId}/human/${kind}`, {
        method: "POST",
        body,
      }),
    )
    // Fire-and-forget: the user can see/retry input failures, while the input queue must keep moving.
    .catch(() => undefined);
}
