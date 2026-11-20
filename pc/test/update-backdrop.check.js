"use strict";
/* 更新提示窗毛玻璃背景裁切、外投影扩展与页面样式合同（DESIGN.md §36.5）。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  UPDATE_SHADOW_PAD,
  UPDATE_BACKDROP_BLEED,
  expandUpdateWindowBounds,
  computeBackdropCrop,
} = require("../src/update-backdrop");

const SRC = path.join(__dirname, "..", "src");
const UI = path.join(SRC, "ui");

test("expandUpdateWindowBounds: clip expands symmetrically around card center, dwm keeps exact bounds", () => {
  const card = { x: 420, y: 260, width: 440, height: 240 };
  const clip = expandUpdateWindowBounds(card, "clip");
  assert.equal(clip.pad, UPDATE_SHADOW_PAD);
  assert.equal(clip.width, card.width + UPDATE_SHADOW_PAD * 2);
  assert.equal(clip.height, card.height + UPDATE_SHADOW_PAD * 2);
  assert.equal(clip.x + clip.width / 2, card.x + card.width / 2, "水平中心不变");
  assert.equal(clip.y + clip.height / 2, card.y + card.height / 2, "垂直中心不变");

  const dwm = expandUpdateWindowBounds(card, "dwm");
  assert.deepEqual(dwm, { ...card, pad: 0 });
});

test("computeBackdropCrop: centered card captures card + bleed with exact negative draw offset", () => {
  const chatContent = { x: 100, y: 50, width: 1280, height: 800 };
  const card = { x: 520, y: 330, width: 440, height: 240 };
  const winBounds = expandUpdateWindowBounds(card, "clip");
  const crop = computeBackdropCrop({ chatContent, winBounds, pad: winBounds.pad });
  assert.ok(crop);
  assert.deepEqual(crop.rect, {
    x: 420 - UPDATE_BACKDROP_BLEED,
    y: 280 - UPDATE_BACKDROP_BLEED,
    width: 440 + UPDATE_BACKDROP_BLEED * 2,
    height: 240 + UPDATE_BACKDROP_BLEED * 2,
  });
  assert.equal(crop.drawX, -UPDATE_BACKDROP_BLEED);
  assert.equal(crop.drawY, -UPDATE_BACKDROP_BLEED);
  assert.equal(crop.drawW, crop.rect.width);
  assert.equal(crop.drawH, crop.rect.height);
});

test("computeBackdropCrop: clamps bleed to chat content edges and preserves pixel alignment", () => {
  const chatContent = { x: 0, y: 0, width: 420, height: 300 };
  const card = { x: 10, y: 12, width: 400, height: 280 };
  const winBounds = expandUpdateWindowBounds(card, "clip");
  const crop = computeBackdropCrop({ chatContent, winBounds, pad: winBounds.pad, bleed: 28 });
  assert.ok(crop);
  assert.deepEqual(crop.rect, { x: 0, y: 0, width: 420, height: 300 });
  assert.equal(crop.drawX, -10);
  assert.equal(crop.drawY, -12);
});

test("computeBackdropCrop: returns null when card has no overlap or invalid dimensions", () => {
  const chatContent = { x: 0, y: 0, width: 1000, height: 700 };
  assert.equal(
    computeBackdropCrop({ chatContent, winBounds: { x: 1200, y: 800, width: 440, height: 240 }, pad: 0 }),
    null,
  );
  assert.equal(
    computeBackdropCrop({ chatContent: { x: 0, y: 0, width: 0, height: 700 }, winBounds: { x: 0, y: 0, width: 440, height: 240 }, pad: 0 }),
    null,
  );
  assert.equal(computeBackdropCrop({ chatContent, winBounds: null }), null);
});

test("computeBackdropCrop: key stays identical when parent and child translate together", () => {
  const a = computeBackdropCrop({
    chatContent: { x: 100, y: 80, width: 1200, height: 800 },
    winBounds: { x: 462, y: 342, width: 476, height: 276 },
    pad: 18,
  });
  const b = computeBackdropCrop({
    chatContent: { x: 350, y: 210, width: 1200, height: 800 },
    winBounds: { x: 712, y: 472, width: 476, height: 276 },
    pad: 18,
  });
  assert.ok(a && b);
  assert.equal(a.key, b.key);
});

test("update UI and preload wire frosted glass style, large radius, CSP data images, and backdrop channel", () => {
  const html = fs.readFileSync(path.join(UI, "update.html"), "utf8");
  const css = fs.readFileSync(path.join(UI, "update.css"), "utf8");
  const preload = fs.readFileSync(path.join(SRC, "preload.js"), "utf8");
  assert.match(html, /img-src 'self' data:/, "CSP 允许主进程传入的 data: 背景切片");
  assert.ok(html.indexOf('href="update.css"') > html.indexOf('href="chrome.css"'), "update.css 在 chrome.css 之后覆盖");
  assert.match(html, /id="backdrop-img"/);
  const radius = css.match(/--r-update:\s*(\d+)px/);
  assert.ok(radius && Number(radius[1]) >= 24, "更新弹窗圆角应明显放大（>= 24px）");
  const shadowPad = css.match(/--update-shadow-pad:\s*(\d+)px/);
  assert.equal(Number(shadowPad?.[1]), UPDATE_SHADOW_PAD, "CSS 阴影留白与 JS 窗口外扩值严格一致");
  assert.match(css, /filter:\s*blur\(24px\)/);
  assert.match(css, /prefers-reduced-transparency:\s*reduce/);
  assert.ok(preload.includes("onUpdateBackdrop") && preload.includes('"update:backdrop"'));
});
