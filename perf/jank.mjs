#!/usr/bin/env node
// ChisaBot jank harness: headless Chrome 1024×673 @ DPR 1.25, CPU throttled 4x, static dist + mock /api.
// Usage: see perf/README.md. `node perf/jank.mjs --help`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startMockServer } from "./mock-server.mjs";
import { summarizeRuns } from "./summary.mjs";
import { summarizeTrace } from "./trace-summary.mjs";

export const SCENARIOS = [
  "idle",
  "sidebar",
  "panel",
  "switch",
  "scroll",
  "stream",
  "settings",
  "resize",
  "orb",
];

const { values: o } = parseArgs({
  options: {
    scenario: { type: "string", default: "all" },
    runs: { type: "string", default: "1" },
    out: { type: "string", default: "perf/out/run" },
    dist: { type: "string", default: "app/dist" },
    tag: { type: "string" },
    cpu: { type: "string", default: "4" },
    lat: { type: "string", default: "0" },
    net: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    cpuprofile: { type: "boolean", default: false },
    react: { type: "boolean", default: false },
    screenshots: { type: "boolean", default: false },
    chrome: {
      type: "string",
      default: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    },
    port: { type: "string", default: "0" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  // `bun run perf:jank -- --x` forwards a literal "--"; drop it so options still parse.
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--")),
});
if (o.help) {
  console.log(`node perf/jank.mjs [--scenario=${SCENARIOS.join(",")}|all] [--runs=3] [--out=dir] [--dist=app/dist]
  [--cpu=4] [--lat=ms] [--net] [--trace] [--cpuprofile] [--react] [--screenshots] [--chrome=path] [--tag=name]`);
  process.exit(0);
}
const ONLY =
  o.scenario === "all" ? SCENARIOS : o.scenario.split(",").map((s) => s.trim());
for (const s of ONLY)
  if (!SCENARIOS.includes(s))
    throw new Error(`unknown scenario ${s}; known: ${SCENARIOS.join(",")}`);
const OUT = path.resolve(o.out);
const DIST = path.resolve(o.dist);
if (!fs.existsSync(path.join(DIST, "index.html")))
  throw new Error(`no build at ${DIST} (run the app build first)`);
fs.mkdirSync(OUT, { recursive: true });
const TAG = o.tag || path.basename(OUT);
const RUNS = Math.max(1, +o.runs);
const want = (n) => ONLY.includes(n);

const TRACE_CATS = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "v8.execute",
].join(",");

/** In-page probes: long tasks, event timing (INP parts), rAF frames, DOM mutations, transitions; optional React commit hook. */
function initProbes({ react }) {
  Object.assign(window, {
    __lt: [],
    __ev: [],
    __fr: [],
    __mut: [],
    __rc: [],
    __an: [],
  });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        window.__lt.push({ s: e.startTime, d: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        if (e.interactionId)
          window.__ev.push({
            n: e.name,
            s: e.startTime,
            d: e.duration,
            ps: e.processingStart,
            pe: e.processingEnd,
            id: e.interactionId,
          });
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
  const frame = (t) => {
    window.__fr.push(t);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const onAnim = (e) => {
    if (window.__an.length > 3000) return;
    const el = e.target;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return;
    }
    const cls =
      el.getAttribute?.("data-slot") ||
      el.className
        ?.toString?.()
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .join(".") ||
      el.tagName;
    const tr = e.type === "transitionrun";
    window.__an.push({
      t: performance.now(),
      k: tr ? "T" : "A",
      p: e.propertyName || e.animationName,
      dur: tr ? cs.transitionDuration : cs.animationDuration,
      ease: tr ? cs.transitionTimingFunction : cs.animationTimingFunction,
      el: String(cls).slice(0, 50),
    });
  };
  addEventListener("transitionrun", onAnim, true);
  addEventListener("animationstart", onAnim, true);
  let lastM = 0;
  const startMO = () =>
    new MutationObserver(() => {
      const t = performance.now();
      if (t - lastM > 2) {
        window.__mut.push(t);
        lastM = t;
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  if (document.documentElement) startMO();
  else addEventListener("DOMContentLoaded", startMO);
  if (!react) return;
  // Minimal DevTools-hook shim (needs a react-dom/profiling build for durations).
  const nameOf = (t) => {
    if (!t || typeof t === "string") return null;
    if (typeof t === "function") return t.displayName || t.name || "Anon";
    if (t.displayName) return t.displayName;
    if (t.render) return t.render.displayName || t.render.name || "ForwardRef";
    return t.type ? nameOf(t.type) : null;
  };
  const diff = (a, b) => {
    if (a === b) return null;
    if (!a || !b) return ["*"];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (k) => a[k] !== b[k],
    );
  };
  const ctxChanged = (n, p) => {
    let d = n.dependencies?.firstContext;
    let e = p.dependencies?.firstContext;
    while (d) {
      if (!e || d.memoizedValue !== e.memoizedValue) return true;
      d = d.next;
      e = e?.next;
    }
    return false;
  };
  const walk = (next, prev, rec) => {
    for (let c = next; c; c = c.sibling) {
      const isComp = [0, 1, 11, 14, 15].includes(c.tag);
      const alt = c.alternate;
      const mounted = !alt || prev === null;
      if (isComp) {
        let cause = "";
        if (mounted) cause = "mount";
        else if ((c.flags & 1) === 1 && alt !== c) {
          const pd = diff(alt.memoizedProps, c.memoizedProps);
          if (c.memoizedState !== alt.memoizedState) cause = "state";
          else if (ctxChanged(c, alt)) cause = "context";
          else if (pd?.length) cause = `props:${pd.slice(0, 3).join(",")}`;
          else cause = "parent(shallow-equal)";
        }
        if (cause)
          rec.push([
            nameOf(c.type) || "?",
            cause,
            +(c.selfBaseDuration || 0).toFixed(2),
          ]);
      }
      if (c.child && (!alt || alt.child !== c.child || mounted))
        walk(c.child, alt ? alt.child : null, rec);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, r);
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      if (!window.__reactOn) return;
      const rec = [];
      const cur = root.current;
      try {
        walk(cur.child, cur.alternate ? cur.alternate.child : null, rec);
      } catch (e) {
        rec.push(["ERR", String(e), 0]);
      }
      window.__rc.push({
        t: performance.now(),
        dur: +(cur.actualDuration || 0).toFixed(2),
        rec,
      });
    },
  };
}

/** Per-interaction breakdown from the in-page probe buffers. */
function perInteraction(clicks, r) {
  return clicks.map((c, i) => {
    const tEnd = clicks[i + 1]?.t0 ?? Number.POSITIVE_INFINITY;
    const byId = new Map();
    for (const e of r.ev.filter((e) => e.s >= c.t0 - 5 && e.s < tEnd))
      byId.set(e.id, [...(byId.get(e.id) || []), e]);
    let best = null;
    for (const a of byId.values()) {
      const d = Math.max(...a.map((e) => e.d));
      if (!best || d > best.d)
        best = {
          d,
          s: Math.min(...a.map((e) => e.s)),
          ps: Math.min(...a.map((e) => e.ps)),
          pe: Math.max(...a.map((e) => e.pe)),
        };
    }
    const tIn = best ? best.s : c.t0;
    const mut = r.mut.find((t) => t >= tIn);
    const fr = mut ? r.fr.find((t) => t > mut) : null;
    const win = r.fr.filter((t) => t >= tIn && t <= tIn + 1000 && t < tEnd);
    let dropped = 0;
    let maxGap = 0;
    for (let k = 1; k < win.length; k++) {
      const d = win[k] - win[k - 1];
      maxGap = Math.max(maxGap, d);
      if (d > 20) dropped += Math.round(d / 16.67) - 1;
    }
    const ms = r.mut.filter((t) => t >= tIn && t < tEnd);
    let settled = null;
    for (let k = 0; k < ms.length; k++)
      if (k === ms.length - 1 || ms[k + 1] - ms[k] > 500) {
        settled = ms[k];
        break;
      }
    const lts = r.lt.filter(
      (l) => l.s >= tIn - 5 && l.s < Math.min(tEnd, tIn + 3000),
    );
    const anims = {};
    for (const x of r.an.filter(
      (x) => x.t >= tIn - 5 && x.t < Math.min(tEnd, tIn + 2000),
    )) {
      const k = `${x.k}:${x.el}:${x.p} ${x.dur} ${x.ease}`;
      anims[k] = (anims[k] || 0) + 1;
    }
    const round = (v) => (v == null ? null : Math.round(v));
    return {
      label: c.label,
      inp: best ? round(best.d) : null,
      inputDelay: best ? round(best.ps - best.s) : null,
      processing: best ? round(best.pe - best.ps) : null,
      presentation: best ? round(best.s + best.d - best.pe) : null,
      firstDomChange: mut ? round(mut - tIn) : null,
      firstFrameAfterChange: fr ? round(fr - tIn) : null,
      domSettled: settled ? round(settled - tIn) : null,
      fps1s:
        win.length > 1
          ? +((win.length - 1) / ((win.at(-1) - win[0]) / 1000)).toFixed(1)
          : 0,
      dropped1s: dropped,
      maxGap1s: round(maxGap),
      longTasks3s: lts.length,
      longTaskMs3s: round(lts.reduce((a, b) => a + b.d, 0)),
      anims: Object.entries(anims)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
    };
  });
}

async function idleStats(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll("*");
    let bf = 0;
    let bigShadow = 0;
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.backdropFilter && cs.backdropFilter !== "none") bf++;
      if (
        [
          ...(cs.boxShadow || "").matchAll(
            /(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/g,
          ),
        ].some((x) => +x[3] >= 24)
      )
        bigShadow++;
    }
    let rules = 0;
    let selectors = 0;
    let has = 0;
    let universal = 0;
    let bytes = 0;
    const visit = (list) => {
      for (const r of list) {
        if (r.selectorText !== undefined) {
          rules++;
          for (const p of r.selectorText.split(/,(?![^(]*\))/)) {
            selectors++;
            if (p.includes(":has(")) has++;
            if (/(^|[\s>+~(])\*/.test(p)) universal++;
          }
        }
        if (r.cssRules) visit(r.cssRules);
      }
    };
    for (const s of document.styleSheets)
      try {
        visit(s.cssRules);
        for (const r of s.cssRules) bytes += r.cssText.length;
      } catch {}
    const anims = document.getAnimations();
    return {
      nodes: all.length,
      backdropFilter: bf,
      bigShadow,
      runningAnimations: anims.filter((a) => a.playState === "running").length,
      infiniteAnimations: anims.filter(
        (a) => a.effect?.getTiming?.().iterations === Number.POSITIVE_INFINITY,
      ).length,
      cssTextBytes: bytes,
      styleRules: rules,
      selectors,
      hasSelectors: has,
      universalSelectors: universal,
      canvases: document.querySelectorAll("canvas").length,
    };
  });
}

async function runOnce(runIdx) {
  const mock = await startMockServer({
    dist: DIST,
    port: +o.port,
    latencyMs: +o.lat,
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chisabot-perf-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: o.chrome,
    headless: true,
    viewport: { width: 1024, height: 673 },
    deviceScaleFactor: 1.25,
    args: ["--no-first-run"],
  });
  const res = {
    tag: TAG,
    run: runIdx,
    cpu: +o.cpu,
    lat: +o.lat,
    net: o.net,
    scenarios: ONLY,
    phases: {},
    idle: {},
  };
  try {
    await ctx.addInitScript(initProbes, { react: o.react });
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("pageerror", (e) =>
      console.error("pageerror", String(e).slice(0, 200)),
    );
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: +o.cpu });
    await cdp.send("Performance.enable");
    await cdp.send("Network.enable");
    if (o.net)
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 60,
        downloadThroughput: 2.5e6,
        uploadThroughput: 1e6,
      });
    const net = new Map();
    let netOn = false;
    cdp.on("Network.requestWillBeSent", (e) => {
      if (netOn)
        net.set(e.requestId, {
          url: e.request.url.replace(mock.base, ""),
          type: e.type,
          t0: e.timestamp,
        });
    });
    cdp.on("Network.responseReceived", (e) => {
      const q = net.get(e.requestId);
      if (q) q.status = e.response.status;
    });
    cdp.on("Network.loadingFinished", (e) => {
      const q = net.get(e.requestId);
      if (q) q.t1 = e.timestamp;
    });
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
          m.name,
          m.value,
        ]),
      );
    const clicks = [];
    const mark = async (label, fn) => {
      const t0 = await page.evaluate(() => performance.now());
      await fn();
      clicks.push({ label, t0 });
    };
    const shot = async (n) => {
      if (o.screenshots)
        await page.screenshot({
          path: path.join(OUT, `${TAG}-r${runIdx}-${n}.png`),
        });
    };
    const phase = async (name, fn) => {
      clicks.length = 0;
      net.clear();
      await page.evaluate(() => {
        Object.assign(window, {
          __lt: [],
          __ev: [],
          __fr: [],
          __mut: [],
          __rc: [],
          __an: [],
          __reactOn: true,
        });
      });
      let tr = null;
      if (o.trace) {
        tr = [];
        tr.h = (d) => tr.push(...d.value);
        cdp.on("Tracing.dataCollected", tr.h);
        await cdp.send("Tracing.start", {
          categories: TRACE_CATS,
          transferMode: "ReportEvents",
        });
      }
      if (o.cpuprofile) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
        await cdp.send("Profiler.start");
      }
      netOn = true;
      const m0 = await metrics();
      const t0 = Date.now();
      await fn();
      const secs = (Date.now() - t0) / 1000;
      const m1 = await metrics();
      netOn = false;
      if (o.cpuprofile) {
        const { profile: pr } = await cdp.send("Profiler.stop");
        fs.writeFileSync(
          path.join(OUT, `cpu-${TAG}-r${runIdx}-${name}.cpuprofile`),
          JSON.stringify(pr),
        );
      }
      let trace = null;
      if (tr) {
        const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
        await cdp.send("Tracing.end");
        await done;
        cdp.off("Tracing.dataCollected", tr.h);
        fs.mkdirSync(path.join(OUT, "traces"), { recursive: true });
        fs.writeFileSync(
          path.join(OUT, "traces", `trace-${TAG}-r${runIdx}-${name}.json`),
          JSON.stringify({ traceEvents: tr }),
        );
        trace = summarizeTrace(tr);
      }
      const r = await page.evaluate(() => {
        window.__reactOn = false;
        return {
          an: window.__an,
          fr: window.__fr,
          lt: window.__lt,
          ev: window.__ev,
          mut: window.__mut,
          rc: window.__rc,
        };
      });
      const gaps = [];
      for (let i = 1; i < r.fr.length; i++) gaps.push(r.fr[i] - r.fr[i - 1]);
      gaps.sort((a, b) => a - b);
      if (r.rc.length)
        fs.writeFileSync(
          path.join(OUT, `react-${TAG}-r${runIdx}-${name}.json`),
          JSON.stringify(r.rc),
        );
      const d = (k) => m1[k] - m0[k];
      res.phases[name] = {
        secs: +secs.toFixed(2),
        fps: +(r.fr.length / secs).toFixed(1),
        p95: +(gaps[Math.floor(gaps.length * 0.95)] || 0).toFixed(1),
        longTasks: r.lt.length,
        longTaskMs: Math.round(r.lt.reduce((a, b) => a + b.d, 0)),
        maxLongTask: Math.round(Math.max(0, ...r.lt.map((l) => l.d))),
        layouts: d("LayoutCount"),
        layoutMs: Math.round(d("LayoutDuration") * 1000),
        recalcs: d("RecalcStyleCount"),
        styleMs: Math.round(d("RecalcStyleDuration") * 1000),
        scriptMs: Math.round(d("ScriptDuration") * 1000),
        taskMs: Math.round(d("TaskDuration") * 1000),
        nodes: m1.Nodes,
        jsHeapMB: +(m1.JSHeapUsedSize / 1e6).toFixed(1),
        reactCommits: r.rc.length || undefined,
        interactions: perInteraction(clicks, r),
        requests: [...net.values()].map((q) => ({
          url: q.url.slice(0, 120),
          status: q.status,
          ms: q.t1 ? Math.round((q.t1 - q.t0) * 1000) : null,
        })),
        trace,
      };
      const p = res.phases[name];
      console.log(
        `[${TAG} r${runIdx}] ${name}: fps=${p.fps} p95=${p.p95} longTaskMs=${p.longTaskMs} styleMs=${p.styleMs} scriptMs=${p.scriptMs}`,
      );
    };

    const goChat = async () => {
      await page.goto(`${mock.base}/channel/c2`, {
        waitUntil: "load",
        timeout: 120000,
      });
      await page.waitForTimeout(12000);
    };
    if (ONLY.some((s) => s !== "orb")) await goChat();
    if (want("idle")) {
      res.idle.chat = await idleStats(page);
      await phase("idle", () => page.waitForTimeout(5000));
    }
    if (want("sidebar"))
      await phase("sidebar", async () => {
        for (let i = 0; i < 4; i++) {
          await mark(`toggle${i}`, () =>
            page.locator('button[aria-label="切换侧边栏"]').first().click(),
          );
          await page.waitForTimeout(900);
        }
      });
    if (want("panel")) {
      await page.waitForTimeout(3000);
      await phase("panel", async () => {
        for (let i = 0; i < 2; i++) {
          await mark(`open${i}`, () =>
            page.locator("button.rail-tab.is-narrow").click(),
          );
          await page.waitForTimeout(900);
          await mark(`close${i}`, () =>
            page.locator('[data-testid="panel-sheet-close"]').click(),
          );
          await page.waitForTimeout(900);
        }
      });
    }
    if (want("switch"))
      await phase("switch", async () => {
        for (let i = 0; i < 4; i++) {
          const to = i % 2 ? "c2" : "c1";
          await mark(`to-${to}-${i < 2 ? "first" : "again"}`, () =>
            page.locator(`a[href="/channel/${to}"]`).first().click(),
          );
          await page.waitForTimeout(2500);
        }
      });
    if (want("scroll")) {
      await page.locator('a[href="/channel/c1"]').first().click();
      await page.waitForTimeout(6000);
      const vp = await page.evaluate(() => {
        const e = document.querySelector(
          '[data-slot="message-scroller-viewport"]',
        );
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          rows: e.querySelectorAll("[data-message-id]").length,
        };
      });
      if (vp) {
        await page.mouse.move(vp.x, vp.y);
        await phase("scroll", async () => {
          await mark("wheel", async () => {});
          for (const dy of [-240, 240])
            for (let i = 0; i < 40; i++) {
              await page.mouse.wheel(0, dy);
              await page.waitForTimeout(16);
            }
        });
      } else console.warn("scroll: no message-scroller viewport, skipped");
    }
    if (want("stream")) {
      await page.locator('a[href="/channel/c2"]').first().click();
      await page.waitForTimeout(3000);
      await page
        .locator(".prompt-area-editor, [contenteditable=true], textarea")
        .first()
        .click();
      await page.keyboard.type("讲讲步骤");
      await phase("stream", async () => {
        await mark("send", () => page.keyboard.press("Enter"));
        await page.waitForTimeout(9000);
      });
    }
    if (want("settings")) {
      const open = async (tag) => {
        await mark(`avatar-menu-${tag}`, () =>
          page.getByRole("button", { name: "账号与设置" }).first().click(),
        );
        await page.waitForTimeout(700);
        await mark(`menu-设置-${tag}`, () =>
          page.getByRole("menuitem", { name: "设置" }).first().click(),
        );
      };
      await phase("settings-open-cold", async () => {
        await open("cold");
        await page.waitForTimeout(3500);
      });
      res.idle.settings = await idleStats(page);
      await shot("settings");
      const hrefs = await page.evaluate(() =>
        [
          ...new Set(
            [...document.querySelectorAll('a[href^="/settings/"]')].map((a) =>
              a.getAttribute("href"),
            ),
          ),
        ].slice(0, 5),
      );
      await phase("settings-pages", async () => {
        for (const h of hrefs) {
          await mark(`page ${h}`, () =>
            page.locator(`a[href="${h}"]`).first().click(),
          );
          await page.waitForTimeout(1800);
        }
      });
      await page.evaluate((n) => history.go(-n), hrefs.length + 1);
      await page.waitForTimeout(3500);
      await phase("settings-open-warm", async () => {
        await open("warm");
        await page.waitForTimeout(3000);
      });
    }
    if (want("resize"))
      // Approximation of a window drag: viewport width 1024→1504→1024 in 16px steps every 33 ms.
      await phase("resize", async () => {
        await mark("resize", async () => {});
        for (let k = 0; k < 2; k++)
          for (let i = 0; i <= 30; i++) {
            const width = k ? 1504 - i * 16 : 1024 + i * 16;
            await cdp.send("Emulation.setDeviceMetricsOverride", {
              width,
              height: 673,
              deviceScaleFactor: 1.25,
              mobile: false,
            });
            await page.waitForTimeout(33);
          }
        await cdp.send("Emulation.clearDeviceMetricsOverride");
        await page.waitForTimeout(500);
      });
    if (want("orb")) {
      // Signed-out sign-in page with the agent orb; measures idle cost of its animation.
      mock.setSignedOut(true);
      await page.goto(`${mock.base}/sign`, { waitUntil: "load" });
      await page.waitForTimeout(6000);
      res.idle.orbPresent = await page.evaluate(
        () => !!document.querySelector(".agent-orb"),
      );
      await shot("orb");
      await phase("orb", () => page.waitForTimeout(8000));
      mock.setSignedOut(false);
    }
  } finally {
    res.api = Object.fromEntries(mock.seen);
    fs.writeFileSync(
      path.join(OUT, `run-${runIdx}.json`),
      JSON.stringify(res, null, 1),
    );
    await ctx.close();
    mock.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return res;
}

const results = [];
for (let i = 1; i <= RUNS; i++) results.push(await runOnce(i));
const summary = summarizeRuns(results);
fs.writeFileSync(
  path.join(OUT, "summary.json"),
  JSON.stringify(summary, null, 1),
);
console.log(
  `wrote ${path.join(OUT, "summary.json")} (${RUNS} run(s), median per metric)`,
);
process.exit(0);
