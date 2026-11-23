"use strict";
/* 原生窗口：和网页同一套令牌（生成物没过期）、CSP 下没有内联样式 / 脚本、预加载通道最小化。 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const UI = path.join(__dirname, "..", "src", "ui");

test("skyglass tokens are generated from the web styles", () => {
  const css = fs.readFileSync(path.join(UI, "skyglass-tokens.css"), "utf8");
  for (const token of [
    "--glass-1",
    "--ink-primary",
    "--accent",
    "--accent-blue",
    "--r-xl",
    "--shadow-2",
    "@property --canvas-scrim",
    "html.dark",
  ]) {
    assert.ok(css.includes(token), token);
  }
  assert.match(css, /html\.dark\s*\{[^}]*--glass-1/);
  const web = fs.readFileSync(
    path.join(__dirname, "..", "..", "app", "src", "styles", "tokens.css"),
    "utf8",
  );
  const pick = (text) => text.match(/--ink-primary:\s*[^;]+;/g);
  assert.deepStrictEqual(
    pick(css),
    pick(web),
    "重新运行 node scripts/sync-skyglass.mjs",
  );
});

test("sky.js is the web computeSky", () => {
  const { computeSky } = require(path.join(UI, "sky.js"));
  const noon = computeSky(720, false);
  assert.strictEqual(noon.body["--sky-1"], "rgba(111,155,199,1)");
  const night = computeSky(22 * 60, true);
  assert.strictEqual(night.body["--sky-1"], "rgba(7,13,28,1)");
  assert.ok(Number(night.body["--sky-stars"]) > 0);
});

test("native pages are CSP-clean and load the shared tokens", () => {
  for (const file of fs.readdirSync(UI).filter((f) => f.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(UI, file), "utf8");
    assert.match(
      html,
      /Content-Security-Policy" content="default-src 'self'; script-src 'self'/,
      file,
    );
    assert.ok(!/\sstyle="/.test(html), `${file} 有内联 style（CSP 会拦）`);
    assert.ok(
      !/<script>(?!<\/script>)/.test(html) &&
        !/<script(?![^>]*\ssrc=)[^>]*>/.test(html),
      `${file} 有内联脚本`,
    );
    assert.ok(
      html.indexOf("skyglass-tokens.css") < html.indexOf("ui.css"),
      `${file} 先载入令牌`,
    );
    assert.ok(
      html.includes('src="sky.js"') &&
        html.indexOf('src="sky.js"') < html.indexOf('src="ui.js"'),
      `${file} 先载入 sky.js`,
    );
  }
});

test("preload channels stay minimal", () => {
  const local = fs.readFileSync(
    path.join(__dirname, "..", "src", "preload.js"),
    "utf8",
  );
  for (const removed of ["cap:set", "roots:add", "account:logout", "local:set"])
    assert.ok(!local.includes(removed), removed);
  const web = fs.readFileSync(
    path.join(__dirname, "..", "src", "web-preload.js"),
    "utf8",
  );
  assert.ok(
    web.includes("location.origin === origin && window.top === window"),
  );
  const main = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"),
    "utf8",
  );
  for (const ch of [
    "pc:state",
    "pc:set",
    "pc:pick-folders",
    "pc:logout",
    "pc:appearance",
    "pc:enroll",
  ])
    assert.ok(main.includes(`handleWeb("${ch}"`), ch);
  assert.ok(
    !/ipcMain\.handle\("(?!\$\{)/.test(
      main.replace(/function handle(Local|Web|ChatWindow)[\s\S]*?\n}\n/g, ""),
    ),
    "所有 handle 都要经过来源检查",
  );
});
