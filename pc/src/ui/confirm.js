"use strict";
(async () => {
  const req = await window.chisa.invoke("confirm:current");
  if (!req) return window.close();
  const $ = (id) => document.getElementById(id);
  $("title").textContent = req.title;
  $("desc").textContent = req.description;
  $("ok").textContent = req.confirmLabel || "确定";
  let answered = false;
  const answer = (ok) => {
    if (answered) return;
    answered = true;
    const okBtn = $("ok");
    const cancelBtn = $("cancel");
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    (ok ? okBtn : cancelBtn).setAttribute("aria-busy", "true");
    window.chisa.invoke("confirm:answer", { id: req.id, ok });
  };
  $("ok").addEventListener("click", () => answer(true));
  $("cancel").addEventListener("click", () => answer(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") answer(false);
  });
  fitDialog("dialog:fit");
  $("cancel").focus();
})();
