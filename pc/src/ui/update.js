"use strict";

/**
 * 把更新器状态映射为更新页面的唯一展示模型（纯函数，单测可直接校验）。
 */
function deriveUpdateView(info) {
  const status = info?.status || "idle";
  const version = typeof info?.version === "string" ? info.version.trim() : "";
  const currentVersion = typeof info?.currentVersion === "string" ? info.currentVersion.trim() : "";
  const fullInstall = Boolean(info?.fullInstall);
  const rawPercent = Number(info?.percent);
  const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : 0;
  const rounded = Math.round(percent);
  const downloadUrl = typeof info?.downloadUrl === "string" ? info.downloadUrl.trim() : "";

  if (status === "checking") {
    return {
      status,
      action: "正在检查更新",
      brand: "ChisaBot",
      subtitle: "你的机器人全程继续运行",
      progressMode: "indeterminate",
      percent: 0,
      percentText: "正在检查…",
      actionKind: "none",
      primaryLabel: "",
      fullInstall,
      downloadUrl,
    };
  }

  if (status === "available") {
    return {
      status,
      action: "正在更新",
      brand: "ChisaBot",
      subtitle: "你的机器人全程继续运行",
      progressMode: "determinate",
      percent: 0,
      percentText: "0%",
      actionKind: "none",
      primaryLabel: "",
      fullInstall,
      downloadUrl,
    };
  }

  if (status === "downloading") {
    return {
      status,
      action: "正在更新",
      brand: "ChisaBot",
      subtitle: "你的机器人全程继续运行",
      progressMode: "determinate",
      percent,
      percentText: `${rounded}%`,
      actionKind: "none",
      primaryLabel: "",
      fullInstall,
      downloadUrl,
    };
  }

  if (status === "verifying") {
    return {
      status,
      action: "正在校验更新",
      brand: "ChisaBot",
      subtitle: "正在校验安装包签名，你的机器人全程继续运行",
      progressMode: "determinate",
      percent: 100,
      percentText: "100%",
      actionKind: "none",
      primaryLabel: "",
      fullInstall,
      downloadUrl,
    };
  }

  if (status === "downloaded") {
    if (fullInstall) {
      // 外壳（图标、安装组件、Electron）变了：不是普通的覆盖更新，要卸载旧版再全新安装（数据保留）。
      return {
        status,
        action: "此更新需要重新安装，以更新图标/组件",
        brand: "",
        subtitle: version
          ? `ChisaBot ${version} 将卸载旧版并全新安装（登录与数据均保留），装好后自动打开`
          : "将卸载旧版并全新安装（登录与数据均保留），装好后自动打开",
        progressMode: "determinate",
        percent: 100,
        percentText: "100%",
        actionKind: "ready",
        primaryLabel: "重新安装",
        fullInstall: true,
        downloadUrl,
      };
    }
    return {
      status,
      action: "更新已就绪",
      brand: "ChisaBot",
      subtitle: version
        ? `ChisaBot ${version} 已准备就绪，重启后自动安装，你的机器人全程继续运行`
        : "新版本已准备就绪，重启后自动安装，你的机器人全程继续运行",
      progressMode: "determinate",
      percent: 100,
      percentText: "100%",
      actionKind: "ready",
      primaryLabel: "立即重启",
      fullInstall: false,
      downloadUrl,
    };
  }

  if (status === "error") {
    return {
      status,
      action: "更新未完成",
      brand: "ChisaBot",
      subtitle: info?.error ? String(info.error) : "下载或校验未成功，可重试或直接下载最新版本。",
      progressMode: "hidden",
      percent: 0,
      percentText: "",
      actionKind: "error",
      primaryLabel: "重新检查",
      fullInstall: false,
      downloadUrl,
    };
  }

  return {
    status,
    action: "已是最新版本",
    brand: "ChisaBot",
    subtitle: currentVersion ? `当前已运行 ChisaBot ${currentVersion} 最新版本` : "当前已是最新版本",
    progressMode: "hidden",
    percent: 100,
    percentText: "",
    actionKind: "idle",
    primaryLabel: "知道了",
    fullInstall: false,
    downloadUrl,
  };
}

if (typeof document !== "undefined") {
  (async () => {
    const $ = (id) => document.getElementById(id);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let restartRunner = null;
    let boundFullInstall = null;
    let focusedReadyOnce = false;
    let lastStatus = null;

    function pulseCopy() {
      if (reducedMotion.matches) return;
      for (const el of [$("title"), $("subtitle")]) {
        if (!el || typeof el.animate !== "function") continue;
        el.animate(
          [
            { opacity: 0.45, transform: "translateY(3px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
    }

    function ensureRestartRunner(fullInstall) {
      const btn = $("restart");
      if (!btn) return null;
      if (restartRunner && boundFullInstall === fullInstall) return restartRunner;
      boundFullInstall = fullInstall;
      btn.textContent = fullInstall ? "重新安装" : "立即重启";
      restartRunner = asyncButton(
        btn,
        fullInstall
          ? { pending: "正在准备…", success: "正在重新安装", error: "安装失败" }
          : { pending: "正在重启…", success: "正在安装", error: "重启失败" },
      );
      return restartRunner;
    }

    function render(info) {
      if (!info) return;
      const view = deriveUpdateView(info);
      const statusChanged = lastStatus !== null && lastStatus !== view.status;
      lastStatus = view.status;
      $("title-action").textContent = view.action;
      const brandEl = $("title-brand");
      brandEl.textContent = view.brand;
      brandEl.classList.toggle("hidden", !view.brand);
      $("subtitle").textContent = view.subtitle;
      if (statusChanged) pulseCopy();

      const progressEl = $("progress");
      const fillEl = $("progress-fill");
      const percentEl = $("percent");
      if (view.progressMode === "hidden") {
        progressEl.classList.add("hidden");
        percentEl.classList.add("hidden");
      } else {
        progressEl.classList.remove("hidden");
        progressEl.dataset.mode = view.progressMode;
        if (view.progressMode === "indeterminate") {
          progressEl.removeAttribute("aria-valuenow");
          fillEl.style.transform = "";
        } else {
          progressEl.setAttribute("aria-valuenow", String(Math.round(view.percent)));
          fillEl.style.transform = `scaleX(${(view.percent / 100).toFixed(4)})`;
        }
        percentEl.classList.toggle("hidden", !view.percentText);
        percentEl.textContent = view.percentText;
      }

      const actionsWrapEl = $("actions-wrap");
      const laterEl = $("later");
      const restartEl = $("restart");
      const retryEl = $("retry");
      const closeOkEl = $("close-ok");

      const showActions = view.actionKind !== "none";
      const showReady = view.actionKind === "ready";
      const showError = view.actionKind === "error";
      const showIdle = view.actionKind === "idle";
      if (actionsWrapEl) {
        actionsWrapEl.dataset.open = showActions ? "true" : "false";
        actionsWrapEl.inert = !showActions;
        actionsWrapEl.setAttribute("aria-hidden", String(!showActions));
      }
      laterEl.classList.toggle("hidden", !showReady);
      restartEl.classList.toggle("hidden", !showReady);
      retryEl.classList.toggle("hidden", !showError);
      closeOkEl.classList.toggle("hidden", !showIdle);

      if (showReady) {
        ensureRestartRunner(view.fullInstall);
        if (!focusedReadyOnce) {
          focusedReadyOnce = true;
          restartEl.focus();
        }
      } else {
        focusedReadyOnce = false;
      }

      const downloadEl = $("download-latest");
      if (downloadEl) downloadEl.classList.toggle("hidden", !view.downloadUrl);
    }

    const retryRunner = asyncButton($("retry"), {
      pending: "检查中…",
      success: "已检查",
      error: "检查失败",
    });

    $("restart").addEventListener("click", () => {
      const runner = ensureRestartRunner(Boolean(boundFullInstall));
      if (!runner) return;
      runner(() => window.chisa.invoke("update:answer", { restart: true }), { keepSuccess: true }).catch(() => {});
    });
    $("later").addEventListener("click", () => window.chisa.invoke("update:answer", { restart: false }));
    $("retry").addEventListener("click", () => {
      retryRunner(() => window.chisa.invoke("update:retry")).catch(() => {});
    });
    $("close-ok").addEventListener("click", () => window.close());
    $("download-latest").addEventListener("click", () => {
      window.chisa.invoke("update:download-latest").catch(() => {});
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") window.chisa.invoke("update:answer", { restart: false });
    });

    window.chisa.onUpdateState?.(render);
    const initial = await window.chisa.invoke("update:current");
    if (!initial) return window.close();
    render(initial);
  })();
}

if (typeof module !== "undefined") module.exports = { deriveUpdateView };
