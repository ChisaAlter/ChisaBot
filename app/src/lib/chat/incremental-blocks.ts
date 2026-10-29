import { parseMarkdownIntoBlocks } from "streamdown";

/**
 * 流式回复的分块只重算最后一段（审查 01 第 5 条）。
 *
 * Streamdown 每次渲染都把整段文字交给 `parseMarkdownIntoBlocks`（marked 词法整段重跑），一条 2500 字的
 * 回复每帧都把前面早已定型的段落重新切一遍。这里记住上一次切出来的块：除了最后两个非空块（以及它们
 * 后面的空行块）之外，前面的块已经被后面完整的内容「封口」，文字接着往后长不会再改变它们。
 * 新文字仍以这串定型块开头时，只把后面的部分交给 `parseMarkdownIntoBlocks`，前面的块原样复用。
 *
 * 结果必须和整段重切一模一样（tests/incremental-blocks.test.ts 逐字对比）；拿不准的情况一律整段重切：
 *  - 文字不是接着往后长（换了一条、被改短、Streamdown 补全未闭合标记时前面变了）；
 *  - 含脚注（`[^`）——Streamdown 对脚注是整段当一块，跨块引用；
 *  - 块拼起来不等于原文（理论上不会发生，发生就退回整段）。
 * 块边界处 Streamdown 自己的合并状态（未闭合 HTML 标签、奇数个 `$$`）一定是空的，否则那里不会是边界，
 * 所以从边界开始单独切后半段和整段切时的判断相同。
 */
const KEEP_TAIL_BLOCKS = 2;

export type BlockParser = (markdown: string) => string[];

export function createIncrementalBlockParser(full: BlockParser = parseMarkdownIntoBlocks): BlockParser {
  let stable: string[] = [];
  let stableText = "";
  return (markdown) => {
    const reuse =
      stableText.length > 0 && !markdown.includes("[^") && markdown.startsWith(stableText);
    const blocks = reuse ? stable.concat(full(markdown.slice(stableText.length))) : full(markdown);
    let cut = blocks.length;
    let tail = 0;
    while (cut > 0 && tail < KEEP_TAIL_BLOCKS) {
      cut--;
      if ((blocks[cut] ?? "").trim() !== "") tail++;
    }
    stable = tail < KEEP_TAIL_BLOCKS ? [] : blocks.slice(0, cut);
    stableText = stable.join("");
    if (!markdown.startsWith(stableText)) {
      stable = [];
      stableText = "";
    }
    return blocks;
  };
}