import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { locateSettingItem, settingTarget } from "@/lib/settings/locate";
import { findEntry, SETTINGS_PAGES } from "@/lib/settings/registry";
import { settleReactWork } from "./settle-react-work";

/**
 * 审查模块 12 第 2 条：设置搜索「跳过去但没定位」。registry 里每个带 find 的条目都要能落到页面上
 * 唯一的一块 `[data-setting-item]`，不靠标题文字碰运气。
 */

const SRC = join(import.meta.dir, "../src");
const APPEARANCE = new Set([
  "general.palette",
  "general.glass",
  "general.wallpaper",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

/** 源码里所有锚点：`data-setting-item="..."` 和 `settingItem="..."`，按空格拆成 token。 */
function anchorTokens(): Map<string, string[]> {
  const tokens = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /(?:data-setting-item|settingItem)="([^"]+)"/g,
    )) {
      for (const token of m[1]!.split(/\s+/))
        tokens.set(token, [...(tokens.get(token) ?? []), file]);
    }
  }
  return tokens;
}

const ITEMS = SETTINGS_PAGES.flatMap((page) =>
  page.items
    .filter((item) => item.find)
    .map((item) => ({ id: `${page.id}.${item.id}`, find: item.find! })),
);

describe("registry find ↔ page anchors", () => {
  const tokens = anchorTokens();
  for (const { id, find } of ITEMS) {
    test(`${id} has exactly one anchor in the source`, () => {
      const key = APPEARANCE.has(id) ? find : id;
      expect(tokens.get(key)?.length ?? 0).toBe(1);
    });
  }
  test("every id-shaped anchor points at a real registry entry", () => {
    for (const token of tokens.keys()) {
      if (!/^[a-z-]+\.[a-z-]+$/.test(token)) continue;
      expect(findEntry(token)?.item).toBeTruthy();
    }
  });
});

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost:3710/settings/connected-accounts",
  });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <main>{node}</main>
    </QueryClientProvider>,
  );
}

describe("locateSettingItem on rendered blocks", () => {
  test("「晨报」lands on 日程、收件箱、通知推送与每日晨报, not the page top", () => {
    draw(
      <>
        <PageSection title="账号连接">{null}</PageSection>
        <PageSection
          settingItem="connected-accounts.personal-calendar connected-accounts.personal-email connected-accounts.notify-webhook connected-accounts.morning-brief"
          title="日程、收件箱、通知推送与每日晨报"
        >
          {null}
        </PageSection>
      </>,
    );
    const entry = findEntry("connected-accounts.morning-brief")!;
    const found = locateSettingItem(
      document,
      "connected-accounts.morning-brief",
      entry.item!.find!,
    );
    expect(found).toBeTruthy();
    const target = settingTarget(found!);
    expect(target.tagName).toBe("SECTION");
    expect(target.querySelector("h2")?.textContent).toBe(
      "日程、收件箱、通知推送与每日晨报",
    );
  });

  test("text stays only as a fallback", () => {
    draw(<PageSection title="常驻指令">{null}</PageSection>);
    const found = locateSettingItem(
      document,
      "general.instructions",
      "常驻指令",
    );
    expect(found?.tagName).toBe("H2");
    expect(settingTarget(found!).tagName).toBe("SECTION");
  });

  test("an anchor wins over a heading with the same text elsewhere", () => {
    draw(
      <>
        <PageSection title="生图模型">{null}</PageSection>
        <PageSection settingItem="media.my-image-model" title="生图模型 · 我的">
          {null}
        </PageSection>
      </>,
    );
    const found = locateSettingItem(
      document,
      "media.my-image-model",
      "生图模型",
    );
    expect(found?.getAttribute("data-setting-item")).toBe(
      "media.my-image-model",
    );
  });

  test("appearance blocks resolve through their find-text anchors", async () => {
    const { AppearancePreferences } = await import(
      "@/components/settings/appearance-preferences"
    );
    draw(<AppearancePreferences />);
    for (const id of APPEARANCE) {
      const find = findEntry(id)!.item!.find!;
      await waitFor(() =>
        expect(locateSettingItem(document, id, find)).toBeTruthy(),
      );
      expect(
        document.querySelectorAll(`[data-setting-item~="${find}"]`).length,
      ).toBe(1);
    }
  });
});
