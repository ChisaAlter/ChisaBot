

(() => {
  const form = document.getElementById("login-form");
  const username = document.getElementById("username");
  const password = document.getElementById("password");
  const remember = document.getElementById("remember");
  const toggle = document.getElementById("password-toggle");
  const submit = document.getElementById("login-submit");
  const submitLabel = document.getElementById("submit-label");
  const error = document.getElementById("login-error");
  let submitting = false;

  function safeNext(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname === "/login" || url.pathname.startsWith("/auth/")) return "/";
      return url.pathname + url.search + url.hash;
    } catch {
      return "/";
    }
  }

  const next = safeNext(new URLSearchParams(window.location.search).get("next"));

  function setError(message, invalidCredentials = false) {
    error.textContent = message;
    for (const input of [username, password]) {
      if (invalidCredentials) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  function setBusy(busy) {
    submitting = busy;
    submit.disabled = busy;
    submit.setAttribute("aria-busy", String(busy));
    submitLabel.textContent = busy ? "正在登录" : "登录";
  }

  toggle.addEventListener("click", () => {
    const visible = password.type === "password";
    password.type = visible ? "text" : "password";
    toggle.textContent = visible ? "隐藏" : "显示";
    toggle.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    toggle.setAttribute("aria-pressed", String(visible));
  });

  for (const input of [username, password]) {
    input.addEventListener("input", () => setError(""));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!form.reportValidity()) return;
    setError("");
    setBusy(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ username: username.value.trim(), password: password.value, remember: remember.checked, next }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok === true) {
        password.value = "";
        window.location.replace(safeNext(data.next || next));
        return;
      }
      if (response.status === 401) {
        setError("账号或密码不正确，请重新输入。", true);
        password.focus();
        password.select();
      } else if (response.status === 429) {
        setError("登录尝试次数较多，请稍后再试。");
      } else if (response.status === 403) {
        setError("登录请求已失效，请刷新页面后重试。");
      } else {
        setError("暂时无法登录，请稍后重试。");
      }
    } catch (cause) {
      setError(cause?.name === "AbortError" ? "连接超时，请重试。" : "无法连接，请检查网络后重试。");
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  });

  // 邀请 / 重置密码链接（CB-040）：/login?invite=cbi_… —— 朋友自己设账号名和密码。
  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  if (inviteToken) {
    setupInvite(inviteToken);
    return;
  }

  // A returning session opens its original workspace without asking for credentials again.
  const sessionController = new AbortController();
  const sessionTimeout = window.setTimeout(() => sessionController.abort(), 8000);
  fetch("/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Accept": "application/json" },
    signal: sessionController.signal,
  })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      if (data?.authenticated === true && !submitting) window.location.replace(next);
    })
    .catch(() => {})
    .finally(() => window.clearTimeout(sessionTimeout));

  function setupInvite(token) {
    const heading = document.getElementById("login-heading");
    const label = document.querySelector(".section-label");
    const description = document.querySelector(".login-description");
    const inviteForm = document.getElementById("invite-form");
    const inviteUser = document.getElementById("invite-username");
    const inviteName = document.getElementById("invite-name");
    const invitePassword = document.getElementById("invite-password");
    const inviteConfirm = document.getElementById("invite-confirm");
    const inviteError = document.getElementById("invite-error");
    const inviteSubmit = document.getElementById("invite-submit");
    const inviteLabel = document.getElementById("invite-label");
    let kind = "invite";
    let busy = false;
    form.hidden = true;
    label.textContent = "邀请";
    heading.textContent = "正在打开邀请…";
    description.textContent = "";
    const fail = (message) => {
      heading.textContent = "链接不可用";
      description.textContent = message;
      inviteForm.hidden = true;
    };
    fetch("/auth/invite?token=" + encodeURIComponent(token), { credentials: "same-origin", cache: "no-store", headers: { "Accept": "application/json" } })
      .then(async (response) => ({ response, data: await response.json().catch(() => null) }))
      .then(({ response, data }) => {
        if (!response.ok || data?.ok !== true) return fail(data?.error || "邀请链接无效或已过期，请向管理员要一个新的。");
        kind = data.kind;
        inviteForm.hidden = false;
        if (kind === "reset") {
          label.textContent = "重置密码";
          heading.textContent = "设置新密码";
          description.textContent = "账号：" + (data.username || "") + "。设好后旧密码和已登录的设备都会失效。";
          document.getElementById("invite-username-field").hidden = true;
          document.getElementById("invite-name-field").hidden = true;
          inviteLabel.textContent = "保存并登录";
          invitePassword.focus();
        } else {
          heading.textContent = "加入 ChisaBot";
          description.textContent = "设一个账号名和密码，以后用它登录网页、PC 和手机客户端。";
          inviteUser.required = true;
          inviteUser.focus();
        }
      })
      .catch(() => fail("无法连接，请检查网络后重试。"));
    for (const input of [inviteUser, inviteName, invitePassword, inviteConfirm]) input.addEventListener("input", () => { inviteError.textContent = ""; });
    inviteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !inviteForm.reportValidity()) return;
      if (invitePassword.value !== inviteConfirm.value) {
        inviteError.textContent = "两次输入的密码不一样。";
        inviteConfirm.focus();
        return;
      }
      busy = true;
      inviteSubmit.disabled = true;
      inviteSubmit.setAttribute("aria-busy", "true");
      const idle = inviteLabel.textContent;
      inviteLabel.textContent = "正在保存";
      try {
        const response = await fetch("/auth/invite", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ token, username: kind === "invite" ? inviteUser.value.trim() : undefined, displayName: kind === "invite" ? inviteName.value.trim() : undefined, password: invitePassword.value, remember: true }),
        });
        const data = await response.json().catch(() => null);
        if (response.ok && data?.ok === true) {
          invitePassword.value = ""; inviteConfirm.value = "";
          window.location.replace("/");
          return;
        }
        inviteError.textContent = data?.error || (response.status === 429 ? "尝试次数较多，请稍后再试。" : "暂时无法保存，请稍后重试。");
      } catch {
        inviteError.textContent = "无法连接，请检查网络后重试。";
      } finally {
        busy = false;
        inviteSubmit.disabled = false;
        inviteSubmit.setAttribute("aria-busy", "false");
        inviteLabel.textContent = idle;
      }
    });
  }
})();
