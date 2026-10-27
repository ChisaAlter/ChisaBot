import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
// RUN_ERROR 可以是第一个事件（@ag-ui/client 的 verify 允许），所以不补一个假的 RUN_STARTED。
import { Observable } from "rxjs";

/**
 * CB-100：智能体运行时（Hermes、远程 AG-UI / Mastra）在流开始之前就连不上时，给这一轮一个终止错误。
 *
 * 以前 `fetch` 抛出的 ConnectionRefused 会作为 observable 的 `error` 往上冒：@ag-ui/client 只打印
 * 「Agent execution failed」，Intelligence 运行器收不到 RUN_ERROR，前端一直停在「思考中」，这一轮也不会被
 * 标记为失败。RUN_ERROR 通过 `next` 发出再 complete，是运行器认得的「这一轮失败了」（见 turns/run-turn.ts）。
 *
 * 只管「一个事件都还没收到」的失败。流一旦开始，之后的错误原样透传，既有行为不变。
 * 取消（AbortError）也原样透传，让既有的「已停止」路径处理。
 */
export const AGENT_RUNTIME_UNREACHABLE = "AGENT_RUNTIME_UNREACHABLE";

const CONNECT_CODES =
  /ConnectionRefused|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ConnectionClosed|FailedToOpenSocket|UNABLE_TO_VERIFY|CERT_|TLS|SSL|Unable to connect|fetch failed/i;

function describe(error: unknown): { text: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const cause = (error as { cause?: unknown }).cause;
    const causeCode =
      cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
    const resolved = typeof code === "string" ? code : typeof causeCode === "string" ? causeCode : undefined;
    return { text: error.message, ...(resolved ? { code: resolved } : {}) };
  }
  return { text: String(error) };
}

function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message === "Fetch is aborted" ||
    error.message === "signal is aborted without reason"
  );
}

/** 给前端看的那句话：中文标题在前（friendly-error 认这个），原始原因跟在后面。 */
export function preStreamFailureMessage(error: unknown): string {
  const { text, code } = describe(error);
  const raw = [code, text].filter(Boolean).join(": ");
  const connect = CONNECT_CODES.test(raw);
  return connect
    ? `智能体运行时无法连接（${raw || "connection failed"}）`
    : `智能体运行时在开始回答前出错（${raw || "unknown error"}）`;
}

/**
 * CB-100b：连接超时只管「发请求 → 收到第一个事件」这一段。对端接受了 TCP 连接却一直不回（或地址不可路由、
 * SYN 被丢）时，不再无限挂着「思考中」。流一旦开始（第一个事件到了）就不再计时，长回答不受影响。
 * CHISABOT_AGENT_CONNECT_TIMEOUT_MS 可调；0 或负数关闭。默认 20 秒：Hermes / AG-UI 服务端收到请求后会先发
 * RUN_STARTED，正常情况远小于这个值。
 */
export const DEFAULT_AGENT_CONNECT_TIMEOUT_MS = 20_000;

export function agentConnectTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CHISABOT_AGENT_CONNECT_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_CONNECT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_AGENT_CONNECT_TIMEOUT_MS;
  return value <= 0 ? 0 : Math.floor(value);
}

export class FailFastTransport extends AbstractAgent {
  /** `inner` is the real transport (HttpAgent / Mastra agent); readable so tests can inspect it. */
  constructor(
    readonly inner: AbstractAgent,
    readonly connectTimeoutMs: number = agentConnectTimeoutMs(),
  ) {
    super({
      ...(inner.agentId !== undefined ? { agentId: inner.agentId } : {}),
      ...(inner.description !== undefined ? { description: inner.description } : {}),
    });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let started = false;
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
      const failBeforeStream = (error: unknown) => {
        finished = true;
        clearTimer();
        const message = preStreamFailureMessage(error);
        console.error({
          error: "agent_runtime_pre_stream_failure",
          context: { agentId: this.inner.agentId, threadId: input.threadId, runId: input.runId },
          message,
          timestamp: new Date().toISOString(),
        });
        subscriber.next({ type: EventType.RUN_ERROR, code: AGENT_RUNTIME_UNREACHABLE, message } as BaseEvent);
        subscriber.complete();
      };
      const subscription = this.inner.run(input).subscribe({
        next: (event) => {
          if (finished) return;
          started = true;
          clearTimer();
          subscriber.next(event);
        },
        error: (error: unknown) => {
          if (finished) return;
          if (started || isAbort(error)) {
            finished = true;
            clearTimer();
            subscriber.error(error);
            return;
          }
          failBeforeStream(error);
        },
        complete: () => {
          if (finished) return;
          finished = true;
          clearTimer();
          subscriber.complete();
        },
      });
      if (this.connectTimeoutMs > 0 && !started && !finished) {
        timer = setTimeout(() => {
          if (started || finished) return;
          subscription.unsubscribe();
          try {
            this.inner.abortRun();
          } catch {
            // 取消失败不影响把这一轮标成失败。
          }
          const timeout = new Error(`ETIMEDOUT: no response within ${this.connectTimeoutMs}ms`);
          (timeout as { code?: string }).code = "ETIMEDOUT";
          failBeforeStream(timeout);
        }, this.connectTimeoutMs);
      }
      return () => {
        clearTimer();
        subscription.unsubscribe();
      };
    });
  }

  clone(): FailFastTransport {
    return new FailFastTransport(this.inner.clone(), this.connectTimeoutMs);
  }

  abortRun(): void {
    this.inner.abortRun();
    super.abortRun();
  }
}
