// 性能模式下头像是不是真的不动了（DESIGN.md §81）：run.ts 打包好 harness.html 后用 Node 调起（`run.ts <输出目录> perf`）。
// 对两个场景（左栏 24 个头像里 3 个在干活 + 3 个在想 + 1 个选中；四种状态各一个 120px）分别量：
//   关 → 开 → 再关，每一段记 document.getAnimations() 里落在头像（.sa）上的、正在跑的 CSS 动画 / 过渡，
//   变形循环的帧数（avatar-morph 的 morphStats.frames），以及页面上所有 requestAnimationFrame 调用数（含 motion 的弹簧）。
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const out = resolve(process.argv[2]);
const url = pathToFileURL(join(out, "harness.html")).href;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});

/** 在页面里量一段时间：头像上的动画、变形帧、rAF 调用。 */
const sample = (page, ms) =>
  page.evaluate(async (ms) => {
    const frames0 = window.__morph.stats.frames;
    const raf0 = window.__raf;
    await new Promise((r) => setTimeout(r, ms));
    const anims = document
      .getAnimations()
      .filter(
        (a) => a.effect?.target?.closest?.(".sa") && a.playState === "running",
      )
      .map((a) => a.animationName || `transition:${a.transitionProperty}`);
    const counts = {};
    for (const name of anims) counts[name] = (counts[name] ?? 0) + 1;
    return {
      perf: document.documentElement.getAttribute("data-perf") === "on",
      morphOn: document.querySelectorAll('.sa[data-morph="on"]').length,
      runningAvatarAnimations: anims.length,
      byName: counts,
      morphFrames: window.__morph.stats.frames - frames0,
      rafCalls: window.__raf - raf0,
      ms,
    };
  }, ms);

const report = {};
for (const scene of ["perf", "states"]) {
  const page = await browser.newPage({
    viewport: { width: 640, height: 1100 },
  });
  await page.addInitScript(() => {
    window.__raf = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      window.__raf++;
      return raf(cb);
    };
  });
  await page.goto(`${url}?scene=${scene}`);
  await page.waitForTimeout(800);
  if (scene === "perf")
    await page.evaluate(() => {
      window.__setWorking(true);
      window.__setThinking(true);
      window.__setSelected(true);
    });
  await page.waitForTimeout(600);
  const off = await sample(page, 2000);
  await page.evaluate(() => window.__setPerfMode(true));
  await page.waitForTimeout(300);
  const on = await sample(page, 2000);
  // 开着性能模式时再换一次状态（选中 / 做完了会重挂），也不应该起任何动画。
  if (scene === "perf")
    await page.evaluate(() => {
      window.__setWorking(false);
      window.__setSelected(false);
    });
  const onAfterChange = await sample(page, 3000);
  await page.screenshot({ path: join(out, `perf-${scene}-on.png`) });
  await page.evaluate(() => window.__setPerfMode(false));
  if (scene === "perf")
    await page.evaluate(() => {
      window.__setWorking(true);
      window.__setSelected(true);
    });
  await page.waitForTimeout(600);
  const offAgain = await sample(page, 2000);
  await page.screenshot({ path: join(out, `perf-${scene}-off.png`) });
  report[scene] = { off, on, onAfterChange, offAgain };
  await page.close();
}
await browser.close();
writeFileSync(join(out, "perf-mode.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
