import { normalizeCommandTimeout } from "../../../../shared/command-timeout";
import { tryClient } from "@/lib/client";
import { describeComputerCall, reportComputerActivity, reportComputerStatus } from "@/lib/copilot/computer-activity";

export type ToolOutcome = Record<string, unknown> & { ok: boolean };

/**
 * Exported for the test that covers what a Bot is told when a call is refused.
 *
 * The distinctions this draws from a status and a body decide the model's next step, and they are
 * drawn nowhere else, so they are worth pinning without standing up the tool registrations and the
 * runtime around them.
 */
export async function callComputer(
  botId: string,
  path: string,
  /*
   * A body, not a `RequestInit`. The client serialises it, so a caller that stringified first would
   * send a JSON string of a JSON string — which is what happened, briefly, when this moved over.
   */
  init?: { method?: string; body?: unknown },
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Announce before the call so the screen can open while the action is running.
  reportComputerActivity(botId);
  const label = describeComputerCall(path, init?.body);
  if (label) reportComputerStatus(botId, label, true);
  try {
    return await callComputerInner(botId, path, init, signal);
  } finally {
    if (label) reportComputerStatus(botId, label, false);
  }
}

async function callComputerInner(
  botId: string,
  path: string,
  init?: { method?: string; body?: unknown },
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  let response: Response;
  try {
    response = await tryClient(`/api/computers/${botId}${path}`, {
      method: init?.method,
      body: init?.body,
      signal,
      // Match the computer's server-side operation limits, with transport margin. Ordinary queries
      // stay at 30s; a foreground command or download must not be cut off by that read budget.
      timeoutMs: path === "/exec"
        ? normalizeCommandTimeout((init?.body ?? {}) as { timeoutMs?: unknown }).effectiveSec * 1000 + 30_000
        : path === "/download" ? 315_000 : 60_000,
    });
  } catch (error) {
    // An abort is a stopped run, not a computer failure.
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, reason: "Stopped.", stopped: true };
    }
    return {
      ok: false,
      reason: "The assistant's computer could not be reached.",
    };
  }

  let body: Record<string, unknown>;
  try {
    const decoded: unknown = await response.json();
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error("Invalid computer response");
    body = decoded as Record<string, unknown>;
  } catch {
    if (signal?.aborted) return { ok: false, reason: "Stopped.", stopped: true };
    // Headers alone do not confirm completion. In particular, do not report a write as successful
    // when its streamed result was interrupted or timed out, and never retry it automatically.
    return { ok: false, reason: "计算机操作的结果未能确认，请先检查实际状态，避免重复执行。" };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: (body?.error as string) ?? "That did not work.",
      // Preserve refusal/stale-ref/control distinctions for the model's next step.
      ...(response.status === 403
        ? { refused: true, rule: body?.rule ?? null }
        : {}),
      ...(response.status === 409
        ? body?.humanHasControl === true
          ? {
              humanHasControl: true,
              requestId: body?.requestId,
              handoff: body?.handoff,
            }
          : body?.snapshotRequired === true
            ? { staleRefs: true, snapshotRequired: true }
            : { staleRefs: true }
        : {}),
    };
  }

  return { ok: true, ...(body ?? {}) };
}
