import { afterAll, describe, expect, test } from "bun:test";

/*
 * 公网页 302 到内网时，实况画面要说安全原因，不说「连不上」。真 Chromium 报的 `at` 是起始网址，
 * 只有真浏览器能证明修法对，所以和 readable-text 一样只在
 *   CHISABOT_COMPUTER_BROWSER=1 bun test tests/egress-redirect-browser.test.ts
 * 时跑（应用镜像里有 Chromium）。
 */
const asked = process.env.CHISABOT_COMPUTER_BROWSER === "1";

describe.skipIf(!asked)(
  "a public page redirecting into the private network",
  () => {
    const cleanup: (() => Promise<unknown>)[] = [];
    afterAll(async () => {
      for (const step of cleanup.reverse()) await step();
    });

    test("the live screen explains the hop that was refused, not the page it started from", async () => {
      const { chromium } = await import("playwright");
      const egress = await import("../src/egress");
      const { startScreencast } = await import("../src/screencast");
      egress.setEgressLogger(() => undefined);
      const filter = await egress.startEgressFilter({ env: {} });
      cleanup.push(async () => {
        await egress.stopEgressFilter();
        egress.setEgressLogger(null);
      });
      egress.setEgressPolicy("a", { mode: "allow_all", rules: [] });
      const proxy = egress.egressFor("a", {});
      if (!proxy) throw new Error("filter not running");
      const browser = await chromium.launch({ proxy });
      cleanup.push(() => browser.close());
      const page = await browser.newPage();
      await page.route("https://redir.example.com/**", (route) =>
        route.fulfill({
          status: 302,
          headers: { location: "https://10.0.0.1/" },
          body: "",
        }),
      );
      const messages: { type?: string; ok?: boolean; error?: string }[] = [];
      const cast = await startScreencast(page, (m) =>
        messages.push(m as { type?: string }),
      );
      cleanup.push(() => cast.stop());
      await cast.send({
        type: "navigate",
        url: "https://redir.example.com/start",
      });
      const navigation = messages.find((m) => m.type === "navigation");
      expect(navigation?.ok).toBe(false);
      expect(navigation?.error).toBe("出于安全原因不允许访问内网地址。");
      expect(filter.port).toBeGreaterThan(0);
    });
  },
);
