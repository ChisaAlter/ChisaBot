#!/usr/bin/env node
// 干活卡 / 流式跳动测量（DESIGN.md §35 系列）：真浏览器 + perf mock（toolTurn 模式），
// 对 240 条历史的 c1 会话发一条消息。
//
// Scenario A：发送后逐帧（rAF）记录滚动区 scrollTop/scrollHeight/clientHeight、内容末尾的屏幕 Y
//   （最后一个 [data-message-id] / 状态槽 / 干活卡的底边）、输入框顶边 Y、第一条完整可见的消息。
//   报告：内容末尾那一条在屏幕上「往下挪 / 往回跳」> 2px 的帧数（纯长高/跟随滚动解释不掉的）、
//   最大跳动 px、每个大跳的时间戳与当时的 DOM 阶段（开场白 / 工具出现 / 干活卡 / 长回答流 / 回合结束）。
// Scenario B：回合还在跑（mock 把第一个工具结果挂起 --hold 毫秒）时量 gap = composerTop − 内容末尾底边，
//   点干活卡展开 → 400ms 量一次 → 再点收起 → 400ms / 1500ms 各量一次（连同 scroller.dataset.cbRelease、
//   spacer / slack 高度）→ 回合结束后再等 2s 量一次。
//
// 用法：
//   node tests/chat-scroll/work-card-jump.mjs --dist app/dist --out <dir> [--chrome <path>]
//         [--viewports 1280x800,420x860] [--hold 6000]
//   矩阵定位（只跑 Scenario A，每个配方一个 run，默认视口 1280x800）：
//   node tests/chat-scroll/work-card-jump.mjs --dist app/dist --out <dir> --answer all
//         [--answer plain,list,code,table,link,image,heading,rich]
// 需要 `bun run generate:app-config && bun run --cwd app build` 先产出 --dist。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startMockServer } from "../../perf/mock-server.mjs";
import { resolveBrowserExecutable } from "../../scripts/verify-ui.mjs";

const { values: o } = parseArgs({
  options: {
    dist: { type: "string", default: "app/dist" },
    out: { type: "string", default: "" },
    chrome: { type: "string" },
    viewports: { type: "string", default: "1280x800,420x860" },
    hold: { type: "string", default: "6000" },
    answer: { type: "string", default: "" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (o.help) {
  console.log(
    "node tests/chat-scroll/work-card-jump.mjs [--dist app/dist] [--out dir] [--chrome path] [--viewports 1280x800,420x860] [--hold 6000] [--answer all|plain,list,...]",
  );
  process.exit(0);
}
const DIST = path.resolve(o.dist);
if (!fs.existsSync(path.join(DIST, "index.html")))
  throw new Error(`no build at ${DIST} (run the app build first)`);
const OUT = o.out
  ? path.resolve(o.out)
  : fs.mkdtempSync(path.join(os.tmpdir(), "work-card-jump-"));
fs.mkdirSync(OUT, { recursive: true });
const HOLD_MS = Math.max(0, +o.hold || 0);
const VIEWPORTS = o.viewports.split(",").map((s) => {
  const [w, h] = s.trim().toLowerCase().split("x").map(Number);
  if (!w || !h) throw new Error(`bad viewport ${s}`);
  return { width: w, height: h };
});
const CHROME = o.chrome || process.env.CHROME_PATH || resolveBrowserExecutable();
if (!CHROME) throw new Error("no Edge/Chrome found (set --chrome or CHROME_PATH)");
const ANSWER_VARIANTS = [
  "rich",
  "plain",
  "list",
  "code",
  "table",
  "link",
  "image",
  "heading",
];
const ANSWER_ONLY = o.answer
  ? o.answer === "all"
    ? ANSWER_VARIANTS
    : o.answer
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
  : null;
if (ANSWER_ONLY)
  for (const v of ANSWER_ONLY)
    if (!ANSWER_VARIANTS.includes(v))
      throw new Error(`unknown --answer ${v}; known: ${ANSWER_VARIANTS.join(",")}`);
const log = (...a) =>
  console.log(new Date().toISOString().slice(11, 23), ...a);

/**
 * 页面加载前挂上滚动写日志：scrollTo/scroll/scrollIntoView（带调用方函数名）与
 * 滚动区 scrollTop 赋值，记在 window.__cbScroll（平滑滚动本身是浏览器驱动的，
 * 这里只能看到「谁发起了平滑滚动、目标哪」——正好用来区分 pinNow/stickToBottom
 * 的 smooth scrollTo 和 message-scroller 库自己的写入）。
 */
const SCROLL_WRAP = `(() => {
  const w = window;
  w.__cbScroll = [];
  const idOf = (el) =>
    (el?.dataset?.slot || "") ||
    (el?.className ? String(el.className).slice(0, 60) : "") ||
    el?.tagName ||
    "?";
  const push = (e) => {
    if (w.__cbScroll.length < 4000) w.__cbScroll.push(e);
  };
  const who = () =>
    (new Error().stack || "")
      .split("\\n")
      .slice(2, 5)
      .map((l) => l.trim().replace(/^at\\s+/, "").replace(/\\s*\\(.*$/, ""))
      .join("<")
      .slice(0, 120);
  for (const name of ["scrollTo", "scroll", "scrollIntoView"]) {
    const orig = Element.prototype[name];
    if (!orig) continue;
    Element.prototype[name] = function (...a) {
      const o = a[0];
      push({
        t: performance.now(),
        k: name,
        el: idOf(this),
        top: o && typeof o === "object" ? o.top : undefined,
        behavior: o && typeof o === "object" ? o.behavior : undefined,
        who: who(),
      });
      return orig.apply(this, a);
    };
  }
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (desc?.set)
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(v) {
        const id = idOf(this);
        if (String(id).includes("message-scroller-viewport"))
          push({
            t: performance.now(),
            k: "st=",
            el: id,
            v: Math.round(v * 10) / 10,
          });
        return desc.set.call(this, v);
      },
    });
})()`;

/**
 * 逐帧采样器：每个 rAF 往 window.__cbFrames 推一条。回合结束（composer-stop 消失）后
 * 再记 ~180 帧（约 3s）把 window.__cbDone 置真；window.__cbStop 置真时停止。
 */
const SAMPLER = `(() => {
  const w = window;
  w.__cbFrames = [];
  w.__cbDone = false;
  w.__cbStop = false;
  let lastRun = -1;
  const scope = () =>
    document.querySelector('[data-testid="kept-page"][data-visible="true"]') ||
    document;
  const CONTENT_BOTTOM =
    '[data-message-id], .chat-status-slot > *, .chat-work, [data-testid="turn-stopped"], [data-testid="turn-fallback"]';
  /*
   * 深层取证：最后一条消息行的高度一帧变 >100px 就「武装」5 帧，把这一行后代的
   * 矩形快照存进 __cbDeep（每帧一份，连起来看哪一层先撑大再缩回）。平时只读一行高。
   * MutationObserver 只看滚动内容列（childList/属性/文字，style 属性噪声除外），
   * 记进 __cbMut，封顶 3000 条后停观，避免拖慢流式渲染本身。
   */
  w.__cbDeep = [];
  w.__cbMut = [];
  w.__cbArm = 0;
  const snap = (root) => {
    const out = [];
    const walk = (el, d) => {
      if (out.length >= 60 || d > 4) return;
      const r = el.getBoundingClientRect();
      const data = {};
      for (const k of Object.keys(el.dataset || {}))
        data[k] = String(el.dataset[k]).slice(0, 40);
      out.push({
        d,
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 60),
        data,
        h: Math.round(r.height * 10) / 10,
        top: Math.round(r.top * 10) / 10,
        txt: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      });
      for (const c of el.children) walk(c, d + 1);
    };
    walk(root, 0);
    return out;
  };
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (w.__cbMut.length >= 3000) {
        mo.disconnect();
        return;
      }
      if (m.type === "attributes" && m.attributeName === "style") continue;
      const el = m.target;
      w.__cbMut.push({
        t: performance.now(),
        k: m.type === "childList" ? "c" : m.type === "attributes" ? "a" : "t",
        tag: el.tagName ? el.tagName.toLowerCase() : "#",
        cls: String(el.className || "").slice(0, 60),
        add: m.addedNodes ? m.addedNodes.length : 0,
        rem: m.removedNodes ? m.removedNodes.length : 0,
        at: m.attributeName || "",
        snip: (el.textContent || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 60),
      });
    }
  });
  const contentEl = document.querySelector(
    '[data-slot="message-scroller-content"]',
  );
  if (contentEl)
    mo.observe(contentEl, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  /*
   * 「真正画出去的那一帧」采样：rAF 在布局 / ResizeObserver 之前跑，量到的是「块刚提交、SettleAtEnd
   * 的 pinNow 还没贴底」的中间态（+230px、scrollTop 还是旧的）——同一次渲染步里 RO 回调先于 paint，
   * 屏幕上从来没有这一帧。这里挂的 RO 比 app 的晚创建，同一次广播里排在 pinNow 之后，读到的
   * cb / scrollTop 才是本帧 paint 出来的样子。
   */
  w.__cbPost = [];
  if (typeof ResizeObserver !== "undefined" && contentEl) {
    new ResizeObserver(() => {
      const f = { t: performance.now() };
      const sc =
        scope().querySelector?.('[data-slot="message-scroller-viewport"]') ||
        document.querySelector('[data-slot="message-scroller-viewport"]');
      if (sc) {
        f.st = sc.scrollTop;
        f.sh = sc.scrollHeight;
        f.ch = sc.clientHeight;
        let cb = -Infinity;
        for (const el of sc.querySelectorAll(CONTENT_BOTTOM)) {
          const r = el.getBoundingClientRect();
          if (r.bottom > cb) cb = r.bottom;
        }
        f.cb = cb === -Infinity ? null : cb;
      }
      w.__cbPost.push(f);
    }).observe(contentEl);
  }
  const tick = () => {
    const f = { t: performance.now() };
    const sc =
      scope().querySelector?.('[data-slot="message-scroller-viewport"]') ||
      document.querySelector('[data-slot="message-scroller-viewport"]');
    if (sc) {
      const vr = sc.getBoundingClientRect();
      f.st = sc.scrollTop;
      f.sh = sc.scrollHeight;
      f.ch = sc.clientHeight;
      f.vt = vr.top;
      f.rel = sc.dataset.cbRelease || "";
      const rows = sc.querySelectorAll("[data-message-id]");
      const last = rows[rows.length - 1];
      if (last) {
        const r = last.getBoundingClientRect();
        f.lid = last.dataset.messageId;
        f.lb = r.bottom;
        f.lh = r.height;
        if (
          w.__cbPrevLh !== undefined &&
          Math.abs(f.lh - w.__cbPrevLh) > 100 &&
          w.__cbDeep.length < 600
        )
          w.__cbArm = 5;
        if (w.__cbArm > 0) {
          w.__cbDeep.push({
            t: f.t,
            lid: f.lid,
            h: f.lh,
            els: snap(last),
          });
          w.__cbArm--;
        }
        w.__cbPrevLh = f.lh;
      }
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (r.bottom <= vr.top + 0.5) continue;
        f.fid = row.dataset.messageId;
        f.ft = r.top;
        f.fpart = r.top < vr.top - 0.5 ? 1 : undefined;
        break;
      }
      let cb = -Infinity;
      for (const el of sc.querySelectorAll(CONTENT_BOTTOM)) {
        const r = el.getBoundingClientRect();
        if (r.bottom > cb) cb = r.bottom;
      }
      f.cb = cb === -Infinity ? null : cb;
      const spacer = sc.querySelector("[data-message-scroller-spacer]");
      f.spacer = spacer && !spacer.hidden ? spacer.offsetHeight : 0;
      const slack = sc.querySelector("[data-chat-slack]");
      f.slack = slack ? slack.offsetHeight : 0;
    }
    const comp = document.querySelector(".composer-frame");
    if (comp) f.ct = comp.getBoundingClientRect().top;
    const card = document.querySelector(
      '[data-testid="chat-work-card"], [data-testid="chat-work-done"]',
    );
    if (card) {
      f.card =
        card.getAttribute("data-testid") === "chat-work-done" ? "done" : "live";
      f.cardText = (card.getAttribute("aria-label") || "").slice(0, 48);
      f.steps = document.querySelector(".chat-work-steps") ? 1 : undefined;
    }
    f.run = document.querySelector('[data-testid="composer-stop"]') ? 1 : 0;
    const live = document.querySelector(
      '[data-testid="transcript-live-status"]',
    );
    if (live) f.lv = live.textContent;
    w.__cbFrames.push(f);
    if (f.run) lastRun = f.t;
    else if (lastRun >= 0 && f.t - lastRun > 3000) w.__cbDone = true;
    if (!w.__cbStop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

/** 一次性量一组（Scenario B 的点测）：和一帧相同的字段。 */
const MEASURE = `(() => {
  const scope =
    document.querySelector('[data-testid="kept-page"][data-visible="true"]') ||
    document;
  const sc =
    scope.querySelector?.('[data-slot="message-scroller-viewport"]') ||
    document.querySelector('[data-slot="message-scroller-viewport"]');
  const f = { t: performance.now() };
  if (sc) {
    f.st = sc.scrollTop;
    f.sh = sc.scrollHeight;
    f.ch = sc.clientHeight;
    f.rel = sc.dataset.cbRelease || "";
    let cb = -Infinity;
    for (const el of sc.querySelectorAll(
      '[data-message-id], .chat-status-slot > *, .chat-work, [data-testid="turn-stopped"], [data-testid="turn-fallback"]',
    )) {
      const r = el.getBoundingClientRect();
      if (r.bottom > cb) cb = r.bottom;
    }
    f.cb = cb === -Infinity ? null : cb;
    const spacer = sc.querySelector("[data-message-scroller-spacer]");
    f.spacer = spacer && !spacer.hidden ? spacer.offsetHeight : 0;
    const slack = sc.querySelector("[data-chat-slack]");
    f.slack = slack ? slack.offsetHeight : 0;
    const steps = sc.querySelector(".chat-work-steps");
    f.steps = steps ? steps.getBoundingClientRect().height : 0;
  }
  const comp = document.querySelector(".composer-frame");
  if (comp) f.ct = comp.getBoundingClientRect().top;
  const card = document.querySelector(
    '[data-testid="chat-work-card"], [data-testid="chat-work-done"]',
  );
  if (card) {
    f.card =
      card.getAttribute("data-testid") === "chat-work-done" ? "done" : "live";
    f.cardText = (card.getAttribute("aria-label") || "").slice(0, 48);
  }
  f.run = document.querySelector('[data-testid="composer-stop"]') ? 1 : 0;
  if (f.ct != null && f.cb != null) f.gap = f.ct - f.cb;
  return f;
})()`;

const wait = (page, ms) => page.waitForTimeout(ms);

async function rmTemp(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function openThread(page, base) {
  await page.goto(`${base}/channel/c1`, { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("[data-message-id]", { timeout: 60000 });
  // 等尾屏历史挂进来（tail-first 挂载窗口，实测 ~96 行）+ SettleAtEnd 钉完底。
  await page.waitForFunction(
    "document.querySelectorAll('[data-message-id]').length > 40 && !!document.querySelector('[data-testid=\"composer-send\"]')",
    undefined,
    { timeout: 60000 },
  );
  await wait(page, 5000);
}

async function sendPrompt(page, text) {
  await page
    .locator(".prompt-area-editor, [contenteditable=true], textarea")
    .first()
    .click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function collectFrames(page, timeout = 150000) {
  await page.waitForFunction("window.__cbDone === true", undefined, {
    timeout,
  });
  await page.evaluate("window.__cbStop = true");
  return page.evaluate(`({
    frames: window.__cbFrames,
    post: window.__cbPost || [],
    deep: window.__cbDeep || [],
    mut: window.__cbMut || [],
    scroll: window.__cbScroll || [],
  })`);
}

/** 这一帧正处在哪一段（用于给大跳标现场）。 */
function phaseOf(f, firstContentT) {
  if (!f.run && f.t < firstContentT) return "idle";
  if (!f.run) return "turn-ended";
  if (f.steps) return `work-open:${f.cardText || ""}`;
  if (f.card === "live") return `work:${f.cardText || ""}`;
  if (f.lv) return `status:${f.lv}`;
  return "running";
}

/** Scenario A 分析：内容末尾那一条（f.cb）相邻两帧的屏幕位移。 */
function analyzeA(frames) {
  const jumps = [];
  const compJumps = [];
  const visJumps = [];
  let prev = null;
  const firstContent = frames.find((f) => f.run)?.t ?? Number.POSITIVE_INFINITY;
  for (const f of frames) {
    if (prev) {
      // 内容末尾底边：长高 + 跟随滚动都解释掉之后剩下的屏幕位移。
      // 贴底时它应该几乎不动（新长多高滚动区就跟着滚多少），>2px 就是肉眼可见的跳。
      if (f.cb != null && prev.cb != null) {
        const dev = f.cb - prev.cb;
        if (Math.abs(dev) > 2)
          jumps.push({ t: f.t, dev, phase: phaseOf(f, firstContent) });
      }
      if (f.ct != null && prev.ct != null && f.ct !== prev.ct)
        compJumps.push({ t: f.t, dev: f.ct - prev.ct });
      if (f.fid && f.fid === prev.fid && f.ft != null && prev.ft != null) {
        const dev = f.ft - prev.ft + (f.st - prev.st);
        if (Math.abs(dev) > 2)
          visJumps.push({ t: f.t, dev, id: f.fid });
      }
    }
    prev = f;
  }
  const milestones = {
    sent: frames.find((f) => f.run)?.t ?? null,
    cardAppears: frames.find((f) => f.card === "live")?.t ?? null,
    cardOpens: frames.find((f) => f.steps)?.t ?? null,
    cardDone: frames.find((f) => f.card === "done")?.t ?? null,
    runEnds: [...frames].reverse().find((f) => f.run)?.t ?? null,
  };
  const top = [...jumps].sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));
  return {
    frames: frames.length,
    jumpFrames: jumps.length,
    downFrames: jumps.filter((j) => j.dev > 0).length,
    upFrames: jumps.filter((j) => j.dev < 0).length,
    maxJumpPx: top.length ? Math.abs(top[0].dev) : 0,
    compJumps,
    visJumpFrames: visJumps.length,
    visMaxJumpPx: visJumps.length
      ? Math.max(...visJumps.map((j) => Math.abs(j.dev)))
      : 0,
    milestones,
    biggest: top.slice(0, 24),
  };
}

/** 相邻两份深层快照里高度变化最大的几层（按遍历序号对齐；结构换了就当整段换）。 */
function diffDeep(prev, next) {
  const n = Math.max(prev?.els?.length || 0, next?.els?.length || 0);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const a = prev?.els?.[i];
    const b = next?.els?.[i];
    const dh = (b?.h ?? 0) - (a?.h ?? 0);
    if (Math.abs(dh) < 5) continue;
    const ref = b || a;
    rows.push({
      i,
      tag: ref.tag,
      cls: ref.cls,
      data: ref.data,
      dh: Math.round(dh * 10) / 10,
      h: [a?.h ?? null, b?.h ?? null],
      txt: (b?.txt || a?.txt || "").slice(0, 100),
    });
  }
  return rows.sort((x, y) => Math.abs(y.dh) - Math.abs(x.dh)).slice(0, 6);
}

/**
 * 「画出来的帧」里的 >50px 向下跳：__cbPost 在 app 的 RO 之后采样（同一次广播、注册更晚），
 * 读到的是本帧 paint 前的最终 scrollTop / 内容末尾位置。rAF 的 downSlam 可能只是提交与贴底之间
 * 的中间态（那一帧从来没画出去）；post 里还剩 >50px 的向下跳才是真正砸在屏幕上的。
 */
function analyzePost(post) {
  const slams = [];
  let upSlams = 0;
  for (let i = 1; i < post.length; i++) {
    const p = post[i - 1];
    const f = post[i];
    if (f.cb == null || p.cb == null) continue;
    const dev = f.cb - p.cb;
    if (dev > 50) slams.push({ t: f.t, dev: +dev.toFixed(1) });
    else if (dev < -50) upSlams++;
  }
  return {
    frames: post.length,
    downSlams: slams.length,
    upSlams,
    maxSlamPx: slams.length ? Math.max(...slams.map((s) => s.dev)) : 0,
    slamList: slams.slice(0, 24),
  };
}

/** --answer 矩阵的一次 run：在 analyzeA 之上加 downSlams / doubleLayout / slam 现场取证。 */
function analyzeVariant(frames, deep, mut, scroll, post = []) {
  const summary = analyzeA(frames);
  const painted = analyzePost(post);
  const slams = [];
  let doubleLayout = 0;
  for (let i = 1; i < frames.length; i++) {
    const p = frames[i - 1];
    const f = frames[i];
    if (f.cb != null && p.cb != null && f.cb - p.cb > 50)
      slams.push({
        t: f.t,
        dev: +(f.cb - p.cb).toFixed(1),
        lid: f.lid,
      });
    if (f.lid && f.lid === p.lid && f.lh != null && p.lh != null) {
      const g = f.lh - p.lh;
      if (g > 100)
        for (let k = i + 1; k <= Math.min(i + 2, frames.length - 1); k++) {
          const q = frames[k];
          if (q.lid === f.lid && q.lh != null && q.lh - f.lh < -40) {
            doubleLayout++;
            break;
          }
        }
    }
  }
  const details = slams.map((s) => {
    const near = deep.filter((d) => d.t >= s.t - 80 && d.t <= s.t + 120);
    const diffs = [];
    for (let k = 1; k < near.length; k++)
      diffs.push({
        at: +(near[k].t - s.t).toFixed(0),
        ch: diffDeep(near[k - 1], near[k]),
      });
    return {
      ...s,
      snapCount: near.length,
      grewShrank: diffs,
      muts: mut
        .filter((m) => m.t >= s.t - 100 && m.t <= s.t + 150)
        .slice(0, 24),
      scrollCalls: scroll
        .filter((c) => c.t >= s.t - 200 && c.t <= s.t + 1600)
        .slice(0, 30),
    };
  });
  return {
    ...summary,
    downSlams: slams.length,
    doubleLayout,
    painted,
    slamDetails: details.slice(0, 24),
  };
}

async function scenarioA(tag, answer) {
  const mock = await startMockServer({
    dist: DIST,
    toolTurn: answer ? { answer } : {},
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cb-jump-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: true,
    viewport: tag,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    args: ["--no-first-run", "--mute-audio"],
  });
  try {
    await ctx.addInitScript(SCROLL_WRAP);
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("pageerror", (e) =>
      log(`  pageerror: ${String(e).slice(0, 160)}`),
    );
    await openThread(page, mock.base);
    await page.evaluate(SAMPLER);
    await sendPrompt(page, "帮我查一下这周末郊外的天气，顺便看看植物园开不开");
    const pack = await collectFrames(page);
    const summary = analyzeA(pack.frames);
    return { ...pack, summary };
  } finally {
    await ctx.close().catch(() => {});
    mock.close();
    await rmTemp(profile);
  }
}

async function scenarioB(tag) {
  const mock = await startMockServer({
    dist: DIST,
    toolTurn: { holdMs: HOLD_MS },
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cb-jump-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: true,
    viewport: tag,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    args: ["--no-first-run", "--mute-audio"],
  });
  const notes = [];
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("pageerror", (e) =>
      log(`  pageerror: ${String(e).slice(0, 160)}`),
    );
    await openThread(page, mock.base);
    await page.evaluate(SAMPLER);
    await sendPrompt(page, "再确认一下周日天气和植物园开放时间");
    await page.waitForSelector('[data-testid="chat-work-card"]', {
      timeout: 30000,
    });
    await wait(page, 400);
    const measure = () => page.evaluate(MEASURE);
    const out = { holdMs: HOLD_MS, steps: [] };
    const step = async (label) => {
      const m = await measure();
      m.label = label;
      out.steps.push(m);
      notes.push(
        `  ${label}: gap=${m.gap?.toFixed(1)} rel=${m.rel || "-"} slack=${m.slack} spacer=${m.spacer} run=${m.run}`,
      );
      return m;
    };
    await step("before-expand");
    await page.click('[data-testid="chat-work-card"]');
    await wait(page, 400);
    await step("expanded+400ms");
    await page.click('[data-testid="chat-work-card"]');
    await wait(page, 400);
    await step("collapsed+400ms");
    await wait(page, 1500);
    await step("collapsed+1900ms");
    // 让回合跑完（hold 结束后还有 ~10s 的工具 + 长回答），结束后再等 2s。
    const pack = await collectFrames(page);
    await wait(page, 2000);
    await step("turn-end+2s");
    out.frames = pack.frames;
    return { out, notes };
  } finally {
    await ctx.close().catch(() => {});
    mock.close();
    await rmTemp(profile);
  }
}

const report = { generated: new Date().toISOString(), holdMs: HOLD_MS, runs: {} };

if (ANSWER_ONLY) {
  // --answer 矩阵：每个配方一个 Scenario A run（默认只跑第一个视口）。
  const vp = VIEWPORTS[0];
  const tag = `${vp.width}x${vp.height}`;
  report.matrix = { viewport: tag, rows: {} };
  for (const name of ANSWER_ONLY) {
    log(`answer=${name} @ ${tag}`);
    const a = await scenarioA(vp, name);
    const v = analyzeVariant(a.frames, a.deep, a.mut, a.scroll, a.post);
    report.matrix.rows[name] = v;
    fs.writeFileSync(
      path.join(OUT, `variant-${name}-${tag}.json`),
      JSON.stringify(
        {
          summary: v,
          frames: a.frames,
          post: a.post,
          deep: a.deep,
          mut: a.mut,
          scroll: a.scroll,
        },
        null,
        1,
      ),
    );
    log(
      `  ${name}: jumps=${v.jumpFrames} max=${v.maxJumpPx.toFixed(0)}px ` +
        `downSlams=${v.downSlams} paintedSlams=${v.painted.downSlams} ` +
        `doubleLayout=${v.doubleLayout} compJumps=${v.compJumps.length}`,
    );
  }
  fs.writeFileSync(
    path.join(OUT, "answer-matrix.json"),
    JSON.stringify(report, null, 1),
  );
  log(`wrote ${path.join(OUT, "answer-matrix.json")}`);
  process.exit(0);
}

for (const vp of VIEWPORTS) {
  const tag = `${vp.width}x${vp.height}`;
  log(`viewport ${tag} — scenario A`);
  const a = await scenarioA(vp);
  const painted = analyzePost(a.post || []);
  report.runs[`${tag}:A`] = {
    summary: a.summary,
    painted,
    frames: a.frames,
  };
  fs.writeFileSync(
    path.join(OUT, `baseline-${tag}-A.json`),
    JSON.stringify(
      {
        summary: a.summary,
        painted,
        frames: a.frames,
        post: a.post,
        deep: a.deep,
        mut: a.mut,
        scroll: a.scroll,
      },
      null,
      1,
    ),
  );
  const s = a.summary;
  log(
    `  A: frames=${s.frames} jumps=${s.jumpFrames} (down=${s.downFrames} up=${s.upFrames}) max=${s.maxJumpPx.toFixed(1)}px compJumps=${s.compJumps.length}`,
  );
  log(
    `  A painted: frames=${painted.frames} downSlams=${painted.downSlams} upSlams=${painted.upSlams} max=${painted.maxSlamPx.toFixed(1)}px`,
  );
  log(`  milestones: ${JSON.stringify(s.milestones)}`);
  for (const j of s.biggest.slice(0, 8))
    log(`    t=${Math.round(j.t)} dev=${j.dev.toFixed(1)} ${j.phase}`);
  log(`viewport ${tag} — scenario B (hold=${HOLD_MS}ms)`);
  const b = await scenarioB(vp);
  report.runs[`${tag}:B`] = b.out;
  fs.writeFileSync(
    path.join(OUT, `baseline-${tag}-B.json`),
    JSON.stringify(b.out, null, 1),
  );
  for (const n of b.notes) log(n);
}
fs.writeFileSync(
  path.join(OUT, "work-card-jump.json"),
  JSON.stringify(report, null, 1),
);
log(`wrote ${path.join(OUT, "work-card-jump.json")}`);
process.exit(0);
