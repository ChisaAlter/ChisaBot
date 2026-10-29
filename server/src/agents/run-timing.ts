import { AsyncLocalStorage } from "node:async_hooks";
import { type BaseEvent, EventType } from "@ag-ui/client";

/*
 * 一轮回答的分段计时（首字延迟 PR）：请求进门 → 排队（会话守卫、建线程、个人记忆）→ 组装工具 → 拼提示词 →
 * 远端接住（RUN_STARTED）→ 模型第一个字 / 第一次工具调用 → 结束。每轮一行 JSON（type: "run-timing"），
 * 只记毫秒数和计数，不记任何消息内容、工具参数或身份信息。
 */

type RequestTiming = { at: number; marks: Map<string, number> };
const requests = new AsyncLocalStorage<RequestTiming>();
const clock = () => performance.now();

/** `/api/copilotkit/*` 进门时调用：这次请求之后发生的一切（包括 agent.run）都能读到进门时刻。 */
export function withRequestTiming<T>(run: () => T, at: number = clock()): T {
  return requests.run({ at, marks: new Map() }, run);
}

/** 在请求里打一个点（如个人记忆读完）；不在请求里时什么也不做。 */
export function markRequest(name: string, at: number = clock()): void {
  requests.getStore()?.marks.set(name, at);
}

export type RunTiming = {
  type: "run-timing";
  runId: string;
  outcome: "finished" | "error" | "cancelled" | "closed";
  /** 进门 → agent.run 开始：会话守卫、建线程、运行时路由、个人记忆这些都在里面。 */
  queueMs: number | null;
  /** 其中个人记忆 / 技能目录 / 预置技能这段读了多久。 */
  memoryMs: number | null;
  /** agent.run 开始 → 工具组装好。 */
  assembleMs: number | null;
  /** 工具组装好 → 提示词和消息拼好、交给远端。 */
  prepareMs: number | null;
  /** 交给远端 → 远端回 RUN_STARTED。 */
  remoteStartMs: number | null;
  /** 交给远端 → 模型第一个字（TEXT_MESSAGE_CONTENT）。 */
  firstTokenMs: number | null;
  /** 交给远端 → 第一次工具调用开始。 */
  firstToolMs: number | null;
  /** 进门（没有就从 agent.run 开始）→ 第一个字：用户实际等的那段里服务器占了多少。 */
  firstTextMs: number | null;
  totalMs: number;
  toolCalls: number;
};

/** 一轮的计时器：`mark` 打阶段点，`observe` 看流出去的事件，`finish` 出一行记录（只出一次）。 */
export class RunTimer {
  private readonly started: number;
  private readonly request: RequestTiming | undefined;
  private assembled?: number;
  private sent?: number;
  private remoteStarted?: number;
  private firstText?: number;
  private firstTool?: number;
  private toolCalls = 0;
  private done = false;

  constructor(
    private readonly runId: string,
    private readonly now: () => number = clock,
    request: RequestTiming | undefined = requests.getStore(),
  ) {
    this.request = request;
    this.started = now();
  }

  mark(stage: "assembled" | "sent"): void {
    if (stage === "assembled") this.assembled ??= this.now();
    else this.sent ??= this.now();
  }

  observe(event: BaseEvent): void {
    switch (event.type) {
      case EventType.RUN_STARTED:
        this.remoteStarted ??= this.now();
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_CHUNK:
        this.firstText ??= this.now();
        break;
      case EventType.TOOL_CALL_START:
        this.firstTool ??= this.now();
        this.toolCalls += 1;
        break;
    }
  }

  finish(outcome: RunTiming["outcome"]): RunTiming | undefined {
    if (this.done) return undefined;
    this.done = true;
    const span = (from?: number, to?: number) =>
      from === undefined || to === undefined
        ? null
        : Math.max(0, Math.round(to - from));
    const memoryStart = this.request?.marks.get("memory-start");
    const memoryEnd = this.request?.marks.get("memory-end");
    return {
      type: "run-timing",
      runId: this.runId,
      outcome,
      queueMs: span(this.request?.at, this.started),
      memoryMs: span(memoryStart, memoryEnd),
      assembleMs: span(this.started, this.assembled),
      prepareMs: span(this.assembled, this.sent),
      remoteStartMs: span(this.sent, this.remoteStarted),
      firstTokenMs: span(this.sent, this.firstText),
      firstToolMs: span(this.sent, this.firstTool),
      firstTextMs: span(this.request?.at ?? this.started, this.firstText),
      totalMs: span(this.started, this.now()) ?? 0,
      toolCalls: this.toolCalls,
    };
  }
}

export function logRunTiming(timing: RunTiming | undefined): void {
  if (timing) console.info(JSON.stringify(timing));
}
