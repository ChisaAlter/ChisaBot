import { describe, expect, test } from "bun:test";
import { friendlyError } from "../src/lib/chat/friendly-error";

/**
 * 模块 8 审查第 3 条（2026-10-29）：Hermes 适配器以前把所有模型出错都说成「Hermes host turn execution
 * failed」，这里的规则一条都对不上，用户永远看不到「被限流 / 对话太长 / 超时」。适配器现在只透传一个固定的
 * 分类句子（examples/hermes-agent/chisabot_protocol.py 的 _FAILURE_MESSAGES），这里直接从源码读出来，
 * 两边谁改了措辞对不上，这个测试就会失败。
 */
const source = await Bun.file(
  new URL("../../examples/hermes-agent/chisabot_protocol.py", import.meta.url),
).text();
const table = source.slice(
  source.indexOf("_FAILURE_MESSAGES = {"),
  source.indexOf("}", source.indexOf("_FAILURE_MESSAGES = {")),
);
const messages = Object.fromEntries(
  [...table.matchAll(/"([a-z_]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]),
);

const expected: Record<string, string> = {
  rate_limit: "请求太频繁，被模型服务商限流",
  quota: "模型额度不足",
  auth: "模型密钥无效或已过期",
  context_length: "对话太长，超出了模型的上下文上限",
  timeout: "模型响应超时",
  provider_unavailable: "模型服务暂时不可用",
  model_not_found: "找不到所选模型",
  content_filter: "请求被模型的内容安全策略拦截",
  stream: "模型的连接中途断开了",
};

describe("Hermes 透传的出错分类在网页上各自得到对的提示", () => {
  test("适配器的每个分类都在这里，没有漏的", () => {
    expect(Object.keys(messages).sort()).toEqual(Object.keys(expected).sort());
  });

  test.each(Object.entries(expected))("%s", (category, title) => {
    const friendly = friendlyError(messages[category] as string);
    expect(friendly.title).toBe(title);
    expect(friendly.hint).toBeTruthy();
  });

  test("认不出来的仍是原来那句，落到兜底提示", () => {
    expect(source).toContain(
      'TURN_FAILED = "Hermes host turn execution failed"',
    );
    expect(friendlyError("Hermes host turn execution failed").title).not.toBe(
      "模型响应超时",
    );
  });
});
