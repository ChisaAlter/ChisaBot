"use strict";
/*
 * 本机登录页（PC 和 Android 共用同一份文件）。
 *
 * 宿主：
 *  - PC：preload.js 的 window.chisa（login:probe / login:submit / login:forget / login:open）。
 *  - Android：MainActivity 的 window.ChisaLogin（state / forget / open 同步；probe / login / scan / pair 异步，
 *    结果回调 window.__chisaLoginReply(id, ok, payload)）。Android 额外有「扫码绑定」（DESIGN.md §33）：
 *    scan 打开相机扫网页「绑定手机」的二维码 → pair 用一次性绑定码换设备令牌和会话 → 直接进入主机器人。
 * 流程：规范化地址（补 https://、去掉末尾 /）→ 探测地址通不通 → 直接请求服务器登录网关（和网页登录表单同一个请求，
 * 会话 Cookie 写进客户端）→ 进入应用。错误前缀「[kind] 」决定提示放在哪个输入框旁。
 */
(async function () {
  const $ = (id) => document.getElementById(id);

  const Host = (function () {
    if (window.chisa) {
      return {
        label: "ChisaBot",
        state: () =>
          window.chisa.invoke("state:get").then((s) => ({
            server: s.serverUrl || s.defaultServerUrl || "",
            recent: s.recentServers || [],
            username: s.username || "",
            remember: s.remember !== false,
            version: s.version || "",
          })),
        probe: (serverUrl) => window.chisa.invoke("login:probe", { serverUrl }),
        login: (input) => window.chisa.invoke("login:submit", input),
        forget: (serverUrl) => window.chisa.invoke("login:forget", serverUrl),
        open: () => window.chisa.invoke("login:open"),
        onNotice(callback) {
          window.chisa.onState((kind) => {
            if (typeof kind === "string" && kind.startsWith("notice:")) callback(kind.slice(7));
          });
        },
      };
    }
    if (window.ChisaLogin) {
      const pending = new Map();
      let seq = 0;
      window.__chisaLoginReply = (id, ok, payload) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (ok) entry.resolve(payload ? JSON.parse(payload) : null);
        else entry.reject(new Error(payload));
      };
      const call = (method, arg) =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          window.ChisaLogin[method](id, JSON.stringify(arg || {}));
        });
      return {
        label: "ChisaBot Android",
        state: async () => JSON.parse(window.ChisaLogin.state()),
        probe: (serverUrl) => call("probe", { serverUrl }),
        login: (input) => call("login", input),
        forget: async (serverUrl) => JSON.parse(window.ChisaLogin.forget(serverUrl)),
        open: async () => window.ChisaLogin.open(),
        scan: typeof window.ChisaLogin.scan === "function" ? () => call("scan") : null,
        pair: (link) => call("pair", link),
        onNotice(callback) {
          window.__chisaLoginNotice = callback;
        },
      };
    }
    throw new Error("这个页面只能在 ChisaBot 客户端里打开。");
  })();

  const NOTICES = {
    expired: "登录已过期，请重新登录。",
    logout: "已退出登录。",
    switch: "输入要连接的服务器地址，然后登录。",
    revoked: "这台手机已在网页上被撤销绑定，请重新扫码绑定，或用账号密码登录。",
    unbound: "已退出登录，并解除了这台手机的绑定。",
  };

  const server = $("server");
  const user = $("user");
  const pass = $("pass");
  const remember = $("remember");
  const history = $("history");
  const historyBtn = $("historyBtn");
  let recent = [];
  let lastServer = "";

  /** 和客户端里的规范化一致：补 https://、去掉路径和末尾 /。返回 "" 表示格式不对。 */
  function normalize(text) {
    let value = String(text || "").trim().replace(/\/+$/, "");
    if (!value) return "";
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    try {
      const url = new URL(value);
      if (!url.hostname) return "";
      return url.origin;
    } catch {
      return "";
    }
  }

  function showNotice(kind) {
    const text = NOTICES[kind];
    $("notice").textContent = text || "";
    $("notice").classList.toggle("hidden", !text);
    if (kind === "switch") {
      server.focus();
      server.select();
    }
  }

  // ---------- 错误（就近）----------
  function clearErrors() {
    for (const el of [server, user, pass]) el.removeAttribute("aria-invalid");
    for (const id of ["serverError", "passError", "err"]) {
      $(id).textContent = "";
      $(id).classList.add("hidden");
    }
  }
  function fail(error) {
    const raw = typeof cleanError === "function" ? cleanError(error) : String(error && error.message ? error.message : error);
    const match = raw.match(/^(?:Error: )?\[(\w+)\]\s*([\s\S]*)$/);
    const kind = match ? match[1] : "invalid";
    const text = match ? match[2] : raw;
    if (kind === "unreachable" || kind === "cert" || kind === "invalid") {
      server.setAttribute("aria-invalid", "true");
      $("serverError").textContent = text;
      $("serverError").classList.remove("hidden");
      $("serverHint").classList.add("hidden");
      server.focus();
    } else if (kind === "auth") {
      user.setAttribute("aria-invalid", "true");
      pass.setAttribute("aria-invalid", "true");
      $("passError").textContent = text;
      $("passError").classList.remove("hidden");
      pass.focus();
      pass.select();
    } else {
      $("err").textContent = text;
      $("err").classList.remove("hidden");
    }
  }
  server.addEventListener("input", () => {
    server.removeAttribute("aria-invalid");
    $("serverError").classList.add("hidden");
    $("serverHint").classList.remove("hidden");
  });
  for (const el of [user, pass])
    el.addEventListener("input", () => {
      user.removeAttribute("aria-invalid");
      pass.removeAttribute("aria-invalid");
      $("passError").classList.add("hidden");
    });
  server.addEventListener("blur", () => {
    const value = normalize(server.value);
    if (value) server.value = value;
  });

  // ---------- 显示密码 ----------
  $("toggle").addEventListener("click", () => {
    const visible = pass.type === "password";
    pass.type = visible ? "text" : "password";
    $("toggle").textContent = visible ? "隐藏" : "显示";
    $("toggle").setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    $("toggle").setAttribute("aria-pressed", String(visible));
  });

  // ---------- 最近用过的服务器 ----------
  const X_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function renderHistory() {
    historyBtn.classList.toggle("hidden", recent.length === 0);
    history.textContent = "";
    for (const url of recent) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(url === normalize(server.value)));
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = `pick${url === lastServer ? " is-current" : ""}`;
      pick.textContent = url.replace(/^https:\/\//, "");
      pick.title = url;
      pick.addEventListener("click", () => {
        server.value = url;
        server.dispatchEvent(new Event("input"));
        closeHistory();
        (user.value ? pass : user).focus();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.setAttribute("aria-label", `从列表移除 ${url}`);
      del.title = "从列表移除";
      del.innerHTML = X_ICON;
      del.addEventListener("click", async (event) => {
        event.stopPropagation();
        li.classList.add("leaving");
        recent = (await Host.forget(url).catch(() => recent.filter((s) => s !== url))) || [];
        setTimeout(() => {
          renderHistory();
          if (!recent.length) closeHistory();
        }, 180);
      });
      li.append(pick, del);
      history.append(li);
    }
  }
  function openHistory() {
    if (!recent.length) return;
    renderHistory();
    history.hidden = false;
    historyBtn.setAttribute("aria-expanded", "true");
  }
  function closeHistory() {
    history.hidden = true;
    historyBtn.setAttribute("aria-expanded", "false");
  }
  historyBtn.addEventListener("click", () => (history.hidden ? openHistory() : closeHistory()));
  server.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && history.hidden) {
      event.preventDefault();
      openHistory();
      history.querySelector(".pick")?.focus();
    }
  });
  history.addEventListener("keydown", (event) => {
    const items = [...history.querySelectorAll(".pick")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" && index >= 0) items[Math.min(items.length - 1, index + 1)].focus();
    else if (event.key === "ArrowUp") index <= 0 ? server.focus() : items[index - 1].focus();
    else return;
    event.preventDefault();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !history.hidden) {
      closeHistory();
      server.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!history.hidden && !$("combo").contains(event.target)) closeHistory();
  });

  // ---------- 初始状态 ----------
  let state = { server: "", recent: [], username: "", remember: true, version: "" };
  try {
    state = await Host.state();
  } catch (error) {
    fail(error);
  }
  recent = state.recent || [];
  lastServer = state.server || "";
  server.value = state.server || "";
  user.value = state.username || "";
  remember.checked = state.remember !== false;
  $("foot").textContent = `${Host.label}${state.version ? ` ${state.version}` : ""}`;
  renderHistory();
  const notice = new URLSearchParams(location.search).get("notice") || state.notice || "";
  showNotice(notice);
  Host.onNotice(showNotice);
  // 有扫码绑定（Android）时不自动聚焦输入框：主操作是扫码，不要一打开就弹出键盘。
  if (notice !== "switch" && !Host.scan) (!server.value ? server : !user.value ? user : pass).focus();

  // ---------- 扫码绑定（Android）----------
  if (Host.scan) {
    $("scanBlock").classList.remove("hidden");
    $("submit").classList.add("outline");
    const scanRun = asyncButton($("scanBtn"), { pending: "绑定中…", success: "已绑定", error: "绑定失败" });
    const scanStep = (text) => {
      $("scanStep").textContent = text || "\u00a0";
      $("scanStep").classList.toggle("hidden", !text);
    };
    const scanFail = (error) => {
      const raw = cleanError(error);
      const match = raw.match(/^(?:Error: )?\[(\w+)\]\s*([\s\S]*)$/);
      $("scanError").textContent = match ? match[2] : raw;
      $("scanError").classList.remove("hidden");
    };
    $("scanBtn").addEventListener("click", async () => {
      if ($("scanBtn").dataset.state === "pending") return;
      $("scanError").classList.add("hidden");
      clearErrors();
      closeHistory();
      let link;
      try {
        link = await Host.scan();
      } catch (error) {
        return scanFail(error);
      }
      if (!link || link.cancelled) return;
      server.value = link.server;
      try {
        await scanRun(
          async () => {
            scanStep(`正在绑定到 ${link.server.replace(/^https:\/\//, "")}…`);
            const result = await Host.pair(link);
            scanStep(`已绑定为「${(result && result.deviceName) || "这台手机"}」，正在进入…`);
            return result;
          },
          { keepSuccess: true },
        );
        setTimeout(() => Host.open(), 750);
      } catch (error) {
        scanStep("");
        scanFail(error);
      }
    });
  }

  // ---------- 登录 ----------
  const run = asyncButton($("submit"), { pending: "登录中…", success: "已登录", error: "登录失败" });
  const step = (text) => {
    $("step").textContent = text || "\u00a0";
  };

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if ($("submit").dataset.state === "pending") return;
    clearErrors();
    closeHistory();
    const serverUrl = normalize(server.value);
    if (!serverUrl) return fail(new Error(server.value.trim() ? "[invalid] 服务器地址格式不对，例如 chisabot.example.com:8443" : "[invalid] 请填写服务器地址。"));
    server.value = serverUrl;
    if (!user.value.trim() || !pass.value) return fail(new Error("[auth] 请填写账号和密码。"));
    try {
      const result = await run(
        async () => {
          step("正在检查服务器地址…");
          await Host.probe(serverUrl);
          step("正在验证账号…");
          const result = await Host.login({ serverUrl, username: user.value.trim(), password: pass.value, remember: remember.checked });
          step(result && result.warning ? result.warning : "正在进入…");
          return result;
        },
        { keepSuccess: true },
      );
      pass.value = "";
      setTimeout(() => Host.open(), result && result.warning ? 2600 : 650);
    } catch (error) {
      step("");
      fail(error);
    }
  });
})();
