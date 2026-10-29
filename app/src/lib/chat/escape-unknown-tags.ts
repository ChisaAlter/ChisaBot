/**
 * 模型常把泛型直接写在正文里（`Vec<String>`、`Option<T>`、`List<Object>`，不加反引号）。
 * Streamdown 把它们当 HTML 标签解析，未知标签被 harden 直接丢掉，文字静默消失（审计 05 必修 1）。
 *
 * 这里在交给 Streamdown 之前，把「不是标准 HTML 元素」的标签（以及大小写不是全小写的标签）
 * 的 `<` 转成 `&lt;`，让它们按原文显示。全小写的标准 HTML 元素（`<details>`、`<kbd>`、`<br>`、
 * `<script>`、`<img onerror>` …）原样留给 Streamdown，照旧由它的 sanitize/harden 清洗。
 *
 * 代码块（``` / ~~~ 围栏，含列表里缩进的围栏）和行内代码原样不动。
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
      .replace(TAG_RE, (whole, _slash: string, name: string) =>
        isHtmlTag(name) ? whole : `&lt;${whole.slice(1)}`,
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

export function escapeUnknownTags(markdown: string): string {
  if (!markdown.includes("<")) return markdown;
  const lines = markdown.split("\n");
  let fence: string | null = null;
  // 行内代码可以跨行，所以按「段落」（非围栏的连续行）整体处理。
  let buf: string[] = [];
  const out: string[] = [];
  const flush = () => {
    if (buf.length) out.push(escapeInline(buf.join("\n")));
    buf = [];
  };
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    if (m) {
      flush();
      fence = m[1]!;
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      out.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.join("\n");
}
