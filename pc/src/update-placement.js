"use strict";
/**
 * 独立更新进度窗口的初始居中位置与边界夹取（DESIGN.md §152）。
 *
 * 主窗口可见时优先居中落在主窗口可见区域（最大化时裁掉 Windows thickFrame 的 -8px 隐形边框）；
 * 主窗口隐藏或最小化时居中落在工作区，并确保窗口宽高不超出工作区、不遮挡任务栏。
 */
const DEFAULT_WIDTH = 880;
const DEFAULT_HEIGHT = 600;
const MIN_WIDTH = 420;
const MIN_HEIGHT = 380;
const MARGIN = 24;

function visibleChatBox(chat, workArea) {
  if (!workArea || !(workArea.width > 0) || !(workArea.height > 0)) return chat;
  const left = Math.max(chat.x, workArea.x);
  const top = Math.max(chat.y, workArea.y);
  const right = Math.min(chat.x + chat.width, workArea.x + workArea.width);
  const bottom = Math.min(chat.y + chat.height, workArea.y + workArea.height);
  if (right - left < MIN_WIDTH || bottom - top < 200) return chat;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function computeUpdateWindowBounds({ chat, chatVisible, workArea, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT }) {
  const maxW = Math.max(MIN_WIDTH, workArea.width - MARGIN * 2);
  const maxH = Math.max(MIN_HEIGHT, workArea.height - MARGIN * 2);
  const w = Math.round(Math.min(width, maxW, workArea.width));
  const h = Math.round(Math.min(height, maxH, workArea.height));
  const anchor = chat && chatVisible ? visibleChatBox(chat, workArea) : workArea;
  const rawX = Math.round(anchor.x + (anchor.width - w) / 2);
  const rawY = Math.round(anchor.y + (anchor.height - h) / 2);
  const minX = workArea.x;
  const maxX = workArea.x + Math.max(0, workArea.width - w);
  const minY = workArea.y;
  const maxY = workArea.y + Math.max(0, workArea.height - h);
  return {
    x: Math.min(maxX, Math.max(minX, rawX)),
    y: Math.min(maxY, Math.max(minY, rawY)),
    width: w,
    height: h,
  };
}

module.exports = { computeUpdateWindowBounds, visibleChatBox, DEFAULT_WIDTH, DEFAULT_HEIGHT, MIN_WIDTH, MIN_HEIGHT, MARGIN };
