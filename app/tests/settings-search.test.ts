import { describe, expect, test } from "bun:test";
import { findEntry, SETTINGS_GROUPS, SETTINGS_PAGES, visibleGroups, visiblePages } from "../src/lib/settings/registry";
import { hitHash, searchSettings } from "../src/lib/settings/search";

/** 设置登记表 + 设置搜索（DESIGN.md §97）。 */
const admin = { admin: true, extras: [] as string[], accountsUi: false };
const user = { admin: false, extras: [] as string[], accountsUi: false };

describe("settings registry", () => {
  test("ids unique, every page in a known group, every route path absolute", () => {
    const ids = SETTINGS_PAGES.flatMap((page) => [page.id, ...page.items.map((item) => `${page.id}.${item.id}`)]);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = new Set(SETTINGS_GROUPS.map((group) => group.id));
    for (const page of SETTINGS_PAGES) {
      expect(groups.has(page.group)).toBe(true);
      expect(page.to.startsWith("/")).toBe(true);
      expect(page.sub.length).toBeGreaterThan(0);
    }
  });

  test("keeps every route the old sidebar linked to", () => {
    const routes = new Set(SETTINGS_PAGES.map((page) => page.to));
    for (const to of [
      "/settings",
      "/settings/memory",
      "/settings/skills",
      "/settings/schedules",
      "/settings/pages",
      "/settings/connected-accounts",
      "/settings/media",
      "/settings/vault",
      "/settings/approvals",
      "/settings/devices",
      "/settings/im",
      "/admin/accounts",
      "/admin/models",
      "/admin/computers",
      "/admin/boundaries",
      "/admin/system-update",
      "/admin/audit",
      "/workflows",
      "/admin/plugins",
    ])
      expect(routes.has(to)).toBe(true);
  });

  test("non-admin sees no admin pages; hidden extras stay hidden", () => {
    const shown = visiblePages(user).map((page) => page.to);
    expect(shown).not.toContain("/admin/models");
    expect(shown).not.toContain("/admin/system-update");
    expect(shown).toContain("/settings/approvals");
    const adminShown = visiblePages(admin).map((page) => page.to);
    expect(adminShown).toContain("/admin/models");
    expect(adminShown).toContain("/admin/plugins");
    expect(adminShown).not.toContain("/workflows");
    expect(adminShown).not.toContain("/admin/accounts");
    expect(visiblePages({ ...admin, extras: ["workflows"], accountsUi: true }).map((page) => page.to)).toEqual(
      expect.arrayContaining(["/workflows", "/admin/plugins", "/admin/accounts"]),
    );
    // 空组不显示（「高级」默认一项都没有）。
    expect(visibleGroups(admin).map((entry) => entry.group.id)).not.toContain("advanced");
    expect(visibleGroups(admin)[0]!.group.id).toBe("general");
    expect(visibleGroups(admin)[1]!.group.id).toBe("bots");
  });
});

describe("settings search", () => {
  test("empty query → nothing", () => {
    expect(searchSettings("", admin)).toEqual([]);
    expect(searchSettings("   ", admin)).toEqual([]);
  });

  test("title, synonym, pinyin initials and English all find the page", () => {
    expect(searchSettings("模型", admin)[0]!.page.id).toBe("models");
    expect(searchSettings("mx", admin)[0]!.page.id).toBe("models");
    expect(searchSettings("api key", admin)[0]!.page.id).toBe("vault");
    expect(searchSettings("深色", admin)[0]!.id).toBe("general.theme");
    expect(searchSettings("dark", admin)[0]!.id).toBe("general.theme");
    expect(searchSettings("完全访问", admin)[0]!.id).toBe("permissions.bot-permission");
    expect(searchSettings("微信", admin)[0]!.page.id).toBe("im");
    expect(searchSettings("回滚", admin)[0]!.id).toBe("system-update.rollback");
    expect(searchSettings("晨报", admin)[0]!.id).toBe("connected-accounts.morning-brief");
    expect(searchSettings("登录信息", admin)[0]!.id).toBe("connected-accounts.saved-logins");
    expect(searchSettings("密钥", admin)[0]!.page.id).toBe("vault");
    expect(searchSettings("知识库", admin)[0]!.id).toBe("memory.knowledge-base");
    expect(searchSettings("精选技能", admin)[0]!.id).toBe("skills.curated-hub");
    expect(searchSettings("stdio", admin)[0]!.id).toBe("plugins.local-stdio-mcp");
  });

  test("admin-only items are not searchable by a normal account", () => {
    expect(searchSettings("回滚", user)).toEqual([]);
    expect(searchSettings("备用模型", user)).toEqual([]);
    expect(searchSettings("记忆", user)[0]!.page.id).toBe("memory");
  });

  test("multi-word: every word must match; page words narrow the item", () => {
    const hits = searchSettings("模型 备用", admin);
    expect(hits[0]!.id).toBe("models.fallback-models");
    expect(searchSettings("模型 不存在的词", admin)).toEqual([]);
  });

  test("results carry a breadcrumb and a jump hash for items only", () => {
    const [hit] = searchSettings("备用模型", admin);
    expect(hit!.path).toBe("模型");
    expect(searchSettings("常驻指令", admin)[0]!.path).toBe("通用");
    expect(searchSettings("记忆 机器人", admin).find((h) => h.item)?.path).toBe("机器人 › 记忆");
    expect(hitHash(hit!)).toBe("find=models.fallback-models");
    const [page] = searchSettings("密钥", admin);
    expect(hitHash(page!)).toBeUndefined();
    expect(findEntry("models.fallback-models")?.item?.find).toBe("备用模型");
    expect(findEntry("nope")).toBeNull();
  });
});
