"use strict";
(async function () {
  const info = await window.chisa.invoke("update:current");
  if (!info) return window.close();
  const $ = (id) => document.getElementById(id);
  if (info.fullInstall) {
    // 外壳（图标、安装组件、Electron）变了：不是普通的覆盖更新，要卸载旧版再全新安装（数据保留）。
    $("title").textContent = "此更新需要重新安装，以更新图标/组件";
    $("restart").textContent = "重新安装";
    $("desc").textContent =
      `ChisaBot ${info.version} 已下载并校验（当前 ${info.currentVersion}）。将卸载旧版后全新安装并重建快捷方式，登录、设置和本机记录都会保留，装好后自动打开；选「稍后」则在下次退出时安装。`;
  } else {
    $("desc").textContent =
      `ChisaBot ${info.version} 已在后台下载并校验完毕（当前 ${info.currentVersion}）。重启后自动安装并重新打开，大约需要十几秒；选「稍后」会在下次退出 ChisaBot 时安装。`;
  }
  const run = asyncButton(
    $("restart"),
    info.fullInstall
      ? { pending: "正在准备…", success: "正在重新安装", error: "安装失败" }
      : { pending: "正在重启…", success: "正在安装", error: "重启失败" },
  );
  $("restart").addEventListener("click", () => {
    run(() => window.chisa.invoke("update:answer", { restart: true }), { keepSuccess: true }).catch(() => {});
  });
  $("later").addEventListener("click", () => window.chisa.invoke("update:answer", { restart: false }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.chisa.invoke("update:answer", { restart: false });
  });
  // 提示窗跟着主窗口放（小窗里会变窄）：量出内容的自然高度报给主进程，窗口高度贴合内容（DESIGN.md §36.5）。
  const fit = () => fitDialog("update:fit");
  let last = 0;
  window.addEventListener("resize", () => {
    if (window.innerWidth === last) return;
    last = window.innerWidth;
    fit();
  });
  last = window.innerWidth;
  fit();
  $("restart").focus();
})();
