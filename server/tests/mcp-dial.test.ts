import { describe, expect, test } from "bun:test";
import { dialAddress } from "../src/plugins/mcp";

/**
 * 凭据落点的唯一决策点：`dialAddress` 决定一个从 vault 取出的 token 以什么形态出现在
 * 这一次拨号上。要钉住的不是「能连上」而是「密钥去了哪」——查询参数、具名 header、
 * Authorization，或者哪里都不去。拼出来的 URL 只活在这一调用的生命周期里；
 * `mcp_servers.url` 和审计行永远存裸地址，这是 placement 存在的全部理由。
 */

describe("where a vault-held credential lands on the wire", () => {
  test("no token means no placement at all — the bare URL, no headers", () => {
    const { url, headers } = dialAddress({
      url: "https://mcp.amap.com/mcp",
      keyParam: "key",
    });
    expect(url.toString()).toBe("https://mcp.amap.com/mcp");
    expect(headers).toBeUndefined();
  });

  test("keyParam interpolates the token into the query string of a URL made for this call", () => {
    const { url, headers } = dialAddress({
      url: "https://mcp.amap.com/mcp",
      token: "s3cret",
      keyParam: "key",
    });
    expect(url.toString()).toBe("https://mcp.amap.com/mcp?key=s3cret");
    expect(headers).toBeUndefined();
  });

  test("keyParam replaces a stale parameter rather than duplicating it", () => {
    const { url } = dialAddress({
      url: "https://mcp.amap.com/mcp?key=stale",
      token: "fresh",
      keyParam: "key",
    });
    expect(url.toString()).toBe("https://mcp.amap.com/mcp?key=fresh");
  });

  test("keyHeader sends the token as a named header and keeps it out of the URL", () => {
    const { url, headers } = dialAddress({
      url: "https://openapi.tuniu.cn/mcp/hotel",
      token: "s3cret",
      keyHeader: "apiKey",
    });
    expect(url.toString()).toBe("https://openapi.tuniu.cn/mcp/hotel");
    expect(headers).toEqual({ apiKey: "s3cret" });
  });

  test("no placement means the Authorization header, as before", () => {
    const { url, headers } = dialAddress({
      url: "https://mcp.notion.com/mcp",
      token: "tok",
    });
    expect(url.toString()).toBe("https://mcp.notion.com/mcp");
    expect(headers).toEqual({ Authorization: "Bearer tok" });
  });

  test("a token that names its own scheme keeps it — Basic is not wrapped in Bearer", () => {
    const { headers } = dialAddress({
      url: "https://x.example/mcp",
      token: "Basic abc123",
    });
    expect(headers).toEqual({ Authorization: "Basic abc123" });
  });

  test("keyParam wins over keyHeader — an entry must place a secret once", () => {
    const { url, headers } = dialAddress({
      url: "https://x.example/mcp",
      token: "tok",
      keyParam: "key",
      keyHeader: "apiKey",
    });
    expect(url.toString()).toBe("https://x.example/mcp?key=tok");
    expect(headers).toBeUndefined();
  });
});
