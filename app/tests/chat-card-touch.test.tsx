import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArtifactCard,
  parseArtifactFence,
} from "../src/components/chat/bot-bubbles";
import {
  clampZoom,
  DiagramZoom,
  svgNaturalWidth,
} from "../src/components/chat/diagram-zoom";

/* 审计 05 必修 3：触屏上卡片头按钮常显、全屏能打开、图能放大。 */
const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
);

/** 取出 `@media (hover: none) { … }` 里的全部内容（按花括号配对）。 */
function hoverNoneBlocks(
  source: string,
): Array<{ start: number; body: string }> {
  const out: Array<{ start: number; body: string }> = [];
  const re = /@media\s*\(hover:\s*none\)\s*\{/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.push({
      start: m.index,
      body: source.slice(m.index + m[0].length, i - 1),
    });
  }
  return out;
}

function declarations(block: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`).exec(block);
  return m?.[1] ?? "";
}

describe("触屏卡片头按钮常显", () => {
  test("默认只在悬停时显示（所以触屏需要单独规则）", () => {
    expect(declarations(css, ".chat-doc-head-actions")).toMatch(
      /opacity:\s*0;\s*pointer-events:\s*none/,
    );
  });

  test("@media (hover: none) 里按钮组常显、可点，并且不再浮在标题上", () => {
    const block = hoverNoneBlocks(css).find((b) =>
      b.body.includes(".chat-doc-head-actions"),
    );
    expect(block).toBeDefined();
    const decl = declarations(block?.body ?? "", ".chat-doc-head-actions");
    expect(decl).toMatch(/opacity:\s*1/);
    expect(decl).toMatch(/pointer-events:\s*auto/);
    expect(decl).toMatch(/position:\s*static/);
    expect(declarations(block?.body ?? "", ".chat-doc-head")).toMatch(
      /flex-wrap:\s*wrap/,
    );
    // 在默认规则之后，层叠顺序上能压过它。
    expect(block?.start ?? 0).toBeGreaterThan(
      css.indexOf(".chat-doc-head-actions {"),
    );
  });

  test("之后没有别的规则把按钮组再藏起来", () => {
    const block = hoverNoneBlocks(css).find((b) =>
      b.body.includes(".chat-doc-head-actions"),
    );
    const after = css.slice(block?.start ?? 0);
    for (const m of after.matchAll(
      /([^{}]*\.chat-doc-head-actions[^{}]*)\{([^}]*)\}/g,
    )) {
      expect(m[2]).not.toMatch(/opacity:\s*0[;\s]|pointer-events:\s*none/);
    }
  });

  test("没有新增 backdrop-filter", () => {
    const block = hoverNoneBlocks(css).find((b) =>
      b.body.includes(".chat-doc-head-actions"),
    );
    expect(block?.body).not.toContain("backdrop-filter");
  });
});

describe("Mermaid 卡片：全屏按钮和缩放", () => {
  const artifact = parseArtifactFence(
    "```mermaid\ngraph TD\nA[开始] --> B[结束]\n```",
  );

  test("卡片头里有全屏按钮", () => {
    expect(artifact).not.toBeNull();
    const html = renderToStaticMarkup(
      <ArtifactCard
        artifact={artifact as NonNullable<typeof artifact>}
        components={{}}
      />,
    );
    const actions =
      /<div class="chat-doc-head-actions">([\s\S]*?)<\/header>/.exec(
        html,
      )?.[1] ?? "";
    expect(actions).toContain('data-testid="artifact-expand-btn"');
    expect(actions).toContain('aria-label="全屏查看"');
  });

  test("DiagramZoom：缩放条和可滚动的画布", () => {
    const html = renderToStaticMarkup(
      <DiagramZoom naturalWidth={480}>
        <svg aria-label="图" />
      </DiagramZoom>,
    );
    for (const id of [
      "artifact-zoom-out",
      "artifact-zoom-reset",
      "artifact-zoom-in",
      "artifact-zoom-viewport",
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("width:calc(min(100%, 480px) * 1)");
    expect(html).toContain(">100%<");
    expect(css).toMatch(/\.chat-artifact-zoom-viewport \{[^}]*overflow: auto/);
  });

  test("缩放范围 50%–800%，宽度从 viewBox 读", () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(20)).toBe(8);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(svgNaturalWidth('<svg viewBox="0 0 720 300" width="100%">')).toBe(
      720,
    );
    expect(svgNaturalWidth('<svg width="320px">')).toBe(320);
    expect(svgNaturalWidth("<svg>")).toBe(640);
  });
});
