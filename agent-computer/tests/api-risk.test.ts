import { describe, expect, test } from "bun:test";
import {
  API_RISK_MAX_BYTES,
  createApiRiskBuffer,
  detectApiRisk,
  extractApiRiskMessage,
  isInspectableJsonResponse,
} from "../src/api-risk";

describe("api-risk response inspection", () => {
  test("isInspectableJsonResponse allows small json xhr/fetch responses and rejects large or non-json payloads", () => {
    expect(
      isInspectableJsonResponse(
        { "content-type": "application/json; charset=utf-8", "content-length": "256" },
        200,
        "xhr",
      ),
    ).toBe(true);

    expect(
      isInspectableJsonResponse(
        { "Content-Type": "application/problem+json" },
        429,
        "fetch",
      ),
    ).toBe(true);

    expect(
      isInspectableJsonResponse(
        { "content-type": "application/json", "content-length": String(API_RISK_MAX_BYTES) },
        200,
        "fetch",
      ),
    ).toBe(false);

    expect(
      isInspectableJsonResponse(
        { "content-type": "text/html; charset=utf-8", "content-length": "120" },
        200,
        "document",
      ),
    ).toBe(false);

    expect(
      isInspectableJsonResponse(
        { "content-type": "application/json", "content-length": "100" },
        204,
        "fetch",
      ),
    ).toBe(false);

    expect(
      isInspectableJsonResponse(
        { "content-type": "application/json", "content-length": "100" },
        200,
        "image",
      ),
    ).toBe(false);
  });

  test("extractApiRiskMessage checks top-level message/msg/error/errMsg/toast fields", () => {
    expect(
      extractApiRiskMessage({ code: 40301, message: "触发安全风控，请完成滑块验证" }),
    ).toBe("触发安全风控，请完成滑块验证");
    expect(
      extractApiRiskMessage({ msg: "请求过于频繁，请稍后再试" }),
    ).toBe("请求过于频繁，请稍后再试");
    expect(
      extractApiRiskMessage({ error: "Too many requests from this IP" }),
    ).toBe("Too many requests from this IP");
    expect(
      extractApiRiskMessage({ errMsg: "检测到异常访问，访问受限" }),
    ).toBe("检测到异常访问，访问受限");
    expect(
      extractApiRiskMessage({ toast: "Rate limit exceeded, verification required" }),
    ).toBe("Rate limit exceeded, verification required");

    expect(extractApiRiskMessage({ message: "ok", data: { id: 1 } })).toBeUndefined();
    expect(extractApiRiskMessage({ msg: "保存成功" })).toBeUndefined();
    expect(extractApiRiskMessage(["rate limit"])).toBeUndefined();
    expect(
      extractApiRiskMessage({ nested: { message: "rate limit" } }),
    ).toBeUndefined();
  });

  test("detectApiRisk returns riskControl payload and skips invalid or >=32KB bodies", () => {
    const hit = detectApiRisk(
      JSON.stringify({ code: 429, msg: "操作过于频繁，触发限流" }),
      "https://api.example.com/v1/submit",
    );
    expect(hit).toEqual({
      url: "https://api.example.com/v1/submit",
      reason:
        "检测到接口风控或限流提示「操作过于频繁，触发限流」；请停止重复尝试，换用其他方式或请用户接管处理。",
    });

    expect(detectApiRisk("not json", "https://api.example.com/bad")).toBeUndefined();

    const oversized = JSON.stringify({
      msg: "rate limit",
      pad: "x".repeat(API_RISK_MAX_BYTES),
    });
    expect(
      detectApiRisk(oversized, "https://api.example.com/huge"),
    ).toBeUndefined();
  });

  test("createApiRiskBuffer keeps hits within 10s window and drops expired ones", () => {
    const buffer = createApiRiskBuffer(10_000, 5);
    const hit1 = { url: "https://a.example/1", reason: "risk-1" };
    const hit2 = { url: "https://a.example/2", reason: "risk-2" };

    buffer.record(hit1, 1_000);
    expect(buffer.latest(5_000)).toEqual(hit1);

    buffer.record(hit2, 6_000);
    expect(buffer.latest(10_999)).toEqual(hit2);
    expect(buffer.latest(15_999)).toEqual(hit2);
    expect(buffer.latest(16_001)).toBeUndefined();

    buffer.record(hit1, 20_000);
    buffer.clear();
    expect(buffer.latest(20_001)).toBeUndefined();
  });
});
