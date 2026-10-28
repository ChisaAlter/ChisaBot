/**
 * 聊天 ```svg 卡片的清洗（审查 S1）。
 *
 * 用 jsdom 而不是 happy-dom：happy-dom 21 的 nodeName 让 DOMPurify 把每个元素都当成未知标签删掉，
 * 测出来的东西不代表浏览器。jsdom 是 DOMPurify 自己的测试环境。
 */
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  sanitizeSvgMarkup,
  svgMarkupToDataUrl,
} from "../src/components/chat/bot-bubbles";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const win = dom.window as unknown as Window & typeof globalThis;
const sanitize = (raw: string) => sanitizeSvgMarkup(raw, win);

const FORBIDDEN_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "animate",
  "set",
  "img",
  "handler",
  "listener",
]);
const SAFE_URL = /^#[\w.:-]*$|^data:image\/(?:png|jpe?g|gif|webp);base64,/i;

/** 输出必须是合法的独立 SVG（否则 <img> 显示成破图），且没有任何可执行面。 */
function expectInert(svg: string | null) {
  expect(svg).not.toBeNull();
  const doc = new dom.window.DOMParser().parseFromString(
    svg as string,
    "image/svg+xml",
  );
  expect(doc.getElementsByTagName("parsererror").length).toBe(0);
  expect(doc.documentElement.localName).toBe("svg");
  expect(doc.documentElement.namespaceURI).toBe("http://www.w3.org/2000/svg");
  for (const el of [
    doc.documentElement,
    ...doc.documentElement.querySelectorAll("*"),
  ]) {
    expect(FORBIDDEN_TAGS.has(el.localName.toLowerCase())).toBe(false);
    for (const attr of el.attributes) {
      expect(attr.localName.toLowerCase().startsWith("on")).toBe(false);
      if (["href", "src"].includes(attr.localName.toLowerCase())) {
        expect(attr.value).toMatch(SAFE_URL);
      }
      expect(attr.value).not.toMatch(/javascript:|vbscript:|data:text\/html/i);
    }
  }
  expect(svg as string).not.toMatch(/javascript:/i);
  return doc;
}

describe("sanitizeSvgMarkup（审查 S1：SVG 卡片 XSS）", () => {
  const payloads: [string, string][] = [
    [
      "<image/onerror> 斜杠分隔属性",
      "<svg><image/onerror=alert(1) href=x /></svg>",
    ],
    ["<image/onerror> 带引号", '<svg><image/onerror="alert(1)"/></svg>'],
    [
      "<animate/onbegin>",
      "<svg><animate/onbegin=alert(1) attributeName=x dur=1s /></svg>",
    ],
    [
      "<animate> 把 href 改成 javascript:",
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text y="20">x</text></a></svg>',
    ],
    [
      "<set> 把 href 改成 javascript:",
      '<svg><a><set attributeName="href" to="javascript:alert(1)"/><text y="20">x</text></a></svg>',
    ],
    ["<svg onload>", '<svg onload="alert(1)"><circle r="10"/></svg>'],
    ["<svg/onload>", '<svg/onload=alert(1)><circle r="10"/></svg>'],
    ["<script>", '<svg><script>alert(1)</script><circle r="5"/></svg>'],
    [
      "<script href>",
      '<svg><script href="data:text/javascript,alert(1)"></script></svg>',
    ],
    [
      "<foreignObject> 里的 HTML",
      '<svg><foreignObject><img src=x onerror=alert(1)><iframe src="javascript:alert(1)"></iframe></foreignObject><path d="M1 1"/></svg>',
    ],
    [
      "<a href=javascript:>",
      '<svg><a href="javascript:alert(1)"><circle r="3"/></a></svg>',
    ],
    [
      "<a xlink:href=javascript:>",
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(2)"><circle r="3"/></a></svg>',
    ],
    [
      "混了空白和实体的 javascript:",
      '<svg><a href=" jav&#x09;ascript&colon;alert(1)"><circle r="3"/></a></svg>',
    ],
    [
      "外部 <use>",
      '<svg><use href="https://evil.example/x.svg#a"/><use href="data:image/svg+xml,%3Csvg onload=alert(1)%3E"/></svg>',
    ],
    [
      "外部 <image> / <feImage>",
      '<svg><image href="https://evil.example/track.png"/><filter id="f"><feImage href="https://evil.example/x"/></filter></svg>',
    ],
    [
      "<iframe>/<embed>/<object>",
      '<svg><iframe srcdoc="<script>alert(1)</script>"></iframe><embed src="x.swf"/><object data="x"></object></svg>',
    ],
    [
      "<style> 里藏标签（mXSS）",
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>"></style></svg>',
    ],
    [
      "<handler>/<listener>",
      '<svg><handler type="text/javascript" ev:event="load"/><listener event="load" handler="#x"/></svg>',
    ],
  ];

  for (const [name, raw] of payloads) {
    test(`清掉 ${name}`, () => {
      const out = sanitize(raw);
      expectInert(out);
      expect(out as string).not.toContain("alert(");
    });
  }

  test("保留正常的图形、文字、样式、渐变、本地引用和内嵌位图", () => {
    const raw = `<svg viewBox="0 0 100 100" width="200" xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient><path id="p" d="M0 0L10 10"/></defs>
      <style>.t { fill: #333; font-size: 12px; }</style>
      <circle cx="50" cy="50" r="10" fill="url(#g)"/>
      <use href="#p"/><use xlink:href="#p"/>
      <text class="t" x="10" y="90">温度 &amp; 湿度 &lt;ok&gt;</text>
      <image href="data:image/png;base64,iVBORw0KGgo=" width="5" height="5"/>
      <g transform="translate(5 5)"><rect width="10" height="10"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s" repeatCount="indefinite"/></rect></g>
    </svg>`;
    const doc = expectInert(sanitize(raw));
    const root = doc.documentElement;
    expect(root.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(root.getAttribute("width")).toBe("200");
    expect(root.querySelector("circle")?.getAttribute("fill")).toBe("url(#g)");
    expect(root.querySelector("linearGradient")).not.toBeNull();
    expect(root.querySelector("style")?.textContent).toContain(".t");
    expect(root.querySelector("text")?.textContent).toBe("温度 & 湿度 <ok>");
    const uses = [...root.querySelectorAll("use")];
    expect(uses).toHaveLength(2);
    expect(uses[0]?.getAttribute("href")).toBe("#p");
    expect(
      uses[1]?.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
    ).toBe("#p");
    expect(root.querySelector("image")?.getAttribute("href")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    const spin = root.querySelector("animateTransform");
    expect(spin?.getAttribute("from")).toBe("0");
    expect(spin?.getAttribute("to")).toBe("360");
  });

  test("只取第一段 <svg>…</svg>，前后的 HTML 不要", () => {
    const out = sanitize(
      '<p onclick="alert(1)">x</p><svg width="10"><circle r="1"/></svg><b>y</b>',
    );
    const doc = expectInert(out);
    expect(doc.documentElement.getAttribute("width")).toBe("10");
    expect(out as string).not.toContain("<p");
  });

  test("不是 SVG 返回 null", () => {
    expect(sanitize("<div>not svg</div>")).toBeNull();
  });

  test("没有 DOM 时宁可不画（返回 null），绝不原样放行", () => {
    expect(
      sanitizeSvgMarkup(
        '<svg onload="alert(1)"><circle r="1"/></svg>',
        undefined,
      ),
    ).toBeNull();
  });

  test("转成 <img> 用的 data URL，图片上下文里 SVG 不执行脚本", () => {
    const svg = sanitize('<svg width="4"><circle r="1"/></svg>') as string;
    const url = svgMarkupToDataUrl(svg);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(svg);
    expect(url).not.toMatch(/[<>"#\s]/);
  });
});
