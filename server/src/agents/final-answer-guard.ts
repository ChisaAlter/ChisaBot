import { randomUUID } from "node:crypto";
import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { Observable } from "rxjs";
import { TOOL_STOPPED_ZH } from "../confirmations/context";
import { REFUSAL_MARKER } from "../plugins/tools";

/**
 * 工具失败之后，这一轮一定要有一句话（Hark 对比 A4，2026-10-29）。
 *
 * 线上 #12「帮我总结这个网页」：web_fetch 读维基超时，工作卡写着「1 步失败」，之后模型一个字都没说，
 * 这一轮以 RUN_FINISHED 结束，界面只剩「这一轮没有收到回答」。模型拿到失败结果后大多会自己解释，
 * 但不是每次都会；运行链路里也没有任何兜底，于是偶发地出现整轮空回复。
 *
 * 这里只管一种情况：这一轮最后一个工具结果是失败（`Refused.` / `Error:`，不含用户自己按停止），
 * 而它之后没有任何回答文字就结束了。此时在 RUN_FINISHED 之前补一条说清原因的回答，
 * 而不是让人对着空白猜。其余情况（成功的工具之后不说话的后台回合、等审批、交给浏览器的工具）原样放行。
 */
const STEP_NAMES: Record<string, string> = {
  web_fetch: "读取网页",
  web_search: "联网搜索",
};

type Failure = { name: string; reason: string };

/** 工具结果在事件里是 JSON 编码过的（字符串结果外面多一层引号）。 */
function unwrap(content: unknown): string {
  if (typeof content !== "string") return "";
  if (!content.startsWith('"')) return content;
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "string" ? parsed : content;
  } catch {
    return content;
  }
}

function failureOf(name: string, content: unknown): Failure | null {
  const text = unwrap(content).trim();
  const marker = text.startsWith(REFUSAL_MARKER)
    ? REFUSAL_MARKER
    : text.startsWith("Error:")
      ? "Error:"
      : null;
  if (!marker) return null;
  if (text.includes(TOOL_STOPPED_ZH)) return null;
  const reason = text.slice(marker.length).split("\n")[0]?.trim().slice(0, 120);
  return { name, reason: reason ?? "" };
}

export function finalAnswerFor(failure: Failure): string {
  const step = STEP_NAMES[failure.name] ?? failure.name;
  const why = failure.reason ? `（${failure.reason}）` : "";
  const hint =
    failure.name === "web_fetch"
      ? "可能是网站暂时连不上。点「重试」再试一次，或者把网页内容直接贴给我。"
      : "点「重试」再试一次。";
  return `抱歉，这一轮没能给出回答：「${step}」这一步失败了${why}。${hint}`;
}

export function guaranteeFinalAnswer(
  source: Observable<BaseEvent>,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const names = new Map<string, string>();
    let failure: Failure | null = null;
    let pendingCall = false;
    let spoke = false;
    const subscription = source.subscribe({
      next: (event) => {
        const e = event as BaseEvent & Record<string, unknown>;
        switch (event.type) {
          case EventType.TOOL_CALL_START:
            names.set(String(e.toolCallId), String(e.toolCallName ?? ""));
            pendingCall = true;
            break;
          case EventType.TOOL_CALL_RESULT:
            pendingCall = false;
            spoke = false;
            failure = failureOf(
              names.get(String(e.toolCallId)) ?? "",
              e.content,
            );
            break;
          case EventType.TEXT_MESSAGE_CONTENT:
          case EventType.TEXT_MESSAGE_CHUNK:
            if (typeof e.delta === "string" && e.delta.trim()) spoke = true;
            break;
          case EventType.RUN_FINISHED:
            if (
              failure &&
              !spoke &&
              !pendingCall &&
              !e.outcome &&
              !e.interrupt
            ) {
              const messageId = `final-answer-${randomUUID()}`;
              subscriber.next({
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              } as BaseEvent);
              subscriber.next({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: finalAnswerFor(failure),
              } as BaseEvent);
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                messageId,
              } as BaseEvent);
            }
            break;
        }
        subscriber.next(event);
      },
      error: (error) => subscriber.error(error),
      complete: () => subscriber.complete(),
    });
    return () => subscription.unsubscribe();
  });
}
