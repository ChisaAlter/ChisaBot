/**
 * GET /control 的回答（CB-103）：任何情况下都是 200 + 一个明确状态，不再回 409 / 503。
 *
 * - `none`：没人接管、没在直播。
 * - `live`：右栏 / 大屏在直播这台电脑。
 * - `user_control`：用户接管着。
 * - `unreachable`：电脑暂时连不上（找不到、不可用、截图让路、3 秒内没回），带 `reason`。
 *
 * 以前 control 读失败直接按 statusFor 回 409 / 503，网页端每秒轮询一次，部署重启那几秒满屏红字。
 * 这里是给人看「现在是什么状态」的，读不到也是一种状态，不是服务器错误。
 */
import type { ComputerControlState } from "../../../shared/computer-control";
import { CaptureBusyError, ComputerUnavailableError } from "./client";

export const CONTROL_READ_TIMEOUT_MS = 3000;

export type ControlStateKind = "none" | "live" | "user_control" | "unreachable";

export type UnreachableReason =
  | "timeout"
  | "capture_busy"
  | "unavailable"
  | "locate_failed"
  | "error";

export type ControlStatus =
  | (ComputerControlState & {
      state: Exclude<ControlStateKind, "unreachable">;
      live?: boolean;
    })
  | { state: "unreachable"; reason: UnreachableReason; message?: string };

type ControlReader = (
  botId: string,
  requestId: string | undefined,
  signal: AbortSignal,
) => Promise<ComputerControlState & { live?: boolean }>;

class ControlReadTimeout extends Error {
  constructor() {
    super("The computer did not answer within 3 seconds.");
    this.name = "ControlReadTimeout";
  }
}

export function unreachableReason(error: unknown): UnreachableReason {
  if (error instanceof ControlReadTimeout) return "timeout";
  if (error instanceof CaptureBusyError) return "capture_busy";
  if (error instanceof ComputerUnavailableError) {
    // locate() 拒绝地址、或 provider 找不到这台电脑。
    return /locat|address|not running|no computer/i.test(error.message)
      ? "locate_failed"
      : "unavailable";
  }
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "error";
}

export function controlStateOf(
  control: ComputerControlState & { live?: boolean },
): Exclude<ControlStateKind, "unreachable"> {
  if (control.holder === "human") return "user_control";
  if (control.live === true) return "live";
  return "none";
}

export async function readControlStatus(
  read: ControlReader,
  botId: string,
  requestId?: string,
  timeoutMs = CONTROL_READ_TIMEOUT_MS,
): Promise<ControlStatus> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new ControlReadTimeout());
    }, timeoutMs);
  });
  try {
    const control = await Promise.race([
      read(botId, requestId, abort.signal),
      timeout,
    ]);
    if (!control || (control.holder !== "bot" && control.holder !== "human"))
      return { state: "unreachable", reason: "error" };
    return { ...control, state: controlStateOf(control) };
  } catch (error) {
    return {
      state: "unreachable",
      reason: unreachableReason(error),
      ...(error instanceof Error ? { message: error.message } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
