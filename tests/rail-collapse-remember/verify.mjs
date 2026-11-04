// 实机回归（收起右栏 / 关抽屉不再清「计算机」标签）：真实浏览器 + 真实 app 代码，
// 只把 /api 换成最小桩（无 postgres 环境）。非 GET 一律拦掉，不写任何数据。
//
// 场景 = 用户报的原路径：切「计算机」→ 收起 / 关闭 → 重开，断言还停在「计算机」。
//   - 1280 宽窗口：「收起右栏」按钮 → 「展开面板」把手
//   - 390 窄窗口抽屉：「关闭面板」按钮 → 「打开面板」把手
//
// BASE 指向任意跑着这套前端的地址（默认 vite dev :3010）：
//   BASE=http://127.0.0.1:3010 node tests/rail-collapse-remember/verify.mjs
import fs from "node:fs";
import { chromium } from "playwright-core";

const base = process.env.BASE || "http://127.0.0.1:3010";
const BOT = "bot-verify-1";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fails = [];
const check = (ok, msg) => {
  log(ok ? "PASS" : "FAIL", msg);
  if (!ok) fails.push(msg);
};
const errors = [];

const agent = {
  id: BOT,
  name: "验证机器人",
  title: "验证",
  roleDescription: "",
  avatarSeed: "v",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

// /api 最小桩：登录、机器人、会话列表、面板；其余 GET 一律 404，非 GET 一律 204。
async function stub(p) {
  await p.route("**/api/**", (route) => {
    const req = route.request();
    if (req.method() !== "GET") return route.fulfill({ status: 204, body: "" });
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/me")
      return json({
        user: {
          id: "u1",
          email: "t@t",
          name: "验证",
          role: "admin",
          onboarding: null,
        },
      });
    if (path === "/api/agents") return json({ agents: [agent] });
    if (path === `/api/agents/${BOT}`) return json(agent);
    if (path === "/api/agents/capabilities")
      return json({ builtInAvailable: true });
    if (path === "/api/channels" || path.startsWith("/api/channels?"))
      return json({ channels: [], nextCursor: null });
    if (path === "/api/live-panels") return json({ items: [] });
    if (path === "/api/settings/preferences")
      return json({ preferences: { mainBotId: BOT } });
    if (path === "/api/capabilities") return json({ authProviders: [] });
    if (path === "/api/version") return json({ commit: "stub-verify" });
    if (path.endsWith("/control")) return json({ holder: "agent" });
    return json({ error: "stub" }, 404);
  });
}

const radios = (p) =>
  p.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[role="radiogroup"][aria-label="右栏内容"] [role="radio"]',
      ),
    ].map((r) => ({
      t: r.textContent.trim(),
      on: r.getAttribute("aria-checked"),
    })),
  );
const url = (p) => p.evaluate(() => location.pathname + location.search);
const onComputer = (rs) => rs.find((r) => r.t === "计算机")?.on === "true";
const clickRadio = async (p, name) =>
  p
    .locator('[role="radiogroup"][aria-label="右栏内容"] [role="radio"]', {
      hasText: name,
    })
    .click();

const exe = (() => {
  const dir = `${process.env.LOCALAPPDATA}\\ms-playwright`;
  if (fs.existsSync(dir)) {
    const hit = fs
      .readdirSync(dir)
      .find((x) => x.startsWith("chromium-") && !x.includes("headless"));
    if (hit) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const p = `${dir}\\${hit}\\${sub}\\chrome.exe`;
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return process.env.CHROME;
})();

const browser = await chromium.launch({
  headless: true,
  executablePath: exe,
  args: ["--no-sandbox"],
});
const OUT = `${process.env.OUT_DIR || "C:/AI/ChisaBot/.qa"}/rail-collapse-remember`;
fs.mkdirSync(OUT, { recursive: true });

async function page(width, mobile = false) {
  const ctx = await browser.newContext({
    viewport: { width, height: 860 },
    locale: "zh-CN",
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await stub(p);
  await p.addInitScript(() => {
    window.__pops = [];
    window.addEventListener("popstate", () => {
      window.__pops.push(JSON.parse(JSON.stringify(history.state ?? null)));
    });
  });
  return p;
}

const chat = `${base}/channel/new?agent=${BOT}&topic=new`;

// ---- 宽窗口：收起右栏 → 展开 ----
{
  const p = await page(1280);
  await p.goto(chat, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[aria-label="收起右栏"]', { timeout: 30000 });
  await clickRadio(p, "计算机");
  await p.waitForTimeout(1500);
  check(
    (await url(p)).includes("watch=true"),
    "1280: 切「计算机」地址带 watch=true",
  );
  check(onComputer(await radios(p)), "1280: 「计算机」选中");
  await p.locator('[aria-label="收起右栏"]').click();
  await p.waitForTimeout(800);
  check(
    (await p.locator('[aria-label="展开面板"]').count()) > 0,
    "1280: 右栏收起，把手出现",
  );
  await p.locator('[aria-label="展开面板"]').first().click();
  await p.waitForTimeout(1200);
  check(onComputer(await radios(p)), "1280: 展开后仍停在「计算机」");
  check((await url(p)).includes("watch=true"), "1280: 地址仍有 watch=true");
  await p.screenshot({ path: `${OUT}/1280-reopened.png` });
  await p.context().close();
}

// ---- 窄窗口抽屉：关闭面板 → 打开 ----
{
  const p = await page(390, true);
  await p.goto(chat, { waitUntil: "domcontentloaded" });
  await p.waitForSelector(".rail-tab.is-narrow", { timeout: 30000 });
  await p.locator(".rail-tab.is-narrow").first().click();
  await p.waitForSelector('[aria-label="关闭面板"]', { timeout: 15000 });
  await clickRadio(p, "计算机");
  await p.waitForTimeout(1500);
  check(
    (await url(p)).includes("watch=true"),
    "390: 切「计算机」地址带 watch=true",
  );
  check(onComputer(await radios(p)), "390: 「计算机」选中");
  await p.locator('[data-testid="panel-sheet-close"]').click();
  await p.waitForTimeout(1200);
  check(
    (await p.locator('[aria-label="关闭面板"]').count()) === 0,
    "390: 抽屉已关",
  );
  log(
    "390 diag after-close:",
    await p.evaluate(() => ({
      url: location.pathname + location.search,
      state: history.state,
      mem: localStorage.getItem("chisabot-ui-memory:v1"),
      pops: window.__pops,
    })),
  );
  await p.locator(".rail-tab.is-narrow").first().click();
  await p.waitForSelector('[aria-label="关闭面板"]', { timeout: 15000 });
  await p.waitForTimeout(800);
  log(
    "390 diag after-reopen:",
    await p.evaluate(() => ({
      url: location.pathname + location.search,
      state: history.state,
      mem: localStorage.getItem("chisabot-ui-memory:v1"),
    })),
  );
  check(onComputer(await radios(p)), "390: 重开抽屉仍停在「计算机」");
  await p.screenshot({ path: `${OUT}/390-reopened.png` });
  await p.context().close();
}

log("pageerrors", errors.length, JSON.stringify(errors.slice(0, 5)));
log(fails.length ? `RESULT FAIL ${fails.length}` : "RESULT PASS");
await browser.close();
process.exit(fails.length ? 1 : 0);
