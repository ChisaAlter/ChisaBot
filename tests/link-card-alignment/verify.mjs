// Render the application and its real message/link-card components in Chromium.
// node tests/link-card-alignment/verify.mjs --out-dir <evidence directory>
// --source-root can reuse an identical checkout's installed dependencies; the
// candidate link-card.css is loaded from this checkout in that case.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startMockServer } from "../../perf/mock-server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    "source-root": { type: "string" },
    "out-dir": { type: "string" },
    "build-dir": { type: "string" },
  },
});
const source = path.resolve(values["source-root"] || root);
const require = createRequire(path.join(source, "app/package.json"));
const { chromium } = require("playwright-core");
const out = path.resolve(
  values["out-dir"] || path.join(root, "perf/out/link-card-alignment"),
);
fs.mkdirSync(out, { recursive: true });
const temp = values["build-dir"]
  ? path.dirname(values["build-dir"])
  : fs.mkdtempSync(path.join(os.tmpdir(), "chisabot-link-card-alignment-"));
const cssPath = "app/src/components/rich-previews/link-card.css";
const candidateCss = fs.readFileSync(path.join(root, cssPath), "utf8");
const results = [];
let browser;
let mock;
let server;
const urls = [
  "https://github.com/fatwang2/dsh-projects",
  "https://github.com/ChisaAlter/ChisaBot",
  "https://github.com/ChisaAlter/WhaleIsle",
];
const messages = [1, 2, 3].flatMap((count) => [
  {
    id: `user-${count}`,
    role: "user",
    content: `${urls.slice(0, count).join(" ")} 看看这个`,
  },
  {
    id: `assistant-${count}`,
    role: "assistant",
    content: `这是项目链接。\n\n${urls.slice(0, count).join("\n")}`,
  },
]);

async function buildCandidate() {
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  await build({
    root: path.join(source, "app"),
    configFile: path.join(source, "app/vite.config.ts"),
    configLoader: "native",
    cacheDir: path.join(temp, "vite-cache"),
    plugins: [
      {
        name: "candidate-link-card-css",
        enforce: "pre",
        load(id) {
          if (
            id.replaceAll("\\", "/").split("?")[0] ===
            path.join(source, cssPath).replaceAll("\\", "/")
          ) {
            return candidateCss;
          }
        },
      },
    ],
    build: { outDir: path.join(temp, "dist"), emptyOutDir: true },
  });
}

// The repository's Vite configuration uses Bun-native TypeScript loading.
// Run Chromium through Node because Bun's Windows pipe transport hangs.
if (values["build-dir"]) {
  await buildCandidate();
  process.exit(0);
}

try {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.env.BUN_PATH || "bun",
      [
        fileURLToPath(import.meta.url),
        "--source-root",
        source,
        "--out-dir",
        out,
        "--build-dir",
        path.join(temp, "dist"),
      ],
      { stdio: "inherit", windowsHide: true },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Candidate build exited ${code}`)),
    );
  });
  const fixture = JSON.parse(
    fs.readFileSync(path.join(root, "perf/fixtures/api.json"), "utf8"),
  );
  fixture["^/api/conversations/threads/tc2/messages$"] = { messages };
  const fixturePath = path.join(temp, "fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  mock = await startMockServer({
    dist: path.join(temp, "dist"),
    fixtures: fixturePath,
  });
  server = http.createServer((req, res) => {
    const target = new URL(req.url, mock.base);
    if (target.pathname === "/api/link-preview") {
      const url = target.searchParams.get("url");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          preview: {
            url,
            finalUrl: url,
            title: `${new URL(url).pathname.slice(1)}: 项目预览`,
            siteName: "GitHub",
            domain: "github.com",
            description: null,
            image: null,
            imageKind: "none",
            imagePending: false,
            favicon: null,
          },
        }),
      );
      return;
    }
    const upstream = http.request(
      target,
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    timeout: 30000,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : process.platform === "win32"
        ? { channel: "msedge" }
        : {}),
  });
  for (const [width, theme] of [
    [1280, "light"],
    [420, "light"],
    [390, "dark"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      locale: "zh-CN",
    });
    await context.addInitScript(
      (theme) => localStorage.setItem("chisabot-theme", theme),
      theme,
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/channel/c2`);
    await page
      .locator('[data-message-id="user-1"] .lc-card')
      .waitFor({ state: "attached", timeout: 45000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="chat-transcript"] .lc-card')
          .length === 12,
    );
    await page.waitForTimeout(800);
    const metrics = await page.evaluate(() => {
      const bounds = (element) => {
        const { left, right, width } = element.getBoundingClientRect();
        return { left, right, width };
      };
      return [1, 2, 3].flatMap((count) =>
        ["user", "assistant"].map((role) => {
          const row = document.querySelector(
            `[data-message-id="${role}-${count}"]`,
          );
          return {
            role,
            count,
            bubble: bounds(row.querySelector('[data-slot="bubble"]')),
            stack: bounds(row.querySelector(".rp-stack")),
            track: bounds(row.querySelector(".lc-stack-track")),
            cards: [...row.querySelectorAll(".lc-card")].map(bounds),
          };
        }),
      );
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    for (const row of metrics) {
      assert.equal(
        row.cards.length,
        row.count,
        `${width}: ${row.role} card count`,
      );
      if (row.count === 1) {
        const edge = row.role === "user" ? "right" : "left";
        assert.ok(
          Math.abs(row.cards[0][edge] - row.bubble[edge]) <= 1,
          `${width}: ${row.role} single card must align with bubble ${edge}: ${JSON.stringify(row)}`,
        );
      }
      for (const card of row.cards) {
        assert.ok(
          card.left >= -1 && card.right <= width + 1,
          `${width}: ${row.role} ${row.count} cards outside viewport`,
        );
        assert.ok(
          card.left >= row.stack.left - 1 && card.right <= row.stack.right + 1,
          `${width}: ${row.role} ${row.count} cards outside message column`,
        );
      }
    }
    assert.ok(overflow <= 1, `${width}: horizontal page overflow`);
    assert.deepEqual(errors, [], `${width}: browser errors`);
    for (const count of [1, 3]) {
      await page
        .locator(`[data-message-id="user-${count}"]`)
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(out, `${width}-${theme}-${count}-cards.png`),
      });
    }
    // Prove this browser check catches the reported bug without rebuilding or
    // changing source: temporarily restore the previous flex alignment.
    const original = await page.addStyleTag({
      content:
        '.rp-stack[data-align="end"] .lc-stack-track { justify-content: normal; }',
    });
    const oldGap = await page
      .locator('[data-message-id="user-1"]')
      .evaluate(
        (row) =>
          row.querySelector('[data-slot="bubble"]').getBoundingClientRect()
            .right -
          row.querySelector(".lc-card").getBoundingClientRect().right,
      );
    await original.evaluate((element) => element.remove());
    if (width === 1280)
      assert.ok(
        oldGap > 50,
        `Expected previous wide-screen alignment to reproduce, got ${oldGap}px`,
      );
    results.push({
      width,
      theme,
      metrics,
      overflow,
      errors,
      previousSingleCardGap: oldGap,
    });
    await context.close();
  }
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  mock?.close();
  assert.ok(
    path.dirname(temp) === os.tmpdir() &&
      path.basename(temp).startsWith("chisabot-link-card-alignment-"),
  );
  fs.rmSync(temp, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(out, "results.json"),
    JSON.stringify(
      {
        source,
        candidate: root,
        temporaryDirectoryCleaned: !fs.existsSync(temp),
        results,
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    ok: true,
    widths: results.map((row) => row.width),
    output: out,
  }),
);
