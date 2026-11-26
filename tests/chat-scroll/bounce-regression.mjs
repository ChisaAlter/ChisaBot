#!/usr/bin/env node
// 多阶段流式（思考 + 开场白 + 干活卡展开收起 + 过程话折叠 + 长 Markdown + 慢图片 + /sync 并发 + 虚拟化 + 上滑不拽回）实机零弹跳回归测试。
// 用法：node tests/chat-scroll/bounce-regression.mjs [--dist app/dist] [--chrome <path>]

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { resolveBrowserExecutable } from "../../scripts/verify-ui.mjs";

const { values: opts } = parseArgs({
  options: {
    dist: { type: "string", default: "app/dist" },
    chrome: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help) {
  console.log(
    "node tests/chat-scroll/bounce-regression.mjs [--dist app/dist] [--chrome <path>]",
  );
  process.exit(0);
}

const DIST = path.resolve(opts.dist);
if (!fs.existsSync(path.join(DIST, "index.html"))) {
  throw new Error(`未找到构建产物 ${DIST}，请先构建 app/dist`);
}
const CHROME =
  opts.chrome || process.env.CHROME_PATH || resolveBrowserExecutable();
if (!CHROME) {
  throw new Error("未找到本机 Edge/Chrome/Chromium，请通过 --chrome 指定");
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) =>
  `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const PARA =
  "这是一段用于实机滚动稳定性验证的回复内容，包含**加粗**、`行内代码`和[参考链接](https://example.com)。".repeat(
    3,
  );

function initialLongHistory() {
  const out = [];
  for (let i = 0; i < 120; i++) {
    out.push({
      id: `hist-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content:
        i % 2 === 0
          ? `第 ${i / 2 + 1} 轮历史提问：请说明第 ${i} 项细节。`
          : `## 历史小结 ${i}\n\n${PARA}\n\n- 要点一\n- 要点二`,
    });
  }
  return out;
}

const LONG_MD = [
  "## 综合分析结果",
  "",
  PARA,
  "",
  "![示意图](/_mock/slow-img.svg)",
  "",
  "### 核心步骤",
  "",
  "1. 统一单向数据流与单一滚动事实源。",
  "2. 移除多余平滑滚动与人造留白。",
  "3. 在绘制前同步瞬时落底。",
  "",
  "```ts",
  "export function pinBottom(el: HTMLElement) {",
  "  el.scrollTop = el.scrollHeight - el.clientHeight;",
  "}",
  "```",
  "",
  PARA,
].join("\n");

const sse = (res, ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

async function streamMultiStageTurn(res, threadId, runId, userMessages, stored) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sse(res, { type: "RUN_STARTED", threadId, runId });

  // 1. 思考胶囊阶段
  const reasonId = uid("rs");
  sse(res, { type: "REASONING_START", messageId: reasonId });
  sse(res, { type: "REASONING_MESSAGE_START", messageId: reasonId, role: "reasoning" });
  sse(res, {
    type: "REASONING_MESSAGE_CONTENT",
    messageId: reasonId,
    delta: "先检索资料并核对细节，再整理最终回答。",
  });
  await sleep(180);
  sse(res, { type: "REASONING_MESSAGE_END", messageId: reasonId });
  sse(res, { type: "REASONING_END", messageId: reasonId });

  // 2. 开场白 + 工具干活卡 + 过程话
  const openId = uid("op");
  const openText = "我先查一下相关资料，马上整理给你。";
  sse(res, { type: "TEXT_MESSAGE_START", messageId: openId, role: "assistant" });
  sse(res, { type: "TEXT_MESSAGE_CONTENT", messageId: openId, delta: openText });
  sse(res, { type: "TEXT_MESSAGE_END", messageId: openId });
  await sleep(160);

  const tc1 = uid("tc");
  const mTool1 = uid("mt");
  sse(res, {
    type: "TOOL_CALL_START",
    toolCallId: tc1,
    toolCallName: "web_search",
    parentMessageId: mTool1,
  });
  sse(res, {
    type: "TOOL_CALL_ARGS",
    toolCallId: tc1,
    delta: '{"query":"滚动稳定性"}',
  });
  sse(res, { type: "TOOL_CALL_END", toolCallId: tc1 });
  await sleep(550);
  sse(res, {
    type: "TOOL_CALL_RESULT",
    toolCallId: tc1,
    messageId: uid("tr"),
    role: "tool",
    content: "结果 1：单滚动源收敛",
  });

  const noteId = uid("nt");
  sse(res, { type: "TEXT_MESSAGE_START", messageId: noteId, role: "assistant" });
  sse(res, {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: noteId,
    delta: "查到了一条线索，再核对一下另一个参数。",
  });
  sse(res, { type: "TEXT_MESSAGE_END", messageId: noteId });
  await sleep(180);

  const tc2 = uid("tc");
  const mTool2 = uid("mt");
  sse(res, {
    type: "TOOL_CALL_START",
    toolCallId: tc2,
    toolCallName: "web_fetch",
    parentMessageId: mTool2,
  });
  sse(res, {
    type: "TOOL_CALL_ARGS",
    toolCallId: tc2,
    delta: '{"url":"https://example.com/spec"}',
  });
  sse(res, { type: "TOOL_CALL_END", toolCallId: tc2 });
  await sleep(220);
  sse(res, {
    type: "TOOL_CALL_RESULT",
    toolCallId: tc2,
    messageId: uid("tr"),
    role: "tool",
    content: "结果 2：ok",
  });

  // 3. 多段 Markdown + 图片增量流式输出
  const ansId = uid("ans");
  sse(res, { type: "TEXT_MESSAGE_START", messageId: ansId, role: "assistant" });
  const chars = Array.from(LONG_MD);
  for (let i = 0; i < chars.length; i += 14) {
    sse(res, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: ansId,
      delta: chars.slice(i, i + 14).join(""),
    });
    await sleep(18);
  }
  sse(res, { type: "TEXT_MESSAGE_END", messageId: ansId });
  sse(res, { type: "RUN_FINISHED", threadId, runId });
  res.end();

  for (const u of userMessages) {
    if (!stored.some((m) => m.id === u.id)) stored.push(u);
  }
  stored.push(
    { id: openId, role: "assistant", content: openText },
    {
      id: mTool1,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: tc1,
          type: "function",
          function: { name: "web_search", arguments: '{"query":"滚动稳定性"}' },
        },
      ],
    },
    { id: uid("tr"), role: "tool", toolCallId: tc1, content: "结果 1：单滚动源收敛" },
    { id: noteId, role: "assistant", content: "查到了一条线索，再核对一下另一个参数。" },
    {
      id: mTool2,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: tc2,
          type: "function",
          function: { name: "web_fetch", arguments: '{"url":"https://example.com/spec"}' },
        },
      ],
    },
    { id: uid("tr"), role: "tool", toolCallId: tc2, content: "结果 2：ok" },
    { id: ansId, role: "assistant", content: LONG_MD },
  );
}

async function startServer() {
  const fxPath = path.resolve("perf/fixtures/api.json");
  const fx = JSON.parse(fs.readFileSync(fxPath, "utf8"));
  const stored = initialLongHistory();
  let seqNum = 10;
  let running = false;
  const pendingRuns = new Map();
  const root = path.resolve(DIST);

  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/_mock/slow-img.svg") {
      setTimeout(() => {
        res.writeHead(200, {
          "content-type": "image/svg+xml",
          "cache-control": "no-cache",
        });
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240"><rect width="480" height="240" fill="#dbeafe"/><text x="240" y="128" text-anchor="middle" font-size="18" fill="#1e3a8a">slow mock image</text></svg>',
        );
      }, 120);
      return;
    }
    if (p.startsWith("/api") || p.startsWith("/auth")) {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const json = (code, v) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(v));
        };
        if (p.startsWith("/auth")) return json(200, {});
        if (p === "/api/me") {
          return json(200, {
            user: {
              id: "u1",
              email: "test@example.com",
              name: "Test",
              image: null,
              role: "admin",
              profileNeedsSetup: false,
              onboarding: null,
            },
          });
        }
        if (p === "/api/conversations/info") {
          return json(200, {
            version: "1.77.0",
            agents: { a1: { name: "a1", description: "", className: "HttpAgent" } },
            audioFileTranscriptionEnabled: false,
          });
        }
        if (/^\/api\/bot-threads\/[^/]+\/sync$/.test(p)) {
          seqNum += 1;
          return json(200, {
            thread: {
              threadId: "tc1",
              seq: `seq-${seqNum}`,
              running,
              revision: "rev-1",
              workers: 0,
              inbox: 0,
            },
          });
        }
        if (p === "/api/conversations/threads/tc1/messages") {
          return json(200, {
            messages: stored,
            version: `v-${stored.length}`,
            cursor: `c-${stored.length}`,
            start: 0,
          });
        }
        if (
          req.method === "POST" &&
          /^\/api\/conversations\/[^/]+\/commands$/.test(p)
        ) {
          let parsed = {};
          try {
            parsed = JSON.parse(body);
          } catch {}
          const input = parsed.input ?? {};
          const userMsgs = (input.messages ?? []).filter((m) => m.role === "user");
          const lastUser = userMsgs[userMsgs.length - 1];
          const runId = input.runId || uid("r");
          running = true;
          pendingRuns.set(lastUser?.id || runId, {
            threadId: "tc1",
            runId,
            userMessages: lastUser ? [lastUser] : [],
          });
          return json(200, { commandId: lastUser?.id || runId, runId });
        }
        if (
          req.method === "POST" &&
          /^\/api\/conversations\/[^/]+\/events$/.test(p)
        ) {
          let parsed = {};
          try {
            parsed = JSON.parse(body);
          } catch {}
          const run = pendingRuns.get(parsed.commandId);
          pendingRuns.delete(parsed.commandId);
          if (!run) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            return res.end();
          }
          void streamMultiStageTurn(
            res,
            run.threadId,
            run.runId,
            run.userMessages,
            stored,
          ).finally(() => {
            running = false;
            seqNum += 1;
          });
          return;
        }
        if (req.method !== "GET") return json(200, {});
        for (const [re, v] of Object.entries(fx)) {
          if (new RegExp(re).test(p)) return json(200, v);
        }
        return json(404, { error: "mock" });
      });
      return;
    }

    let f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      f = path.join(root, "index.html");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(f)] || "application/octet-stream",
    });
    fs.createReadStream(f).pipe(res);
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

const INIT_PROBE = `(() => {
  const w = window;
  w.__probe = {
    raf: [],
    micro: [],
    painted: [],
    shrinks: [],
    scrollWrites: [],
    lastSnap: null,
    debug: false,
    smoothCalls: 0,
    smoothComputed: 0,
    recording: false,
  };
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (desc?.set && desc?.get) {
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        if (w.__probe.recording && this.dataset?.slot === "message-scroller-viewport") {
          const before = desc.get.call(this);
          desc.set.call(this, v);
          const after = desc.get.call(this);
          const sh = this.scrollHeight;
          const ch = this.clientHeight;
          const pinned = this.getAttribute("data-cb-pinned") === "true";
          if (w.__probe.debug || (pinned && sh > ch && Math.abs(after - (sh - ch)) > 4)) {
            w.__probe.scrollWrites.push({
              t: Math.round(performance.now()),
              kind: "scrollTop=",
              req: Math.round(v),
              before: Math.round(before),
              after: Math.round(after),
              sh,
              ch,
              pinned,
              stack: w.__probe.debug
                ? String(new Error().stack || "").split(String.fromCharCode(10)).slice(1, 4).map(s => s.trim()).join(" | ")
                : "",
            });
          }
          return;
        }
        return desc.set.call(this, v);
      },
    });
  }
  for (const fn of ["scrollTo", "scroll"]) {
    const orig = Element.prototype[fn];
    if (!orig) continue;
    Element.prototype[fn] = function (...args) {
      if (w.__probe.recording && this.dataset?.slot === "message-scroller-viewport") {
        const o = args[0];
        if (o && typeof o === "object" && o.behavior === "smooth") {
          w.__probe.smoothCalls += 1;
        }
        const pinned = this.getAttribute("data-cb-pinned") === "true";
        const before = desc ? desc.get.call(this) : this.scrollTop;
        const r = orig.apply(this, args);
        const after = desc ? desc.get.call(this) : this.scrollTop;
        const sh = this.scrollHeight;
        const ch = this.clientHeight;
        if (w.__probe.debug || (pinned && sh > ch && Math.abs(after - (sh - ch)) > 4)) {
          w.__probe.scrollWrites.push({
            t: Math.round(performance.now()),
            kind: fn,
            arg: o && typeof o === "object" ? { top: Math.round(o.top ?? -1), behavior: o.behavior } : args[0],
            before: Math.round(before),
            after: Math.round(after),
            sh,
            ch,
            pinned,
            stack: w.__probe.debug
              ? String(new Error().stack || "").split(String.fromCharCode(10)).slice(1, 4).map(s => s.trim()).join(" | ")
              : "",
          });
        }
        return r;
      }
      return orig.apply(this, args);
    };
  }
  const getVp = () =>
    document.querySelector('[data-testid="kept-page"][data-visible="true"] [data-slot="message-scroller-viewport"]') ||
    document.querySelector('[data-slot="message-scroller-viewport"]');
  const bottomY = (vp) => {
    let cb = -Infinity;
    for (const el of vp.querySelectorAll('[data-message-id], .chat-status-slot > *, .chat-work')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > cb) cb = r.bottom;
    }
    return cb === -Infinity ? null : Math.round(cb);
  };
  let wiredVp = null;
  let wiredCt = null;
  const ensureObservers = () => {
    const vp = getVp();
    const ct = vp?.querySelector('[data-testid="chat-transcript"]');
    if (vp && vp !== wiredVp) {
      wiredVp = vp;
      vp.addEventListener("scroll", () => {
        if (!w.__probe.recording) return;
        w.__probe.micro.push({
          t: performance.now(),
          st: Math.round(vp.scrollTop),
          pinned: vp.getAttribute("data-cb-pinned") === "true",
        });
      }, { passive: true });
    }
    if (ct && ct !== wiredCt && typeof ResizeObserver !== "undefined") {
      wiredCt = ct;
      new ResizeObserver(() => {
        if (!w.__probe.recording || !wiredVp) return;
        const st = Math.round(wiredVp.scrollTop);
        const cb = bottomY(wiredVp);
        w.__probe.micro.push({
          t: performance.now(),
          st,
          pinned: wiredVp.getAttribute("data-cb-pinned") === "true",
        });
        w.__probe.painted.push({
          t: performance.now(),
          st,
          cb,
          gap: Math.round(wiredVp.scrollHeight - wiredVp.scrollTop - wiredVp.clientHeight),
        });
      }).observe(ct, { box: "border-box" });
    }
    return vp;
  };
  const tick = () => {
    const vp = ensureObservers();
    if (w.__probe.recording && vp) {
      if (getComputedStyle(vp).scrollBehavior === "smooth") {
        w.__probe.smoothComputed += 1;
      }
      const prevSnap = w.__probe.lastSnap;
      const items = {};
      if (w.__probe.debug) {
        const ct = vp.querySelector('[data-testid="chat-transcript"]');
        if (ct) {
          let idx = 0;
          for (const el of ct.children) {
            const key =
              el.getAttribute('data-message-id') ||
              el.getAttribute('data-testid') ||
              el.className ||
              'child-' + idx;
            items[idx + ':' + String(key).slice(0, 32)] = Math.round(el.getBoundingClientRect().height);
            idx += 1;
          }
          const slot = vp.querySelector('.chat-status-slot');
          if (slot) items['SLOT'] = Math.round(slot.getBoundingClientRect().height);
        }
      }
      const snap = {
        t: Math.round(performance.now()),
        st: Math.round(vp.scrollTop),
        sh: vp.scrollHeight,
        ch: vp.clientHeight,
        pb: getComputedStyle(vp.querySelector('[data-slot="message-scroller-content"]') || vp).paddingBottom,
        slotH: Math.round(vp.querySelector('.chat-status-slot')?.getBoundingClientRect().height ?? -1),
        slotText: (vp.querySelector('.chat-status-slot')?.textContent ?? '').slice(0, 40),
        msgCount: vp.querySelectorAll('[data-message-id]').length,
        workSteps: vp.querySelectorAll('.chat-work-steps').length,
        items,
      };
      w.__probe.lastSnap = snap;
      if (w.__probe.debug && prevSnap && snap.sh < prevSnap.sh) {
        const diffs = [];
        for (const k of new Set([...Object.keys(prevSnap.items), ...Object.keys(snap.items)])) {
          const a = prevSnap.items[k];
          const b = snap.items[k];
          if (a !== b) diffs.push(k + ": " + a + "->" + b);
        }
        w.__probe.shrinks.push({
          t: snap.t,
          sh: prevSnap.sh + "->" + snap.sh,
          st: prevSnap.st + "->" + snap.st,
          ch: prevSnap.ch + "->" + snap.ch,
          pb: prevSnap.pb + "->" + snap.pb,
          diffs: diffs.slice(0, 8),
        });
      }
      w.__probe.raf.push({
        t: performance.now(),
        st: Math.round(vp.scrollTop),
        sh: vp.scrollHeight,
        ch: vp.clientHeight,
        pinned: vp.getAttribute("data-cb-pinned") === "true",
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

function collectReversals(list, key, minStep = 2) {
  let lastDir = 0;
  let prev = null;
  let prevItem = null;
  const rev = [];
  for (const item of list) {
    const val = item[key];
    if (val == null) continue;
    if (prev != null) {
      const diff = val - prev;
      if (Math.abs(diff) >= minStep) {
        const dir = diff > 0 ? 1 : -1;
        if (lastDir !== 0 && dir !== lastDir) {
          rev.push({
            t: Math.round(item.t),
            from: prevItem,
            to: item,
            diff,
          });
        }
        lastDir = dir;
        prev = val;
        prevItem = item;
      }
    } else {
      prev = val;
      prevItem = item;
    }
  }
  return rev;
}

async function rmDir(dir) {
  for (let i = 0; i < 6; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch {}
    await sleep(80);
  }
}

async function runCase({ name, width, height, urlSuffix = "", testWheelDetach = false }) {
  const srv = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cb-bounce-reg-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: true,
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    args: ["--no-first-run", "--mute-audio"],
  });
  try {
    await ctx.addInitScript(INIT_PROBE);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${srv.base}/channel/c1${urlSuffix}`, {
      waitUntil: "load",
      timeout: 60_000,
    });
    await page.waitForSelector("[data-message-id]", { timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const vp = document.querySelector(
          '[data-slot="message-scroller-viewport"]',
        );
        return (
          Boolean(document.querySelector("[data-message-id]")) &&
          Boolean(vp) &&
          vp.getAttribute("data-cb-pinned") === "true" &&
          vp.scrollHeight > vp.clientHeight + 500 &&
          Boolean(document.querySelector('[aria-label="消息"]'))
        );
      },
      null,
      { timeout: 30_000 },
    );
    await sleep(1000);

    await page.evaluate((dbg) => {
      window.__probe.raf.length = 0;
      window.__probe.micro.length = 0;
      window.__probe.painted.length = 0;
      window.__probe.shrinks.length = 0;
      window.__probe.scrollWrites.length = 0;
      window.__probe.lastSnap = null;
      window.__probe.debug = dbg;
      window.__probe.smoothCalls = 0;
      window.__probe.smoothComputed = 0;
      window.__probe.recording = true;
    }, process.env.DEBUG_BOUNCE === "1");

    // 第一轮：多阶段流式 + 干活卡展开/收起 + 图片 + sync
    const ta = page.locator('[aria-label="消息"]').first();
    await ta.click();
    await ta.fill("请完整梳理第一轮多阶段分析");
    await page.keyboard.press("Enter");

    const card = page.locator('[data-testid="chat-work-card"]').first();
    await card.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    if (await card.isVisible().catch(() => false)) {
      await card.click();
      await sleep(160);
      await card.click();
    }

    // 等回合跑完并经历 600ms/800ms + 2s sync 周期
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="composer-stop"]'),
      null,
      { timeout: 45_000 },
    );
    await sleep(1400);

    // 第二轮：连续发送（测试 composer 收缩 + instant 跟流）
    await ta.click();
    await ta.fill("第二轮连续追问：再补充一条结论\n带换行的多行输入");
    await page.keyboard.press("Enter");

    if (testWheelDetach) {
      await page.waitForSelector('[data-testid="composer-stop"]', {
        timeout: 15_000,
      });
      await sleep(300);
      const vpBox = await page.evaluate(() => {
        const vp = document.querySelector(
          '[data-slot="message-scroller-viewport"]',
        );
        const r = vp.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, st: vp.scrollTop };
      });
      await page.mouse.move(vpBox.x, vpBox.y);
      await page.mouse.wheel(0, -400);
      await sleep(100);
      const detached = await page.evaluate(() => {
        const vp = document.querySelector(
          '[data-slot="message-scroller-viewport"]',
        );
        return {
          pinned: vp.getAttribute("data-cb-pinned"),
          stAfterWheel: vp.scrollTop,
        };
      });
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="composer-stop"]'),
        null,
        { timeout: 45_000 },
      );
      await sleep(400);
      const afterEnd = await page.evaluate(() => {
        const vp = document.querySelector(
          '[data-slot="message-scroller-viewport"]',
        );
        return {
          pinned: vp.getAttribute("data-cb-pinned"),
          stAtEnd: vp.scrollTop,
          max: vp.scrollHeight - vp.clientHeight,
        };
      });
      if (detached.pinned !== null || afterEnd.pinned !== null) {
        throw new Error(
          `[${name}] 上滑后仍保持 pinned: ${JSON.stringify({ detached, afterEnd })}`,
        );
      }
      if (afterEnd.stAtEnd > afterEnd.max - 20) {
        throw new Error(
          `[${name}] 上滑看历史被拽回底部: ${JSON.stringify(afterEnd)}`,
        );
      }
      console.log(`PASS ${name} (wheel-detach verified)`);
      return;
    }

    await page.waitForFunction(
      () => !document.querySelector('[data-testid="composer-stop"]'),
      null,
      { timeout: 45_000 },
    );
    await sleep(1200);

    const probe = await page.evaluate(() => {
      window.__probe.recording = false;
      return window.__probe;
    });

    const endGap = probe.painted.at(-1)?.gap ?? 0;
    const pinnedRaf = probe.raf.filter((r) => r.pinned && r.sh > r.ch);
    const unpinnedFrames = probe.raf.filter((r) => r.sh > r.ch && !r.pinned).length;
    const badScrollWrites = probe.scrollWrites.filter(
      (x) => x.pinned && x.sh > x.ch && Math.abs(x.after - (x.sh - x.ch)) > 4,
    );
    const maxRafPinnedGap = pinnedRaf.reduce(
      (m, r) => Math.max(m, Math.abs(r.sh - r.ch - r.st)),
      0,
    );
    const maxPaintedGap = probe.painted.reduce(
      (m, p) => Math.max(m, Math.abs(p.gap ?? 0)),
      0,
    );

    const summary = {
      name,
      rafFrames: probe.raf.length,
      microEvents: probe.micro.length,
      unpinnedFrames,
      badScrollWrites: badScrollWrites.length,
      maxPaintedGap,
      maxRafPinnedGap,
      smoothCalls: probe.smoothCalls,
      smoothComputed: probe.smoothComputed,
      endGap,
    };
    console.log("CASE", JSON.stringify(summary));

    if (
      probe.smoothCalls > 0 ||
      probe.smoothComputed > 0 ||
      unpinnedFrames > 0 ||
      badScrollWrites.length > 0 ||
      maxPaintedGap > 4 ||
      endGap > 4
    ) {
      console.error(
        `DETAILS ${name}:`,
        JSON.stringify(
          {
            badScrollWrites: badScrollWrites.slice(0, 15),
            paintedGaps: probe.painted.filter((p) => Math.abs(p.gap ?? 0) > 4).slice(0, 12),
            rafRevList: collectReversals(probe.raf, "st", 2).slice(0, 8),
            shrinks: probe.shrinks.slice(0, 12),
          },
          null,
          2,
        ),
      );
      return { ok: false, summary };
    }
    return { ok: true, summary };
  } finally {
    await ctx.close().catch(() => {});
    srv.close();
    await rmDir(profile);
  }
}

const results = [
  await runCase({ name: "desktop-1440", width: 1440, height: 900 }),
  await runCase({ name: "narrow-420", width: 420, height: 860 }),
  await runCase({
    name: "virtual-1440",
    width: 1440,
    height: 900,
    urlSuffix: "?virtualTranscript=1",
  }),
];
await runCase({
  name: "wheel-detach-1440",
  width: 1440,
  height: 900,
  testWheelDetach: true,
});
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  throw new Error(`FAIL bounce-regression: ${JSON.stringify(failed)}`);
}
console.log("PASS bounce-regression");
