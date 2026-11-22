"use strict";
/* 独立更新进度窗口的状态机与页面结构合同（DESIGN.md §152）。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deriveUpdateView } = require("../src/ui/update");

const UI = path.join(__dirname, "..", "src", "ui");

test("deriveUpdateView maps every updater status into deterministic UI state", () => {
  const dlUrl = "https://github.com/ChisaAlter/ChisaBot/releases/latest";

  const checking = deriveUpdateView({ status: "checking", currentVersion: "0.1.179", downloadUrl: dlUrl });
  assert.equal(checking.action, "正在检查更新");
  assert.equal(checking.brand, "ChisaBot");
  assert.equal(checking.progressMode, "indeterminate");
  assert.equal(checking.actionKind, "none");

  const available = deriveUpdateView({ status: "available", version: "0.1.180", downloadUrl: dlUrl });
  assert.equal(available.action, "正在更新");
  assert.equal(available.progressMode, "determinate");
  assert.equal(available.percent, 0);
  assert.equal(available.percentText, "0%");
  assert.equal(available.actionKind, "none");

  const downloading = deriveUpdateView({ status: "downloading", version: "0.1.180", percent: 83.4, downloadUrl: dlUrl });
  assert.equal(downloading.action, "正在更新");
  assert.equal(downloading.brand, "ChisaBot");
  assert.equal(downloading.subtitle, "你的机器人全程继续运行");
  assert.equal(downloading.progressMode, "determinate");
  assert.equal(downloading.percent, 83.4);
  assert.equal(downloading.percentText, "83%");
  assert.equal(downloading.actionKind, "none");
  assert.equal(downloading.downloadUrl, dlUrl);

  const clampedHigh = deriveUpdateView({ status: "downloading", percent: 150 });
  assert.equal(clampedHigh.percent, 100);
  assert.equal(clampedHigh.percentText, "100%");
  const clampedLow = deriveUpdateView({ status: "downloading", percent: -12 });
  assert.equal(clampedLow.percent, 0);
  assert.equal(clampedLow.percentText, "0%");

  const verifying = deriveUpdateView({ status: "verifying", version: "0.1.180" });
  assert.equal(verifying.action, "正在校验更新");
  assert.equal(verifying.percent, 100);
  assert.equal(verifying.percentText, "100%");
  assert.equal(verifying.actionKind, "none");

  const ready = deriveUpdateView({ status: "downloaded", version: "0.1.180", fullInstall: false, downloadUrl: dlUrl });
  assert.equal(ready.action, "更新已就绪");
  assert.equal(ready.brand, "ChisaBot");
  assert.equal(ready.percent, 100);
  assert.equal(ready.actionKind, "ready");
  assert.equal(ready.primaryLabel, "立即重启");
  assert.equal(ready.fullInstall, false);

  const full = deriveUpdateView({ status: "downloaded", version: "0.1.180", fullInstall: true });
  assert.equal(full.action, "此更新需要重新安装，以更新图标/组件");
  assert.equal(full.brand, "");
  assert.equal(full.actionKind, "ready");
  assert.equal(full.primaryLabel, "重新安装");
  assert.equal(full.fullInstall, true);

  const failed = deriveUpdateView({ status: "error", error: "连不上更新服务器" });
  assert.equal(failed.action, "更新未完成");
  assert.equal(failed.subtitle, "连不上更新服务器");
  assert.equal(failed.progressMode, "hidden");
  assert.equal(failed.actionKind, "error");
  assert.equal(failed.primaryLabel, "重新检查");

  const idle = deriveUpdateView({ status: "none", currentVersion: "0.1.179" });
  assert.equal(idle.action, "已是最新版本");
  assert.match(idle.subtitle, /0\.1\.179/);
  assert.equal(idle.progressMode, "hidden");
  assert.equal(idle.actionKind, "idle");
  assert.equal(idle.primaryLabel, "知道了");
});

test("update.html and update.css follow the clean standalone progress layout without legacy backdrop", () => {
  const html = fs.readFileSync(path.join(UI, "update.html"), "utf8");
  const css = fs.readFileSync(path.join(UI, "update.css"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");

  assert.doesNotMatch(html, /backdrop-img|update-frost|dialog-desc/);
  assert.match(html, /class="update-mark"[\s\S]*logo\.png/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /id="download-latest"[^>]*>下载最新版本</);
  assert.match(html, /data-win="minimize"[\s\S]*data-win="toggle-maximize"[\s\S]*data-win="close"/);

  assert.match(css, /body\.update-page[\s\S]*background:\s*#ffffff/);
  assert.match(css, /\.dark body\.update-page[\s\S]*background:\s*#111318/);
  assert.match(css, /\.update-progress-fill[\s\S]*#1680fa/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);

  assert.ok(!preload.includes("update:backdrop") && !preload.includes("update:fit"));
});
