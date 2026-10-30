// 宽度变化 → 聊天记录回归（DESIGN.md §106）。
//
// 起因：拖右栏把手（或收起右栏、缩窗口）时整列重新换行，而 `SettleAtEnd` 的 «跟着变» 留白（§94.6）把内容列的
// min-height 钉在「更窄那次换行」的高度上，拖回来也不会降——松手时整段对话被推到上面，视口里只剩一片空白。
//
// 跑法（真浏览器，指向一段已经比一屏长的对话）：
//   BASE=http://127.0.0.1:3097 CHANNEL=channel_... ASSERT=1 node tests/rail-drag-scroll/drag-scroll.mjs
//   SCENARIO=bottom|mid|collapse   （默认 bottom，可逗号分隔跑多个：SCENARIO=bottom,mid,collapse）
//
// 判据：
//   bottom   把手往返（右栏 380 → 500 → 380）之后：内容列高度回到拖动前 ±8px、留白 < 8px、离底 ≤4px、
//            最后一条消息在视口里。
//   mid      翻在历史中间拖动：第一条可见消息不变（同一个 id、屏幕位置 ±2px），留白不增长。
//   collapse 右栏收起再展开（Ctrl+Alt+B，260ms 宽度动画）：同 bottom。
// 不满足就退出码 1（ASSERT=1 时）。CHROME 可以指定 chromium 可执行文件；镜像里默认用 /ms-playwright。
import { existsSync, readdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE;
const CHANNEL = process.env.CHANNEL;
if (!BASE || !CHANNEL) {
  console.error(
    "需要 BASE 和 CHANNEL：BASE=http://127.0.0.1:3097 CHANNEL=channel_... node tests/rail-drag-scroll/drag-scroll.mjs",
  );
  process.exit(2);
}
const WIDTH = Number(process.env.WIDTH || 1280);
const HEIGHT = Number(process.env.HEIGHT || 800);
const DRAG = Number(process.env.DRAG || 120);
const ASSERT = process.env.ASSERT === "1";
const SCENARIOS = (process.env.SCENARIO || "bottom").split(",").map((s) => s.trim()).filter(Boolean);

function launchOptions() {
  if (process.env.CHROME) return { executablePath: process.env.CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  if (existsSync("/ms-playwright")) {
    const dir = readdirSync("/ms-playwright").find((d) => d.startsWith("chromium-") && !d.includes("headless"));
    if (dir) return { executablePath: `/ms-playwright/${dir}/chrome-linux64/chrome`, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  }
  return { channel: "chrome", args: ["--no-sandbox"] };
}

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, locale: "zh-CN" });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror", String(error).slice(0, 200)));

await page.goto(`${BASE}/channel/${CHANNEL}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid=kept-page][data-visible=true] [data-testid="chat-transcript"]', { timeout: 30000 });
await page.waitForTimeout(2500);

const sample = (label) =>
  page.evaluate((label) => {
    const content = document.querySelector('[data-testid=kept-page][data-visible=true] [data-testid="chat-transcript"]');
    let viewport = content?.parentElement;
    while (viewport) {
      if (/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)) break;
      viewport = viewport.parentElement;
    }
    const slack = document.querySelector("[data-chat-slack]");
    const rows = [...(content?.querySelectorAll("[data-testid=kept-page][data-visible=true] [data-message-id]") ?? [])];
    const view = viewport?.getBoundingClientRect();
    const firstVisible = view ? rows.find((row) => row.getBoundingClientRect().bottom > view.top + 1) : null;
    const last = rows.at(-1)?.getBoundingClientRect();
    return {
      label,
      rail: Math.round(document.getElementById("chisabot-panel-rail")?.getBoundingClientRect().width ?? 0),
      scrollTop: viewport ? Math.round(viewport.scrollTop) : null,
      scrollHeight: viewport?.scrollHeight ?? null,
      clientHeight: viewport?.clientHeight ?? null,
      gap: viewport ? Math.round(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) : null,
      contentH: content ? Math.round(content.getBoundingClientRect().height) : null,
      slackH: slack ? Math.round(slack.getBoundingClientRect().height) : null,
      minH: content?.style.minHeight ?? "",
      firstId: firstVisible?.dataset.messageId ?? null,
      firstOffset: firstVisible && view ? Math.round(firstVisible.getBoundingClientRect().top - view.top) : null,
      lastVisible: Boolean(last && view && last.bottom > view.top + 1 && last.top < view.bottom),
    };
  }, label);

const scrollTo = (where) =>
  page.evaluate((where) => {
    const content = document.querySelector('[data-testid=kept-page][data-visible=true] [data-testid="chat-transcript"]');
    let viewport = content?.parentElement;
    while (viewport) {
      if (/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)) break;
      viewport = viewport.parentElement;
    }
    if (!viewport) return;
    viewport.scrollTop = where === "bottom" ? viewport.scrollHeight : Math.round((viewport.scrollHeight - viewport.clientHeight) * 0.45);
  }, where);

async function dragRail() {
  const handle = await page.locator(".glass-rail-handle").boundingBox();
  if (!handle) throw new Error("没有找到右栏把手（.glass-rail-handle）：窗口要 ≥1280 宽、右栏要展开");
  const y = handle.y + handle.height / 2;
  const x = handle.x + handle.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(x - (step * DRAG) / 10, y);
    await page.waitForTimeout(80);
  }
  const widest = await sample("dragged");
  for (let step = 10; step >= 0; step -= 1) {
    await page.mouse.move(x - (step * DRAG) / 10, y);
    await page.waitForTimeout(80);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
  return widest;
}

const results = [];
/**
 * 贴底场景（bottom / collapse）：高度要回到原样、留白收干净、还在底部、最后一条还在视口里。
 * 翻在中间（mid）：位置由浏览器的滚动锚定接管——同一屏、第一条可见消息不动，另外不留新留白。
 */
function judge(scenario, before, after, extra = []) {
  const stickToBottom = scenario !== "mid";
  const failures = [
    [Math.abs((after.contentH ?? 0) - (before.contentH ?? 0)) > 8, `内容列高度没有回到原样：${before.contentH} → ${after.contentH}`],
    [(after.slackH ?? 0) >= 8, `底部留白没有收掉：${after.slackH}px`],
    [stickToBottom && (after.gap ?? 99) > 4, `没有贴在底部：离底 ${after.gap}px`],
    [stickToBottom && !after.lastVisible, "最后一条消息不在视口里（被推到上面 / 视口落在留白里）"],
    ...extra,
  ];
  for (const [failed, message] of failures) if (failed) console.log(`✗ [${scenario}] ${message}`);
  const ok = failures.every(([failed]) => !failed);
  results.push({
    scenario,
    ok,
    line: `${ok ? "PASS" : "FAIL"} [${scenario}] ${before.contentH}px → ${after.contentH}px，留白 ${after.slackH}px，离底 ${after.gap}px`,
  });
  console.log(results.at(-1).line);
}
for (const scenario of SCENARIOS) {
  if (scenario === "bottom") {
    await scrollTo("bottom");
    await page.waitForTimeout(600);
    const before = await sample("before");
    await dragRail();
    const after = await sample("after");
    console.table([before, after]);
    judge(scenario, before, after);
  } else if (scenario === "mid") {
    await scrollTo("mid");
    await page.waitForTimeout(700);
    const before = await sample("before");
    await dragRail();
    const after = await sample("after");
    console.table([before, after]);
    judge(scenario, before, after, [
      [after.firstId !== before.firstId, `第一条可见消息换了：${before.firstId} → ${after.firstId}`],
      [
        Math.abs((after.firstOffset ?? 0) - (before.firstOffset ?? 0)) > 2,
        `第一条可见消息被移动了 ${(after.firstOffset ?? 0) - (before.firstOffset ?? 0)}px`,
      ],
    ]);
  } else if (scenario === "collapse") {
    await scrollTo("bottom");
    await page.waitForTimeout(600);
    const before = await sample("before");
    await page.keyboard.press("Control+Alt+KeyB");
    await page.waitForTimeout(900);
    await page.keyboard.press("Control+Alt+KeyB");
    await page.waitForTimeout(900);
    const after = await sample("after");
    console.table([before, after]);
    judge(scenario, before, after);
  } else {
    console.log(`跳过未知场景 ${scenario}`);
  }
}

// 每个场景在 judge() 里当场打印 PASS / FAIL；这里只收总账。
if (results.some((result) => !result.ok) && ASSERT) process.exitCode = 1;

await browser.close();
