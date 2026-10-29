/**
 * 流式回复的分块只重切还没定型的那一段（审查 01 第 5 条）。
 *
 * Streamdown 每次渲染都把整段文字交给 `parseMarkdownIntoBlocks`（marked 词法整段重跑），一条 2500 字的
 * 回复每帧都把前面早已定型的段落重新切一遍。这里记住已经「封口」的前缀块，新文字仍以它开头时只把后面的
 * 部分交给 `parseMarkdownIntoBlocks`，前面的块原样复用。结果必须和整段重切一模一样
 * （tests/incremental-blocks.test.tsx 逐步对比 + 固定种子的 fuzz 对比）。
 *
 * 什么时候前缀算封口——之前用的「除最后两块外都不会变」不成立：后面来的行可以把前面的块并掉
 * （段落后面跟一个不从 1 开始的有序列表、setext 下划线），重复的 `[r]: …` 定义也会多留一块。
 * 现在只在下面这些条件全满足时才缓存，拿不准一律整段重切：
 *  - 切点前面是空行（段落、列表、引用、表格都被空行结束，后面的行并不回来）；
 *  - 切点后面已经有一整行（以换行结束），而且顶格、不是列表项 / 引用 / 缩进 / HTML / `[` 开头——
 *    这些都可能是前面列表、引用、HTML 块的延续；
 *  - 前缀里代码围栏成对、`$$` 成对（Streamdown 会把奇数个 `$$` 的块和后面合并）、没有顶格的 HTML
 *    （Streamdown 按未闭合标签合并块，HTML 块也能跨空行）；
 *  - 全文没有脚注（`[^`，Streamdown 整段当一块）和链接定义（`[x]: …`，重复定义会改变分块）。
 * 流式结束后 SmoothStreamdown 会换回整段解析再切一次兜底（smooth-markdown.tsx）。
 *
 * 这个文件不静态 import streamdown（#414 把 Streamdown 改成用到才下载，静态 import 会把它拉回主包）：
 * 整段分块函数由调用方传进来，SmoothStreamdown 经 loadFullBlockParser() 动态 import 拿到，和 Streamdown
 * 是同一个懒加载模块。
 */
const DEFINITION = /^ {0,3}\[[^\]\n]*\]:/m;
const HTML_LINE = /^ {0,3}</m;
const FENCE_LINE = /^ {0,3}(?:```|~~~)/gm;
const BLANK_END = /\n[ \t]*\n[ \t\n]*$/;
const MAY_CONTINUE = /^(?:[ \t>[<]|[*+-](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;

export type BlockParser = (markdown: string) => string[];

function countDollarPairs(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "$" && text[i + 1] === "$") {
      count++;
      i++;
    }
  }
  return count;
}

function unsafeText(text: string): boolean {
  return text.includes("[^") || DEFINITION.test(text);
}

export function createIncrementalBlockParser(full: BlockParser): BlockParser {
  let stable: string[] = [];
  let stableText = "";
  let fences = 0;
  let dollars = 0;
  const reset = () => {
    stable = [];
    stableText = "";
    fences = 0;
    dollars = 0;
  };
  return (markdown) => {
    let reuse = stableText.length > 0 && markdown.startsWith(stableText);
    if (reuse && unsafeText(markdown.slice(stableText.length))) reuse = false;
    if (!reuse) reset();
    const blocks = reuse ? stable.concat(full(markdown.slice(stableText.length))) : full(markdown);
    if (!reuse && unsafeText(markdown)) return blocks;

    // 从后往前找最靠后的封口切点（只看 stable 之后新出现的块）。
    let end = markdown.length;
    for (let cut = blocks.length - 1; cut > stable.length; cut--) {
      end -= (blocks[cut] ?? "").length;
      const rest = markdown.slice(end);
      const prefix = markdown.slice(0, end);
      if (!BLANK_END.test(prefix)) continue;
      const lineEnd = rest.indexOf("\n");
      if (lineEnd <= 0 || MAY_CONTINUE.test(rest)) continue;
      if (rest.slice(0, lineEnd).trim() === "") continue;
      const added = prefix.slice(stableText.length);
      if (HTML_LINE.test(added)) continue;
      const addedFences = added.match(FENCE_LINE)?.length ?? 0;
      if ((fences + addedFences) % 2 !== 0) continue;
      const addedDollars = countDollarPairs(added);
      if ((dollars + addedDollars) % 2 !== 0) continue;
      if (blocks.slice(0, cut).join("") !== prefix) break;
      stable = blocks.slice(0, cut);
      stableText = prefix;
      fences += addedFences;
      dollars += addedDollars;
      break;
    }
    return blocks;
  };
}
let loadedFull: BlockParser | null = null;
let loadingFull: Promise<BlockParser> | null = null;

/** Streamdown 自己的整段分块函数，动态 import（和 Streamdown 组件同一个分包）。 */
export function loadFullBlockParser(): Promise<BlockParser> {
  loadingFull ??= import("streamdown")
    .then((module) => {
      loadedFull = module.parseMarkdownIntoBlocks;
      return loadedFull;
    })
    .catch((error) => {
      loadingFull = null;
      throw error;
    });
  return loadingFull;
}

/** 已经下载好的整段分块函数；还没下载时是 null。 */
export function loadedFullBlockParser(): BlockParser | null {
  return loadedFull;
}
