import { guardedFetch, BlockedUrlError } from "../../../shared/net/guarded-fetch";
import type { NotifyWebhookView } from "../../../shared/personal-sources";
import { DeliveryOutcomeUnknownError, DeliveryRejectedError } from "../delivery/durable-dispatch";

/** A transport receipt means accepted by the endpoint, never read by the recipient. */
export async function sendWebhook(input: { url: string; kind: NotifyWebhookView["kind"]; title: string; body: string; id: string; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<string[]> {
  if (input.signal?.aborted) throw new DeliveryRejectedError("发送前已取消。");
  const text = `【${input.title}】\n${input.body}`;
  const payload = input.kind === "feishu" ? { msg_type: "text", content: { text } }
    : input.kind === "dingtalk" || input.kind === "wecom" ? { msgtype: "text", text: { content: text } }
    : input.kind === "bark" ? { title: input.title, body: input.body, group: "ChisaBot" }
    : input.kind === "serverchan" ? { title: input.title, desp: input.body }
    : { title: input.title, message: input.body, text, content: text, source: "chisabot", deliveryId: input.id };
  let response;
  try {
    response = await guardedFetch(input.url, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json", "Idempotency-Key": input.id }, timeoutMs: 8_000, maxBytes: 64 * 1024, maxRedirects: 0, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  } catch (error) {
    if (error instanceof BlockedUrlError) throw new DeliveryRejectedError("通知目标未通过公网地址检查，未发送。");
    throw new DeliveryOutcomeUnknownError("未收到通知平台确认，发送结果待核对；不会自动重发。");
  }
  if (response.status < 200 || response.status >= 300) {
    if (response.status >= 500) throw new DeliveryOutcomeUnknownError(`通知平台返回 HTTP ${response.status}，接收结果待核对。`);
    throw new DeliveryRejectedError(`通知平台拒绝请求（HTTP ${response.status}）。`, response.status === 429);
  }
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(response.body.toString("utf8")); } catch {
    if (input.kind !== "custom") throw new DeliveryOutcomeUnknownError("通知平台响应无法解析，接收结果待核对。");
  }
  const code = input.kind === "feishu" ? data.code ?? data.StatusCode
    : input.kind === "dingtalk" || input.kind === "wecom" ? data.errcode
    : input.kind === "bark" || input.kind === "serverchan" ? data.code : undefined;
  const expected = input.kind === "bark" ? 200 : 0;
  if (input.kind !== "custom" && (typeof code !== "number" || response.truncated)) throw new DeliveryOutcomeUnknownError("通知平台未返回完整确认，接收结果待核对。");
  if (typeof code === "number" && code !== expected) throw new DeliveryRejectedError(`通知平台拒绝发送（业务码 ${code}）。`);
  // Do not retain provider response bodies: some contain credentials or private links.
  const dataNode = data.data && typeof data.data === "object" ? data.data as Record<string, unknown> : {};
  return [data.message_id, dataNode.message_id, dataNode.pushid].filter((id): id is string => typeof id === "string" && id.length > 0);
}
