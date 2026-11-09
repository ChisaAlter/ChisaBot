/**
 * Tool-loop guard for one DSH session.
 *
 * A model can keep calling tools forever: the same call with the same arguments, or an endless
 * walk of different calls that never reaches an answer. DSH itself has no step cap, so a turn
 * like that spins until someone presses stop, and the person sees only a spinner. This guard
 * bounds every turn:
 *
 * - the same tool with the same arguments runs at most `maxRepeats - 1` times per turn;
 * - at most `maxCalls` tool calls run per turn;
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

export class ToolLoopGuard {
  constructor(limits = LIMITS) {
    this.limits = { ...LIMITS, ...limits };
    this.turn = undefined;
    this.reset();
  }

  reset() {
    this.calls = 0;
    this.executed = new Map();
    this.signatures = new Map();
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
    const seen = (this.signatures.get(signature) ?? 0) + 1;
    this.signatures.set(signature, seen);
    if (seen >= this.limits.maxRepeats) {
      this.stopped = { reason: "repeat", name, count: seen };
    } else if (this.calls + 1 > this.limits.maxCalls) {
      this.stopped = { reason: "limit", name, count: this.calls + 1 };
    }
    if (this.stopped) {
      if (this.limits.grace === 0)
        return { kind: "conclude", text: this.conclusion() };
      return { kind: "refuse", message: this.notice() };
    }
    this.calls += 1;
    this.executed.set(name, (this.executed.get(name) ?? 0) + 1);
    return { kind: "run" };
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
    const ran = this.calls
      ? `这一轮已经实际执行了 ${this.calls} 次工具调用（${tally}），`
      : "这一轮没有执行成功的工具调用，";
    const why =
      this.stopped.reason === "repeat"
        ? `模型反复用同样的参数调用「${this.stopped.name}」（已请求 ${this.stopped.count} 次），没有新进展`
        : `工具调用达到了单轮上限（${this.limits.maxCalls} 次）仍没有得出结论`;
    return `这一轮我停下来了：${why}，叫它停下作答后它仍继续请求工具，所以我中止了这一轮，没有继续空转。${ran}没有拿到可以确认的结果，我不会假装已经完成。你可以换个说法、补充更具体的信息，或换一个模型后再试。`;
  }
}
