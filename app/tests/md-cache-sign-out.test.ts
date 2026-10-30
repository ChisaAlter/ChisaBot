import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { signOutAndReLogin } from "../src/lib/auth/login-redirect";
import { signOutMutationOptions } from "../src/lib/auth/mutations";
import { mdCache } from "../src/lib/chat/md-cache";

/** 解析缓存里存的是消息原文：两条退出路径都要清空它，不能带到下一个账号。 */

function fill() {
  mdCache.clear();
  mdCache.set("k", { type: "root", children: [] }, 10);
  expect(mdCache.size).toBe(1);
}

describe("退出时清空 Markdown 解析缓存", () => {
  test("设置里的「退出登录」（signOutMutationOptions.onSuccess）", async () => {
    fill();
    const opts = signOutMutationOptions(new QueryClient());
    // biome-ignore lint/suspicious/noExplicitAny: 只调 onSuccess
    await (opts.onSuccess as any)?.(undefined, undefined, undefined, undefined);
    expect(mdCache.size).toBe(0);
    expect(mdCache.totalChars).toBe(0);
  });

  test("登录异常页的「退出重新登录」（signOutAndReLogin），退出请求失败也清", async () => {
    for (const fail of [false, true]) {
      fill();
      const replaced: string[] = [];
      const win = {
        location: { replace: (u: string) => replaced.push(u) },
        fetch: async () => {
          if (fail) throw new TypeError("network");
          return new Response(null, { status: 200 });
        },
        sessionStorage: { getItem: () => null, setItem: () => {} },
      };
      // biome-ignore lint/suspicious/noExplicitAny: 假窗口
      await signOutAndReLogin(win as any, 1_000);
      expect(replaced).toEqual(["/login"]);
      expect(mdCache.size).toBe(0);
    }
  });
});
