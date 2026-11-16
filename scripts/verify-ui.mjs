#!/usr/bin/env node
/**
 * 零下载实机无头浏览器 UI 自验收驱动。
 *
 * 直接复用本机已安装的 Edge / Chrome / Chromium 与根依赖 playwright-core，
 * 在桌面（1440x900）与移动（390x844）双视口下完成页面渲染、交互闭环、
 * 控制台零报错与全页截图检查，并在 finally 中严格回收自有临时目录。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

function browserCandidates() {
  const fromEnv = [
    process.env.CHISABOT_VERIFY_BROWSER_PATH?.trim(),
    process.env.CHROME_PATH?.trim(),
  ].filter(Boolean);

  if (process.platform === "win32") {
    return [
      ...fromEnv,
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
  }

  if (process.platform === "darwin") {
    return [
      ...fromEnv,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }

  return [
    ...fromEnv,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

export function resolveBrowserExecutable() {
  for (const candidate of browserCandidates()) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      if (!existsSync(dir)) return true;
    } catch {
      // Windows 下浏览器刚退出时目录句柄偶有极短释放延迟，稍候重试一次。
    }
    await sleep(60);
  }
  return !existsSync(dir);
}

const SELF_TEST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChisaBot UI 自验收测试夹具</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; display: flex; min-height: 100vh; }
    aside { width: 240px; padding: 16px; border-right: 1px solid #ddd; background: #f5f6f8; }
    main { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
    li { padding: 10px 12px; border-radius: 8px; background: #eef2ff; }
    form { display: flex; gap: 8px; margin-top: auto; }
    input { flex: 1; min-width: 0; padding: 10px 12px; border: 1px solid #bbb; border-radius: 8px; }
    button { padding: 10px 16px; border: 0; border-radius: 8px; background: #1f4b99; color: #fff; cursor: pointer; }
    @media (max-width: 640px) { aside { display: none; } }
  </style>
</head>
<body>
  <aside aria-label="会话列表">ChisaBot 会话</aside>
  <main>
    <h1>对话工作区</h1>
    <ul data-testid="message-list">
      <li>系统：就绪，等待自验收消息</li>
    </ul>
    <form id="composer">
      <input data-testid="prompt-input" placeholder="输入验收消息" />
      <button type="submit" data-testid="send-btn">发送</button>
    </form>
  </main>
  <script>
    const form = document.getElementById("composer");
    const input = document.querySelector('[data-testid="prompt-input"]');
    const list = document.querySelector('[data-testid="message-list"]');
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      const item = document.createElement("li");
      item.textContent = value;
      list.appendChild(item);
      input.value = "";
    });
  </script>
</body>
</html>`;

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SELF_TEST_HTML);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法绑定本地自验收测试端口");
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

export async function runVerifyUi({
  url,
  selfTest = false,
  outDir,
  executablePath = resolveBrowserExecutable(),
}) {
  if (!executablePath) {
    return {
      ok: false,
      exitCode: 2,
      reason: "browser_not_found",
      candidates: browserCandidates(),
    };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "chisabot-verify-ui-"));
  const artifactDir = outDir ? path.resolve(outDir) : tempDir;
  let fixture;
  let browser;
  let context;
  let page;

  const consoleErrors = [];
  const pageErrors = [];
  const server5xx = [];

  try {
    let targetUrl = url;
    if (selfTest) {
      fixture = await startFixtureServer();
      targetUrl = fixture.url;
    }

    if (!targetUrl) {
      throw new Error("必须提供 --url <http-url> 或 --self-test");
    }

    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        ...(process.platform === "linux"
          ? ["--no-sandbox", "--disable-dev-shm-usage"]
          : []),
      ],
    });

    context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });
    page.on("response", (res) => {
      if (res.status() >= 500) {
        server5xx.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    let selfTestRenderedText = "";
    if (selfTest) {
      const sampleText = "自验收实机回路正常";
      await page.fill('[data-testid="prompt-input"]', sampleText);
      await page.click('[data-testid="send-btn"]');
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector('[data-testid="message-list"]')
            ?.textContent?.includes(expected) ?? false,
        sampleText,
        { timeout: 5_000 },
      );
      selfTestRenderedText =
        (await page
          .locator('[data-testid="message-list"] li')
          .last()
          .textContent()) ?? "";
    }

    const desktopMetrics = await page.evaluate(() => ({
      title: document.title,
      interactiveCount: document.querySelectorAll(
        'button, a, input, textarea, [role="button"]',
      ).length,
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth + 2,
    }));

    const desktopPng = path.join(artifactDir, "desktop.png");
    await page.screenshot({ path: desktopPng, fullPage: true });
    const desktopScreenshotBytes = readFileSync(desktopPng).length;

    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.waitForTimeout(100);
    const mobileMetrics = await page.evaluate(() => ({
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth + 2,
    }));

    const mobilePng = path.join(artifactDir, "mobile.png");
    await page.screenshot({ path: mobilePng, fullPage: true });
    const mobileScreenshotBytes = readFileSync(mobilePng).length;

    const ok =
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      server5xx.length === 0 &&
      desktopScreenshotBytes > 1000 &&
      mobileScreenshotBytes > 1000 &&
      !desktopMetrics.horizontalOverflow &&
      !mobileMetrics.horizontalOverflow &&
      (!selfTest || selfTestRenderedText.includes("自验收实机回路正常"));

    const report = {
      ok,
      mode: selfTest ? "self-test" : "url",
      url: targetUrl,
      browserExecutable: executablePath,
      title: desktopMetrics.title,
      interactiveCount: desktopMetrics.interactiveCount,
      desktopOverflow: desktopMetrics.horizontalOverflow,
      mobileOverflow: mobileMetrics.horizontalOverflow,
      desktopScreenshotBytes,
      mobileScreenshotBytes,
      selfTestRenderedText: selfTest ? selfTestRenderedText : undefined,
      consoleErrors,
      pageErrors,
      server5xx,
      tempDir,
      tempDirCleaned: false,
      exitCode: ok ? 0 : 1,
    };

    if (outDir) {
      writeFileSync(
        path.join(artifactDir, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
    }

    return report;
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (fixture?.server) {
      fixture.server.closeAllConnections?.();
      await new Promise((resolve) => fixture.server.close(() => resolve(undefined)));
    }
    await cleanupTempDir(tempDir);
  }
}

async function main() {
  const cleanArgs = process.argv
    .slice(2)
    .filter((arg, index) => !(index === 0 && arg === "--"));

  const { values } = parseArgs({
    args: cleanArgs,
    options: {
      url: { type: "string" },
      "out-dir": { type: "string" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help || (!values.url && !values["self-test"])) {
    console.log(
      "用法: node scripts/verify-ui.mjs (--self-test | --url <http-url> [--out-dir <dir>])",
    );
    process.exit(values.help ? 0 : 1);
  }

  const report = await runVerifyUi({
    url: values.url,
    selfTest: values["self-test"],
    outDir: values["out-dir"],
  });

  const finalized = {
    ...report,
    tempDirCleaned: report.tempDir ? !existsSync(report.tempDir) : true,
  };
  console.log(JSON.stringify(finalized, null, 2));
  process.exit(finalized.exitCode);
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url &&
  path.basename(fileURLToPath(import.meta.url)) === "verify-ui.mjs";

if (isEntrypoint) {
  await main();
}
