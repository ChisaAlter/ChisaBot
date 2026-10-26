import { afterAll, describe, expect, test } from "bun:test";

/*
 * §101.8：读页面只读人看得见的字。真 Chromium 才有布局，所以和 native-select 一样只在
 *   CHISABOT_COMPUTER_BROWSER=1 bun test tests/readable-text.test.ts
 * 时跑（应用镜像里有 Chromium）。
 */
const asked = process.env.CHISABOT_COMPUTER_BROWSER === "1";
const PAGE = `<!doctype html><title>Sign in</title><body>
<div id="fallback" style="display:none">This wallpaper needs WebGL, which isn’t available in your browser.</div>
<div style="visibility:hidden">藏起来的字</div>
<h1>hark pro</h1><button>Continue with Google</button>
<script>window.x = "脚本里的字";</script><style>.a{color:red}</style>
</body>`;
const site = asked
  ? Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) })
  : null;
afterAll(() => site?.stop(true));

describe.skipIf(!asked)("visible page text in a real Chromium", () => {
  test("hidden fallback text, scripts and styles are not read; visible text is", async () => {
    const { chromium } = await import("playwright");
    const { visiblePageText } = await import("../src/readable-text");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${site!.port}/`);
      const text = await page.evaluate(visiblePageText);
      expect(text).toContain("hark pro");
      expect(text).toContain("Continue with Google");
      expect(text).not.toContain("needs WebGL");
      expect(text).not.toContain("藏起来的字");
      expect(text).not.toContain("脚本里的字");
      expect(text).not.toContain("color:red");
    } finally {
      await browser.close();
    }
  });
});
