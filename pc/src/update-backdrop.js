"use strict";
/**
 * 更新提示窗（update.html）的毛玻璃实时背景裁切与外投影留白计算。
 *
 * Electron 透明子窗口里的 CSS backdrop-filter 只能模糊本窗口内部像素，无法穿透到父窗口（windows.chat）。
 * 因此主进程通过 windows.chat.webContents.capturePage(rect) 截取弹窗背后一块含 bleed 溢出边的区域，
 * 交给 update.html 渲染在卡片底层再做高斯模糊 + 磨砂罩层，实现与网页卡片一致的真磨砂质感；
 * 脱离主窗口（托盘右下角）时返回 null，页面退回中性深/浅磨砂质感底面。
 */

/** clip 模式（Windows / Linux 透明窗）四周留给柔和外投影的透明边距（DIP），需大于投影模糊半径以免裁边。 */
const UPDATE_SHADOW_PAD = 28;
/** 截图四周多截的溢出像素（DIP），保证 blur(24px) 贴近卡片边缘时不吸入透明/黑边。 */
const UPDATE_BACKDROP_BLEED = 32;

/**
 * 把卡片区域（computeUpdateBounds 返回值）扩展为实际 BrowserWindow 区域：
 * clip 模式四边对称外扩 UPDATE_SHADOW_PAD（保持卡片中心点不变）；dwm 模式（macOS）不扩。
 */
function expandUpdateWindowBounds(cardBounds, frameMode) {
  const pad = frameMode === "clip" ? UPDATE_SHADOW_PAD : 0;
  return {
    x: Math.round(cardBounds.x - pad),
    y: Math.round(cardBounds.y - pad),
    width: Math.round(cardBounds.width + pad * 2),
    height: Math.round(cardBounds.height + pad * 2),
    pad,
  };
}

/**
 * 计算 updateWindow 卡片背后对应到 windows.chat 内容区的截图矩形与绘制偏移（DIP）。
 * 卡片与主窗口无交集时返回 null。
 */
function computeBackdropCrop({ chatContent, winBounds, pad = 0, bleed = UPDATE_BACKDROP_BLEED } = {}) {
  if (!chatContent || !winBounds) return null;
  const cw = Math.floor(chatContent.width);
  const ch = Math.floor(chatContent.height);
  if (cw < 2 || ch < 2) return null;

  const cardX = winBounds.x + pad;
  const cardY = winBounds.y + pad;
  const cardW = winBounds.width - pad * 2;
  const cardH = winBounds.height - pad * 2;
  if (cardW < 2 || cardH < 2) return null;

  const relX = cardX - chatContent.x;
  const relY = cardY - chatContent.y;
  const cropLeft = Math.max(0, Math.floor(relX - bleed));
  const cropTop = Math.max(0, Math.floor(relY - bleed));
  const cropRight = Math.min(cw, Math.ceil(relX + cardW + bleed));
  const cropBottom = Math.min(ch, Math.ceil(relY + cardH + bleed));
  const cropW = cropRight - cropLeft;
  const cropH = cropBottom - cropTop;
  if (cropW < 2 || cropH < 2) return null;

  return {
    rect: { x: cropLeft, y: cropTop, width: cropW, height: cropH },
    drawX: Math.round(cropLeft - relX),
    drawY: Math.round(cropTop - relY),
    drawW: cropW,
    drawH: cropH,
    key: `${Math.round(relX)},${Math.round(relY)},${Math.round(cardW)},${Math.round(cardH)},${cw},${ch}`,
  };
}

module.exports = {
  UPDATE_SHADOW_PAD,
  UPDATE_BACKDROP_BLEED,
  expandUpdateWindowBounds,
  computeBackdropCrop,
};
