import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Streamdown } from "streamdown";
import { escapeUnknownTags } from "../src/lib/chat/escape-unknown-tags";

/** 和 SmoothStreamdown 一样：先转义未知标签，再交给 Streamdown（含它的 harden / sanitize）。 */
function render(markdown: string): string {
  return renderToString(
    createElement(Streamdown, null, escapeUnknownTags(markdown)),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

describe("正文里的尖括号（审计 05 必修 1）", () => {
  test("泛型按原文显示，不被当成标签吞掉", () => {
    for (const s of [
      "Vec<String>",
      "Option<T>",
      "HashMap<K, V>",
      "List<Object>",
      "Box<dyn Error>",
      "Vec<u8>",
    ]) {
      expect(text(render(`返回 ${s} 就行`))).toContain(s);
    }
    expect(text(render("Result<Vec<String>, Error> 嵌套"))).toContain(
      "Result<Vec<String>, Error>",
    );
  });

  test("闭合形式的未知标签也按文字显示", () => {
    expect(text(render("用 <Foo>bar</Foo> 包一下"))).toContain(
      "<Foo>bar</Foo>",
    );
    expect(text(render("<T> 是类型参数"))).toContain("<T>");
  });

  test("行内代码和代码块原样不动", () => {
    expect(escapeUnknownTags("`Vec<String>`")).toBe("`Vec<String>`");
    const fenced = "```rust\nlet v: Vec<String> = vec![];\n```";
    expect(escapeUnknownTags(fenced)).toBe(fenced);
    const tilde = "- 列表\n\n  ~~~\n  Option<T>\n  ~~~";
    expect(escapeUnknownTags(tilde)).toBe(tilde);
    expect(text(render(fenced))).toContain("Vec<String>");
  });

  test("标准 HTML 照旧交给 Streamdown 处理", () => {
    const html = render(
      "<details><summary>展开</summary>内容</details> 和 <kbd>Ctrl</kbd>",
    );
    expect(html).toContain("<details");
    expect(html).toContain("<kbd");
  });

  test("危险 HTML 仍被清洗，不会因为转义而漏过去", () => {
    const html = render(
      'a <script>alert(1)</script> b <img src=x onerror="alert(1)"> c <iframe src="https://e.x"></iframe>',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    // 大小写不规范的标签按文字显示（惰性文本），不会变成元素。
    const upper = render("<SCRIPT>alert(1)</SCRIPT>");
    expect(upper).not.toMatch(/<script/i);
  });

  test("自动链接、比较符号不受影响", () => {
    // 自动链接仍是链接（Streamdown 把链接画成带 data-streamdown="link" 的按钮）。
    expect(render("见 <https://example.com>")).toMatch(
      /data-streamdown="link"[^>]*>https:\/\/example\.com</,
    );
    expect(render("见 <mailto:a@b.co>")).toContain("a@b.co");
    expect(escapeUnknownTags("见 <https://example.com> 和 <a@b.co>")).toBe(
      "见 <https://example.com> 和 <a@b.co>",
    );
    expect(text(render("a<b 且 c > d"))).toContain("a<b 且 c > d");
  });

  test("和 HTML 元素同名的小写泛型紧跟标识符时也按文字显示", () => {
    for (const s of [
      "Vec<option>",
      "List<object>",
      "Result<a>",
      "Vec<i>",
      "Box<b>",
      "Map<string, data>",
    ]) {
      const html = render(`用 ${s} 存，后面还有字`);
      expect(text(html)).toContain(`用 ${s} 存，后面还有字`);
    }
    // Result<a> 不变成链接吞掉后文；Vec<i> 后面不变成斜体。
    expect(render("Result<a> 后面的字")).not.toContain(
      'data-streamdown="link"',
    );
    expect(render("Vec<i> 后面的字")).not.toMatch(/<(i|em)[\s>]/);
    // 前面有空格的真 HTML 照旧是元素，闭合标签也不受影响。
    expect(render("按 <kbd>Ctrl</kbd> 键")).toContain("<kbd");
    // 贴着文字写的换行、上下标照旧是 HTML。
    for (const s of ["a<br>b", "a<br/>b", "H<sub>2</sub>O", "10<sup>3</sup>"])
      expect(escapeUnknownTags(s)).toBe(s);
    expect(render("| 列 |\n| --- |\n| 第一行<br>第二行 a<br>b |")).toContain(
      "<br",
    );
    expect(render("H<sub>2</sub>O")).toContain("<sub");
    expect(escapeUnknownTags("文字<kbd>Ctrl</kbd>")).toBe(
      "文字<kbd>Ctrl</kbd>",
    );
  });

  test("缩进代码块（含列表里的）原样不动", () => {
    const top =
      "说明：\n\n    let v: Vec<String> = vec![];\n    Option<T>\n\n后文 Vec<u8>";
    const out = escapeUnknownTags(top);
    expect(out).toContain("    let v: Vec<String> = vec![];\n    Option<T>");
    expect(out).toContain("后文 Vec&lt;u8>");
    expect(text(render(top))).toContain("let v: Vec<String> = vec![];");
    expect(render(top)).not.toContain("&amp;lt;");

    const inList =
      "1. 第一步\n\n       let x: Vec<String> = f();\n\n2. 第二步 Option<T>";
    const listOut = escapeUnknownTags(inList);
    expect(listOut).toContain("       let x: Vec<String> = f();");
    expect(listOut).toContain("第二步 Option&lt;T>");
    expect(render(inList)).not.toContain("&amp;lt;");

    const bullet = "- 项目\n\n      Map<K, V> m;\n      List<Object> l;";
    expect(escapeUnknownTags(bullet)).toBe(bullet);

    // 制表符缩进
    const tab = "看代码：\n\n\tVec<String> v;";
    expect(escapeUnknownTags(tab)).toBe(tab);
  });

  test("不是代码块的缩进照常转义", () => {
    // 段落中间的缩进行是段落续行，不是代码块。
    expect(escapeUnknownTags("第一行\n    Vec<String> 续行")).toContain(
      "Vec&lt;String>",
    );
    // 列表项下 4 格缩进是同一项的第二段，不是代码。
    expect(escapeUnknownTags("- 项目\n\n    第二段 Vec<String>")).toContain(
      "Vec&lt;String>",
    );
    // 代码块结束后的普通段落恢复转义。
    expect(
      escapeUnknownTags("说明\n\n    code<T>\n\n结尾 Vec<String>"),
    ).toContain("结尾 Vec&lt;String>");
  });
});
