/*
 * 增量分块的 fuzz 语料生成器（tests/incremental-blocks.test.tsx 和本地大批量对比共用）。
 * 用容易让「后面的行改写前面的块」的片段随机拼：不从 1 开始的有序列表、setext 下划线、重复的链接定义、
 * 代码围栏、`$$`、HTML、引用、缩进续行、表格、脚注……再按随机长度一段段「流」进来。
 */
const PIECES = [
  "说明如下：",
  "段落一行",
  "接着一行**加粗",
  "结尾**的文字",
  "2. 第二步",
  "1. 第一步",
  "3) 第三步",
  "- 要点",
  "* 星号项",
  "+ 加号项",
  "  - 嵌套",
  "  续行",
  "    缩进代码",
  "\t制表符",
  "===",
  "---",
  "***",
  "- - -",
  "# 标题",
  "## 二级",
  "> 引用",
  ">> 两层",
  "```",
  "```js",
  "~~~",
  "const a = 1;",
  "$$",
  "x^2 $$ y",
  "$$a$$ 行内",
  "<div>",
  "</div>",
  "<details>",
  "<!-- 注释",
  "-->",
  "[r]: https://example.com/r",
  "[r]: https://example.com/again",
  "[ref][r] 链接",
  "[链接](https://example.com)",
  "脚注[^1]",
  "[^1]: 脚注",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "表头 | 二",
  "-- | --",
  "`行内` 代码",
  "中文，标点。",
  "a",
  "",
  "",
  "",
  "   ",
];

/** 固定种子的伪随机数（mulberry32）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomDoc(random: () => number, maxLines = 24): string {
  const lines: string[] = [];
  const count = 1 + Math.floor(random() * maxLines);
  for (let i = 0; i < count; i++) lines.push(PIECES[Math.floor(random() * PIECES.length)] ?? "");
  const joined = lines.join("\n");
  return random() < 0.3 ? `${joined}\n` : joined;
}

/** 把一篇文字切成随机长度的流式前缀（最后一个一定是全文）。 */
export function streamPrefixes(text: string, random: () => number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    i = Math.min(text.length, i + 1 + Math.floor(random() * 12));
    out.push(text.slice(0, i));
  }
  if (out.length === 0) out.push("");
  return out;
}