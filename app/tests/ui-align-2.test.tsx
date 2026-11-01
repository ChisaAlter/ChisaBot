import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { edgePunct, labelText, T } from "../src/components/ui/button";

/* DESIGN.md §82.6–§82.10 对齐第二轮的静态护栏（真浏览器测量在 tests/ui-align/）。 */
const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");
const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

test("trailing / leading full-width brackets are wrapped so no-halt fonts can trim them (§82.7)", () => {
  expect(html(labelText("检查（不生成图片）"))).toBe('<span class="btn-t">检查（不生成图片<span class="t-close">）</span></span>');
  expect(html(labelText("「草稿」"))).toBe('<span class="btn-t"><span class="t-open">「</span>草稿<span class="t-close">」</span></span>');
  expect(html(<T>{"保存"}</T>)).toBe('<span class="btn-t">保存</span>');
  expect(edgePunct("）")).toBe("）");
  expect(css).toMatch(/html\[data-no-halt\] \.t-close \{ margin-inline-end: -0\.5em; \}/);
});

test("select values, approvals segment and copy label are trimmed the same way as buttons (§82.6)", () => {
  expect(css).toMatch(/\[data-slot="select-value"\]:not\(:has\(\*\)\),\s*\.t-line \{[^}]*text-box: trim-both cap alphabetic;/);
  expect(css).toMatch(/\.t-line \{[^}]*overflow-x: clip;/);
  expect(css).toMatch(/\.ap-seg button \{ display: inline-flex; align-items: center;/);
  expect(css).toMatch(/\.chat-msg-action \.btn-labels > span \{ text-box: trim-both cap alphabetic; \}/);
});

test("dropdown menu items wrap bare label text (§82.6)", () => {
  const src = readFileSync(path.join(import.meta.dir, "../src/components/ui/dropdown-menu.tsx"), "utf8");
  expect(src).toContain("{labelText(children)}");
});

test("folded rows collapse instead of unmounting, and the panel handle never covers the message column (§82.9 / §82.10)", () => {
  expect(css).toMatch(/\[data-slot="message-scroller-item"\]\[data-folded\] \{[^}]*animation: chat-row-fold 220ms/);
  expect(css).toMatch(/body\[data-has-narrow-rail\] \[data-testid="chat-transcript"\] \{\s*padding-right: max\(1rem, calc\(var\(--rail-tab-clear\)/);
  const src = readFileSync(path.join(import.meta.dir, "../src/components/channels/chat-transcript.tsx"), "utf8");
  expect(src).toContain("renderFolded(item, index)");
});

test("device badges never carry bare text — the label sits in <T> so it is trimmed like buttons (§82.6)", () => {
  const files = [
    "../src/components/devices/devices.tsx",
    "../src/components/devices/full-access.tsx",
    "../src/components/devices/pair-phone.tsx",
    "../src/components/im/im.tsx",
    "../src/components/local-agents/device-agents-panel.tsx",
    "../src/routes/_authed/admin/system-update.tsx",
    "../src/routes/_authed/settings/devices/$deviceId.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(path.join(import.meta.dir, f), "utf8");
    // one-line badges: <span className="device-badge …">{…}</span> with no <T> inside
    const bare = src.match(/<span\b[^>]*device-badge[^>]*>\{[^<]*\}<\/span>/g) ?? [];
    expect({ f, bare }).toEqual({ f, bare: [] });
  }
});
