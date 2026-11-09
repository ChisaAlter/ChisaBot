import { AsyncLocalStorage } from "node:async_hooks";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { type FallbackUse, withFallbackListener } from "./agents/model-fallback";

/**
 * 输入框里的「上下文」读数（DESIGN.md §25）：这一轮对话现在有多大。
 *
 * AG-UI 的 RUN_FINISHED 自带 `usage`，但那是一次运行里所有模型调用的**累加**：机器人调了两次工具，
 * 输入 token 就被算了三遍，拿它当「上下文占用」会虚高好几倍。真正的占用是这次运行**最后一次**模型
 * 调用的输入 + 输出（下一轮会原样带上它们）。模型调用在 AI SDK 里，RUN_FINISHED 在 AG-UI 里，
 * 中间没有现成的接缝，所以：
 *
 * - `meterLanguageModel` 包住语言模型，每次 doStream / doGenerate 结束时把这一步的用量记到当前运行
 *   的计量器里（AsyncLocalStorage，运行之间互不串）；
 * - `meterRun` 让一次运行在计量器里跑，并在 RUN_FINISHED 上补一个 `metadata.contextUsage`。
 *
 * 事件照常写进本地会话表，所以刷新页面以后也读得到（`GET /api/conversations/threads/:id/context`）。
 * 提供方没有给用量时什么也不补，读数退回到「约」的估算，绝不编数字。
 */
export type ContextUsage = {
  /** 最后一次模型调用的输入 token（含缓存命中）。 */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** 实际回答这一步的模型 id（提供方返回的，或连接上配置的）。 */
  model?: string;
};

type Meter = { last?: ContextUsage; fallback?: FallbackUse };
const meters = new AsyncLocalStorage<Meter>();

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** AI SDK 两代用量形状都认：V3 是 `{ total, … }` 对象，V2 是数字。 */
export function readStepUsage(usage: unknown): Omit<ContextUsage, "model"> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  const pick = (key: string, sub: string) => {
    const value = raw[key];
    if (value && typeof value === "object") return count((value as Record<string, unknown>)[sub]);
    return count(value);
  };
  const inputTokens = pick("inputTokens", "total");
  const outputTokens = pick("outputTokens", "total");
  if (inputTokens === undefined || inputTokens === 0) return undefined;
  const cached =
    raw.inputTokens && typeof raw.inputTokens === "object"
      ? count((raw.inputTokens as Record<string, unknown>).cacheRead)
      : count(raw.cachedInputTokens);
  return {
    inputTokens,
    outputTokens: outputTokens ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  };
}

function record(usage: unknown, model: string | undefined) {
  const meter = meters.getStore();
  if (!meter) return;
  const step = readStepUsage(usage);
  if (step) meter.last = { ...step, ...(model ? { model } : {}) };
}

type StreamResult = { stream: ReadableStream<unknown> } & Record<string, unknown>;
type MeterableModel = {
  modelId?: string;
  doStream?: (options: unknown) => PromiseLike<StreamResult>;
  doGenerate?: (options: unknown) => PromiseLike<Record<string, unknown>>;
};

/**
 * 同一个模型对象，只是每一步结束时记一下用量。不改请求、不改流里的任何一块。
 * 不是对象（网关字符串 id）就原样返回。
 */
export function meterLanguageModel<T>(model: T): T {
  if (!model || typeof model !== "object") return model;
  const target = model as unknown as MeterableModel;
  return new Proxy(model as unknown as object, {
    get(object, property) {
      if (property === "doStream" && typeof target.doStream === "function") {
        return async (options: unknown) => {
          const result = await target.doStream!.call(object, options);
          if (!meters.getStore() || !(result?.stream instanceof ReadableStream)) return result;
          let responseModel: string | undefined;
          const stream = result.stream.pipeThrough(
            new TransformStream<unknown, unknown>({
              transform(part, controller) {
                const chunk = part as { type?: string; usage?: unknown; modelId?: unknown };
                if (chunk?.type === "response-metadata" && typeof chunk.modelId === "string")
                  responseModel = chunk.modelId;
                if (chunk?.type === "finish") record(chunk.usage, responseModel ?? target.modelId);
                controller.enqueue(part);
              },
            }),
          );
          return { ...result, stream };
        };
      }
      if (property === "doGenerate" && typeof target.doGenerate === "function") {
        return async (options: unknown) => {
          const result = await target.doGenerate!.call(object, options);
          const response = result?.response as { modelId?: unknown } | undefined;
          record(result?.usage, typeof response?.modelId === "string" ? response.modelId : target.modelId);
          return result;
        };
      }
      // 不传 receiver：模型类的私有字段只认它自己，getter / 方法都在原对象上跑。
      const value = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  }) as unknown as T;
}

/**
 * 让一次运行在自己的计量器里跑，RUN_FINISHED 带上最后一步的用量。
 * 订阅发生在 `meters.run` 里，AI SDK 之后的所有异步调用都继承这个上下文。
 */
export function meterRun(run: () => Observable<BaseEvent>): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const meter: Meter = {};
    /*
     * 这一轮主模型额度用完 / 不可用、换了备用模型（agents/model-fallback.ts）：记在 RUN_FINISHED 的
     * metadata.modelFallback，对话里那一轮末尾显示一行淡色小字（DESIGN.md §61）。第一次换的为准。
     */
    const onFallback = (use: FallbackUse) => {
      meter.fallback ??= use;
    };
    const subscription = meters.run(meter, () => withFallbackListener(onFallback, () =>
      run().subscribe({
        next: (event) => {
          if (event.type === EventType.RUN_FINISHED && (meter.last || meter.fallback)) {
            const finished = event as BaseEvent & { metadata?: Record<string, unknown> };
            subscriber.next({
              ...finished,
              metadata: {
                ...(finished.metadata ?? {}),
                ...(meter.last ? { contextUsage: meter.last } : {}),
                ...(meter.fallback ? { modelFallback: meter.fallback } : {}),
              },
            } as BaseEvent);
            return;
          }
          subscriber.next(event);
        },
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      }),
    ));
    return () => subscription.unsubscribe();
  });
}

/** 读数的来源，界面据此决定要不要写「约」。 */
export type ThreadContextReading = {
  /** 当前对话占用（最后一步输入 + 输出）。 */
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  model?: string;
  /**
   * measured：最后一次模型调用的实测值；
   * run-total：旧事件只有整次运行的累加用量（有工具调用时偏大）；
   * estimate：没有任何实测用量，按消息文字粗估（不含系统提示与工具定义）。
   */
  source: "measured" | "run-total" | "estimate";
  at?: string;
};

type RunFinishedRow = { event: Record<string, unknown>; created_at: Date | string };

/** 从一条 RUN_FINISHED 里读读数：优先 `metadata.contextUsage`，否则退到 AG-UI 的累加 `usage`。 */
export function readingFromRunFinished(row: RunFinishedRow): ThreadContextReading | undefined {
  const at = new Date(row.created_at).toISOString();
  const metadata = row.event.metadata as Record<string, unknown> | undefined;
  const measured = metadata?.contextUsage as Record<string, unknown> | undefined;
  if (measured && count(measured.inputTokens)) {
    const inputTokens = count(measured.inputTokens)!;
    const outputTokens = count(measured.outputTokens) ?? 0;
    return {
      tokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      ...(count(measured.cachedInputTokens) !== undefined ? { cachedInputTokens: count(measured.cachedInputTokens) } : {}),
      ...(typeof measured.model === "string" ? { model: measured.model } : {}),
      source: "measured",
      at,
    };
  }
  const usage = Array.isArray(row.event.usage) ? (row.event.usage as Record<string, unknown>[]) : [];
  const last = usage[usage.length - 1];
  if (last && count(last.inputTokens)) {
    const inputTokens = count(last.inputTokens)!;
    const outputTokens = count(last.outputTokens) ?? 0;
    return {
      tokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      ...(typeof last.model === "string" ? { model: last.model } : {}),
      source: "run-total",
      at,
    };
  }
  return undefined;
}

/**
 * 没有实测用量时的粗估：中日韩文字约 1 token / 字，其余约 4 字符 / token。
 * 只数消息文字（含工具参数与结果），系统提示、工具定义不在其中，所以只会偏小，界面上标「约」。
 */
export function estimateTokens(messages: readonly unknown[]): number {
  let cjk = 0;
  let other = 0;
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const char of value) {
        if (/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u.test(char)) cjk += 1;
        else other += 1;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      // 图片 / 文件的内联字节不是「文字」，按字符数估会离谱，跳过。
      if (record.type === "image" || record.type === "file" || record.type === "binary") return;
      for (const key of ["content", "text", "arguments", "args", "toolCalls", "function", "result"])
        if (key in record) visit(record[key], depth + 1);
    }
  };
  for (const message of messages) {
    visit(message, 0);
    other += 16; // 每条消息的角色与格式开销
  }
  return Math.round(cjk + other / 4);
}
