// 由 run.ts 在打包之后用 Node 调起；harness.html 已经在输出目录里。
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const out = resolve(process.argv[2]);
const url = pathToFileURL(join(out, "harness.html")).href;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
const stats = (page) =>
  page.evaluate(() => {
    const m = window.__morph;
    return {
      frames: m.stats.frames,
      painted: m.stats.painted,
      costs: m.costs.slice(),
    };
  });

// 1) 性能：左栏 24 个头像，先全部待机，再 3 个 working + 1 个选中。
const page = await browser.newPage({ viewport: { width: 320, height: 1100 } });
await page.addInitScript(() => {
  window.__long = [];
  window.__gaps = [];
  window.__measure = false;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__long.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  let last = 0;
  const tick = (now) => {
    if (window.__measure && last) window.__gaps.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.goto(url);
await page.waitForTimeout(1500);
const settled = await stats(page);
await page.waitForTimeout(3000);
const idle = await stats(page);
await page.evaluate(() => {
  window.__long.length = 0;
  window.__morph.costs.length = 0;
  window.__measure = true;
  window.__setWorking(true);
  window.__setSelected(true);
});
await page.waitForTimeout(10000);
const working = await stats(page);
const browserSide = await page.evaluate(() => ({
  long: window.__long.slice(),
  gaps: window.__gaps.slice(),
}));
await page.evaluate(() => {
  window.__setWorking(false);
  window.__setSelected(false);
});
await page.waitForTimeout(4000);
const after1 = await stats(page);
await page.waitForTimeout(2000);
const after2 = await stats(page);
await page.close();

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
    : 0;
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const report = {
  idle: {
    loopFramesIn3s: idle.frames - settled.frames,
    paintsIn3s: idle.painted - settled.painted,
  },
  working3Selected1: {
    seconds: 10,
    loopFrames: working.frames - idle.frames,
    longTasks: browserSide.long.length,
    longTaskMaxMs: Math.max(0, ...browserSide.long),
    frameGapAvgMs: +avg(browserSide.gaps).toFixed(2),
    frameGapP95Ms: +pct(browserSide.gaps, 95).toFixed(2),
    frameGapMaxMs: +Math.max(0, ...browserSide.gaps).toFixed(2),
    framesOver20ms: browserSide.gaps.filter((g) => g > 20).length,
    morphCostAvgMs: +avg(working.costs).toFixed(3),
    morphCostP95Ms: +pct(working.costs, 95).toFixed(3),
    morphCostMaxMs: +Math.max(0, ...working.costs).toFixed(3),
  },
  afterStop: { loopFramesInLast2s: after2.frames - after1.frames },
};
writeFileSync(join(out, "perf.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

// 1b) 流式回复时的主线程：每 30 ms 一段字 + 3 在想 + 3 在干活 + 对话里 18px 在想。
const sp = await browser.newPage({ viewport: { width: 320, height: 1300 } });
await sp.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__long.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
});
await sp.goto(`${url}?scene=stream`);
await sp.waitForTimeout(1500);
const s0 = await stats(sp);
await sp.evaluate(() => {
  window.__long.length = 0;
  window.__morph.costs.length = 0;
  window.__setWorking(true);
  window.__setThinking(true);
  window.__startStream();
});
await sp.waitForTimeout(10000);
const s1 = await stats(sp);
const streamLong = await sp.evaluate(() => window.__long.slice());
await sp.evaluate(() => window.__stopStream());
await sp.close();
report.streaming = {
  seconds: 10,
  loopFrames: s1.frames - s0.frames,
  longTasksOver50ms: streamLong.filter((d) => d > 50).length,
  longTaskMaxMs: Math.max(0, ...streamLong),
  morphCostAvgMs: +avg(s1.costs).toFixed(3),
  morphCostP95Ms: +pct(s1.costs, 95).toFixed(3),
  morphCostMaxMs: +Math.max(0, ...s1.costs).toFixed(3),
};
writeFileSync(join(out, "perf.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.streaming, null, 2));

// 2) 录屏：四种状态，28px（左栏实际大小，验收用）和 100px。
const { GIFEncoder, quantize, applyPalette } = await import(
  pathToFileURL(join(process.env.GIFENC, "dist/gifenc.esm.js")).href
);
const { PNG } = createRequire(import.meta.url)(process.env.PNGJS);
for (const [px, vw, vh, dpr] of [
  [28, 400, 90, 2],
  [100, 640, 200, 1],
]) {
  const context = await browser.newContext({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: dpr,
    recordVideo: { dir: out, size: { width: vw, height: vh } },
  });
  const rec = await context.newPage();
  await rec.goto(`${url}?scene=states&size=${px}`);
  await rec.waitForTimeout(300);
  const frames = [];
  const shotStart = Date.now();
  for (let i = 0; i < 110; i++) {
    frames.push(await rec.screenshot({ type: "png" }));
    await rec.waitForTimeout(30);
  }
  const shotDelay = Math.round((Date.now() - shotStart) / frames.length);
  const video = await rec.video()?.path();
  await context.close();
  console.log("video", px, video);
  const gif = GIFEncoder();
  for (const buf of frames) {
    const png = PNG.sync.read(buf);
    const rgba = new Uint8Array(
      png.data.buffer,
      png.data.byteOffset,
      png.data.length,
    );
    const palette = quantize(rgba, 128);
    gif.writeFrame(applyPalette(rgba, palette), png.width, png.height, {
      palette,
      delay: shotDelay,
    });
  }
  gif.finish();
  writeFileSync(join(out, `avatar-morph-states-${px}px.gif`), gif.bytes());
  console.log("gif ok", px, shotDelay);
}
await browser.close();
