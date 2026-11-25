import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const srcDir = path.join(import.meta.dir, "../src");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

const stylesCss = stripComments(
  readFileSync(path.join(srcDir, "styles.css"), "utf8"),
);
const tokensCss = stripComments(
  readFileSync(path.join(srcDir, "styles/tokens.css"), "utf8"),
);
const materialsCss = stripComments(
  readFileSync(path.join(srcDir, "styles/materials.css"), "utf8"),
);

function extractRuleBody(css: string, selectorPrefix: string): string {
  const escaped = selectorPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`));
  expect(match).toBeTruthy();
  return match?.[1] ?? "";
}

test("styles.css 统一用户与 AI 聊天气泡，不引用 --glass-user 且不覆盖 background/box-shadow", () => {
  expect(stylesCss).not.toContain("--glass-user");

  const aiBubbleBody = extractRuleBody(
    stylesCss,
    '.glass-main [data-slot="message"][data-align="start"] [data-slot="bubble"][data-variant="ghost"] > [data-slot="bubble-content"]',
  );
  const userBubbleBody = extractRuleBody(
    stylesCss,
    '.glass-main [data-slot="bubble"][data-align="end"] > [data-slot="bubble-content"]',
  );

  for (const body of [aiBubbleBody, userBubbleBody]) {
    expect(body).toContain("padding: 12px 16px;");
    expect(body).toContain("border-radius: var(--r-bubble);");
    expect(body).not.toMatch(/(?:^|[;\s])background(?:-color)?\s*:/);
    expect(body).not.toMatch(/(?:^|[;\s])box-shadow\s*:/);
  }
  expect(userBubbleBody).not.toMatch(/(?:^|[;\s])color\s*:/);
});

test("tokens.css 注册 @property --surface-bg-hold (inherits: false) 与 4 个 --mat-*-hold 令牌", () => {
  const bgHoldProp = extractRuleBody(tokensCss, "@property --surface-bg-hold");
  expect(bgHoldProp).toMatch(/inherits:\s*false\s*;/);

  for (const token of [
    "--mat-glass-panel-hold",
    "--mat-glass-elevated-hold",
    "--mat-clear-panel-hold",
    "--mat-clear-elevated-hold",
  ]) {
    const propBody = extractRuleBody(tokensCss, `@property ${token}`);
    expect(propBody).toMatch(/syntax:\s*"<color>"\s*;/);
    expect(propBody).toMatch(/inherits:\s*true\s*;/);
    expect(tokensCss).toMatch(new RegExp(`${token}\\s*:\\s*color-mix\\(`));
  }
});

test("materials.css 在 glass-hold 与入退场/关闭态切到 --surface-bg-hold（不直接写 background）", () => {
  const keyframeMatch = materialsCss.match(
    /@keyframes glass-hold\s*\{\s*from,\s*to\s*\{([^{}]*)\}\s*\}/,
  );
  expect(keyframeMatch).toBeTruthy();
  const keyframeBody = keyframeMatch?.[1] ?? "";
  expect(keyframeBody).toContain(
    "--surface-bg: var(--surface-bg-hold, var(--surface-bg-solid));",
  );
  expect(keyframeBody).not.toMatch(/(?:^|[;\s])background(?:-color)?\s*:/);

  const strippingMatch = materialsCss.match(
    /:is\([\s\S]*?\[data-slot="dialog-content"\][\s\S]*?\[data-slot="sheet-content"\][\s\S]*?\):is\(\s*\[data-starting-style\],\s*\[data-ending-style\],\s*\[data-closed\],\s*\[data-state="closed"\],\s*\[data-leaving="true"\]\s*\)[\s\S]*?\.glass-rail:is\(\.is-collapsed,\s*\[data-rail-motion="closing"\]\)\s*>\s*\.rail-card\s*\{([^{}]*)\}/,
  );
  expect(strippingMatch).toBeTruthy();
  const strippingBody = strippingMatch?.[1] ?? "";
  expect(strippingBody).toContain(
    "--surface-bg: var(--surface-bg-hold, var(--surface-bg-solid));",
  );
  expect(strippingBody).not.toMatch(/(?:^|[;\s])background(?:-color)?\s*:/);
});

test("面板与抽屉开合不叠加透明度淡入：rail-sheet 锁定 opacity: 1、rail-card 与侧栏无 opacity: 0 / glass-fade-in", () => {
  const railSheetStateBody = extractRuleBody(
    stylesCss,
    '.rail-sheet[data-slot="sheet-content"]:is([data-starting-style], [data-ending-style])',
  );
  expect(railSheetStateBody).toMatch(/opacity:\s*1\s*;/);

  const railEnterMatch = stylesCss.match(
    /@keyframes rail-card-enter\s*\{([\s\S]*?\n)\}/,
  );
  const railExitMatch = stylesCss.match(
    /@keyframes rail-card-exit\s*\{([\s\S]*?\n)\}/,
  );
  expect(railEnterMatch).toBeTruthy();
  expect(railExitMatch).toBeTruthy();
  expect(railEnterMatch?.[1] ?? "").not.toMatch(/opacity\s*:/);
  expect(railExitMatch?.[1] ?? "").not.toMatch(/opacity\s*:/);

  const sideFullBody = extractRuleBody(stylesCss, ".glass-side-full");
  const miniBody = extractRuleBody(stylesCss, ".glass-mini");
  expect(sideFullBody).not.toContain("glass-fade-in");
  expect(miniBody).not.toContain("glass-fade-in");
});

test("默认 glass / clear 浅色表面去除生硬白边，保持通透柔和磨砂质感且壁纸画布自动保底加厚", () => {
  for (const material of ["glass", "clear"] as const) {
    const scope =
      material === "glass"
        ? ':where(html[data-material="glass"], html:not([data-material]))'
        : ':where(html[data-material="clear"])';
    const body = extractRuleBody(materialsCss, scope);
    for (const role of ["panel", "elevated", "bubble", "control"] as const) {
      expect(body).toMatch(new RegExp(`--mat-${role}-border:\\s*transparent;`));
      const hlMatch = body.match(new RegExp(`--mat-${role}-hl:\\s*([^;]+);`));
      expect(hlMatch).toBeTruthy();
      expect(hlMatch?.[1] ?? "").not.toContain("inset 0 0 0 1px");
    }
  }

  const rootBody = extractRuleBody(tokensCss, ":root");
  for (const token of [
    "--mat-glass-panel-1",
    "--mat-glass-panel-2",
    "--mat-glass-bubble-1",
    "--mat-glass-bubble-2",
  ]) {
    const m = rootBody.match(
      new RegExp(`${token}:\\s*color-mix\\([\\s\\S]*?\\/\\s*(0\\.\\d+)\\)`),
    );
    expect(m).toBeTruthy();
    expect(Number(m?.[1])).toBeLessThanOrEqual(0.58);
  }

  const wallpaperBody = extractRuleBody(
    tokensCss,
    'html[data-canvas="wallpaper"]',
  );
  expect(wallpaperBody).toContain("--ink-4: var(--ink-3);");
  expect(wallpaperBody).toContain("--mat-glass-panel-1:");
  expect(wallpaperBody).toContain("--mat-clear-bubble-1:");
});
