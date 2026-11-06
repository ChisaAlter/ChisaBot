import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import {
  createTaskCenterRoots,
  taskCenterRootPath,
} from "../src/task-center/roots";

/** 不落库的假 $client：行存进 Map，按 owner 前缀隔离。 */
function mockDatabase() {
  const store = new Map<string, string>();
  const unsafe = async (text: string, params: unknown[] = []) => {
    if (text.startsWith("CREATE TABLE")) return [];
    if (text.startsWith("SELECT path FROM")) {
      const [owner] = params as [string];
      return [...store.keys()]
        .filter((key) => key.startsWith(`${owner}\x1f`))
        .map((key) => ({ path: key.slice(owner.length + 1) }));
    }
    if (text.startsWith("SELECT count(*)")) {
      const [owner] = params as [string];
      return [
        {
          count: [...store.keys()].filter((key) =>
            key.startsWith(`${owner}\x1f`),
          ).length,
        },
      ];
    }
    if (text.startsWith("INSERT")) {
      const [owner, path] = params as [string, string];
      store.set(`${owner}\x1f${path}`, path);
      return [];
    }
    if (text.startsWith("DELETE")) {
      const [owner, path] = params as [string, string];
      store.delete(`${owner}\x1f${path}`);
      return [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return { store, unsafe };
}
const roots = (unsafe: unknown) =>
  createTaskCenterRoots({ $client: { unsafe } } as unknown as Database);

describe("task center root path validation", () => {
  test("accepts absolute shapes and normalizes trailing separators", () => {
    expect(taskCenterRootPath(" /srv/docs/ ")).toBe("/srv/docs");
    expect(taskCenterRootPath("C:\\data\\repo\\")).toBe("C:\\data\\repo");
    expect(taskCenterRootPath("D:/docs")).toBe("D:/docs");
    expect(taskCenterRootPath("\\\\server\\share\\")).toBe("\\\\server\\share");
    // 驱动器根与 Unix 根保持原样，不被裁成无效形态。
    expect(taskCenterRootPath("C:\\")).toBe("C:\\");
    expect(taskCenterRootPath("/")).toBe("/");
  });

  test("rejects empty, relative, traversal and credential-looking paths", () => {
    for (const bad of [
      "",
      "   ",
      "relative/path",
      "docs",
      "C:relative",
      "x:",
      "/srv/../escape",
      "..\\up",
      "/srv/token-store",
      "C:\\data\\passwords",
      "\\\\share\\secret",
      `/srv/${"a".repeat(600)}`,
    ]) {
      expect(() => taskCenterRootPath(bad)).toThrow();
    }
  });
});

describe("task center roots store", () => {
  test("ensure creates the owner-keyed table", async () => {
    const calls: string[] = [];
    const module = roots(async (text: string) => {
      calls.push(text);
      return [];
    });
    await module.ensure();
    expect(calls[0]).toContain("chisabot_task_center_roots");
    expect(calls[0]).toContain("PRIMARY KEY");
  });

  test("add dedupes by path, list is per-owner, remove only hits the owner", async () => {
    const { unsafe } = mockDatabase();
    const module = roots(unsafe);
    await module.add("owner", "/srv/docs");
    await module.add("owner", "/srv/docs/");
    await module.add("other", "/srv/private");
    expect(await module.list("owner")).toEqual(["/srv/docs"]);
    await module.remove("owner", "/srv/docs");
    expect(await module.list("owner")).toEqual([]);
    expect(await module.list("other")).toEqual(["/srv/private"]);
  });

  test("add rejects invalid paths before touching the store", async () => {
    const { store, unsafe } = mockDatabase();
    const module = roots(unsafe);
    await expect(module.add("owner", "../etc")).rejects.toThrow("..");
    await expect(module.add("owner", "not-absolute")).rejects.toThrow(
      "绝对路径",
    );
    expect(store.size).toBe(0);
  });

  test("the per-owner cap refuses the 51st root", async () => {
    const { unsafe } = mockDatabase();
    const module = roots(unsafe);
    for (let i = 0; i < 50; i++) await module.add("owner", `/srv/dir-${i}`);
    await expect(module.add("owner", "/srv/one-more")).rejects.toThrow("50");
  });
});
