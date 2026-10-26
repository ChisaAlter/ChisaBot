// e2e（CB-098）：竖屏 / 手机网页 / PC 小窗下的左右抽屉、「面板 | 计算机」切换、横向溢出和页面错误。
// 两种模式：web（<768 带触屏 → data-phone）和 pc（注入 window.chisabotWindow 桩 → data-desktop）。
// 只读：除了登录态以外不发任何写请求（非 GET 全部拦掉）。用法见同目录 README.md。
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:3010";
const OUT = process.env.OUT_DIR || "/tmp/mobile-portrait";
const MODES = (process.env.MODES || "web,pc").split(",");
const SIZES = (
  process.env.SIZES || "360x800,378x842,390x844,412x915,768x1024,1280x800"
)
  .split(",")
  .map((s) => s.split("x").map(Number));
const CHANNEL = process.env.CHANNEL; // 可选：一条已有会话的 id（/channel/<id>）
const ROUTES = process.env.ROUTES
  ? process.env.ROUTES.split(",")
  : [
      "/channel/new",
      ...(CHANNEL ? [`/channel/${CHANNEL}`] : []),
      "/bots",
      "/approvals",
      "/reachability",
      "/settings",
      "/settings/skills",
      "/settings/memory",
      "/settings/schedules",
      "/admin/models",
      "/admin/plugins",
      "/admin/audit",
    ];
const EDGE = 24; // 抽屉离视口另一边至少留这么多（实现是 100vw - 48px）
const exe =
  process.env.CHROME ||
  ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) =>
    fs.existsSync(p),
  ) ||
  (() => {
    const d = fs.existsSync("/ms-playwright")
      ? fs
          .readdirSync("/ms-playwright")
          .find((x) => x.startsWith("chromium-") && !x.includes("headless"))
      : null;
    return d ? `/ms-playwright/${d}/chrome-linux64/chrome` : undefined;
  })();
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const results = [];
const check = (ok, msg) => {
  if (!ok) {
    fails.push(msg);
    console.log("FAIL", msg);
  }
  return ok;
};

const desktopStub = () => {
  window.chisabotWindow = {
    platform: "win32",
    minimize() {},
    toggleMaximize() {},
    close() {},
    isMaximized: async () => false,
    onMaximizedChange() {
      return () => {};
    },
    toggleCompact() {},
    isCompact: async () => true,
    onCompactChange() {
      return () => {};
    },
  };
};

/* 页面里跑的几何工具（字符串注入，避免闭包）。Chromium 的可拖动区 = 所有 app-region:drag 盒的并集减去 no-drag 盒，不看层叠。 */
const GEO = `(() => {
  const region = (el) => { const cs = getComputedStyle(el); return cs.webkitAppRegion || cs.getPropertyValue("app-region") || ""; };
  const boxes = (kind) => [...document.querySelectorAll("*")].filter((el) => region(el) === kind && getComputedStyle(el).display !== "none").map((el) => el.getBoundingClientRect()).filter((b) => b.width && b.height);
  const inside = (b, x, y) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  window.__geo = {
    drag(x, y) { return boxes("drag").some((b) => inside(b, x, y)) && !boxes("no-drag").some((b) => inside(b, x, y)); },
    inNoDrag(x, y) { return boxes("no-drag").some((b) => inside(b, x, y)); },
    hits(el) { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const t = document.elementFromPoint(x, y); return { x, y, ok: !!t && (el === t || el.contains(t)), hit: t ? t.tagName.toLowerCase() + "." + String(t.className).slice(0, 40) : null }; },
  };
})()`;

const leftSel = '[data-slot="sidebar"][data-mobile="true"]';
const isOpen = (page, sel) =>
  page.evaluate((s) => !!document.querySelector(s), sel);
const waitClosed = (page, sel) =>
  page
    .waitForFunction((s) => !document.querySelector(s), sel, { timeout: 3000 })
    .then(
      () => true,
      () => false,
    );
const waitOpen = (page, sel) =>
  page
    .waitForSelector(sel, { timeout: 3000 })
    .then(() => page.waitForTimeout(350))
    .then(
      () => true,
      () => false,
    );

async function drawerChecks(page, sel, _tag, mode, _w, _h) {
  return page.evaluate(
    ({ sel, mode, EDGE }) => {
      const d = document.querySelector(sel);
      const b = d.getBoundingClientRect();
      const past = [...d.querySelectorAll("*")]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width && r.right > b.right + 0.5;
        })
        .map(
          (e) =>
            `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`,
        );
      const controls = [
        ...d.querySelectorAll("button, a[href], input, [role=radio]"),
      ].filter(
        (e) =>
          e.getBoundingClientRect().width &&
          getComputedStyle(e).visibility !== "hidden",
      );
      const blocked = [];
      const dragged = [];
      for (const e of controls) {
        e.scrollIntoView({ block: "center", inline: "nearest" });
        const hit = window.__geo.hits(e);
        const name = (
          e.getAttribute("aria-label") ||
          e.textContent ||
          e.tagName
        )
          .trim()
          .slice(0, 16);
        if (!hit.ok) blocked.push(`${name}→${hit.hit}`);
        if (
          mode === "pc" &&
          (window.__geo.drag(hit.x, hit.y) ||
            !window.__geo.inNoDrag(hit.x, hit.y))
        )
          dragged.push(name);
      }
      return {
        left: b.left,
        right: b.right,
        width: b.width,
        vw: innerWidth,
        fits: b.left >= 0 && b.right <= innerWidth - EDGE + 0.5,
        past,
        controls: controls.length,
        blocked,
        dragged,
      };
    },
    { sel, mode, EDGE },
  );
}

async function closeVariants(page, sel, open, closeBtnSel, _w, h, rec, key) {
  const out = {};
  // 1. 关闭按钮
  if (await open()) {
    const btn = page.locator(`${sel} ${closeBtnSel}`).first();
    out.button =
      (await btn.count()) > 0 &&
      (await btn.click({ timeout: 2000 }).then(
        () => waitClosed(page, sel),
        () => false,
      ));
  }
  // 2. Esc
  if (await open()) {
    await page.keyboard.press("Escape");
    out.esc = await waitClosed(page, sel);
  }
  // 3. 遮罩（中间，和顶部 20px —— PC 上原来是拖动区）
  for (const [name, y] of [
    ["backdropMid", h / 2],
    ["backdropTop", 20],
  ]) {
    if (await open()) {
      // 在这一行上找一个确实落在遮罩上的点（PC 右上角那排窗口按钮在遮罩之上，不算遮罩）。
      const x = await page.evaluate((y) => {
        for (let x = 4; x < innerWidth; x += 4) {
          if (
            document.elementFromPoint(x, y)?.getAttribute("data-slot") ===
            "sheet-overlay"
          )
            return x;
        }
        return null;
      }, y);
      if (x === null) {
        out[name] = true;
        out[`${name}Geo`] = "这一行没有露出的遮罩";
        await page.keyboard.press("Escape");
        await waitClosed(page, sel);
        continue;
      }
      const geo = await page.evaluate(
        ([x, y]) => ({
          drag: window.__geo.drag(x, y),
          hit: document.elementFromPoint(x, y)?.getAttribute("data-slot"),
        }),
        [x, y],
      );
      await page.mouse.click(x, y);
      out[name] = (await waitClosed(page, sel)) && !geo.drag;
      out[`${name}Geo`] = geo;
    }
  }
  // 4. window.__chisabotBack()
  if (await open()) {
    out.backTrue = await page.evaluate(
      () => window.__chisabotBack?.() === true,
    );
    out.backClosed = await waitClosed(page, sel);
    out.backFalse = await page.evaluate(
      () => window.__chisabotBack?.() === false,
    );
  }
  rec[key] = out;
  for (const k of [
    "button",
    "esc",
    "backdropMid",
    "backdropTop",
    "backTrue",
    "backClosed",
    "backFalse",
  ])
    check(
      out[k] === true,
      `${rec.tag} ${key} 关闭方式 ${k} (${JSON.stringify(out[`${k}Geo`] ?? out[k])})`,
    );
}

const browser = await chromium.launch({
  headless: true,
  executablePath: exe,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
for (const mode of MODES) {
  for (const [w, h] of SIZES) {
    const narrow = w < 768;
    const sheetWidth = w < 1280;
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      hasTouch: mode === "web" && narrow,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    if (mode === "pc") await ctx.addInitScript(desktopStub);
    await ctx.route("**/*", (r) =>
      ["GET", "HEAD", "OPTIONS"].includes(r.request().method()) ||
      (r.request().url().includes("/api/channels/") &&
        r.request().url().endsWith("/activity"))
        ? r.continue()
        : r.fulfill({ status: 204, body: "" }),
    );
    for (const route of ROUTES) {
      const tag = `${mode}-${w}x${h}${route.replaceAll("/", "_")}`;
      const rec = { tag, mode, size: `${w}x${h}`, route };
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
      try {
        await page.goto(BASE + route, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(1800);
        await page.evaluate(GEO);
        rec.finalUrl = new URL(page.url()).pathname;
        rec.overflowX = await page.evaluate(() =>
          Math.max(
            0,
            document.documentElement.scrollWidth - innerWidth,
            document.body.scrollWidth - innerWidth,
          ),
        );
        check(rec.overflowX === 0, `${tag} 横向溢出 ${rec.overflowX}px`);
        await page.screenshot({ path: `${OUT}/${tag}.png` });

        if (narrow) {
          const opener = page
            .locator('.glass-topbar button[aria-label^="打开"]')
            .first();
          const open = async () => {
            if (await isOpen(page, leftSel)) return true;
            await opener.click({ timeout: 3000 }).catch(() => {});
            return waitOpen(page, leftSel);
          };
          if (
            check(
              (await opener.count()) > 0 && (await open()),
              `${tag} 左抽屉能打开`,
            )
          ) {
            await page.evaluate(GEO);
            rec.left = await drawerChecks(page, leftSel, tag, mode, w, h);
            check(
              rec.left.fits,
              `${tag} 左抽屉宽度不超视口 (${rec.left.left}..${rec.left.right} / ${w})`,
            );
            check(
              rec.left.past.length === 0,
              `${tag} 左抽屉内容伸出框外 ${rec.left.past.slice(0, 3).join(" ")}`,
            );
            check(
              rec.left.blocked.length === 0,
              `${tag} 左抽屉控件被挡 ${rec.left.blocked.slice(0, 4).join(" | ")}`,
            );
            if (mode === "pc")
              check(
                rec.left.dragged.length === 0,
                `${tag} 左抽屉控件落在拖动区 ${rec.left.dragged.join(",")}`,
              );
            await page.screenshot({ path: `${OUT}/${tag}-left.png` });
            await closeVariants(
              page,
              leftSel,
              open,
              '[data-testid="sidebar-drawer-close"]',
              w,
              h,
              rec,
              "leftClose",
            );
            if (mode === "web" && narrow) {
              // 手机网页：浏览器「返回」先关抽屉，不离开页面；按钮关闭后历史长度复原（不污染历史、不多退）。
              const before = await page.evaluate(() => ({
                len: history.length,
                url: location.href,
              }));
              await open();
              await page.waitForTimeout(200);
              await page
                .locator(`${leftSel} [data-testid="sidebar-drawer-close"]`)
                .click();
              await waitClosed(page, leftSel);
              await page.waitForTimeout(300);
              const afterBtn = await page.evaluate(() => ({
                len: history.length,
                url: location.href,
                marker: !!history.state?.__cbOverlay,
              }));
              await open();
              await page.waitForTimeout(200);
              await page.goBack();
              const closedByBack = await waitClosed(page, leftSel);
              await page.waitForTimeout(300);
              const afterBack = await page.evaluate(() => location.href);
              rec.history = { before, afterBtn, closedByBack, afterBack };
              check(
                !afterBtn.marker && afterBtn.url === before.url,
                `${tag} 按钮关闭后历史顶上不留抽屉记录 ${JSON.stringify(afterBtn)}`,
              );
              check(
                closedByBack && afterBack === before.url,
                `${tag} 浏览器返回先关抽屉、不离开页面 (${afterBack})`,
              );
            }
          }
        }

        const railTab = page.locator(".rail-tab.is-narrow").first();
        if (sheetWidth && (await railTab.isVisible().catch(() => false))) {
          const sel = ".rail-sheet";
          const open = async () => {
            if (await isOpen(page, sel)) return true;
            await page
              .locator(".rail-tab.is-narrow")
              .first()
              .click({ timeout: 3000 })
              .catch(() => {});
            return waitOpen(page, sel);
          };
          if (check(await open(), `${tag} 右抽屉能打开`)) {
            await page.evaluate(GEO);
            rec.right = await drawerChecks(page, sel, tag, mode, w, h);
            check(
              rec.right.left >= 0 && rec.right.right <= w,
              `${tag} 右抽屉宽度不超视口 (${rec.right.left}..${rec.right.right})`,
            );
            check(
              rec.right.blocked.length === 0,
              `${tag} 右抽屉控件被挡 ${rec.right.blocked.slice(0, 4).join(" | ")}`,
            );
            if (mode === "pc")
              check(
                rec.right.dragged.length === 0,
                `${tag} 右抽屉控件落在拖动区 ${rec.right.dragged.join(",")}`,
              );
            const tabs = page.locator(`${sel} .rail-tabs-item`);
            if ((await tabs.count()) === 2) {
              rec.tabsGeo = await page.evaluate(() =>
                [
                  ...document.querySelectorAll(".rail-sheet .rail-tabs-item"),
                ].map((e) => {
                  const h = window.__geo.hits(e);
                  return {
                    t: e.textContent.trim(),
                    hit: h.ok,
                    drag: window.__geo.drag(h.x, h.y),
                    noDrag: window.__geo.inNoDrag(h.x, h.y),
                  };
                }),
              );
              for (const t of rec.tabsGeo) {
                check(t.hit, `${tag} 分段器「${t.t}」中心点被挡`);
                if (mode === "pc")
                  check(
                    !t.drag && t.noDrag,
                    `${tag} 分段器「${t.t}」在拖动区里 / 不在 no-drag 区 ${JSON.stringify(t)}`,
                  );
              }
              await tabs
                .filter({ hasText: "计算机" })
                .click({ timeout: 2000 })
                .catch(() => {});
              await page.waitForTimeout(400);
              const toComputer = await page.evaluate(() =>
                document
                  .querySelector(".rail-sheet .rail-tabs")
                  ?.getAttribute("data-tab"),
              );
              await page
                .locator(`${sel} .rail-tabs-item`)
                .filter({ hasText: "面板" })
                .click({ timeout: 2000 })
                .catch(() => {});
              await page.waitForTimeout(400);
              const toPanels = await page.evaluate(() =>
                document
                  .querySelector(".rail-sheet .rail-tabs")
                  ?.getAttribute("data-tab"),
              );
              rec.tabSwitch = { toComputer, toPanels };
              check(
                toComputer === "computer" && toPanels === "panels",
                `${tag} 「面板 / 计算机」切换 ${JSON.stringify(rec.tabSwitch)}`,
              );
            }
            await page.screenshot({ path: `${OUT}/${tag}-right.png` });
            await closeVariants(
              page,
              sel,
              open,
              '[data-testid="panel-sheet-close"]',
              w,
              h,
              rec,
              "rightClose",
            );
          }
        }
      } catch (e) {
        check(false, `${tag} 异常 ${String(e.message).split("\n")[0]}`);
      }
      rec.pageErrors = errors;
      check(
        errors.length === 0,
        `${tag} pageErrors ${errors.slice(0, 2).join(" | ")}`,
      );
      results.push(rec);
      await page.close();
      console.log(
        JSON.stringify({
          tag,
          overflowX: rec.overflowX,
          left: rec.left && { w: rec.left.width, fits: rec.left.fits },
          right: rec.right && { w: rec.right.width },
          tabs: rec.tabSwitch,
          errs: errors.length,
        }),
      );
    }
    await ctx.close();
  }
}
/*
 * CB-098 QA 回归：窄屏手机网页在 /channel/new 打开右栏抽屉，切「计算机」再切回「面板」，之后连续返回
 * 必须最多 2 次就离开页面（以前切标签 push 了 `watch`，返回时抽屉被地址拉回来、又压一条记录，死循环）。
 */
const TAB_BACK_SIZES = (process.env.TAB_BACK_SIZES || "390x844,360x800")
  .split(",")
  .map((s) => s.split("x").map(Number));
if (MODES.includes("web")) {
  for (const [w, h] of TAB_BACK_SIZES) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    const tag = `web-${w}x${h}-tab-then-back`;
    const rec = { tag, mode: "web", size: `${w}x${h}`, route: "/channel/new" };
    try {
      await page.goto("about:blank");
      await page.goto(`${BASE}/channel/new`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".rail-tab.is-narrow", { timeout: 20000 });
      await page.waitForTimeout(1500);
      await page.click(".rail-tab.is-narrow");
      await page.waitForSelector(".rail-sheet .rail-tabs-item");
      await page.waitForTimeout(600);
      await page.locator(".rail-sheet .rail-tabs-item").nth(1).click();
      await page.waitForTimeout(800);
      await page.locator(".rail-sheet .rail-tabs-item").nth(0).click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/${tag}-before-back.png` });
      const trail = [];
      let backs = 0;
      for (; backs < 10; ) {
        await page.goBack().catch(() => {});
        backs += 1;
        await page.waitForTimeout(900);
        const url = page.url();
        const drawer = url.startsWith(BASE)
          ? await page.evaluate(() => !!document.querySelector(".rail-sheet")).catch(() => null)
          : null;
        trail.push({ url: url.replace(BASE, ""), drawer });
        if (!url.startsWith(BASE)) break;
      }
      rec.tabThenBack = { backs, left: !page.url().startsWith(BASE), trail };
      check(
        rec.tabThenBack.left && backs <= 2,
        `${tag} 切标签后返回 ${backs} 次${rec.tabThenBack.left ? "离开" : "仍未离开"}页面（应 ≤ 2）`,
      );
    } catch (e) {
      check(false, `${tag} 异常 ${String(e.message).split("\n")[0]}`);
    }
    results.push(rec);
    console.log(JSON.stringify({ tag, tabThenBack: rec.tabThenBack && { backs: rec.tabThenBack.backs, left: rec.tabThenBack.left } }));
    await ctx.close();
  }
}
/*
 * CB-098 QA 第二轮：用返回关掉抽屉后马上（150ms / 400ms）又点开，再按返回必须先关抽屉、留在页面上。
 * 左右两个抽屉，360 / 378 / 390 三个宽度。
 */
const REOPEN_SIZES = (process.env.REOPEN_SIZES || "360x800,378x842,390x844")
  .split(",")
  .map((s) => s.split("x").map(Number));
const DRAWERS = [
  { name: "left", open: '.glass-topbar button[aria-label^="打开"]', sel: '[data-slot="sidebar"][data-mobile="true"]' },
  { name: "right", open: ".rail-tab.is-narrow", sel: ".rail-sheet" },
];
if (MODES.includes("web")) {
  for (const [w, h] of REOPEN_SIZES) {
    for (const d of DRAWERS) {
      for (const delay of [150, 400]) {
        const ctx = await browser.newContext({
          viewport: { width: w, height: h },
          isMobile: true,
          hasTouch: true,
        });
        const page = await ctx.newPage();
        const tag = `web-${w}x${h}-${d.name}-back-reopen-${delay}ms`;
        const rec = { tag, mode: "web", size: `${w}x${h}`, route: "/channel/new" };
        try {
          await page.goto("about:blank");
          await page.goto(`${BASE}/channel/new`, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(d.open, { timeout: 20000 });
          await page.waitForTimeout(1500);
          await page.click(d.open);
          await page.waitForSelector(d.sel);
          await page.waitForTimeout(500);
          // 从返回那一刻起算 delay，并用 DOM click 立刻点（Playwright 的 click 本身要好几百毫秒）。
          const t0 = Date.now();
          await page.evaluate(() => history.back());
          await page.waitForSelector(d.sel, { state: "detached", timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(Math.max(0, delay - (Date.now() - t0)));
          rec.reopenAfterMs = Date.now() - t0;
          await page.evaluate((sel) => document.querySelector(sel)?.click(), d.open);
          await page.waitForSelector(d.sel);
          await page.waitForTimeout(300);
          await page.goBack().catch(() => {});
          await page.waitForTimeout(900);
          const stayed = page.url().startsWith(BASE);
          const drawerOpen = stayed
            ? await page.evaluate((sel) => !!document.querySelector(sel), d.sel).catch(() => null)
            : null;
          await page.screenshot({ path: `${OUT}/${tag}.png` }).catch(() => {});
          rec.backReopen = { stayed, drawerOpen };
          check(stayed && drawerOpen === false, `${tag} 重开后返回：${stayed ? (drawerOpen ? "抽屉没关" : "ok") : "直接离开了页面"}`);
        } catch (e) {
          check(false, `${tag} 异常 ${String(e.message).split("\n")[0]}`);
        }
        results.push(rec);
        console.log(JSON.stringify({ tag, reopenAfterMs: rec.reopenAfterMs, backReopen: rec.backReopen }));
        await ctx.close();
      }
    }
  }
}
await browser.close();
fs.writeFileSync(
  `${OUT}/results.json`,
  JSON.stringify({ fails, results }, null, 1),
);
console.log(`\n${results.length} 页，${fails.length} 项失败`);
process.exit(fails.length ? 1 : 0);
