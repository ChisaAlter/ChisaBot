/**
 * 模型常把泛型直接写在正文里（`Vec<String>`、`Option<T>`、`List<Object>`，不加反引号）。
 * Streamdown 把它们当 HTML 标签解析，未知标签被 harden 直接丢掉，文字静默消失（审计 05 必修 1）。
 *
 * 这里在交给 Streamdown 之前，把「不是标准 HTML 元素」的标签（以及大小写不是全小写的标签）
 * 的 `<` 转成 `&lt;`，让它们按原文显示。全小写的标准 HTML 元素（`<details>`、`<kbd>`、`<br>`、
 * `<script>`、`<img onerror>` …）原样留给 Streamdown，照旧由它的 sanitize/harden 清洗。
 *
 * 紧跟在标识符字符后面的开标签（`Vec<option>`、`List<object>`、`Result<a>`、`Vec<i>`）一律转义：
 * 真正的 HTML 前面总有空格或标点，而和 HTML 同名的小写泛型不转义会丢字、变链接或让后文全斜体。
 * 例外是 `br` / `wbr` / `sub` / `sup`（`a<br>b`、`H<sub>2</sub>O` 很常见，没人拿它们当泛型名）。
 *
 * 代码块（``` / ~~~ 围栏、4 格缩进的代码块，含列表里的）和行内代码原样不动。
 * `<https://…>`、`<a@b.c>` 这类自动链接不匹配标签形式，不受影响。
 */

const HTML_ELEMENTS = new Set(
  (
    "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption center cite code col colgroup " +
    "data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure font footer form frame frameset " +
    "h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee menu meta " +
    "meter nav noscript object ol optgroup option output p param picture plaintext pre progress q rp rt ruby s samp script search " +
    "section select slot small source span strike strong style sub summary sup svg math table tbody td template textarea tfoot " +
    "th thead time title tr track tt u ul var video wbr xmp"
  ).split(" "),
);

/** `<name` / `</name`，后面必须是空白、`/` 或 `>`，所以 `<https://…>`、`<a@b.c>`、`a<b` 之类不受影响。 */
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/g;

/** `<` 前面是这些字符时，它是泛型参数而不是标签。 */
const IDENT_BEFORE = /[A-Za-z0-9_]/;
/** 例外：常贴着文字写、又几乎不会当泛型名的标签（表格里的 `a<br>b`、`H<sub>2</sub>O`、`10<sup>3</sup>`）。 */
const INLINE_AFTER_WORD = new Set(["br", "wbr", "sub", "sup"]);

function isHtmlTag(name: string): boolean {
  return name === name.toLowerCase() && HTML_ELEMENTS.has(name);
}

function escapeInline(text: string): string {
  if (!text.includes("<")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    const plainEnd = tick === -1 ? text.length : tick;
    out += text
      .slice(i, plainEnd)
      .replace(
        TAG_RE,
        (
          whole: string,
          slash: string,
          name: string,
          at: number,
          src: string,
        ) =>
          isHtmlTag(name) &&
          (slash ||
            INLINE_AFTER_WORD.has(name) ||
            !IDENT_BEFORE.test(src[at - 1] ?? ""))
            ? whole
            : `&lt;${whole.slice(1)}`,
      );
    if (tick === -1) break;
    // 行内代码：同样长度的反引号串收尾；找不到收尾就当普通反引号。
    let run = tick;
    while (text[run] === "`") run++;
    const ticks = text.slice(tick, run);
    const close = findClosingTicks(text, run, ticks.length);
    if (close === -1) {
      out += ticks;
      i = run;
      continue;
    }
    out += text.slice(tick, close + ticks.length);
    i = close + ticks.length;
  }
  return out;
}

function findClosingTicks(text: string, from: number, len: number): number {
  let i = from;
  while (i < text.length) {
    const at = text.indexOf("`", i);
    if (at === -1) return -1;
    let end = at;
    while (text[end] === "`") end++;
    if (end - at === len) return at;
    i = end;
  }
  return -1;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
/** 列表项：缩进、标记（`-` `*` `+` `1.` `1)`）、标记后的空格。 */
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;

/** 行首缩进的列宽（制表符补到 4 的倍数）。 */
function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w++;
    else if (ch === "\t") w += 4 - (w % 4);
    else break;
  }
  return w;
}

export function escapeUnknownTags(markdown: string): string {
  if (!markdown.includes("<")) return markdown;
  const lines = markdown.split("\n");
  let fence = "";
  // 缩进代码块：内容至少比所在列表项的正文多缩进 4 格（不在列表里就是 4 格），且前一行是空行。
  let codeIndent = 0;
  let listIndent = 0;
  let afterBreak = true;
  // 行内代码可以跨行，所以按「段落」（非代码的连续行）整体处理。
  let buf: string[] = [];
  const out: string[] = [];
  const flush = () => {
    if (buf.length) out.push(escapeInline(buf.join("\n")));
    buf = [];
  };
  for (const line of lines) {
    const blank = line.trim() === "";
    const indent = indentWidth(line);
    if (fence) {
      out.push(line);
      const close = FENCE_RE.exec(line)?.[1];
      if (
        close &&
        close[0] === fence[0] &&
        close.length >= fence.length &&
        line.trim() === close
      ) {
        fence = "";
        afterBreak = true;
      }
      continue;
    }
    if (codeIndent) {
      if (blank || indent >= codeIndent) {
        out.push(line);
        continue;
      }
      codeIndent = 0;
    }
    if (blank) {
      flush();
      out.push(line);
      afterBreak = true;
      continue;
    }
    if (afterBreak && indent >= listIndent + 4) {
      flush();
      codeIndent = listIndent + 4;
      out.push(line);
      continue;
    }
    const open = FENCE_RE.exec(line)?.[1];
    if (open) {
      flush();
      fence = open;
      out.push(line);
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item) {
      const marker = indentWidth(item[1] ?? "") + (item[2] ?? "").length;
      const gap =
        indentWidth(`${item[1] ?? ""}${item[2] ?? ""}${item[3] ?? ""}`) -
        marker;
      // 标记后空 5 格以上时，正文从标记后 1 格开始（多出来的算缩进代码）。
      listIndent = marker + (gap >= 1 && gap <= 4 ? gap : 1);
    } else if (afterBreak && indent < listIndent) {
      listIndent = 0;
    }
    afterBreak = false;
    buf.push(line);
  }
  flush();
  return out.join("\n");
}
