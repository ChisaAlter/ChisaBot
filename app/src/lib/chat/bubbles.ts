/**
 * 一条机器人回复 → 几个气泡（DESIGN.md §69，向 Hark 的「一条一条发短消息」看齐）。
 *
 * 规则只有这一份，渲染和测试都用它：
 * - 按空行分段；代码块（``` 围起来的）永远是一整段，不会从中间切开（流式时没闭合的代码块也算一整段）。
 * - 连续的列表项、表格行、引用行各自算一段；以「：」/「:」结尾的短引导句和紧跟的列表 / 表格合成一段。
 * - 标题行（# …）和它下面那段合成一段。
 * - ```draft 代码块 = 草稿卡（kind "draft"）；第一行「标题：…」是卡片标题。
 * - ```doc（或 ```summary）代码块 = 文档卡（kind "doc"，DESIGN.md §76）：长的总结 / 说明 / 清单，正文是 Markdown；同样可写标题行。
 * - 其他代码块 kind "code"。
 * - 段首的 `> ` 行 = 回复引用（quote），只在它后面还有正文时才算；整段都是引用就当普通段落。
 * - 最多 MAX_BUBBLES 个气泡，多出来的并进最后一个；空段丢掉。
 */
export type BubbleSegment = {
  kind: "text" | "draft" | "doc" | "brief" | "code";
  /** 这一段的 Markdown 原文（kind "draft" / "doc" / "brief" 时是正文，不含围栏和标题行）。 */
  text: string;
  /** kind "text"：段首引用的原话（去掉 `> `）。 */
  quote?: string;
  /** kind "draft" / "doc" / "brief"：卡片标题。 */
  title?: string;
  /** 这一段的内容需要整列宽（表格、代码、清单、草稿）；否则气泡贴着文字宽度。 */
  wide: boolean;
};

export const MAX_BUBBLES = 6;

const DOC_INFOS = new Set(["doc", "summary"]);
const BRIEF_INFOS = new Set(["brief", "morning-brief"]);

const FENCE = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)?(.*)$/;
const LIST = /^\s{0,3}([-*+]|\d{1,3}[.)、])\s+/;
const TABLE = /^\s*\|/;
const QUOTE = /^\s{0,3}>\s?/;
const HEADING = /^\s{0,3}#{1,6}\s/;

type Block = { lines: string[]; fence?: string; info?: string; open?: boolean; heading?: string };

function toBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.some((l) => l.trim())) blocks.push({ lines: cur });
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = FENCE.exec(line);
    if (m) {
      flush();
      const marker = m[1] ?? "```";
      const info = (m[2] ?? "").toLowerCase();
      const body: string[] = [line];
      let closed = false;
      for (i = i + 1; i < lines.length; i++) {
        const l = lines[i] ?? "";
        body.push(l);
        // 收尾的围栏至少和开头一样长（CommonMark）：````doc 里面可以放 ``` 代码块。
        const close = l.trim();
        if (close.length >= marker.length && close.startsWith(marker[0]?.repeat(3) ?? "```") && close.replace(/[`~]/g, "") === "") {
          closed = true;
          break;
        }
      }
      blocks.push({ lines: body, fence: marker, info, open: !closed });
      continue;
    }
    if (!line.trim()) flush();
    else cur.push(line);
  }
  flush();
  return blocks;
}

const allMatch = (b: Block, re: RegExp) =>
  !b.fence && b.lines.every((l) => re.test(l) || /^\s{2,}\S/.test(l));
const isList = (b: Block) => !b.fence && LIST.test(b.lines[0] ?? "") && allMatch(b, LIST);
const isTable = (b: Block) => !b.fence && b.lines.every((l) => TABLE.test(l));
const isHeadingOnly = (b: Block) => !b.fence && b.lines.length === 1 && HEADING.test(b.lines[0] ?? "");
const isIntro = (b: Block) => {
  if (b.fence || b.lines.length !== 1) return false;
  const l = (b.lines[0] ?? "").trim();
  return /[：:]$/.test(l) && l.length <= 80;
};

/** 空行分开的列表项（松散列表）合回一段；引导句 + 列表 / 表格合成一段；标题 + 下一段合成一段。 */
function mergeBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev && !prev.fence && !b.fence) {
      const prevTail: Block = { lines: prev.lines.slice(-1) };
      if ((isList(b) && (isList(prev) || LIST.test(prevTail.lines[0] ?? "") || isIntro(prev))) ||
          (isTable(b) && isIntro(prev)) ||
          isHeadingOnly(prev)) {
        prev.lines.push("", ...b.lines);
        continue;
      }
    }
    if (prev && !prev.fence && isHeadingOnly(prev) && b.fence && (b.info === "draft" || DOC_INFOS.has(b.info ?? "") || BRIEF_INFOS.has(b.info ?? ""))) {
      // 标题 + 草稿 / 文档卡 / 晨报卡：标题当卡片标题（卡片本身有头部），不把标题行塞进围栏里。
      out.pop();
      out.push({ ...b, lines: [...b.lines], heading: (prev.lines[0] ?? "").replace(HEADING, "").trim() });
      continue;
    }
    if (prev && !prev.fence && isHeadingOnly(prev) && b.fence) {
      // 标题 + 代码块：标题跟着代码块走（各自成段会留下一个只有标题的气泡）。
      out.pop();
      out.push({ ...b, lines: [...prev.lines, "", ...b.lines] });
      continue;
    }
    out.push({ ...b, lines: [...b.lines] });
  }
  return out;
}

function draftOf(b: Block, kind: "draft" | "doc" | "brief" = "draft"): BubbleSegment {
  const body = b.lines.slice(1, b.open ? undefined : -1);
  while (body.length && !body[0]?.trim()) body.shift();
  let title: string | undefined;
  const t = /^\s*(?:标题|title)\s*[：:]\s*(.+)$/i.exec(body[0] ?? "");
  if (t) {
    title = t[1]?.trim().slice(0, 48);
    body.shift();
    while (body.length && !body[0]?.trim()) body.shift();
  }
  while (body.length && !body[body.length - 1]?.trim()) body.pop();
  title ??= b.heading?.slice(0, 48) || undefined;
  return { kind, text: body.join("\n"), ...(title ? { title } : {}), wide: true };
}

function textOf(b: Block): BubbleSegment {
  const lines = b.lines;
  const wide = b.fence !== undefined || lines.some((l) => TABLE.test(l)) || lines.filter((l) => LIST.test(l)).length >= 3;
  if (b.fence) return { kind: "code", text: lines.join("\n"), wide: true };
  let q = 0;
  while (q < lines.length && QUOTE.test(lines[q] ?? "")) q++;
  if (q > 0 && q < lines.length) {
    const quote = lines.slice(0, q).map((l) => l.replace(QUOTE, "")).join(" ").trim();
    const rest = lines.slice(q);
    while (rest.length && !rest[0]?.trim()) rest.shift();
    if (quote && rest.length) return { kind: "text", text: rest.join("\n"), quote: quote.slice(0, 120), wide };
  }
  return { kind: "text", text: lines.join("\n"), wide };
}

/**
 * 这一段去掉 Markdown 图片（以及流式时写到一半、还没闭合的图片）和 `<img>` 之后什么都不剩（§93.2）。
 * 这种段在气泡里画出来是空的——图片本来就画在气泡下面的图片卡里。
 */
export function isMediaOnly(text: string): boolean {
  const rest = text
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/!\[[^\]\n]*(\](\([^)\n]*)?)?$/, "")
    .trim();
  return rest === "";
}

export function splitBubbles(text: string): BubbleSegment[] {
  if (!text.trim()) return [];
  const blocks = mergeBlocks(toBlocks(text));
  // 段首引用单独成了一块（引用行后面空了一行）时，和下一段合起来。
  const joined: Block[] = [];
  for (const b of blocks) {
    const prev = joined[joined.length - 1];
    if (prev && !prev.fence && !b.fence && allMatch(prev, QUOTE) && !allMatch(b, QUOTE)) {
      prev.lines.push(...b.lines);
      continue;
    }
    joined.push(b);
  }
  let segs = joined.map((b) =>
    b.fence && b.info === "draft"
      ? draftOf(b)
      : b.fence && DOC_INFOS.has(b.info ?? "")
        ? draftOf(b, "doc")
        : b.fence && BRIEF_INFOS.has(b.info ?? "")
          ? draftOf(b, "brief")
          : textOf(b),
  );
  // 只有图片的一段（`![截图](/api/…)`）：正文里的图片不内联画、统一进下面的图片卡（§31，HiddenMarkdownImage），
  // 留着它就是一个空的小气泡（DESIGN.md §93.2）。流式写到一半的图片（`![当前电脑截图](/api/dev`）同理。
  segs = segs.filter(
    (s) => (s.text.trim() && !(s.kind === "text" && isMediaOnly(s.text))) || s.kind === "draft" || s.kind === "doc" || s.kind === "brief",
  );
  if (segs.length > MAX_BUBBLES) {
    const head = segs.slice(0, MAX_BUBBLES - 1);
    const tail = segs.slice(MAX_BUBBLES - 1);
    // 多出来的按原文并成一段（草稿 / 引用照原样写回 Markdown，不丢内容）。
    const md = tail
      .map((s) =>
        s.kind === "draft" || s.kind === "doc" || s.kind === "brief"
          ? [`\`\`\`${s.kind}`, ...(s.title ? [`标题：${s.title}`] : []), s.text, "```"].join("\n")
          : s.quote
            ? `> ${s.quote}\n${s.text}`
            : s.text,
      )
      .join("\n\n");
    segs = [...head, { kind: "text", text: md, wide: true }];
  }
  return segs;
}
