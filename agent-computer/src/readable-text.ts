/**
 * 页面上「人看得见的字」（DESIGN.md §101.8）。
 *
 * 以前在 body 的克隆上取 innerText：克隆不在文档里、没有布局，innerText 就退化成 textContent，
 * 藏起来的字全进来了。2026-10-18 实测：Hark 登录页正常显示（截图里壁纸、按钮都在），读出来的第一句却是
 * 藏着的备用提示「This wallpaper needs WebGL, which isn’t available in your browser」，机器人以为页面坏了。
 * 现在直接取活页面的 innerText（按布局，display:none / visibility:hidden 的不算，script / style 本来就不算）；
 * 取不到（页面还没有 body、或者 innerText 是空的）才退回原来的克隆做法。
 *
 * 这个函数在页面里执行（page.evaluate），不能引用外面的任何东西。
 */
export function visiblePageText(): string {
  const body = document.body;
  if (!body) return "";
  const live = body.innerText ?? "";
  if (live.trim()) return live;
  const clone = body.cloneNode(true) as HTMLElement;
  for (const node of clone.querySelectorAll("script, style, noscript, svg")) node.remove();
  return clone.innerText ?? "";
}
