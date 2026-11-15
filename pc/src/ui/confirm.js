"use strict";
(async () => {
  const req = await window.chisa.invoke("confirm:current");
  if (!req) return window.close();
  const $ = (id) => document.getElementById(id);
  $("title").textContent = req.title;
  $("desc").textContent = req.description;
  $("ok").textContent = req.confirmLabel || "确定";
  const answer = (ok) => window.chisa.invoke("confirm:answer", { id: req.id, ok });
  $("ok").addEventListener("click", () => answer(true));
  $("cancel").addEventListener("click", () => answer(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") answer(false);
  });
  fitDialog("dialog:fit");
  $("cancel").focus();
})();
