import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SERVER_TEST_QUARANTINE } from "../../scripts/test-quarantine";

const ROOT = path.join(import.meta.dir, "../..");

test("DESIGN.md 章节索引表与正文章节号 1:1 完全同步", () => {
  const design = readFileSync(path.join(ROOT, "DESIGN.md"), "utf8");
  const lines = design.split(/\r?\n/);
  const tocIds: number[] = [];
  const bodyIds: number[] = [];

  for (const line of lines) {
    const tocMatch = line.match(/^\|\s*\[(\d+)\]\(#/);
    if (tocMatch) tocIds.push(Number(tocMatch[1]));

    const headingMatch = line.match(/^## (\d+)\.\s/);
    if (headingMatch) bodyIds.push(Number(headingMatch[1]));
  }

  expect(bodyIds.length).toBeGreaterThan(50);
  const tocSet = new Set(tocIds);
  const bodySet = new Set(bodyIds);

  const missingInToc = bodyIds.filter((id) => !tocSet.has(id));
  const extraInToc = tocIds.filter((id) => !bodySet.has(id));
  expect(missingInToc).toEqual([]);
  expect(extraInToc).toEqual([]);
});

test("AGENTS.md 自动门禁对照表中引用的路径在仓库中全部真实存在", () => {
  const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const sectionStart = agents.indexOf("## 7. 自动门禁对照表");
  expect(sectionStart).toBeGreaterThan(-1);

  const section = agents.slice(sectionStart);
  const referencedPaths = [
    ...section.matchAll(
      /`((?:app|server|shared|scripts|pc|\.claude)\/[^`\s]+)`/g,
    ),
  ].flatMap((match) => (match[1] ? [match[1]] : []));

  expect(referencedPaths.length).toBeGreaterThanOrEqual(6);
  const missing = referencedPaths.filter(
    (rel) => !existsSync(path.join(ROOT, rel)),
  );
  expect(missing).toEqual([]);
});

test("scripts/test-quarantine.ts 不得积压未清零的隔离测试", () => {
  expect(Object.keys(SERVER_TEST_QUARANTINE)).toEqual([]);
});

test("环境变量文档与 config.ts 真实默认值保持一致（防 docs 与代码再次漂移）", () => {
  const configSrc = readFileSync(
    path.join(ROOT, "server/src/config.ts"),
    "utf8",
  );
  // config.ts 中 accountsUi 实际规则是：`!["0", "false"].includes(...)`，即默认开启
  expect(configSrc).toContain('accountsUi: !["0", "false"].includes(');

  const staleAccountsDocs = [
    "docs/accounts.md",
    "docs/friend-deploy.md",
    "docs/features.md",
    "docs/configuration.md",
    "docs/architecture.md",
    "docs/settings-ia.md",
    "deploy/friend.env.example",
  ];
  for (const rel of staleAccountsDocs) {
    const content = readFileSync(path.join(ROOT, rel), "utf8");
    expect(content).not.toMatch(
      /CHISABOT_ACCOUNTS_UI=1[^。\n]*(?:才显示|打开入口|默认关闭)/,
    );
    expect(content).not.toMatch(
      /默认关闭.*CHISABOT_ACCOUNTS_UI|CHISABOT_ACCOUNTS_UI.*（默认关闭）/,
    );
  }
});
