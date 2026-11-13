"use strict";
/*
 * 本机小窗口的窗框（DESIGN.md §91）。在 <head> 里同步加载，第一帧之前就定好：
 *  - <html data-frame="dwm|clip">：主进程按系统选的窗框（?frame=，src/window-chrome.js）。clip = Windows 10，
 *    窗口透明，chrome.css 把整页裁成圆角；dwm = Windows 11，圆角和阴影由系统画，页面铺满到边。
 *  - [data-win="minimize|close"] 按钮：只控制本窗口（主进程核对来源）。
 */
(function () {
  var match = /[?&]frame=(dwm|clip)(?:&|$)/.exec(location.search);
  document.documentElement.dataset.frame = match ? match[1] : "dwm";
  // macOS 用原生红绿灯（titleBarStyle=hiddenInset，window-chrome.js）：本页 .win-ctrl 按钮按 data-os 隐藏。
  document.documentElement.dataset.os = /Mac/.test(navigator.userAgent) ? "mac" : "";
  document.addEventListener("DOMContentLoaded", function () {
    var buttons = document.querySelectorAll("[data-win]");
    for (var i = 0; i < buttons.length; i++) {
      (function (button) {
        button.addEventListener("click", function () {
          if (window.chisa) window.chisa.invoke("window:local", button.dataset.win).catch(function () {});
        });
      })(buttons[i]);
    }
  });
})();
