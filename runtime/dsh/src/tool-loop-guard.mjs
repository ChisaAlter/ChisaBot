/**
 * Tool-loop guard for one DSH session.
 *
 * A model can keep calling tools forever: the same call with the same arguments, or an endless
 * walk of different calls that never reaches an answer. DSH itself has no step cap, so a turn
 * like that spins until someone presses stop, and the person sees only a spinner. This guard
 * bounds every turn:
 *
 * - the same tool with the same arguments, with no state change in between, runs at most
 *   `maxRepeats - 1` times (QA513 P2: a write / edit / side-effecting shell, or a different
 *   result for the same call, resets that streak so multi-step coding is not stopped);
 * - at most `maxCalls` tool calls are attempted per turn;
 * - once either limit is hit, no further call runs in that turn. The model is told to stop and
 *   answer honestly; if it still asks for tools `grace` more times, the turn is concluded with a
 *   plain statement of what happened, so the person always gets an answer instead of a spinner.
 */
export const TOOL_CALLS_PER_TURN = 40;
export const SAME_CALL_REPEATS = 4;
export const STOP_GRACE_CALLS = 2;

const LIMITS = {
  maxCalls: TOOL_CALLS_PER_TURN,
  maxRepeats: SAME_CALL_REPEATS,
  grace: STOP_GRACE_CALLS,
};

/** Stable JSON: object keys sorted, so `{a,b}` and `{b,a}` are the same call. */
export function canonicalArgs(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalArgs).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalArgs(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * Tools that change workspace / system state. A successful one between two identical calls means
 * the second call is not "stuck repeating" (QA513 P2: read → write → test → read is fine).
 */
export function isMutatingTool(name) {
  if (typeof name !== "string" || !name) return false;
  const n = name.toLowerCase().replace(/[\s-]+/g, "_");
  return /(?:^|_)(?:write|edit|create|delete|remove|append|patch|apply|update|save|mkdir|move|rename|copy|cp|rm|touch|install|uninstall|commit|push|run|exec|shell|bash|sh|powershell|cmd|test|pytest|build|deploy)(?:_|\d|$)/.test(
    n,
  );
}

/** Validates optional limits from the runtime configuration; anything else keeps the defaults. */
export function toolLoopLimits(input) {
  const limits = { ...LIMITS };
  if (!input || typeof input !== "object") return limits;
  for (const key of Object.keys(LIMITS)) {
    const value = input[key];
    if (value === undefined) continue;
    const min = key === "grace" ? 0 : key === "maxRepeats" ? 2 : 1;
    if (!Number.isSafeInteger(value) || value < min || value > 1000)
      throw new Error(`Invalid toolLoop.${key}.`);
    limits[key] = value;
  }
  return limits;
}

export const MODEL_STOP_NOTICE =
  "TOOL_LOOP_STOPPED: this call was NOT executed. The tool loop for this turn has been stopped by ChisaBot because {why}. " +
  "Do not call any more tools in this turn. Reply to the user now, in the user's language, with an honest conclusion: " +
  "what you tried, what you actually found, what is still missing or failing, and what the user can do next. " +
  "Do not claim anything succeeded that did not.";

function resultFingerprint(result) {
  if (result == null) return "null";
  if (typeof result === "string") return JSON.stringify(result);
  if (typeof result === "object") {
    if (typeof result.content === "string")
      return `content:${JSON.stringify(result.content)}`;
    try {
      return canonicalArgs(result);
    } catch {
      return String(result);
    }
  }
  return JSON.stringify(result);
}

function looksFailed(result) {
  if (result == null) return true;
  if (typeof result === "string")
    return /^(error\b|failed\b|exception\b)/i.test(result.trim());
  if (typeof result === "object") {
    if (result.ok === false || result.error) return true;
    if (typeof result.content === "string")
      return /^(error\b|failed\b|exception\b)/i.test(result.content.trim());
  }
  return false;
}

export class ToolLoopGuard {
  constructor(limits = LIMITS) {
    this.limits = { ...LIMITS, ...limits };
    this.turn = undefined;
    this.reset();
  }

  reset() {
    this.attempts = 0;
    this.succeeded = 0;
    this.failed = 0;
    this.rejected = 0;
    this.executed = new Map();
    this.lastSignature = undefined;
    this.streak = 0;
    this.lastResults = new Map();
    this.pending = undefined;
    this.stopped = undefined;
    this.refused = 0;
  }

  /** Whether the current turn's loop was stopped (the action nudge must not restart it). */
  isStopped(turn) {
    return this.turn === turn && this.stopped !== undefined;
  }

  /**
   * Decide one tool call. Returns `{ kind: "run" }`, `{ kind: "refuse", message }` (a model-facing
   * error; the call is not executed) or `{ kind: "conclude", text }` (end the turn with `text`).
   */
  admit(turn, name, args) {
    if (turn !== this.turn) {
      this.turn = turn;
      this.reset();
    }
    if (this.stopped) {
      this.refused += 1;
      if (this.refused > this.limits.grace)
        return { kind: "conclude", text: this.conclusion() };
      return { kind: "refuse", message: this.notice() };
    }
    const signature = `${name}\u0000${canonicalArgs(args)}`;
    // Only a consecutive streak of the same call counts as a repeat. An intervening different
    // call (including a write) resets the streak so multi-step coding is not blocked (QA513 P2).
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.streak = 0;
    }
    this.streak += 1;
    this.attempts += 1;
    if (this.streak >= this.limits.maxRepeats) {
      this.stopped = { reason: "repeat", name, count: this.streak };
    } else if (this.attempts > this.limits.maxCalls) {
      this.stopped = { reason: "limit", name, count: this.attempts };
    }
    if (this.stopped) {
      // This attempt did not run.
      this.attempts -= 1;
      this.streak -= 1;
      if (this.limits.grace === 0)
        return { kind: "conclude", text: this.conclusion() };
      return { kind: "refuse", message: this.notice() };
    }
    this.pending = { name, signature };
    return { kind: "run" };
  }

  /**
   * Record the outcome of a call that `admit` allowed. Gateway rejects are not "实际执行"
   * (QA513 P3). A different result for the same call, or a mutating tool, resets the repeat streak.
   */
  observe(outcome) {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const { name, signature } = pending;
    // Approval pause: call has not run yet. Drop the pending slot and roll back the admit
    // that reserved attempts/streak, so a resume of the same call is counted once
    // (QA513 r2 P2: otherwise rebind + re-admit double-counts and can refuse an approved call).
    if (outcome?.deferred) {
      this.attempts -= 1;
      this.streak -= 1;
      return;
    }
    if (outcome?.rejected) {
      this.rejected += 1;
      return;
    }
    const result = outcome?.result;
    const failed = outcome?.failed === true || looksFailed(result);
    if (failed) this.failed += 1;
    else this.succeeded += 1;
    this.executed.set(name, (this.executed.get(name) ?? 0) + 1);
    const fingerprint = resultFingerprint(result);
    const previous = this.lastResults.get(signature);
    this.lastResults.set(signature, fingerprint);
    // Same call, new result → progress; keep this call as streak of 1.
    // Intervening different calls (including writes) already reset the streak in admit
    // via lastSignature — no need to special-case mutating names here, or a repeated
    // `run_tests` with the same failure would never trip the guard.
    if (previous !== undefined && previous !== fingerprint) this.streak = 1;
  }

  notice() {
    const why =
      this.stopped.reason === "repeat"
        ? `the tool "${this.stopped.name}" was requested ${this.stopped.count} times with identical arguments without progress`
        : `this turn reached the limit of ${this.limits.maxCalls} tool calls`;
    return MODEL_STOP_NOTICE.replace("{why}", why);
  }

  /** The person-facing conclusion used when the model keeps asking for tools after the stop. */
  conclusion() {
    const tally = [...this.executed]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, count]) => `「${tool}」${count} 次`)
      .join("、");
    const ran = this.succeeded + this.failed;
    const parts = [];
    if (ran)
      parts.push(
        `实际执行了 ${ran} 次工具调用（成功 ${this.succeeded} 次、失败 ${this.failed} 次${tally ? `；${tally}` : ""}）`,
      );
    else parts.push("没有实际执行成功的工具调用");
    if (this.rejected)
      parts.push(`另有 ${this.rejected} 次调用被网关拒绝、未执行`);
    const ranSentence = `${parts.join("；")}。`;
    const why =
      this.stopped.reason === "repeat"
        ? `模型反复用同样的参数调用「${this.stopped.name}」（已连续请求 ${this.stopped.count} 次），没有新进展`
        : `工具调用达到了单轮上限（${this.limits.maxCalls} 次）仍没有得出结论`;
    const outcome =
      this.succeeded > 0
        ? "已有部分结果，但还没有得出可以确认的最终结论，我不会假装已经完成。"
        : "没有拿到可以确认的结果，我不会假装已经完成。";
    return `这一轮我停下来了：${why}，叫它停下作答后它仍继续请求工具，所以我中止了这一轮，没有继续空转。${ranSentence}${outcome}你可以换个说法、补充更具体的信息，或换一个模型后再试。`;
  }
}

/**
 * Keep one guard per run across compose/rebind (approval resume). A new runId starts fresh;
 * a new turn still resets inside `admit` (QA513 P3).
 */
export function ensureLoopGuard(state, limits) {
  const runId = state?.binding?.runId;
  if (!state.loopGuard || state.loopGuardRunId !== runId) {
    state.loopGuard = new ToolLoopGuard(limits);
    state.loopGuardRunId = runId;
    state.loopConcluded = undefined;
  }
  return state.loopGuard;
}
