"use strict";
(async () => {
  const $ = (id) => document.getElementById(id);
  const render = async () => {
    const state = await window.chisa.invoke("state:get");
    $("server").textContent = state.serverUrl || "";
    const paused = state.local.localPaused;
    $("status").textContent = state.statusText;
    $("status").className = `badge ${paused ? "is-danger" : state.status === "online" ? "is-ok" : "is-warn"}`;
    $("pause").textContent = paused ? "解除" : "紧急停止";
    $("pause").className = `btn sm ${paused ? "outline" : "destructive"}`;
    $("pauseText").textContent = paused ? "紧急停止中：拒绝一切远程操作。解除需要再确认一次。" : "拒绝一切远程操作；断网时也有效。";
    return state;
  };
  let state = await render();
  window.chisa.onState(async () => (state = await render()));
  const params = new URLSearchParams(location.search);
  if (params.get("error")) $("detail").textContent = `网络断开或服务器暂时不可用（${params.get("error")}）。恢复后会自动重新载入。`;
  const retry = asyncButton($("retry"), { pending: "正在连接…", success: "已连接", error: "仍然连不上" });
  $("retry").addEventListener("click", () => retry(() => window.chisa.invoke("chat:retry")).catch(() => {}));
  $("pause").addEventListener("click", () => window.chisa.invoke("paused:set", !state.local.localPaused).then(render));
})();
