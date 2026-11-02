#!/usr/bin/env node
/**
 * pstack 策展移植生成器（docs/pstack-port.md）
 *
 * 把上游 cursor/plugins/pstack 的 SKILL.md 转换成 examples/zh-CN/skills.yaml 里的
 * 共享技能条目，写进受管区块（# >>> pstack-port / # <<< pstack-port）之间；上游更新后重跑即可。
 *
 * 用法：
 *   node scripts/pstack-port.mjs [--upstream <pstack 目录>] [--dry-run]
 *
 * 默认上游目录：../pstack-upstream/pstack（相对仓库根，可用 --upstream 覆盖）。
 * 只搬「可机械转换」的资产；需要深度改写的（poteto-mode、how、why、swarm、arena、
 * interrogate、各 playbook）不在本表，移植矩阵见 docs/pstack-port.md。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const UPSTREAM =
  argVal("--upstream") ?? join(ROOT, "..", "pstack-upstream", "pstack");
const DRY_RUN = args.includes("--dry-run");
const TARGET = join(ROOT, "examples", "zh-CN", "skills.yaml");
const MARK_BEGIN = "# >>> pstack-port";
const MARK_END = "# <<< pstack-port";

/** slug 上限 40，超长原则名用短 slug；正文与引用里的旧名统一替换。 */
const RENAMES = {
  "principle-migrate-callers-then-delete-legacy-apis":
    "principle-migrate-then-delete",
  "principle-separate-before-serializing-shared-state":
    "principle-separate-before-serializing",
  "principle-test-behavior-not-implementation": "principle-test-behavior",
};

/** 中文标题。 */
const TITLES = {
  "principle-attack-the-premise": "前提攻击",
  "principle-boundary-discipline": "边界纪律",
  "principle-build-the-lever": "造杠杆",
  "principle-encode-lessons-in-structure": "把教训固化成结构",
  "principle-exhaust-the-design-space": "穷尽设计空间",
  "principle-experience-first": "体验优先",
  "principle-explain-the-number": "解释数字",
  "principle-fix-root-causes": "修复根因",
  "principle-foundational-thinking": "地基思维",
  "principle-guard-the-context-window": "守护上下文窗口",
  "principle-laziness-protocol": "懒惰协议",
  "principle-make-operations-idempotent": "幂等操作",
  "principle-migrate-callers-then-delete-legacy-apis": "先迁移调用方再删旧 API",
  "principle-minimize-reader-load": "读者负担最小化",
  "principle-model-the-domain": "领域建模",
  "principle-never-block-on-the-human": "不阻塞人",
  "principle-outcome-oriented-execution": "结果导向执行",
  "principle-redesign-from-first-principles": "第一性原理重构",
  "principle-separate-before-serializing-shared-state": "共享状态先分离再串行",
  "principle-sequence-verifiable-units": "可验证单元排序",
  "principle-subtract-before-you-add": "先减后加",
  "principle-test-behavior-not-implementation": "测行为不测实现",
  "principle-type-system-discipline": "类型系统纪律",
  "principle-prove-it-works": "证明它能用",
  unslop: "反 AI 腔",
  "technical-writing": "技术写作规范",
  tdd: "TDD 修复",
  "benchmark-checklist": "基准测量清单",
  "typescript-best-practices": "TypeScript 最佳实践",
  "blast-radius": "爆炸半径",
  correct: "纠错改仓",
  bro: "说人话",
  "in-your-own-words": "复述需求",
  sharpen: "把任务磨深",
  "poteto-mode": "工程模式（pstack 主入口）",
  how: "它怎么工作",
  why: "为什么是这样",
  architect: "设计草图",
  "pstack-pb-investigation": "PB·调查",
  "pstack-pb-bug-fix": "PB·Bug 修复",
  "pstack-pb-feature": "PB·新功能",
};

/** 本批只收纯文本纪律类、无 Cursor 专有依赖的资产。 */
const PORT = [
  ...Object.keys(TITLES).filter((k) => k.startsWith("principle-")),
  "unslop",
  "technical-writing",
  "tdd",
  "benchmark-checklist",
  "typescript-best-practices",
  "blast-radius",
  "correct",
  "bro",
  "in-your-own-words",
  "sharpen",
];

/**
 * 手工改写版：adapted/<slug>.md，frontmatter（name/description）+ 正文，即移植终稿。
 * 收录进 PORT 时优先取本地改写版，跳过上游读取与 adaptBody（正文已是 ChisaBot 语义）。
 * 上游没有对应 SKILL.md 的（如 playbook 拆出的 pstack-pb-*）也走这里。
 */
const ADAPTED_DIR = join(ROOT, "scripts", "pstack-port", "adapted");
const ADAPTED = [
  "poteto-mode",
  "how",
  "why",
  "architect",
  "pstack-pb-investigation",
  "pstack-pb-bug-fix",
  "pstack-pb-feature",
];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const MAX_INSTRUCTIONS = 20_000;
const MAX_TITLE = 60;
const MAX_SUMMARY = 200;

function parseSkill(path) {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`no frontmatter: ${path}`);
  const fm = m[1];
  const name = fm.match(/^name:\s*(\S+)/m)?.[1];
  const desc = fm.match(/^description:\s*(?:"([\s\S]*?)"|'(.*?)'|(.*))$/m);
  const description = (desc?.[1] ?? desc?.[2] ?? desc?.[3] ?? "").trim();
  if (!name) throw new Error(`no name: ${path}`);
  return { name, description, body: m[2].trim() };
}

/** 正文适配：相对链接 → /slug，旧 slug 全量改名。 */
function adaptBody(body) {
  let out = body;
  for (const [oldSlug, newSlug] of Object.entries(RENAMES)) {
    out = out.split(oldSlug).join(newSlug);
  }
  out = out.replace(
    /\[([^\]]+)\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g,
    "$1（/$2）",
  );
  out = out.replace(/\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g, "（/$1）");
  out = out.replace(/\(\.\.?\/references\/[a-z0-9-]+\.md\)/g, "");
  out = out.replace(/`references\/[a-z0-9-]+\.md`/g, "内附示例");
  out +=
    "\n\n---\n来源：Cursor 官方插件 pstack（MIT License），移植版见 docs/pstack-port.md。";
  return out.trim();
}

function yamlBlockScalar(key, value, indent) {
  const pad = " ".repeat(indent);
  return `${pad}${key}: |-\n${value
    .split("\n")
    .map((l) => `${pad}  ${l}`)
    .join("\n")}`;
}

const skillsDir = join(UPSTREAM, "skills");
if (!existsSync(skillsDir)) {
  console.error(
    `上游目录不存在：${skillsDir}\n先 clone：https://github.com/cursor/plugins`,
  );
  process.exit(1);
}

const entries = [];
const seen = new Set();
const push = ({ name, description, instructions }) => {
  const slug = RENAMES[name] ?? name;
  if (!SLUG_RE.test(slug)) throw new Error(`slug 不合规：${slug}`);
  if (seen.has(slug)) throw new Error(`slug 重复：${slug}`);
  seen.add(slug);
  const title = TITLES[name] ?? name;
  const summary =
    description.length > MAX_SUMMARY
      ? `${description.slice(0, 197)}...`
      : description;
  if (instructions.length > MAX_INSTRUCTIONS)
    throw new Error(
      `instructions 超长：${slug} ${instructions.length} > ${MAX_INSTRUCTIONS}`,
    );
  if (title.length > MAX_TITLE) throw new Error(`title 超长：${title}`);
  entries.push({ slug, title, summary, instructions });
};

// 排序：改写件与核心技能在前——技能目录页只展示前 40 条，原则叶靠 poteto-mode 索引按 slug 懒加载，排最后也能用 skill_list 搜到。
for (const file of ADAPTED) {
  const { name, description, body } = parseSkill(
    join(ADAPTED_DIR, `${file}.md`),
  );
  if (name !== file)
    throw new Error(`adapted/${file}.md 内 name=${name} 不一致`);
  push({
    name,
    description,
    instructions: `${body.trim()}\n\n---\n来源：改写自 Cursor 官方插件 pstack（MIT License），适配说明见 docs/pstack-port.md。`,
  });
}

for (const src of PORT.filter((k) => !k.startsWith("principle-"))) {
  const { name, description, body } = parseSkill(
    join(skillsDir, src, "SKILL.md"),
  );
  if (name !== src) console.warn(`警告：目录 ${src} 内 name=${name}`);
  push({ name, description, instructions: adaptBody(body) });
}

for (const src of PORT.filter((k) => k.startsWith("principle-"))) {
  const { name, description, body } = parseSkill(
    join(skillsDir, src, "SKILL.md"),
  );
  if (name !== src) console.warn(`警告：目录 ${src} 内 name=${name}`);
  push({ name, description, instructions: adaptBody(body) });
}

const block =
  `${MARK_BEGIN} — generated by scripts/pstack-port.mjs，请勿手改\n` +
  entries
    .map(
      (e) =>
        `  - slug: ${e.slug}\n` +
        `    title: "${e.title.replace(/"/g, '\\"')}"\n` +
        `    summary: "${e.summary.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"\n` +
        yamlBlockScalar("instructions", e.instructions, 4),
    )
    .join("\n") +
  `\n  ${MARK_END}\n`;

let yaml = readFileSync(TARGET, "utf8");
if (yaml.includes(MARK_BEGIN)) {
  const begin = yaml.indexOf(MARK_BEGIN);
  const end = yaml.indexOf(MARK_END) + MARK_END.length;
  yaml = `${yaml.slice(0, begin)}${block.trimEnd()}\n${yaml.slice(end)}`;
} else {
  yaml = `${yaml.trimEnd()}\n\n${block}`;
}

if (DRY_RUN) {
  console.log(block);
} else {
  writeFileSync(TARGET, yaml);
  console.log(`已写入 ${TARGET}：${entries.length} 个技能`);
}
for (const e of entries)
  console.log(
    `  ${e.slug.padEnd(42)} ${String(e.instructions.length).padStart(6)} chars`,
  );
