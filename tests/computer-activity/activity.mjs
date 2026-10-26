// CB-101 验收：计算机活动面板。真浏览器 × 4 个尺寸 × web / pc 两种外壳。
// BASE=http://127.0.0.1:3210 BOT=<id> DATABASE_URL=… OUT=… node tests/computer-activity/activity.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const base = process.env.BASE || "http://127.0.0.1:3210";
const bot = process.env.BOT;
const out = process.env.OUT || "/workspace/cb-reqs/CB-101/after";
const repo = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
fs.mkdirSync(out, { recursive: true });
const SIZES = [
  [360, 800],
  [390, 844],
  [768, 1024],
  [1280, 800],
];
const MODES = ["web", "pc"];
// 一张 1280×800 的灰色 PNG 太大，用 16×10 的放大显示就够了：预览只要「有画面」。
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAA7N+mxAAAAFklEQVR4nGP8//8/AymAiST1oxpGNQAAkfMDEaoCq5oAAAAASUVORK5CYII=";

const seed = (phase) =>
  execFileSync("bun", ["tests/computer-activity/seed.ts", phase], {
    cwd: repo,
    env: { ...process.env, BOT: bot },
    stdio: "inherit",
  });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];

let channelId = "new";
const narrow = (width) => width < 768;

async function open(
  mode,
  [width, height],
  { live = false, watch = true, tab = "activity" } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 1,
    isMobile: false,
  });
  if (mode === "pc") {
    await context.addInitScript(() => {
      const noop = () => () => undefined;
      window.chisabotWindow = {
        platform: "win32",
        minimize() {},
        toggleMaximize() {},
        close() {},
        isMaximized: async () => false,
        onMaximizedChange: noop,
        toggleCompact() {},
        isCompact: async () => false,
        onCompactChange: noop,
      };
      window.chisabotPC = {
        state: async () => ({}),
        setLocal: async () => ({}),
        checkUpdate: async () => ({}),
        installUpdate: async () => ({}),
        pickFolders: async () => [],
        enroll: async () => ({}),
        reconnect: async () => ({}),
        logout: async () => ({}),
        onChange: noop,
      };
    });
  }
  await context.route("**/api/computers/*/status", (route) =>
    route.fulfill({ json: { botId: bot, state: "ready" } }),
  );
  await context.route("**/api/computers/*/screenshot*", (route) =>
    live
      ? route.fulfill({
          status: 503,
          json: { error: "capture busy", captureBusy: true, liveCast: true },
        })
      : route.fulfill({
          json: {
            base64: PNG,
            url: "https://example.com/",
            title: "Example Domain",
            width: 1280,
            height: 800,
          },
        }),
  );
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // 先停在 about:blank：按返回离开了对话页能看出来（落回 about:blank）。
  await page.goto("about:blank");
  await page.goto(
    `${base}/channel/${channelId}?agent=${bot}${watch ? "&watch=true" : ""}`,
    { waitUntil: "domcontentloaded" },
  );
  if (!watch) {
    await page
      .locator("[data-jump-activity]")
      .first()
      .waitFor({ timeout: 45_000 });
    return { context, page, pageErrors };
  }
  await page
    .locator(".activity-log")
    .first()
    .waitFor({ state: "attached", timeout: 45_000 });
  // 窄屏默认「画面」，要看活动先切过去（切换不走路由）。
  if (narrow(width) && tab === "activity")
    await page.locator('.computer-mobile-tab[data-tab="activity"]').click();
  if (!narrow(width) || tab === "activity")
    await page.locator(".activity-log").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  return { context, page, pageErrors };
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [];
    if (doc.scrollWidth > doc.clientWidth + 1)
      offenders.push(`document ${doc.scrollWidth}>${doc.clientWidth}`);
    for (const element of document.querySelectorAll(
      ".activity-log, .activity-scroll, .activity-step, .computer-status",
    )) {
      const rect = element.getBoundingClientRect();
      if (rect.width && element.scrollWidth > element.clientWidth + 1)
        offenders.push(
          `${element.className} ${element.scrollWidth}>${element.clientWidth}`,
        );
      if (rect.right > window.innerWidth + 1)
        offenders.push(
          `${element.className} right ${Math.round(rect.right)}>${window.innerWidth}`,
        );
    }
    return offenders;
  });
}

try {
  const me = await (await fetch(`${base}/api/me`)).json();
  await fetch(`${base}/api/me/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  await fetch(`${base}/api/me/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "活动验收" }),
  });
  process.env.USER_ID = me.user.id;
  const created = await (
    await fetch(`${base}/api/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [bot] }),
    })
  ).json();
  channelId = created.channel.id;
  process.env.THREAD = created.channel.threadId;

  for (const mode of MODES) {
    for (const size of SIZES) {
      const label = `${mode}-${size[0]}x${size[1]}`;
      seed("history");
      const { context, page, pageErrors } = await open(mode, size);
      const log = page.locator(".activity-log").first();
      const text = await log.innerText();
      // 合并命令
      assert.match(text, /运行了 4 条命令/, `${label}: merged commands`);
      // 失败的命令不并进去，单独显示「失败 · 退出码 1」
      assert.match(
        text,
        /失败 · 退出码 1/,
        `${label}: failed command on its own`,
      );
      // 拒绝：给人看的状态，不显示给模型的原文
      assert.match(text, /已拒绝：电脑当前由你控制/, `${label}: refused state`);
      assert.doesNotMatch(
        text,
        /接管|没有执行/,
        `${label}: no model-facing text`,
      );
      // 打码：URL 里的 token、密码框里的字、人自己输入的内容
      assert.doesNotMatch(
        text,
        /SECRET123|hunter2|私人内容/,
        `${label}: masking`,
      );
      assert.match(
        text,
        /token=••••/,
        `${label}: masked token visible as ••••`,
      );
      assert.match(text, /你\s*输入了文字/, `${label}: human step labelled 你`);
      // 组头是你那句话
      assert.match(text, /帮我看看 example\.com/, `${label}: turn prompt`);
      await page.screenshot({ path: path.join(out, `${label}.png`) });

      // 展开合并的那行：4 条命令逐条可见
      await log.locator("[data-activity-batch] > button").first().click();
      assert.equal(
        await log
          .locator("[data-activity-batch] .activity-batch-list > li")
          .count(),
        4,
        `${label}: batch expands`,
      );

      // 淡入且不跳：先往下滚，记住眼前那一行的位置，再来一条新记录
      const scroller = log.locator(".activity-scroll");
      const scrollable = await scroller.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 40,
      );
      assert(scrollable, `${label}: activity list scrolls`);
      await scroller.evaluate((element) => {
        element.scrollTop = 160;
        element.dispatchEvent(new Event("scroll"));
      });
      await page.waitForTimeout(300);
      const anchor = await scroller.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll("[data-activity-step]")].find(
          (r) => r.getBoundingClientRect().top >= top,
        );
        return {
          id: row?.getAttribute("data-activity-step"),
          y: row?.getBoundingClientRect().top,
        };
      });
      seed("live");
      await log.locator(".activity-unseen").waitFor({ timeout: 10_000 });
      const after = await page.evaluate(
        (id) =>
          document
            .querySelector(`[data-activity-step="${id}"]`)
            ?.getBoundingClientRect().top,
        anchor.id,
      );
      const jump = Math.abs((after ?? 0) - (anchor.y ?? 0));
      assert(jump <= 2, `${label}: scroll stayed put (moved ${jump}px)`);
      const unseen = await log.locator(".activity-unseen").innerText();
      assert.match(unseen, /条新记录/);
      await log.locator(".activity-unseen").click();
      await page.waitForTimeout(500);
      const freshCount = await log.locator(".activity-step.is-fresh").count();
      assert(freshCount >= 1, `${label}: new entry highlighted`);
      const liveText = await log.innerText();
      assert.match(
        liveText,
        /example\.org\/login\?code=••••/,
        `${label}: live URL masked`,
      );
      assert.doesNotMatch(liveText, /OTP999/);
      await page.screenshot({ path: path.join(out, `${label}-fresh.png`) });
      const offenders = await overflow(page);
      await context.close();

      // 大屏直播：预览让路，状态行说清楚
      const liveRun = await open(mode, size, { live: true });
      await liveRun.page
        .locator(".computer-status[data-casting]")
        .waitFor({ timeout: 15_000 });
      const status = await liveRun.page
        .locator(".computer-status")
        .first()
        .innerText();
      assert.match(status, /画面正在大屏直播/, `${label}: live-cast status`);
      if (size[0] === 1280 || size[0] === 390)
        await liveRun.page.screenshot({
          path: path.join(out, `${label}-live.png`),
        });
      const liveOffenders = await overflow(liveRun.page);
      await liveRun.context.close();

      // 对话 → 活动记录：面板没开（不带 watch）时点聊天里的「在活动里看」，面板打开、窄屏切到「活动」、那一步高亮。
      seed("history");
      const jumpRun = await open(mode, size, { watch: false });
      await jumpRun.page
        .locator('[data-jump-activity="cb101-read-call"]')
        .first()
        .click();
      const target = jumpRun.page.locator(
        '.activity-step.is-activity-jump[data-tool-call="cb101-read-call"]',
      );
      await target.first().waitFor({ timeout: 15_000 });
      if (narrow(size[0]))
        assert.equal(
          await jumpRun.page
            .locator('.computer-mobile-tab[data-tab="activity"]')
            .getAttribute("aria-selected"),
          "true",
          `${label}: jump switches to 活动`,
        );
      const inView = await target.first().evaluate((row) => {
        const box = row.getBoundingClientRect();
        const scroller = row
          .closest(".activity-scroll")
          ?.getBoundingClientRect();
        return (
          Boolean(scroller) &&
          box.top >= (scroller?.top ?? 0) - 1 &&
          box.bottom <= (scroller?.bottom ?? 0) + 1 &&
          box.bottom <= window.innerHeight
        );
      });
      assert(inView, `${label}: jumped step is scrolled into view`);
      await jumpRun.page.waitForTimeout(250);
      await jumpRun.page.screenshot({
        path: path.join(out, `${label}-jump.png`),
      });
      const jumpOffenders = await overflow(jumpRun.page);
      assert.equal(
        jumpOffenders.length,
        0,
        `${label}: overflow after jump ${JSON.stringify(jumpOffenders)}`,
      );
      await jumpRun.context.close();

      // 桌面端（≥768）：「在活动里看」= 手动在右栏切到「计算机」（push）。按一次返回，两条路径的 URL、history.length、
      // 计算机开没开都一样，而且都还在这个对话里。
      if (!narrow(size[0])) {
        const backState = (page) =>
          page.evaluate(() => ({
            url: location.pathname + location.search,
            len: history.length,
            computer:
              new URLSearchParams(location.search).get("watch") === "true" &&
              Boolean(document.querySelector(".activity-log")),
          }));
        seed("history");
        const viaJump = await open(mode, size, { watch: false });
        const jumpStart = await viaJump.page.evaluate(() => history.length);
        await viaJump.page
          .locator('[data-jump-activity="cb101-read-call"]')
          .first()
          .click();
        await viaJump.page
          .locator(".activity-log")
          .first()
          .waitFor({ state: "attached", timeout: 15_000 });
        assert.equal(
          await viaJump.page.evaluate(() => history.length),
          jumpStart + 1,
          `${label}: desktop jump pushes like a manual switch`,
        );
        await viaJump.page.goBack();
        await viaJump.page.waitForTimeout(1000);
        const jumpBackState = await backState(viaJump.page);
        await viaJump.context.close();

        seed("history");
        const viaHand = await open(mode, size, { watch: false });
        const computerTab = viaHand.page.getByRole("radio", { name: /计算机/ });
        if (
          !(await computerTab
            .first()
            .isVisible()
            .catch(() => false))
        ) {
          await viaHand.page
            .getByRole("button", { name: /打开面板|展开面板|显示面板/ })
            .first()
            .click();
        }
        await computerTab.first().click();
        await viaHand.page
          .locator(".activity-log")
          .first()
          .waitFor({ state: "attached", timeout: 15_000 });
        await viaHand.page.goBack();
        await viaHand.page.waitForTimeout(1000);
        const handBackState = await backState(viaHand.page);
        await viaHand.context.close();

        assert.deepEqual(
          jumpBackState,
          handBackState,
          `${label}: back after jump == back after switching by hand`,
        );
        assert.match(
          jumpBackState.url,
          /^\/channel\//,
          `${label}: back stays on the chat page`,
        );

        // 计算机已经开着时跳转：和手动在同样情况下一样，不多压 history。
        seed("history");
        const alreadyOpen = await open(mode, size);
        const openLen = await alreadyOpen.page.evaluate(() => history.length);
        await alreadyOpen.page.evaluate(() =>
          document
            .querySelector('[data-jump-activity="cb101-read-call"]')
            ?.click(),
        );
        await alreadyOpen.page
          .locator(
            '.activity-step.is-activity-jump[data-tool-call="cb101-read-call"]',
          )
          .first()
          .waitFor({ timeout: 15_000 });
        assert.equal(
          await alreadyOpen.page.evaluate(() => history.length),
          openLen,
          `${label}: jump with the computer open adds no history`,
        );
        await alreadyOpen.context.close();
      }

      // 窄屏（360/390）：「在活动里看」= 手动路径「点把手打开面板（openPanelSheet）→ 抽屉里点『计算机』」。两条路径的 history.length、
      // 第一次 / 第二次返回后的 URL 和抽屉状态逐项一样；抽屉一开始就开着时也一样。
      if (narrow(size[0])) {
        const navState = (page) =>
          page.evaluate(() =>
            location.href.startsWith("about:")
              ? { left: true, len: history.length }
              : {
                  left: false,
                  len: history.length,
                  url:
                    location.pathname.replace(/channel_[^/]+/, "CH") +
                    location.search.replace(/agent=[^&]*&?/, ""),
                  drawer: Boolean(
                    document.querySelector("#chisabot-panel-sheet"),
                  ),
                  computer:
                    new URLSearchParams(location.search).get("watch") ===
                    "true",
                },
          );
        const trace = async (how, drawerFirst) => {
          seed("history");
          const run = await open(mode, size, { watch: false });
          if (drawerFirst) {
            await run.page.getByRole("button", { name: "打开面板" }).click();
            await run.page
              .locator("#chisabot-panel-sheet")
              .waitFor({ timeout: 10_000 });
            await run.page.waitForTimeout(400);
          }
          const steps = { start: await navState(run.page) };
          if (how === "jump") {
            // 抽屉开着时它盖住对话，用 DOM click 触发聊天里那颗按钮（同一个 onClick → requestActivityJump）。
            await run.page.evaluate(() =>
              document
                .querySelector('[data-jump-activity="cb101-read-call"]')
                ?.click(),
            );
            await run.page
              .locator(
                '.computer-mobile-tab[data-tab="activity"][aria-selected="true"]',
              )
              .waitFor({ timeout: 15_000 });
          } else {
            if (!drawerFirst) {
              await run.page.getByRole("button", { name: "打开面板" }).click();
              await run.page
                .locator("#chisabot-panel-sheet")
                .waitFor({ timeout: 10_000 });
            }
            await run.page
              .locator("#chisabot-panel-sheet")
              .getByRole("radio", { name: /计算机/ })
              .click();
            await run.page
              .locator(".computer-mobile-tabs")
              .waitFor({ timeout: 15_000 });
          }
          await run.page.waitForTimeout(1000);
          steps.after = await navState(run.page);
          for (const name of ["back1", "back2"]) {
            if (steps.back1?.left) break;
            await run.page.goBack({ timeout: 5_000 }).catch(() => undefined);
            await run.page.waitForTimeout(1200);
            steps[name] = await navState(run.page);
          }
          await run.context.close();
          return steps;
        };
        {
          // 深链接（?watch=true）进来：抽屉以 restore 打开；第一次返回关抽屉，第二次离开。
          seed("history");
          const run = await open(mode, size, { watch: true });
          await run.page.locator("#chisabot-panel-sheet").waitFor({ timeout: 15_000 });
          await run.page.waitForTimeout(1000);
          const deep = { start: await navState(run.page) };
          for (const name of ["back1", "back2"]) {
            await run.page.goBack({ timeout: 5_000 }).catch(() => undefined);
            await run.page.waitForTimeout(1200);
            deep[name] = await navState(run.page);
            if (deep[name].left) break;
          }
          await run.context.close();
          console.log(`nav ${label} deep link ${JSON.stringify(deep)}`);
          assert.equal(deep.back1.left, false, `${label} (deep link): first back stays`);
          assert.equal(deep.back1.drawer, false, `${label} (deep link): first back closes the drawer`);
          assert.equal(deep.back2?.left, true, `${label} (deep link): second back leaves`);
        }
        for (const drawerFirst of [false, true]) {
          const viaJump = await trace("jump", drawerFirst);
          const viaHand = await trace("manual", drawerFirst);
          const which = drawerFirst ? "drawer already open" : "drawer closed";
          console.log(
            `nav ${label} ${which} jump=${JSON.stringify(viaJump)} manual=${JSON.stringify(viaHand)}`,
          );
          assert.deepEqual(
            viaJump,
            viaHand,
            `${label} (${which}): jump and manual open give the same history / back results`,
          );
          // CB-101 第二阶段：抽屉经由 openPanelSheet 打开，只压它自己那一条；切「计算机」replace。
          assert.equal(
            viaJump.after.len,
            drawerFirst ? viaJump.start.len : viaJump.start.len + 1,
            `${label} (${which}): the drawer adds one entry, switching tabs adds none`,
          );
          assert.equal(viaJump.after.drawer, true, `${label} (${which}): drawer open`);
          assert.equal(viaJump.after.computer, true, `${label} (${which}): computer shown`);
          assert.equal(viaJump.back1.left, false, `${label} (${which}): first back stays on the page`);
          assert.equal(viaJump.back1.drawer, false, `${label} (${which}): first back closes the drawer`);
          assert.equal(viaJump.back2?.left, true, `${label} (${which}): second back leaves`);
        }
      }

      // 窄屏「画面 | 活动」：默认画面；在画面时来了新活动 → 活动标签亮未读点；切过去清掉；切换不加 history。
      let tabErrors = [];
      if (narrow(size[0])) {
        seed("history");
        const tabRun = await open(mode, size, { tab: "screen" });
        const tabs = tabRun.page.locator(".computer-mobile-tabs");
        assert(await tabs.isVisible(), `${label}: segmented tabs visible`);
        assert.equal(
          await tabRun.page
            .locator('.computer-mobile-tab[data-tab="screen"]')
            .getAttribute("aria-selected"),
          "true",
          `${label}: 画面 by default`,
        );
        assert.equal(
          await tabRun.page.locator(".activity-log").first().isVisible(),
          false,
          `${label}: activity hidden on 画面`,
        );
        const before = await tabRun.page.evaluate(() => history.length);
        seed("live");
        await tabRun.page
          .locator('.computer-mobile-tab[data-tab="activity"][data-unread]')
          .waitFor({ timeout: 15_000 });
        await tabRun.page.screenshot({
          path: path.join(out, `${label}-tab-unread.png`),
        });
        await tabRun.page
          .locator('.computer-mobile-tab[data-tab="activity"]')
          .click();
        await tabRun.page
          .locator(".activity-log")
          .first()
          .waitFor({ timeout: 5_000 });
        assert.equal(
          await tabRun.page
            .locator('.computer-mobile-tab[data-tab="activity"][data-unread]')
            .count(),
          0,
          `${label}: unread cleared`,
        );
        await tabRun.page.screenshot({
          path: path.join(out, `${label}-tab-activity.png`),
        });
        await tabRun.page
          .locator('.computer-mobile-tab[data-tab="screen"]')
          .click();
        assert.equal(
          await tabRun.page.evaluate(() => history.length),
          before,
          `${label}: tab switch leaves history alone`,
        );
        const tabOffenders = await overflow(tabRun.page);
        assert.equal(
          tabOffenders.length,
          0,
          `${label}: overflow tabs ${JSON.stringify(tabOffenders)}`,
        );
        tabErrors = tabRun.pageErrors;
        await tabRun.context.close();
      } else {
        // 平板及以上：没有分段标签，画面和活动都在。
        const wide = await open(mode, size);
        assert.equal(
          await wide.page.locator(".computer-mobile-tabs").isVisible(),
          false,
          `${label}: no tabs on wide`,
        );
        tabErrors = wide.pageErrors;
        await wide.context.close();
      }

      const errors = [
        ...pageErrors,
        ...liveRun.pageErrors,
        ...jumpRun.pageErrors,
        ...tabErrors,
      ];
      results.push({
        label,
        overflow: offenders.length + liveOffenders.length,
        offenders: [...offenders, ...liveOffenders],
        pageErrors: errors.length,
        errors,
        scrollJumpPx: jump,
        pass: true,
      });
      assert.equal(
        offenders.length + liveOffenders.length,
        0,
        `${label}: overflow ${JSON.stringify([...offenders, ...liveOffenders])}`,
      );
      assert.equal(
        errors.length,
        0,
        `${label}: page errors ${errors.join(" | ")}`,
      );
      console.log(`ok ${label} jump=${jump}px`);
    }
  }
} finally {
  fs.writeFileSync(
    path.join(out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
