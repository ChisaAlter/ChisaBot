"use strict";
/**
 * 「新版本已下载」提示窗放在哪（DESIGN.md §36.5）。
 *
 * 主窗口看得见时：当主窗口的子窗口，在主窗口可见区域（最大化时裁到当前显示器工作区内，排除 Windows
 * thickFrame 的 -8px 屏幕外隐形边框）做水平 + 垂直正中央居中，宽 = min(440, 可见宽 − 32)，
 * 跟着主窗口移动 / 改大小 / 进出小窗；不再置顶到所有程序上面，也不压住输入框。
 * 主窗口隐藏到托盘或最小化时：放在主窗口所在显示器工作区的右下角（留 16px），置顶，像系统通知一样。
 * 纯函数，pc/test/compact.check.js 里测。
 */
const MAX_WIDTH = 440;
const MIN_WIDTH = 320;
const TOP_INSET = 64; // 保留导出兼容
const MARGIN = 16;

function visibleChatBox(chat, workArea) {
  if (!workArea || !(workArea.width > 0) || !(workArea.height > 0)) return chat;
  const left = Math.max(chat.x, workArea.x);
  const top = Math.max(chat.y, workArea.y);
  const right = Math.min(chat.x + chat.width, workArea.x + workArea.width);
  const bottom = Math.min(chat.y + chat.height, workArea.y + workArea.height);
  if (right - left < MIN_WIDTH || bottom - top < 200) return chat;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function computeUpdateBounds({ chat, chatVisible, workArea, contentHeight = 260 }) {
  const height = Math.round(Math.min(Math.max(contentHeight, 200), 460));
  if (chat && chatVisible) {
    const box = visibleChatBox(chat, workArea);
    const width = Math.round(Math.max(Math.min(MAX_WIDTH, box.width - MARGIN * 2), Math.min(MIN_WIDTH, box.width)));
    const clampedHeight = Math.min(height, Math.max(200, box.height - MARGIN * 2));
    const x = Math.round(box.x + (box.width - width) / 2);
    const y = Math.round(box.y + Math.max(0, (box.height - clampedHeight) / 2));
    return { x, y, width, height: clampedHeight, attached: true };
  }
  const width = MAX_WIDTH;
  return {
    x: workArea.x + workArea.width - width - MARGIN,
    y: workArea.y + workArea.height - height - MARGIN,
    width,
    height,
    attached: false,
  };
}

module.exports = { computeUpdateBounds, visibleChatBox, MAX_WIDTH, TOP_INSET, MARGIN };
