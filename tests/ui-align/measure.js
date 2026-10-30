// UI 文本对齐测量（DESIGN.md §82）。在页面里跑：window.__alignMeasure(opts) → { flags, counts, controls }。
// 量的是：控件内容框的中心 vs 文字框中心（竖 >1px / 横 >2px 算歪）、文字墨迹中心（字形实际画出来的部分）、
// 图标和文字是否在一条线上、文字被裁、按钮里换行、同一行按钮高度不一、干活卡上下的间距。
(() => {
  const SEL = [
    "button", "a[role=button]", "[role=button]", "[role=tab]", "[role=menuitem]", "[role=menuitemradio]",
    "[role=menuitemcheckbox]", "[role=option]", "[role=switch]", "[data-slot=badge]", "[data-slot=select-trigger]",
    "[data-slot=tabs-trigger]", "[data-slot=toggle-group-item]", "input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]):not([type=file])",
    "[class*=pill]", "[class*=chip]", "[class*=badge]", "[class*=-tag]", "[class*=seg]", "[class*=tab-]", ".glass-toast", "[data-sonner-toast]",
  ].join(",");
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  const r1 = (n) => Math.round(n * 10) / 10;
  const visible = (el) => {
    if (!el.checkVisibility) return el.offsetParent !== null;
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
  };
  // opacity: 0 的祖先（按钮状态机里藏起来的那一面）不算
  const shown = (el, stop) => {
    for (let e = el; e && e !== stop.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.5) return false;
      if (e.classList?.contains("sr-only")) return false;
      if (cs.position === "absolute" && cs.clip !== "auto" && cs.clip !== "") return false;
    }
    return true;
  };
  const desc = (el) => {
    const t = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const cls = (typeof el.className === "string" ? el.className : el.className?.baseVal || "").split(/\s+/).filter((c) => c && !c.includes(":") && !c.includes("[") && c.length < 40).slice(0, 4).join(".");
    const id = el.getAttribute("data-testid") || el.getAttribute("data-slot") || "";
    return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ""}${cls ? "." + cls : ""} 「${t}」`;
  };
  const union = (rs) => {
    if (!rs.length) return null;
    const u = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const r of rs) { u.left = Math.min(u.left, r.left); u.top = Math.min(u.top, r.top); u.right = Math.max(u.right, r.right); u.bottom = Math.max(u.bottom, r.bottom); }
    u.cx = (u.left + u.right) / 2; u.cy = (u.top + u.bottom) / 2; u.w = u.right - u.left; u.h = u.bottom - u.top;
    return u;
  };
  function textParts(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const s = n.nodeValue;
      if (!s || !s.trim()) continue;
      const p = n.parentElement;
      if (!p || !shown(p, el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      if (!rects.length) continue;
      const cs = getComputedStyle(p);
      g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = g.measureText(s.trim());
      for (const r of rects) {
        // Chromium: 文字的 inline 盒高 = 主字体 ascent + descent；基线 = 顶 + ascent。墨迹 = 基线 - 实际上沿 … 基线 + 实际下沿。
        const fa = m.fontBoundingBoxAscent, fd = m.fontBoundingBoxDescent;
        const base = r.top + (r.height - (fa + fd)) / 2 + fa;
        out.push({ rect: r, ink: { left: r.left, right: r.right, top: base - m.actualBoundingBoxAscent, bottom: base + m.actualBoundingBoxDescent }, text: s.trim(), node: p });
      }
    }
    return out;
  }
  function icons(el) {
    return [...el.querySelectorAll("svg, img, [data-icon], .chat-thinking-dots, .btn-glyph")]
      .filter((i) => !i.closest("svg:not(:scope)") || i.tagName.toLowerCase() !== "svg" || i.parentElement.closest("svg") === null)
      .filter((i) => shown(i, el))
      .map((i) => ({ el: i, rect: i.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 6 && rect.height >= 6 && rect.width <= 40 && rect.height <= 40);
  }
  // 控件有没有看得见的“框”（底色 / 描边 / 阴影）：没有框的（文字链接、标题行）竖向居中看不出来，不量
  function hasBox(cs) {
    const a = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 1; const v = m[1].split(/[ ,/]+/).filter(Boolean); return v.length > 3 ? parseFloat(v[3]) : 1; };
    if (cs.backgroundColor && a(cs.backgroundColor) > 0.04 && cs.backgroundColor !== "transparent") return true;
    if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
    if ((parseFloat(cs.borderTopWidth) || 0) > 0 && a(cs.borderTopColor) > 0.08 && cs.borderTopStyle !== "none") return true;
    if (cs.boxShadow && cs.boxShadow !== "none") return true;
    return false;
  }
  function contentBox(el) {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const px = (v) => parseFloat(v) || 0;
    const b = { left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft), right: r.right - px(cs.borderRightWidth) - px(cs.paddingRight), top: r.top + px(cs.borderTopWidth) + px(cs.paddingTop), bottom: r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom) };
    b.cx = (b.left + b.right) / 2; b.cy = (b.top + b.bottom) / 2;
    const outer = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, w: r.width, h: r.height };
    return { b, outer, cs };
  }
  // 横向：只对“文字本该居中”的控件量（justify-content:center / text-align:center，或按钮本身就是 inline-flex 居中）
  function hCentred(el, cs) {
    if (/^(input|textarea)$/i.test(el.tagName)) return cs.textAlign === "center";
    const jc = cs.justifyContent;
    if (/flex|grid/.test(cs.display)) return jc === "center" || (cs.display.includes("grid") && (cs.justifyItems === "center" || cs.placeItems?.includes("center")));
    return cs.textAlign === "center";
  }
  window.__alignMeasure = function (opts = {}) {
    const flags = []; const controls = [];
    const seen = new Set();
    const els = [...document.querySelectorAll(SEL)].filter((el) => {
      if (seen.has(el)) return false; seen.add(el);
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.height > 72) return false;
      if (el.closest("[data-align-ignore]")) return false;
      // 包着别的控件的大容器不量
      if (!/^(BUTTON|A|INPUT)$/.test(el.tagName) && el.querySelector("button,a,input,[role=button],[role=tab]")) return false;
      if (el.tagName === "BUTTON" && el.querySelector("button,input")) return false;
      return true;
    });
    for (const el of els) {
      const { b, outer, cs } = contentBox(el);
      const isInput = /^(input)$/i.test(el.tagName);
      const parts = isInput ? [] : textParts(el);
      const ics = isInput ? [] : icons(el);
      let T = union(parts.map((p) => p.rect)); let I = union(parts.map((p) => p.ink));
      // §82.2 文字包在 .btn-t（text-box: trim-both cap alphabetic）里时，按钮居中的是裁过的盒子（大写字母顶 → 基线），
      // 不是字体的 ascent + descent：竖向用 .btn-t 的盒子量，否则 V 会把「裁过以后墨迹居中」误报成文字框偏。
      // §82.6：同样适用于别的裁了文字盒的元素（下拉触发的值、菜单项 `.t-line`、「复制」的 `.btn-labels > span`）。
      // 横向也用裁过的盒子：字体没有 halt 时 `.t-close` 用负 margin 收掉「）」空着的半个字宽，文字节点的矩形还带着那半个字宽。
      let trimmedBox = null;
      if (T && parts.length && CSS.supports("text-box", "trim-both cap alphabetic")) {
        const trimOf = (n) => { for (let e = n; e && e !== el.parentElement; e = e.parentElement) { if (e.classList?.contains("btn-t")) return e; const t = getComputedStyle(e).textBoxTrim; if (t && t !== "none") return e; } return null; };
        const trims = parts.map((p) => trimOf(p.node));
        if (trims.every(Boolean)) { const R = union([...new Set(trims)].map((t) => t.getBoundingClientRect())); trimmedBox = R; T = { ...T, top: R.top, bottom: R.bottom }; T.cy = (T.top + T.bottom) / 2; T.h = T.bottom - T.top; }
      }
      if (isInput) {
        // 输入框：用一个同字体的探针量文字在框里的位置（值或占位文字）
        const s = el.value || el.placeholder; if (!s) continue;
        const fs = parseFloat(cs.fontSize); const lh = cs.lineHeight === "normal" ? fs * 1.2 : parseFloat(cs.lineHeight);
        g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; const m = g.measureText(s);
        const top = b.cy - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 2; // Chromium 把单行输入的文字在内容框里竖着居中
        const lineTop = b.top + (b.bottom - b.top - Math.min(lh, b.bottom - b.top)) / 2;
        T = { left: b.left, right: b.left + m.width, top, bottom: top + m.fontBoundingBoxAscent + m.fontBoundingBoxDescent }; T.cy = (T.top + T.bottom) / 2; T.cx = (T.left + T.right) / 2; T.h = T.bottom - T.top; T.w = T.right - T.left;
        const baseY = top + m.fontBoundingBoxAscent; I = { top: baseY - m.actualBoundingBoxAscent, bottom: baseY + m.actualBoundingBoxDescent }; I.cy = (I.top + I.bottom) / 2;
        void lineTop;
      }
      if (!T && ics.length) {
        // 只有图标的按钮：只做像素级居中检查
        const U = union(ics.map((i) => i.rect)); const idx = controls.length; el.setAttribute("data-align-i", String(idx));
        controls.push({ i: idx, d: desc(el), h: r1(outer.h), w: r1(outer.w), lines: 1, single: true, centred: true, cjk: false, iconOnly: true, boxed: hasBox(cs), radius: parseFloat(cs.borderTopLeftRadius) || 0, dx: r1(U.cx - b.cx),
          cb: { l: r1(b.left - outer.left), r: r1(outer.right - b.right), t: r1(parseFloat(cs.borderTopWidth) || 0), b: r1(parseFloat(cs.borderBottomWidth) || 0) } });
        continue;
      }
      if (!T) continue;
      const tops = [...new Set(parts.map((p) => Math.round(p.rect.top)))].sort((a, b) => a - b);
      const lines = tops.filter((t, i) => i === 0 || Math.abs(t - tops[i - 1]) > 3).length;
      // 同一个文字节点被折成几行才算换行（名字 + 版本号这种上下两行不算）
      const nodeLines = new Map(); for (const p of parts) { const k = p.node; if (!nodeLines.has(k)) nodeLines.set(k, new Set()); nodeLines.get(k).add(Math.round(p.rect.top / 4)); }
      const wrapped = [...nodeLines.values()].some((v) => v.size > 1) && !parts.some((p) => /vertical/.test(getComputedStyle(p.node).writingMode) || p.node.getBoundingClientRect().width <= parseFloat(getComputedStyle(p.node).fontSize) * 1.4);
      const C = union([...(trimmedBox ? [trimmedBox] : parts.map((p) => p.rect)), ...ics.map((i) => i.rect)]) || T;
      const d = desc(el);
      const idx = controls.length; el.setAttribute("data-align-i", String(idx));
      const rec = { i: idx, d, h: r1(outer.h), w: r1(outer.w), dy: r1(T.cy - b.cy), dyInk: r1(I.cy - outer.cy), dx: r1(C.cx - b.cx), lines, centred: hCentred(el, cs) && !isInput, single: lines <= 1, boxed: hasBox(cs) || isInput, radius: parseFloat(cs.borderTopLeftRadius) || 0, desc: /[gjpqy,;（）()「」【】]/.test(parts.map((p) => p.text).join("") || el.value || el.placeholder || ""), cjk: /[\u3400-\u9fff]/.test(parts.map((p) => p.text).join("") || el.value || el.placeholder || ""),
        cb: { l: r1(b.left - outer.left), r: r1(outer.right - b.right), t: r1(parseFloat(cs.borderTopWidth) || 0), b: r1(parseFloat(cs.borderBottomWidth) || 0) }, bg: cs.backgroundColor };
      controls.push(rec);
      const add = (kind, extra) => { flags.push({ kind, d, ...extra, rect: { x: outer.left, y: outer.top, w: outer.w, h: outer.h } }); el.setAttribute("data-align-flag", kind); };
      const single = lines <= 1;
      const boxed = hasBox(cs) || isInput;
      // 竖向：文字盒中心 vs 内容框中心；内容框比文字矮（被压扁）时，比较外框
      const room = b.bottom - b.top;
      if (single) {
        const ref = room >= T.h - 0.5 ? b.cy : outer.cy;
        const dy = T.cy - ref;
        if (Math.abs(dy) > 1 && outer.h <= 64 && boxed) add("V", { dy: r1(dy), why: `文字框中心偏 ${r1(dy)}px（${cs.display} align-items:${cs.alignItems} line-height:${cs.lineHeight}）` });
        // 墨迹：字形实际画出来的部分和外框中心（用户眼睛看到的）
        const dyi = I.cy - outer.cy;
        if (Math.abs(dyi) > 1.5 && outer.h <= 64 && Math.abs(dy) <= 1 && boxed && /[\u3400-\u9fff]/.test(parts.map((p) => p.text).join(""))) add("INK", { dy: r1(dyi), why: `字形墨迹中心偏 ${r1(dyi)}px（字体 ${cs.fontFamily.split(",")[0]} ${cs.fontSize}）` });
      }
      if (single && hCentred(el, cs) && !isInput) {
        const dx = C.cx - b.cx;
        if (Math.abs(dx) > 2) add("H", { dx: r1(dx), why: `内容横向偏 ${r1(dx)}px` });
      }
      for (const ic of ics) {
        const ir = ic.rect; const icy = (ir.top + ir.bottom) / 2;
        const sameLine = parts.some((p) => p.rect.top < ir.bottom && p.rect.bottom > ir.top);
        if (!sameLine) continue;
        const ref = I.cy; // 和字形中心比
        const cjkLabel = /[\u3400-\u9fff]/.test(parts.map((p) => p.text).join(""));
        if (Math.abs(icy - ref) > (cjkLabel ? 1.5 : 2.5)) add("ICON", { dy: r1(icy - ref), why: `图标和文字不在一条线上（图标中心比字中心偏 ${r1(icy - ref)}px）` });
        break;
      }
      // 裁字：文字超出控件
      const ell = cs.textOverflow === "ellipsis" || (isInput && getComputedStyle(el, "::placeholder").textOverflow === "ellipsis") || parts.some((p) => getComputedStyle(p.node).textOverflow === "ellipsis");
      if (T.right > outer.right + 1 || T.left < outer.left - 1 || T.bottom > outer.bottom + 1 || T.top < outer.top - 1) {
        if (!ell) add("CLIP", { why: `文字超出控件（文字 ${r1(T.w)}×${r1(T.h)}，控件 ${r1(outer.w)}×${r1(outer.h)}）` });
      } else if (!ell && (el.scrollWidth > el.clientWidth + 1) && cs.overflowX !== "visible") add("CLIP", { why: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}` });
      if (wrapped && outer.h <= 64 && !/^(input)$/i.test(el.tagName)) {
        const txt = parts.map((p) => p.text).join("");
        if (txt.length <= 24) add("WRAP", { why: `短标签换成 ${lines} 行` });
      }
    }
    // 有框的按钮和正上方 / 正下方的文字贴在一起（< 4px）：空状态里描述和按钮、卡片里说明和按钮
    const leafSel = "p, h1, h2, h3, h4, h5, label, li, dd, dt, [class*=desc], [class*=hint], [class*=tip]";
    for (const el of els) {
      if (!/^(BUTTON|A)$/.test(el.tagName) && el.getAttribute("role") !== "button") continue;
      const cs = getComputedStyle(el); if (!hasBox(cs)) continue;
      const r = el.getBoundingClientRect(); if (r.height > 64) continue;
      let scope = el.parentElement; for (let k = 0; k < 2 && scope?.parentElement; k++) scope = scope.parentElement;
      if (!scope) continue;
      for (const t of scope.querySelectorAll(leafSel)) {
        if (t.contains(el) || el.contains(t) || !visible(t) || !(t.innerText || "").trim()) continue;
        if (t.closest("button,a,[role=button],[role=menu],[role=listbox]")) continue;
        const tr = t.getBoundingClientRect(); if (tr.right <= r.left || tr.left >= r.right) continue;
        const gap = tr.bottom <= r.top + 0.5 ? r.top - tr.bottom : tr.top >= r.bottom - 0.5 ? tr.top - r.bottom : null;
        if (gap !== null && gap < 4) {
          flags.push({ kind: "TIGHT", d: desc(el), why: `按钮和${tr.bottom <= r.top + 0.5 ? "上面" : "下面"}的文字只隔 ${r1(gap)}px（${desc(t)}）`, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
          el.setAttribute("data-align-flag", "TIGHT"); break;
        }
      }
    }
    // 同一行的按钮高度不一（同一个父元素、横排、都是按钮）
    const groups = new Map();
    for (const el of els) {
      if (!/^(BUTTON|A)$/.test(el.tagName) && el.getAttribute("role") !== "button" && el.getAttribute("role") !== "tab") continue;
      const p = el.parentElement; if (!p) continue;
      const pcs = getComputedStyle(p);
      if (!/flex/.test(pcs.display) || pcs.flexDirection.startsWith("column")) continue;
      if (!groups.has(p)) groups.set(p, []); groups.get(p).push(el);
    }
    for (const [p, list] of groups) {
      if (list.length < 2) continue;
      const rs = list.map((e) => e.getBoundingClientRect());
      const top0 = rs[0].top; if (!rs.every((r) => Math.abs(r.top - top0) < 24)) continue;
      const hs = rs.map((r) => r1(r.height));
      const withText = list.filter((e) => (e.innerText || "").trim());
      if (withText.length < 2) continue;
      const th = withText.map((e) => r1(e.getBoundingClientRect().height));
      if (Math.max(...th) - Math.min(...th) > 1) {
        flags.push({ kind: "ROWH", d: desc(p), why: `同一行按钮高度不一：${th.join(" / ")}`, rect: (() => { const r = p.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })() });
        p.setAttribute("data-align-flag", "ROWH");
      }
      void hs;
    }
    // 干活卡 / 收起的「✓ …」行上下的间距（§75 / §82）：找卡片上方、下方最近的可见块
    const spacing = [];
    const cards = [...document.querySelectorAll("[data-testid=kept-page][data-visible=true] :is([data-testid=chat-work-card], [data-testid=chat-work-done])")].filter(visible);
    const blockSel = ".copilotKitMessage, [data-message-id] *, .chat-bubble, [class*=bubble], .jr-surface, [class*=card], p, li, h1, h2, h3, pre, table, img";
    const minGap = opts.minGap ?? 6;
    for (const card of cards) {
      const wrap = card.closest(".chat-work") || card;
      const cr = wrap.getBoundingClientRect();
      const scroller = card.closest(".copilotKitMessages, [data-chat-scroller], main") || document.body;
      const blocks = [...scroller.querySelectorAll(blockSel)].filter((e) => !wrap.contains(e) && !e.contains(wrap) && visible(e)).map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r, e }) => r.height > 4 && r.width > 4 && r.right > cr.left - 400 && r.left < cr.right + 400 && ((e.innerText || "").trim() || getComputedStyle(e).backgroundColor !== "rgba(0, 0, 0, 0)" || e.tagName === "IMG"));
      let above = null, below = null;
      for (const b of blocks) {
        if (b.r.bottom <= cr.top + 1 && (!above || b.r.bottom > above.r.bottom)) above = b;
        if (b.r.top >= cr.bottom - 1 && (!below || b.r.top < below.r.top)) below = b;
      }
      const ga = above ? r1(cr.top - above.r.bottom) : null; const gb = below ? r1(below.r.top - cr.bottom) : null;
      const rec = { card: card.getAttribute("data-testid"), above: above ? desc(above.e) : null, gapAbove: ga, below: below ? desc(below.e) : null, gapBelow: gb, cardH: r1(cr.height) };
      spacing.push(rec);
      if (ga !== null && ga < minGap) { flags.push({ kind: "GAP", d: desc(card), why: `干活卡上方只有 ${ga}px（上面是 ${rec.above}）`, rect: { x: cr.left, y: cr.top - 2, w: cr.width, h: cr.height + 4 } }); card.setAttribute("data-align-flag", "GAP"); }
      if (gb !== null && gb < minGap) { flags.push({ kind: "GAP", d: desc(card), why: `干活卡下方只有 ${gb}px（下面是 ${rec.below}）`, rect: { x: cr.left, y: cr.top - 2, w: cr.width, h: cr.height + 4 } }); card.setAttribute("data-align-flag", "GAP"); }
    }
    const counts = {}; for (const f of flags) counts[f.kind] = (counts[f.kind] || 0) + 1;
    return { flags, counts, controls: controls.length, list: controls, spacing };
  };
  // 像素级：拿控件截图（data URL）算墨迹框（文字 + 图标实际画出来的像素），相对控件左上角，CSS px
  window.__alignPix = function (url, dpr, rec) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0);
        const W = img.width, H = img.height; const d = x.getImageData(0, 0, W, H).data;
        const px = (X, Y) => { const k = (Y * W + X) * 4; return [d[k], d[k + 1], d[k + 2]]; };
        const rad = Math.min(rec.radius || 0, H / dpr / 2);
        const x0 = Math.max(0, Math.round(Math.max(rec.cb.l, rad * 0.75) * dpr) + 1), x1 = Math.min(W - 1, W - Math.round(Math.max(rec.cb.r, rad * 0.75) * dpr) - 2);
        const y0 = Math.round((rec.cb.t + 1) * dpr), y1 = H - Math.round((rec.cb.b + 1) * dpr) - 1;
        if (x1 - x0 < 4 || y1 - y0 < 4) return res(null);
        // 底色：内容区四条边上的像素中位数
        const edge = []; for (let X = x0; X <= x1; X += 2) { edge.push(px(X, y0), px(X, y1)); } for (let Y = y0; Y <= y1; Y += 2) { edge.push(px(x0, Y), px(x1, Y)); }
        const med = [0, 1, 2].map((ch) => edge.map((p) => p[ch]).sort((a, b) => a - b)[edge.length >> 1]);
        let top = -1, bot = -1, left = W, right = -1;
        for (let Y = y0; Y <= y1; Y++) {
          // 一整行几乎都是“墨迹”的是色带（吸顶栏的边、外面的阴影），不是字
          let cnt = 0, l = W, r = -1;
          for (let X = x0; X <= x1; X++) {
            const p = px(X, Y); const dist = Math.abs(p[0] - med[0]) + Math.abs(p[1] - med[1]) + Math.abs(p[2] - med[2]);
            if (dist > 90) { cnt++; if (X < l) l = X; if (X > r) r = X; }
          }
          if (!cnt || cnt > (x1 - x0 + 1) * 0.85) continue;
          if (top < 0) top = Y; bot = Y; if (l < left) left = l; if (r > right) right = r;
        }
        if (top < 0) return res(null);
        res({ top: top / dpr, bottom: (bot + 1) / dpr, left: left / dpr, right: (right + 1) / dpr, W: W / dpr, H: H / dpr });
      };
      img.onerror = () => res(null); img.src = url;
    });
  };
  window.__alignMark = function (on = true) {
    let s = document.getElementById("__align_style");
    if (!on) { s?.remove(); return; }
    if (!s) { s = document.createElement("style"); s.id = "__align_style"; document.head.appendChild(s); }
    s.textContent = "[data-align-flag]{outline:2px solid #ef4444 !important;outline-offset:1px !important}[data-align-flag=INK]{outline-color:#f59e0b !important}[data-align-flag=GAP]{outline-color:#a855f7 !important}";
  };
  window.__alignClear = function () { document.querySelectorAll("[data-align-flag]").forEach((e) => { e.removeAttribute("data-align-flag"); }); };
})();
