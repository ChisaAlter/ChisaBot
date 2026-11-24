import { describe, expect, test } from "bun:test";
import { THEMES } from "../src/lib/appearance";
import {
  findEntry,
  navGroups,
  SETTINGS_PAGES,
  visibleGroups,
} from "../src/lib/settings/registry";
import {
  normalizeSlugInput,
  SKILL_SLUG,
  slugFromTitle,
} from "../src/lib/skill-slug";
import { formDirty, shouldConfirmDismiss } from "../src/lib/unsaved";

/** 审查模块 12：未保存拦截、技能名字、设置文案（DESIGN.md §11 / §97 / §154）。 */
const admin = { admin: true, extras: [] as string[], accountsUi: false };

describe("unsaved guard rules", () => {
  test("only Esc / click outside / close button are guarded, and only when dirty", () => {
    expect(shouldConfirmDismiss(true, "escape-key")).toBe(true);
    expect(shouldConfirmDismiss(true, "outside-press")).toBe(true);
    expect(shouldConfirmDismiss(true, "close-press")).toBe(true);
    expect(shouldConfirmDismiss(false, "escape-key")).toBe(false);
    expect(shouldConfirmDismiss(true, undefined)).toBe(false);
    expect(shouldConfirmDismiss(true, "trigger-press")).toBe(false);
  });

  test("formDirty compares every field", () => {
    const base = { title: "a", body: "", shared: false };
    expect(formDirty(base, { ...base })).toBe(false);
    expect(formDirty(base, { ...base, body: "x" })).toBe(true);
    expect(formDirty(base, { ...base, shared: true })).toBe(true);
  });
});

describe("skill slug", () => {
  test("Chinese titles still give a valid, stable name, never --", () => {
    for (const title of [
      "周报",
      "写周报",
      "每日 晨报",
      "🙂",
      "a",
      "中文 AI 助手",
    ]) {
      const slug = slugFromTitle(title);
      expect(SKILL_SLUG.test(slug)).toBe(true);
      expect(slug).not.toContain("--");
      expect(slugFromTitle(title)).toBe(slug);
    }
    expect(slugFromTitle("周报")).not.toBe(slugFromTitle("月报"));
  });

  test("ASCII titles map to readable names", () => {
    expect(slugFromTitle("Weekly Report")).toBe("weekly-report");
    expect(slugFromTitle("  GitHub PR review!! ")).toBe("github-pr-review");
    expect(slugFromTitle("")).toBe("");
    expect(slugFromTitle("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  test("typing is normalised without runs of hyphens", () => {
    expect(normalizeSlugInput("周报")).toBe("");
    expect(normalizeSlugInput("My  Skill")).toBe("my-skill");
    expect(normalizeSlugInput("-a--b-")).toBe("a-b-");
  });
});

describe("settings copy matches the product", () => {
  test("色彩主题文案与数量严格来自 V2 THEMES（6 套），无陈旧数字与液态玻璃残留", () => {
    const palette = findEntry("general.palette")?.item;
    expect(palette).toBeDefined();
    expect(palette?.description).toContain(`${THEMES.length} 套`);
    for (const t of THEMES) {
      expect(palette?.description).toContain(t.name);
    }
    expect(palette?.description).not.toContain("7 套");
    expect(palette?.description).not.toContain("7 款");
    expect(palette?.description).not.toContain("8 款");

    const material = findEntry("general.material")?.item;
    expect(material).toBeDefined();
    expect(material?.description).toContain("磨砂");
    expect(material?.description).toContain("通透");
    expect(material?.description).toContain("实色");
    expect(material?.description).not.toContain("液态玻璃");
  });

  test("壁纸与技能说明无陈旧文案与硬编码技能数量", () => {
    const wallpaper = findEntry("general.wallpaper")?.item;
    expect(wallpaper).toBeDefined();
    expect(wallpaper?.description).not.toContain("内置");
    expect(wallpaper?.description).toContain("背景模糊");
    expect(wallpaper?.description).toContain("护眼薄幕");

    const hub = findEntry("skills.curated-hub")?.item;
    expect(hub).toBeDefined();
    expect(hub?.description).not.toMatch(/\d+\s*款/);
  });

  test("media page title matches its h1", () => {
    expect(SETTINGS_PAGES.find((page) => page.id === "media")?.title).toBe(
      "生图与识图",
    );
  });

  test("vault and legacy system-update are searchable but not duplicate rail items", () => {
    const rail = navGroups(admin).flatMap((entry) =>
      entry.pages.map((page) => page.id),
    );
    expect(rail).not.toContain("vault");
    expect(rail).toContain("connected-accounts");
    expect(rail).not.toContain("system-update");
    expect(rail).toContain("updates");
    expect(
      visibleGroups(admin).flatMap((entry) =>
        entry.pages.map((page) => page.id),
      ),
    ).toEqual(expect.arrayContaining(["vault", "system-update", "updates"]));
  });
});
