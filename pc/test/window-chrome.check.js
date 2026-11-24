"use strict";
/* 本机小窗口的窗框（DESIGN.md §91）：登录窗 / 本机确认 / 审批 / 更新提示都无边框、圆角、不能改大小。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const chrome = require("../src/window-chrome");

const SRC = path.join(__dirname, "..", "src");
const UI = path.join(SRC, "ui");
const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8");

test("frameMode: Windows (10 and 11) / Linux → clip, macOS → dwm, env override wins", () => {
  assert.equal(chrome.frameMode({ platform: "win32" }), "clip", "Windows 11 也用透明裁切：系统窗框在 125/150% 露浅色边");
  assert.equal(chrome.frameMode({ platform: "linux" }), "clip");
  assert.equal(chrome.frameMode({ platform: "darwin" }), "dwm");
  assert.equal(chrome.frameMode({ platform: "win32", override: "dwm" }), "dwm");
  assert.equal(chrome.frameMode({ platform: "darwin", override: "clip" }), "clip");
  assert.equal(chrome.frameMode({ platform: "win32", override: "nonsense" }), "clip");
});

test("login height fits short work areas", () => {
  assert.equal(chrome.loginHeight(1040), 760);
  assert.equal(chrome.loginHeight(614), 590);
  assert.equal(chrome.loginHeight(300), 480);
  assert.equal(chrome.loginHeight(undefined), 760);
  assert.equal(chrome.loginWindowOptions("clip", { workAreaHeight: 614 }).height, 590);
});

test("login window is created frameless, fixed size, no maximize, both frame modes", () => {
  for (const mode of ["dwm", "clip"]) {
    const o = chrome.loginWindowOptions(mode, { background: "#9dbddc" });
    assert.equal(o.frame, false, `${mode}: 无原生标题栏 / 边框`);
    assert.equal(o.resizable, false, `${mode}: 不能改大小`);
    assert.equal(o.maximizable, false, `${mode}: 不能最大化`);
    assert.equal(o.fullscreenable, false);
    assert.equal(o.minimizable, true, `${mode}: 能最小化`);
    assert.equal(o.width, 460);
    assert.equal(o.height, 760, "没传工作区时 760");
  }
  const dwm = chrome.loginWindowOptions("dwm", { background: "#12203a" });
  assert.equal(dwm.thickFrame, true, "dwm：thickFrame 才有 Windows 11 系统圆角和阴影");
  assert.equal(dwm.transparent, false);
  assert.equal(dwm.backgroundColor, "#12203a");
  const clip = chrome.loginWindowOptions("clip");
  assert.equal(clip.transparent, true, "clip：透明窗口，页面自己裁圆角");
  assert.equal(clip.thickFrame, false);
  assert.equal(clip.backgroundColor, "#00000000", "clip：圆角外不能有底色（白边）");
});

test("main.js builds the login window, update window and local dialogs from window-chrome", () => {
  const openLogin = main.slice(main.indexOf("function openLogin("), main.indexOf("function loginUrl("));
  assert.match(openLogin, /windowChrome\.loginWindowOptions\(FRAME/, "openLogin 用 loginWindowOptions");
  assert.ok(!/frame:\s*true/.test(main), "没有窗口用原生边框");
  const dialogs = main.match(/windowChrome\.dialogWindowOptions\(FRAME/g) || [];
  assert.equal(dialogs.length, 2, "本机确认 / 审批两个弹窗");
  const updateOpts = main.match(/windowChrome\.updateWindowOptions\(/g) || [];
  assert.equal(updateOpts.length, 1, "独立更新进度窗口使用 updateWindowOptions");
  // 所有本机页面都带 ?frame=，页面才知道要不要自己裁圆角。
  for (const page of ["confirm.html", "approval.html"])
    assert.match(
      main,
      new RegExp(
        `loadFile\\(\\s*path\\.join\\(UI,\\s*"${page.replace(".", "\\.")}"\\),\\s*\\{\\s*query:\\s*windowChrome\\.frameQuery\\(FRAME\\),?\\s*\\},?\\s*\\)`,
      ),
      page,
    );
  assert.match(
    main,
    /loadFile\(\s*path\.join\(UI,\s*"update\.html"\),\s*\{\s*query:\s*windowChrome\.frameQuery\("dwm"\),?\s*\},?\s*\)/,
    "更新窗口走不透明无边框 dwm 帧",
  );
  assert.match(
    main,
    /loadFile\(\s*path\.join\(UI,\s*file\),\s*\{\s*query:\s*\{\s*\.\.\.windowChrome\.frameQuery\(FRAME\)/,
    "localWindow（登录窗）带 ?frame=",
  );
  // 只剩两个窗口不走 window-chrome：主窗口（自己的无边框 thickFrame）和 localWindow 的默认值。
  const created = main.match(/new BrowserWindow\(\{/g) || [];
  assert.equal(created.length, 5);
  const chat = main.slice(main.indexOf("function openChat("), main.indexOf("function showOffline("));
  assert.match(chat, /frame: false/);
});

test("local window controls only act on the calling local window and gate maximize by isMaximizable()", () => {
  assert.match(main, /handleLocal\("window:local"/);
  const block = main.slice(main.indexOf('handleLocal("window:local"'), main.indexOf('handleLocal("dialog:fit"'));
  assert.match(block, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  assert.match(block, /win === windows\.chat\) return false/, "不能借本机页面关主窗口");
  assert.match(block, /win\.isMaximizable\(\)/, "仅允许可最大化的本机窗口切换最大化");
  assert.ok(chrome.updateWindowOptions().maximizable === true && chrome.updateWindowOptions().resizable === true);
  const preload = fs.readFileSync(path.join(SRC, "preload.js"), "utf8");
  assert.ok(preload.includes('"window:local"') && preload.includes('"dialog:fit"'));
});

test("login page and update page window controls", () => {
  const html = fs.readFileSync(path.join(UI, "login.html"), "utf8");
  assert.ok(html.indexOf('src="chrome.js"') > 0 && html.indexOf('src="chrome.js"') < html.indexOf("<body"), "chrome.js 在 head 里同步加载");
  assert.ok(html.includes('href="chrome.css"'));
  assert.ok(html.includes('data-win="minimize"') && html.includes('data-win="close"'));
  assert.ok(!html.includes('data-win="maximize"') && !html.includes('data-win="toggle-maximize"'));
  assert.ok(html.indexOf('class="win-bar"') > html.indexOf("</form>"), "窗口按钮在表单后面，Tab 先走表单");

  const updateHtml = fs.readFileSync(path.join(UI, "update.html"), "utf8");
  assert.ok(updateHtml.includes('data-win="minimize"') && updateHtml.includes('data-win="toggle-maximize"') && updateHtml.includes('data-win="close"'));
  assert.ok(updateHtml.indexOf('class="win-bar"') > updateHtml.indexOf("</main>"), "更新页窗口按钮在主体内容后面");

  for (const page of ["approval.html", "confirm.html", "update.html"]) {
    const d = fs.readFileSync(path.join(UI, page), "utf8");
    assert.ok(d.includes('src="chrome.js"') && d.includes('href="chrome.css"'), page);
  }
});

test("clip mode stops the sky propagating to the canvas and rounds the page; dialogs have a single edge", () => {
  const css = fs.readFileSync(path.join(UI, "chrome.css"), "utf8");
  assert.match(css, /--r-window:\s*8px/, "与 Windows 11 系统圆角一致");
  assert.match(css, /html\[data-frame="clip"\]\s*\{\s*background: linear-gradient\(transparent, transparent\)/);
  assert.match(css, /clip-path: inset\(0 round var\(--r-window\)\)/);
  assert.ok(!/rgba\(255,\s*255,\s*255,\s*0?\.[0-9]+\)\s*;?\s*\}/.test(css.split("body::after")[1]?.split("}")[0] || ""), "外沿细线不是白色");
  const dialog = fs.readFileSync(path.join(UI, "dialog.css"), "utf8");
  assert.match(dialog, /body\.dialog-page \{ padding: 0;/, "不再在天空上留一圈");
  assert.match(dialog, /\.dialog-page \.dialog\.auth-card \{ border: 0; border-radius: 0; box-shadow: none; \}/, "卡片不再有自己的描边");
  assert.match(dialog, /\.dialog-code \{ flex: none; max-height: 168px;/, "摘要框按内容定高");
});

test("fitHeight clamps and rounds the measured dialog height", () => {
  assert.equal(chrome.fitHeight(203.2), 204);
  assert.equal(chrome.fitHeight(40), 160);
  assert.equal(chrome.fitHeight(5000), 640);
  assert.equal(chrome.fitHeight(NaN), 0);
  assert.equal(chrome.fitHeight("300"), 0);
});
