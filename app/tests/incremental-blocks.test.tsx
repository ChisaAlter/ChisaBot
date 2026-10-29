import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { parseMarkdownIntoBlocks, Streamdown } from "streamdown";
import { createIncrementalBlockParser } from "@/lib/chat/incremental-blocks";
import { randomDoc, rng, streamPrefixes } from "./markdown-fuzz";
import { settleReactWork } from "./settle-react-work";

if (typeof document === "undefined") GlobalRegistrator.register();
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

/*
 * 增量分块必须和 Streamdown 整段重切的结果一模一样（审查 01 第 5 条）。
 * 每份语料按字符一个一个「流」进来，每一步都和 parseMarkdownIntoBlocks(整段) 对比。
 */
const DOC = [
  "## 概览",
  "",
  "这是一份**测试文档**，用来验证：流式时只重切最后一段。",
  "",
  "- 第一项",
  "- 第二项，带 `行内代码`",
  "  - 嵌套一项",
  "",
  "1. 有序",
  "2. 列表",
  "",
  "```python",
  "def f(x):",
  "    return x * 2",
  "",
  "print(f(3))",
  "```",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "> 引用一段",
  "> 继续引用",
  "",
  "段落一行",
  "接着一行",
  "===",
  "",
  "另一个段落",
  "---",
  "",
  "    缩进代码",
  "    第二行",
  "",
  "<div>",
  "",
  "HTML 里面的 **markdown**",
  "",
  "</div>",
  "",
  "$$",
  "x^2 + y^2",
  "",
  "= z^2",
  "$$",
  "",
  "***",
  "",
  "[链接](https://example.com) 和 [ref][r]",
  "",
  "[r]: https://example.com/r",
  "",
  "~~~",
  "未闭合的代码块一直到结尾",
].join("\n");

const CORPUS: string[] = [
  DOC,
  "第一段。\n\n第二段**加粗**。\n\n- a\n- b\n\n\n\n结尾",
  "- 列表\n\n  列表里的第二段\n\n- 下一项\n\n不是列表",
  "<details>\n<summary>点开</summary>\n\n内容\n\n</details>\n\n后面",
  "表头 | 二\n-- | --\n甲 | 乙\n\n文字",
  "```\n```\n\n```js\nconst a = 1;\n```\n后面紧跟",
  "$$a$$ 行内\n\n$$\n块\n$$\n\n$$ 未闭合\n\n还有",
  "# 一\n## 二\n### 三\n正文\n\n\t制表符缩进\n\n结束",
  "脚注引用[^1]。\n\n[^1]: 脚注内容\n\n后文",
  "a\r\nb\r\n\r\nc",
  "",
  "   \n\n  \n",
  // 审查 #415：后面的行会把前面的块并掉，旧的「除最后两块外都定型」在这些例子上流完了仍然不一致。
  "说明如下：\n2. 第二步\n- 要点",
  "段落一行\n接着一行\n2. 不从 1 开始\n\n后文",
  "段落\n===\n\n另一段\n---\n\n结尾",
  "第一段\n\n第二段\n---",
  "[r]: https://example.com/r\n[r]: https://example.com/again\n- - -\nx^2 $",
  "[ref][r]\n\n[r]: https://a.example\n\n[r]: https://b.example\n\n后文",
  "- a\n\n- b\n\n2. c\n\n  续行\n\n结尾",
  "> 引用\n\n> 第二段引用\n\n正文",
  "<!-- 注释\n\n跨空行\n\n-->\n\n后文",
  "```\n代码\n\n还在代码里\n\n```\n\n后文",
];

function streamCompare(text: string, step = 1) {
  const parse = createIncrementalBlockParser(parseMarkdownIntoBlocks);
  for (let i = 0; i <= text.length; i += step) {
    const prefix = text.slice(0, i);
    expect({ i, blocks: parse(prefix) }).toEqual({ i, blocks: parseMarkdownIntoBlocks(prefix) });
  }
  expect(parse(text)).toEqual(parseMarkdownIntoBlocks(text));
}

test("streamed one character at a time, every step matches a full re-parse", () => {
  for (const text of CORPUS) streamCompare(text);
});

test("streamed in uneven chunks (several characters per frame) also matches", () => {
  for (const text of CORPUS) for (const step of [3, 7, 40]) streamCompare(text, step);
});

test("the reuse actually happens: a streamed document re-lexes only its tail", () => {
  // 普通回复没有链接定义和顶格 HTML（有的话保守地整段重切，见 incremental-blocks.ts）；两份拼起来模拟长一点的回答。
  const typical = DOC.replace("[r]: https://example.com/r\n", "")
    .replace(/<div>[\s\S]*?<\/div>\n/, "")
    .replace("~~~\n未闭合的代码块一直到结尾", "");
  const text = `${typical}\n\n${typical}`;
  let lexed = 0;
  const parse = createIncrementalBlockParser((md) => {
    lexed += md.length;
    return parseMarkdownIntoBlocks(md);
  });
  let naive = 0;
  for (let i = 0; i <= text.length; i++) {
    parse(text.slice(0, i));
    naive += i;
  }
  // 整段重切是 O(n²) 个字符；增量的每步只重切最后一个封口点之后的部分。
  expect(lexed).toBeLessThan(naive / 3);
});

test("text that is replaced, shortened or rewritten at the tail falls back to a full parse", () => {
  const parse = createIncrementalBlockParser(parseMarkdownIntoBlocks);
  const seq = [
    DOC,
    DOC.slice(0, 300),
    `${DOC.slice(0, 200)}**未闭合**`,
    `${DOC.slice(0, 201)}**未闭合**`,
    "完全不同的一条消息\n\n- x",
    DOC,
  ];
  for (const text of seq) expect(parse(text)).toEqual(parseMarkdownIntoBlocks(text));
});

/*
 * 渲染结果也一样：同一个 Streamdown（含它自己补全未闭合标记那一步），一份用默认分块，一份用增量分块，
 * 逐步长大，每一步的 HTML 都相同。
 */
test("rendered HTML is identical to the default block parser at every streaming step", async () => {
  const text = CORPUS.slice(1, 8).join("\n\n").concat("\n\n", DOC.slice(0, DOC.indexOf("```python")));
  const parse = createIncrementalBlockParser(parseMarkdownIntoBlocks);
  const Pair = ({ md }: { md: string }) => (
    <>
      <div data-testid="a">
        <Streamdown isAnimating mode="streaming">
          {md}
        </Streamdown>
      </div>
      <div data-testid="b">
        <Streamdown isAnimating mode="streaming" parseMarkdownIntoBlocksFn={parse}>
          {md}
        </Streamdown>
      </div>
    </>
  );
  const view = render(<Pair md="" />);
  for (let i = 1; i <= text.length; i += 5) {
    await act(async () => {
      view.rerender(<Pair md={text.slice(0, i)} />);
    });
    expect(view.getByTestId("b").innerHTML).toBe(view.getByTestId("a").innerHTML);
  }
  expect(view.getByTestId("b").textContent?.length ?? 0).toBeGreaterThan(100);
});
/*
 * 固定种子的 fuzz 对比（审查 #415）：随机拼容易改写前面块的片段，按随机长度流进来，每一步都和整段重切对比。
 * CI 里跑 600 篇（约一万步）；本地用 tests/markdown-fuzz.ts 跑过 20 万篇、0 个不一致。
 */
test("fuzz: random documents streamed in random chunks always match a full re-parse (fixed seed)", () => {
  const random = rng(415);
  const mismatches: string[] = [];
  for (let run = 0; run < 600; run++) {
    const doc = randomDoc(random);
    const parse = createIncrementalBlockParser(parseMarkdownIntoBlocks);
    for (const prefix of streamPrefixes(doc, random)) {
      if (JSON.stringify(parse(prefix)) !== JSON.stringify(parseMarkdownIntoBlocks(prefix))) {
        mismatches.push(prefix);
        break;
      }
    }
  }
  expect(mismatches).toEqual([]);
});
