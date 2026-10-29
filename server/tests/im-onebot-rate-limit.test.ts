import { describe, expect, test } from "bun:test";
import { gatewayClientIp } from "../src/auth/gateway-identity";
import type { Database } from "../src/db/client";
import { createImService } from "../src/im/service";

/*
 * 审计 #5：IM OneBot 反向连接的失败限速按「网关给的真实 IP」计数（gatewayClientIp，和设备令牌限速同一个函数）。
 * nginx 每个转发都把 X-Real-IP / X-Forwarded-For 覆盖成 realip 处理后的 $remote_addr、清掉 CF-Connecting-IP
 * （trust-boundary-redline 测 nginx.conf）；这里测应用侧：客户端自己填的 CF-Connecting-IP 换多少个值都绕不过限速，
 * 也不会把别人的 IP 拖进限速。
 *
 * 用一个不合法的连接 id：authorizeReverse 在查库之前就拒绝，这条路径不碰数据库。
 */
function onebotRoutes() {
  const service = createImService({
    database: {} as Database,
    encryptionKey: "x".repeat(64),
    runTurn: async () => ({ replyText: "" }),
    botAvailable: async () => false,
  });
  return service.routes(async (_c, next) => {
    await next();
  });
}

/** nginx 转给应用的样子：两个头都是真实 IP；再加上客户端想伪造的头。 */
function knock(
  app: ReturnType<typeof onebotRoutes>,
  realIp: string,
  forged: Record<string, string> = {},
) {
  return app.request("/onebot/bad-id", {
    headers: {
      "x-real-ip": realIp,
      "x-forwarded-for": realIp,
      authorization: "Bearer wrong",
      ...forged,
    },
  });
}

describe("gatewayClientIp", () => {
  test("reads X-Real-IP, then the first X-Forwarded-For, never CF-Connecting-IP", () => {
    expect(
      gatewayClientIp(
        new Headers({
          "x-real-ip": "203.0.113.7",
          "cf-connecting-ip": "198.51.100.1",
        }),
      ),
    ).toBe("203.0.113.7");
    expect(
      gatewayClientIp(
        new Headers({
          "x-forwarded-for": "203.0.113.8, 10.0.0.1",
          "cf-connecting-ip": "198.51.100.1",
        }),
      ),
    ).toBe("203.0.113.8");
    expect(
      gatewayClientIp(new Headers({ "cf-connecting-ip": "198.51.100.1" })),
    ).toBeNull();
    expect(gatewayClientIp(new Headers())).toBeNull();
  });
});

describe("IM OneBot failure limit counts the gateway's client IP", () => {
  test("a rotating forged CF-Connecting-IP does not reset the count", async () => {
    const app = onebotRoutes();
    for (let i = 0; i < 20; i++) {
      const response = await knock(app, "203.0.113.7", {
        "cf-connecting-ip": `198.51.100.${i}`,
      });
      expect(response.status).toBe(401);
    }
    expect(
      (
        await knock(app, "203.0.113.7", {
          "cf-connecting-ip": "198.51.100.250",
        })
      ).status,
    ).toBe(429);
    expect((await knock(app, "203.0.113.7")).status).toBe(429);
  });

  test("forging someone else's IP in CF-Connecting-IP does not lock that person out", async () => {
    const app = onebotRoutes();
    for (let i = 0; i < 25; i++)
      await knock(app, "203.0.113.7", { "cf-connecting-ip": "203.0.113.99" });
    expect((await knock(app, "203.0.113.7")).status).toBe(429);
    expect((await knock(app, "203.0.113.99")).status).toBe(401);
  });

  test("a forged X-Real-IP never reaches the app: nginx overwrites it, so the key is the real client", async () => {
    const app = onebotRoutes();
    // 客户端发了 X-Real-IP: 192.0.2.1，nginx 改写成 $remote_addr（203.0.113.7）后才到这里。
    for (let i = 0; i < 20; i++) await knock(app, "203.0.113.7");
    expect((await knock(app, "203.0.113.7")).status).toBe(429);
    expect((await knock(app, "192.0.2.1")).status).toBe(401);
  });
});
