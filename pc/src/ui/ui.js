"use strict";
/*
 * 本机窗口共用（DESIGN.md §16.5）：
 *  - 外观跟网页一致：深色 / 浅色取 PC 主窗口里网页的设置（主进程转来，没有时跟随系统），
 *    「背景随时间变化」开着时用网页同一个 computeSky 算天空（sky.js 由网页源码生成）；
 *  - 异步按钮状态机（DESIGN.md §2：最少 300ms 进行中，成功 1.5s、失败 2s 后复位）。
 */
const Appearance = (() => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let current = { dark: null, sky: true };
  function apply() {
    const dark = current.dark === null || current.dark === undefined ? media.matches : !!current.dark;
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    const body = document.body.style;
    const root = document.documentElement.style;
    if (current.sky === false || typeof computeSky !== "function") {
      for (const k of ["--sky-1", "--sky-2", "--sky-3", "--sky-4", "--sky-cloud", "--sky-glow", "--sky-glow-x", "--sky-glow-y", "--sky-stars"]) body.removeProperty(k);
      root.removeProperty("--sky-lift");
      root.removeProperty("--sky-muted");
      return;
    }
    const now = new Date();
    const sky = computeSky(now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60, dark);
    for (const k in sky.body) body.setProperty(k, sky.body[k]);
    for (const k in sky.root) root.setProperty(k, sky.root[k]);
  }
  media.addEventListener("change", apply);
  setInterval(apply, 60000);
  apply();
  return {
    set(next) {
      if (next) current = { ...current, ...next };
      apply();
    },
  };
})();

if (window.chisa) {
  window.chisa.invoke("state:get").then((state) => Appearance.set(state?.appearance)).catch(() => {});
  window.chisa.onState(() => window.chisa.invoke("state:get").then((state) => Appearance.set(state?.appearance)).catch(() => {}));
}

function asyncButton(button, labels) {
  const idle = button.innerHTML;
  button.dataset.async = "";
  button.dataset.state = "idle";
  button.innerHTML =
    `<span class="s-idle">${idle}</span>` +
    `<span class="s-pending"><i class="spin"></i>${labels.pending}</span>` +
    `<span class="s-success"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>${labels.success}</span>` +
    `<span class="s-error"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>${labels.error}</span>`;
  return async function run(fn, { keepSuccess = false } = {}) {
    if (button.dataset.state === "pending") return undefined;
    button.dataset.state = "pending";
    button.setAttribute("aria-busy", "true");
    const started = Date.now();
    const settle = () => new Promise((r) => setTimeout(r, Math.max(0, 300 - (Date.now() - started))));
    try {
      const value = await fn();
      await settle();
      button.dataset.state = "success";
      if (!keepSuccess) setTimeout(() => (button.dataset.state = "idle"), 1500);
      return value;
    } catch (error) {
      await settle();
      button.dataset.state = "error";
      setTimeout(() => (button.dataset.state = "idle"), 2000);
      throw error;
    } finally {
      button.removeAttribute("aria-busy");
    }
  };
}

function cleanError(error) {
  const text = error?.message ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/**
 * 弹窗按内容定高（DESIGN.md §91.3）：按自然高度量出对话框内容，报给主进程（审批 / 本机确认用 dialog:fit，
 * 更新提示用 update:fit）。主进程等这一次报上来才显示窗口，所以不会先露出旧高度再跳。
 */
function measureDialog() {
  document.body.classList.add("is-measuring");
  const height = document.querySelector("main").getBoundingClientRect().height;
  document.body.classList.remove("is-measuring");
  return Math.ceil(height);
}
function fitDialog(channel) {
  if (!window.chisa) return;
  const run = () => window.chisa.invoke(channel || "dialog:fit", { height: measureDialog() }).catch(() => {});
  if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(run);
  else run();
}

Object.assign(globalThis, { asyncButton, cleanError, fitDialog });
