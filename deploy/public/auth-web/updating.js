// 部署 / 重启时网关返回 502/503/504 显示这一页：每 2 秒探一次 /health，通了就重新载入原地址。
(() => {
  var tries = 0;
  var text = document.getElementById("u-text");
  function probe() {
    tries++;
    fetch("/health", { cache: "no-store", credentials: "same-origin" })
      .then((r) => {
        if (r.ok) location.reload();
        else later();
      })
      .catch(later);
  }
  function later() {
    if (tries === 45 && text) text.textContent = "比平时久了一点。服务器可能在重启，稍后会自动回来；也可以点下面的按钮重试。";
    setTimeout(probe, tries < 45 ? 2000 : 6000);
  }
  document.getElementById("u-retry").addEventListener("click", () => { location.reload(); });
  setTimeout(probe, 1500);
})();
