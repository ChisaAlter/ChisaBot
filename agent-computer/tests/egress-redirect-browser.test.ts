import { afterAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

/*
 * 公网页跳到内网时，实况画面要说安全原因，不说「连不上」，也不能因为 goto 已在中间页 commit 就不说。
 * 真 Chromium 报的 `at` 是起始网址，只有真浏览器能证明修法对，所以和 readable-text 一样只在
 *   CHISABOT_COMPUTER_BROWSER=1 bun test tests/egress-redirect-browser.test.ts
 * 时跑（应用镜像里有 Chromium）。浏览器和生产一样只给代理地址、不带凭据。
 */
const asked = process.env.CHISABOT_COMPUTER_BROWSER === "1";
const SECURITY = "出于安全原因不允许访问内网地址。";

type Message = { type?: string; ok?: boolean; error?: string };

describe.skipIf(!asked)(
  "a public page redirecting into the private network",
  () => {
    const cleanup: (() => Promise<unknown>)[] = [];
    afterAll(async () => {
      for (const step of cleanup.reverse()) await step();
    });

    let ready: Promise<Page> | null = null;
    function browserPage(): Promise<Page> {
      ready ??= (async () => {
        const { chromium } = await import("playwright");
        const egress = await import("../src/egress");
        egress.setEgressLogger(() => undefined);
        const filter = await egress.startEgressFilter({ env: {} });
        cleanup.push(async () => {
          await egress.stopEgressFilter();
          egress.setEgressLogger(null);
        });
        egress.setEgressPolicy("a", { mode: "allow_all", rules: [] });
        const browser = await chromium.launch({
          proxy: { server: `http://127.0.0.1:${filter.port}` },
        });
        cleanup.push(() => browser.close());
        const page = await browser.newPage();
        await page.route("https://redir.example.com/**", (route) =>
          route.fulfill({
            status: 302,
            headers: { location: "https://10.0.0.1/" },
            body: "",
          }),
        );
        // A page that commits fine and then sends the browser on into the private network.
        await page.route("https://hop1.example.com/**", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><script>location.replace('https://10.0.0.1/')</script>hop1",
          }),
        );
        return page;
      })();
      return ready;
    }

    /** Cast `page`, navigate, and resolve once a failed navigation message arrives. */
    async function navigateUntilRefused(page: Page, url: string) {
      const { startScreencast } = await import("../src/screencast");
      const messages: Message[] = [];
      let refused: () => void = () => undefined;
      const failed = new Promise<void>((resolve) => {
        refused = resolve;
      });
      const cast = await startScreencast(page, (m) => {
        messages.push(m as Message);
        if ((m as Message).type === "navigation" && (m as Message).ok === false)
          refused();
      });
      await cast.send({ type: "navigate", url });
      await failed;
      await cast.stop();
      return messages.filter((m) => m.type === "navigation");
    }

    test("the live screen explains the hop that was refused, not the page it started from", async () => {
      const page = await browserPage();
      const navigations = await navigateUntilRefused(
        page,
        "https://redir.example.com/start",
      );
      expect(navigations.at(-1)?.error).toBe(SECURITY);
    });

    test("a hop refused after goto already committed still gets the security message", async () => {
      const page = await browserPage();
      const navigations = await navigateUntilRefused(
        page,
        "https://hop1.example.com/",
      );
      expect(navigations[0]?.ok).toBe(true);
      expect(navigations.at(-1)).toMatchObject({ ok: false, error: SECURITY });
    });
  },
);
