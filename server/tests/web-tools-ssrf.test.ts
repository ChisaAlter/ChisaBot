import { describe, expect, test } from "bun:test";
import { assertPublicUrl } from "../src/web/tools";

/**
 * CR-P1-01：assertPublicUrl 已改走 shared/net；这些地址是旧本地 privateIp 会放行的。
 * 单独文件：web-tools.test.ts 还拉 json-render，在部分环境下会因 workspace 解析挂掉。
 */
describe("assertPublicUrl (shared SSRF)", () => {
  test("refuses classic private / localhost", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicUrl("http://10.1.2.3/")).rejects.toThrow();
    await expect(assertPublicUrl("http://[::1]/")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toThrow();
  });

  test("refuses mapped / tunnel / documentation addresses the weak guard missed", async () => {
    const blocked = [
      "http://[::ffff:0:7f00:1]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[2002:7f00:1::]/",
      "http://[2001::1]/",
      "http://[::7f00:1]/",
      "http://192.0.0.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://169.254.169.254/latest/meta-data/",
    ];
    for (const url of blocked) {
      await expect(assertPublicUrl(url)).rejects.toThrow(/不能访问|只支持|不是有效/);
    }
  });
});
