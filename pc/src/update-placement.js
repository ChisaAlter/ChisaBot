"use strict";
/**
 * 「新版本已下载」提示窗放在哪（DESIGN.md §36.5，CB-006）。
 *
 * 主窗口看得见时：当主窗口的子窗口，放在主窗口里、顶栏下面靠右（离顶 64px、离右 16px），
 * 宽 = min(440, 主窗口宽 − 32)，跟着主窗口移动 / 改大小 / 进出小窗；不再置顶到所有程序上面，
 * 也不压住居中主导航或底部输入框。
 * 主窗口隐藏到托盘或最小化时：放在主窗口所在显示器工作区的右下角（留 16px），置顶，像系统通知一样。
 * 纯函数，pc/test/compact.check.js 里测。
 */
const MAX_WIDTH = 440;
const MIN_WIDTH = 320;
const TOP_INSET = 64; // 网页顶栏 56 + 8
const MARGIN = 16;

function computeUpdateBounds({ chat, chatVisible, workArea, contentHeight = 260 }) {
  const height = Math.round(Math.min(Math.max(contentHeight, 200), 460));
  if (chat && chatVisible) {
    const width = Math.round(Math.max(Math.min(MAX_WIDTH, chat.width - MARGIN * 2), Math.min(MIN_WIDTH, chat.width)));
    const x = Math.round(chat.x + Math.max(0, chat.width - width - MARGIN));
    const y = Math.round(chat.y + Math.min(TOP_INSET, Math.max(0, chat.height - height)));
    return { x, y, width, height: Math.min(height, Math.max(200, chat.height - (y - chat.y))), attached: true };
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

module.exports = { computeUpdateBounds, MAX_WIDTH, TOP_INSET, MARGIN };
