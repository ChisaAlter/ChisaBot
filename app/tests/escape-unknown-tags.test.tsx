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
    expect(escapeUnknownTags("a<b 且 c > d")).toBe("a<b 且 c > d");
  });
});
