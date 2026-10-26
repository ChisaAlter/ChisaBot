"use strict";

(() => {
  if (window.location.pathname === "/login" || window.location.pathname.startsWith("/auth/") || document.getElementById("chisabot-account-control")) return;

  const originalFetch = window.fetch.bind(window);
  let redirecting = false;
  const authChannel = typeof window.BroadcastChannel === "function" ? new window.BroadcastChannel("chisabot-auth") : null;

  function goToLogin(preservePath = true) {
    if (redirecting) return;
    redirecting = true;
    if (!preservePath) authChannel?.postMessage("logout");
    const next = window.location.pathname + window.location.search + window.location.hash;
    window.location.replace(preservePath ? "/login?next=" + encodeURIComponent(next) : "/login");
  }
  if (authChannel) authChannel.onmessage = (event) => {
    if (event.data === "logout") goToLogin(false);
  };

  // Read only the small authentication error copy. The app keeps the original
  // response, including its SSE stream, headers, status and body.
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    let path = "";
    let method = "GET";
    try {
      const request = args[0];
      const requestUrl = request instanceof Request ? request.url : String(request);
      const url = new URL(requestUrl, window.location.href);
      if (url.origin === window.location.origin) path = url.pathname;
      method = (args[1]?.method || (request instanceof Request ? request.method : "GET")).toUpperCase();
    } catch {
      // Fetch accepted the request; unrelated input formats need no interception.
    }
    if (path === "/api/auth/sign-out" && method === "POST" && response.ok) {
      goToLogin(false);
    } else if (path && response.status === 401 && (response.headers.get("Content-Type") || "").includes("application/json")) {
      const data = await response.clone().json().catch(() => null);
      if (data?.openbotAuthRequired === true) goToLogin();
    }
    return response;
  };

  let checkingSession = false;
  let lastSessionCheck = 0;
  async function checkSession() {
    if (document.visibilityState !== "visible" || checkingSession || redirecting || Date.now() - lastSessionCheck < 2000) return;
    checkingSession = true;
    lastSessionCheck = Date.now();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await originalFetch("/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });
      const data = response.ok ? await response.json().catch(() => null) : null;
      if (data?.authenticated === false) goToLogin();
    } catch {
      // A network interruption does not establish that a session has expired.
    } finally {
      window.clearTimeout(timeout);
      checkingSession = false;
    }
  }
  window.setInterval(checkSession, 45000);
  window.addEventListener("focus", checkSession);
  document.addEventListener("visibilitychange", checkSession);

  function mountAccountControl() {
    if (document.getElementById("chisabot-account-control")) return;
    const host = document.createElement("div");
    host.id = "chisabot-account-control";
    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/auth/login.css";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-signout";
    button.textContent = "退出登录";
    button.setAttribute("aria-label", "退出 ChisaBot 登录");
    shadow.append(stylesheet, button);
    document.body.append(host);

    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = "正在退出…";
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch("/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Accept": "application/json" },
          signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if ((response.ok && data?.ok === true) || response.status === 401) {
          goToLogin(false);
          return;
        }
        throw new Error("Logout failed");
      } catch {
        button.disabled = false;
        button.textContent = "退出失败，重试";
        button.setAttribute("aria-label", "退出登录失败，点击重试");
      } finally {
        window.clearTimeout(timeout);
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAccountControl, { once: true });
  else mountAccountControl();
})();
