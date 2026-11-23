"use strict";
(async () => {
  const OPS = { system_info: "读取系统信息", shell: "运行命令", list_files: "列出文件", read_file: "读取文件", write_file: "写入文件", screenshot: "截图", input: "操作鼠标键盘", open: "打开网址 / 文件", clipboard_read: "读取剪贴板", clipboard_write: "写入剪贴板", search: "搜索文件", read_range: "读取文件", edit_file: "修改文件", apply_patch: "应用补丁", git: "运行 git", shell_session: "运行命令", exec_start: "后台运行命令", exec_poll: "查看命令输出", exec_kill: "结束命令", exec_list: "查看后台命令", process_list: "查看进程", process_kill: "结束进程", file_upload: "传文件到这台电脑", file_download: "从这台电脑取文件" };
  const req = await window.chisa.invoke("approval:current");
  if (!req) return window.close();
  const $ = (id) => document.getElementById(id);
  $("title").textContent = `${req.botName || "机器人"} 想${OPS[req.operation] || req.operation}`;
  $("title").title = $("title").textContent;
  if (req.local) {
    $("eyebrow").textContent = "ChisaBot · 高风险操作 · 本机确认";
    $("where").textContent = "只能在这台电脑上处理";
  }
  $("summary").textContent = req.summary || "";
  // 改文件类操作：把改动（diff）也给本人看，删行红、加行绿。
  if (req.diff) {
    const pre = $("summary");
    pre.classList.add("has-diff");
    pre.appendChild(document.createTextNode("\n\n"));
    for (const line of String(req.diff).slice(0, 8000).split("\n")) {
      const span = document.createElement("span");
      span.textContent = `${line}\n`;
      if (line.startsWith("+") && !line.startsWith("+++")) span.style.color = "var(--success, #16a34a)";
      else if (line.startsWith("-") && !line.startsWith("---")) span.style.color = "var(--danger, #dc2626)";
      else if (line.startsWith("@@")) span.style.opacity = "0.6";
      pre.appendChild(span);
    }
  }
  // 剩余时间：优先用服务器按它自己的时钟算好的 remainingMs（这台电脑的时钟可能不准）；
  // 没有时才看 expiresAt，且只在结果合理时采用，否则按 2 分钟；之后用单调时钟倒数。
  const fallback = 120000;
  let ms = typeof req.remainingMs === "number" ? req.remainingMs : NaN;
  if (!(ms > 0)) {
    const naive = req.expiresAt ? Date.parse(req.expiresAt) - Date.now() : NaN;
    ms = naive > 0 && naive <= fallback ? naive : fallback;
  }
  const deadline = performance.now() + ms;
  let decided = false;
  const decide = (decision) => {
    if (decided) return;
    decided = true;
    const allowBtn = $("allow");
    const denyBtn = $("deny");
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    const chosen = decision === "approve" ? allowBtn : denyBtn;
    chosen.setAttribute("aria-busy", "true");
    chosen.textContent = decision === "approve" ? "已允许…" : "已拒绝…";
    window.chisa.invoke("approval:decide", { id: req.id, decision });
  };
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    $("countdown").textContent = left > 0 ? `${left} 秒后自动拒绝` : "即将自动拒绝";
    if (left <= 0) decide("deny");
  };
  tick();
  setInterval(tick, 1000);
  $("allow").addEventListener("click", () => decide("approve"));
  $("deny").addEventListener("click", () => decide("deny"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") decide("deny");
  });
  fitDialog("dialog:fit");
  $("deny").focus();
})();
