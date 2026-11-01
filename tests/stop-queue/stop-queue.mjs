// CB-104 E2E: Stop and queued messages, against an isolated local server whose model is
// tests/stop-queue/mock-model.mjs. Creates one guarded temporary bot and deletes only that bot.
//
//   PORT=4314 node tests/stop-queue/mock-model.mjs &
//   (server: BOT_MODEL=mock-stop-queue OPENAI_BASE_URL=http://127.0.0.1:4314/v1, isolated DB)
//   BASE=http://127.0.0.1:3310 MOCK=http://127.0.0.1:4314 VIEWPORT=1280 OUT=/tmp/out node tests/stop-queue/stop-queue.mjs
//
// Covers: Stop feedback within 300 ms and the turn really ending (model stream cut) within ~2 s;
// queued follow-ups after Stop shown once as a held item (never "已读取" + "没有收到回答");
// a new message typed after Stop goes out at once and is answered once; 「全部发送」; Esc stops;
// a failed stop request (unlock → 503) shows 「停止失败，重试」 and the retry asks again.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { guardedDeleteBot, guardInit, trackBot } from "../realtest/guard.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3310";
const MOCK = process.env.MOCK || "http://127.0.0.1:4314";
const WIDTH = Number(process.env.VIEWPORT || 1280);
const MOBILE = WIDTH < 768;
const OUT = process.env.OUT || path.resolve("audit/stop-queue");
const TAG = process.env.TAG || `w${WIDTH}`;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: MOBILE
    ? { width: WIDTH, height: 844 }
    : { width: WIDTH, height: 820 },
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  ...(MOBILE ? { isMobile: true, hasTouch: true } : {}),
});
const page = await context.newPage();
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const results = [];
let failures = 0;
const check = (ok, what, extra) => {
  results.push({
    ok: Boolean(ok),
    what,
    ...(extra === undefined ? {} : { extra }),
  });
  log(ok ? "PASS" : "FAIL", what, extra ?? "");
  if (!ok) failures++;
};
const shot = (name) =>
  page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => {
  const r = await context.request.fetch(BASE + p, {
    ...o,
    headers: { "content-type": "application/json", ...o.headers },
    data: o.body,
  });
  return { status: r.status(), body: await r.text() };
};
const until = async (fn, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
};
const stats = async () => (await fetch(`${MOCK}/stats`)).json();
const composer = () => page.locator('[aria-label="消息"]:visible').first();
const send = async (text) => {
  await composer().click();
  await composer().fill(text);
  await page.keyboard.press("Enter");
};
const transcript = () =>
  page
    .locator(
      "[data-testid=kept-page][data-visible=true] [data-testid=chat-transcript]",
    )
    .innerText()
    .catch(() => "");
const count = (text, needle) => text.split(needle).length - 1;
const visible = (selector) => page.locator(`${selector}:visible`).count();
let bot;
let thread;
const inbox = async () =>
  JSON.parse((await api(`/api/copilotkit/threads/${thread}/inbox`)).body);
const serverMessages = async () => {
  const b = JSON.parse(
    (await api(`/api/copilotkit/threads/${thread}/messages`)).body,
  );
  return b.messages || b;
};

/** Press Stop (or Esc) and time the visible feedback and the real end of the turn. */
async function stopAndMeasure(how) {
  const before = await stats();
  const t0 = Date.now();
  if (how === "esc") {
    await composer().click();
    await page.keyboard.press("Escape");
  } else
    await page
      .locator(
        '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]:visible',
      )
      .click();
  let feedbackMs = null;
  await until(
    async () => {
      const changed =
        (await visible(
          '[data-testid=kept-page][data-visible=true] [data-testid="composer-stopping"]',
        )) > 0 ||
        (await visible(
          '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]',
        )) === 0;
      if (changed) feedbackMs = Date.now() - t0;
      return changed;
    },
    "stop feedback",
    10000,
  ).catch(() => {});
  let endedMs = null;
  await until(
    async () => {
      const s = await stats();
      const idle =
        !(await inbox()).running &&
        (await visible(
          '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]',
        )) === 0 &&
        (await visible(
          '[data-testid=kept-page][data-visible=true] [data-testid="composer-stopping"]',
        )) === 0;
      if (s.open === 0 && idle) {
        endedMs = Date.now() - t0;
        return true;
      }
      return false;
    },
    "turn ended",
    20000,
  ).catch(() => {});
  const after = await stats();
  return { feedbackMs, endedMs, modelAborted: after.aborted > before.aborted };
}

try {
  await until(
    () =>
      context.request.get(`${BASE}/api/version`).then(
        (r) => r.ok(),
        () => false,
      ),
    "preview ready",
    60000,
  );
  await api("/api/me/onboarding", {
    method: "POST",
    body: JSON.stringify({ completed: true }),
  });
  await api("/api/me/profile", {
    method: "PATCH",
    body: JSON.stringify({ name: "停止排队测试" }),
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await sleep(1000);
  if (
    await page.getByRole("button", { name: "保存并进入", exact: true }).count()
  ) {
    await page.getByPlaceholder("例如：千咲").fill("停止排队测试");
    await page.getByRole("button", { name: "保存并进入", exact: true }).click();
    await page
      .getByRole("button", { name: "保存并进入", exact: true })
      .waitFor({ state: "hidden" });
  }
  await guardInit(api);
  const create = await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      name: `停止排队回归 ${TAG}`,
      title: "临时测试",
      roleDescription: "测试停止和排队。",
      visibility: "private",
    }),
  });
  if (create.status !== 201)
    throw new Error(`create bot ${create.status} ${create.body}`);
  bot = trackBot(JSON.parse(create.body).agent.id);
  await api(`/api/agents/${bot}/model`, {
    method: "PUT",
    body: JSON.stringify({ model: "mock-stop-queue" }),
  });
  await page.goto(`${BASE}/bot?agent=${bot}`, {
    waitUntil: "domcontentloaded",
  });
  await composer().waitFor({ timeout: 45000 });

  // 1. A long answer; one interrupting follow-up (read into the turn) and one plain follow-up (queued).
  await send("LONG 请写一篇1500字的文章，介绍时间管理的方法。");
  await page.waitForURL((u) => /\/channel\/(?!new)/.test(u.pathname), {
    timeout: 15000,
  });
  const channel = page.url().split("/channel/")[1].split(/[?#]/)[0];
  const channelData = JSON.parse((await api(`/api/channels/${channel}`)).body);
  thread = channelData.channel?.threadId || channelData.threadId;
  await page
    .locator(
      '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]:visible',
    )
    .waitFor({ timeout: 15000 });
  await sleep(1500);
  await send("换个方向：补充一个总结表格。");
  await until(
    async () => (await inbox()).items?.some((i) => i.status === "read"),
    "follow-up read into the turn",
    15000,
  );
  await sleep(1500);
  await send("补充：用三句话总结番茄工作法。");
  await page
    .locator(
      '[data-testid=kept-page][data-visible=true] [data-testid="queued-messages"] .queued-msg',
    )
    .first()
    .waitFor({ timeout: 5000 });
  await shot("1-queued");

  // 2. Stop.
  const stop = await stopAndMeasure("click");
  check(
    stop.feedbackMs !== null && stop.feedbackMs <= 300,
    "Stop gives visible feedback within 300 ms",
    stop.feedbackMs,
  );
  check(
    stop.endedMs !== null && stop.endedMs <= 3000,
    "the turn actually ends (model stream closed, server idle) within ~2 s",
    stop.endedMs,
  );
  check(stop.modelAborted, "the model request was aborted, not left streaming");
  await sleep(2500);
  await shot("2-stopped");
  let text = await transcript();
  check(
    !text.includes("没有收到回答"),
    "no 「没有收到回答」 card after a user Stop",
  );
  check(text.includes("已停止"), "the stopped turn shows 「已停止」");
  const pageText = await page.locator("body").innerText();
  check(
    count(pageText, "换个方向：补充一个总结表格。") === 1,
    "the read follow-up is shown exactly once",
    count(pageText, "换个方向：补充一个总结表格。"),
  );
  check(
    count(pageText, "补充：用三句话总结番茄工作法。") === 1,
    "the queued follow-up is shown exactly once",
    count(pageText, "补充：用三句话总结番茄工作法。"),
  );
  check(
    (await visible(
      '[data-testid=kept-page][data-visible=true] [data-testid="queued-read"]',
    )) === 0 || !text.includes("换个方向"),
    "no 「已读取」 on a follow-up that got no reply",
  );
  const held = (await inbox()).items
    .filter((i) => i.status === "paused")
    .map((i) => i.id);
  check(
    held.length === 2,
    "both pre-stop follow-ups are held on the server",
    held.length,
  );
  check(
    (await visible(
      '[data-testid=kept-page][data-visible=true] [data-testid="queued-send-all"]',
    )) === 1,
    "held items offer 「全部发送」",
  );

  // 3. A new message after Stop goes out immediately and is answered once.
  const t3 = Date.now();
  await send("新问题：番茄工作法是什么？");
  await until(
    async () =>
      (await transcript()).includes("收到：新问题：番茄工作法是什么？"),
    "new message answered",
    20000,
  ).catch(() => {});
  text = await transcript();
  check(
    text.includes("收到：新问题：番茄工作法是什么？"),
    "a new message after Stop is sent and answered",
    Date.now() - t3,
  );
  const newBubbles = await page
    .locator(
      '[data-testid=kept-page][data-visible=true] [data-testid="queued-messages"] .queued-msg',
      {
        hasText: "新问题：番茄工作法是什么？",
      },
    )
    .count();
  check(newBubbles === 0, "the new message is not parked as 「已暂停」");
  check(
    count(text, "新问题：番茄工作法是什么？") === 2,
    "the new message appears once (plus once quoted in the reply)",
    count(text, "新问题：番茄工作法是什么？"),
  );
  check(
    (await visible(
      '[data-testid=kept-page][data-visible=true] [data-testid="queued-messages"] .queued-msg',
    )) === 2,
    "the two pre-stop items still wait",
  );
  await shot("3-new-message");

  // 4. 全部发送 sends the held items, each once.
  await page
    .locator(
      '[data-testid=kept-page][data-visible=true] [data-testid="queued-send-all"]:visible',
    )
    .click();
  await until(
    async () => {
      const t = await transcript();
      return (
        t.includes("收到：补充：用三句话总结番茄工作法。") &&
        t.includes("收到：换个方向：补充一个总结表格。")
      );
    },
    "held items answered",
    40000,
  ).catch(() => {});
  await until(
    async () =>
      (await visible(
        '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]',
      )) === 0,
    "idle",
    20000,
  ).catch(() => {});
  await sleep(1500);
  text = await transcript();
  check(
    text.includes("收到：换个方向：补充一个总结表格。") &&
      text.includes("收到：补充：用三句话总结番茄工作法。"),
    "全部发送 answers every held item",
  );
  check(
    (await visible(
      '[data-testid=kept-page][data-visible=true] [data-testid="queued-messages"] .queued-msg',
    )) === 0,
    "no held items left",
  );
  const saved = await serverMessages();
  const users = saved
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
  check(
    users.filter((u) => u.includes("换个方向：补充一个总结表格。")).length ===
      1,
    "stored transcript keeps the read follow-up once",
    users.filter((u) => u.includes("换个方向")).length,
  );
  check(
    users.filter((u) => u.includes("补充：用三句话总结番茄工作法。")).length ===
      1,
    "stored transcript keeps the queued follow-up once",
  );
  const pageAll = await page.locator("body").innerText();
  check(
    count(pageAll, "换个方向：补充一个总结表格。") === 2,
    "on screen: the follow-up once plus once quoted in its reply",
    count(pageAll, "换个方向：补充一个总结表格。"),
  );
  await shot("4-send-all");

  // 5. Esc stops a running turn.
  await send("LONG 再写一篇。");
  await page
    .locator(
      '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]:visible',
    )
    .waitFor({ timeout: 15000 });
  await sleep(1500);
  const esc = await stopAndMeasure("esc");
  check(
    esc.feedbackMs !== null && esc.feedbackMs <= 300,
    "Esc in the composer stops: feedback within 300 ms",
    esc.feedbackMs,
  );
  check(
    esc.endedMs !== null && esc.endedMs <= 3000 && esc.modelAborted,
    "Esc ends the turn within ~2 s",
    esc.endedMs,
  );
  await sleep(1500);
  text = await transcript();
  check(!text.includes("没有收到回答"), "no 「没有收到回答」 after Esc");
  await shot("5-esc");

  // 6. The stop request fails (unlock → 503): 「停止失败，重试」 shows at once; retry asks again and clears it.
  await send("LONG 第三篇。");
  await page
    .locator(
      '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]:visible',
    )
    .waitFor({ timeout: 15000 });
  await sleep(1500);
  let unlockCalls = 0;
  let failUnlock = true;
  await page.route("**/api/copilotkit/threads/*/unlock", (route) => {
    unlockCalls++;
    return failUnlock
      ? route.fulfill({ status: 503, body: "unavailable" })
      : route.continue();
  });
  const t6 = Date.now();
  await page
    .locator(
      '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop"]:visible',
    )
    .click();
  let failedMs = null;
  await until(
    async () =>
      (await visible(
        '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop-failed"]',
      )) > 0,
    "stop-failed shown",
    10000,
  )
    .then(() => {
      failedMs = Date.now() - t6;
    })
    .catch(() => {});
  check(
    failedMs !== null && failedMs <= 2000,
    "a failed stop request (503) shows 「停止失败，重试」 at once",
    failedMs,
  );
  await shot("6-stop-failed");
  // Retry at once (unlock now goes through); if the turn already ended the prompt has cleared itself.
  const callsBeforeRetry = unlockCalls;
  failUnlock = false;
  const retried = await page
    .locator(
      '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop-failed"]:visible',
    )
    .click({ timeout: 1000 })
    .then(
      () => true,
      () => false,
    );
  if (retried) {
    await until(
      async () => unlockCalls > callsBeforeRetry,
      "retry re-sent unlock",
      5000,
    ).catch(() => {});
    check(
      unlockCalls > callsBeforeRetry,
      "「重试」 sends the stop request again",
      unlockCalls - callsBeforeRetry,
    );
  }
  let clearedMs = null;
  const t6b = Date.now();
  await until(
    async () =>
      !(await inbox()).running &&
      (await visible(
        '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop-failed"]',
      )) === 0 &&
      (await visible(
        '[data-testid=kept-page][data-visible=true] [data-testid="composer-send"]',
      )) > 0,
    "turn over, prompt cleared",
    10000,
  )
    .then(() => {
      clearedMs = Date.now() - t6b;
    })
    .catch(() => {});
  check(
    clearedMs !== null,
    "once the turn is over 「停止失败，重试」 clears and Send is back",
    { clearedMs, retried },
  );
  await sleep(500);
  check(
    (await visible(
      '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop-failed"]',
    )) === 0,
    "the prompt does not come back",
  );
  // The next turn starts clean.
  await send("新一轮：你好");
  await until(
    async () => (await transcript()).includes("收到：新一轮：你好"),
    "next turn answered",
    20000,
  ).catch(() => {});
  check(
    (await transcript()).includes("收到：新一轮：你好") &&
      (await visible(
        '[data-testid=kept-page][data-visible=true] [data-testid="composer-stop-failed"]',
      )) === 0,
    "a new turn does not carry 「停止失败，重试」",
  );
  await page.unroute("**/api/copilotkit/threads/*/unlock");
  await sleep(1000);
  await shot("7-retry-ok");
  results.push({ stop, esc, stopFailed: { failedMs, unlockCalls, retried } });
} catch (error) {
  check(
    false,
    `script error: ${error instanceof Error ? error.message : String(error)}`,
  );
  await shot("error").catch(() => {});
} finally {
  fs.writeFileSync(
    path.join(OUT, `${TAG}-results.json`),
    JSON.stringify({ base: BASE, width: WIDTH, failures, results }, null, 2),
  );
  if (bot) await guardedDeleteBot(api, bot).catch(() => {});
  await browser.close();
  log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
