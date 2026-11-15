"use strict";
/**
 * 行级文本差异与补丁（docs/pc-node.md §12）。纯 JS、无依赖，PC 客户端与无界面节点共用：
 * - unifiedDiff(old, new)：Myers 差异 → 标准 unified diff（3 行上下文），给机器人和审批卡片看；
 * - parsePatch(text) / applyHunks(content, hunks)：解析并应用 unified diff（允许行号偏移，空白不同时再宽松匹配一次）。
 */

class PatchError extends Error {}

/** 拆行：返回 { lines, eol, finalNewline }。 */
function splitText(text) {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  if (text === "") return { lines: [], eol, finalNewline: false };
  const finalNewline = /\r?\n$/.test(text);
  const body = finalNewline ? text.replace(/\r?\n$/, "") : text;
  return { lines: body.split(/\r?\n/), eol, finalNewline };
}

function joinText({ lines, eol, finalNewline }) {
  if (!lines.length) return "";
  return lines.join(eol) + (finalNewline ? eol : "");
}

/**
 * Myers O(ND) 行差异。返回操作序列 [{t:" "|"-"|"+", s}]。
 * 先去掉公共前后缀；中间部分差异太大（D 超过上限）时退化为「整段删除 + 整段新增」。
 */
function diffLines(a, b, maxD = 4000) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = [];
  for (let i = 0; i < start; i++) out.push({ t: " ", s: a[i] });
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  out.push(...myers(A, B, maxD));
  for (let i = endA; i < a.length; i++) out.push({ t: " ", s: a[i] });
  return out;
}

function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((s) => ({ t: "+", s }));
  if (!m) return a.map((s) => ({ t: "-", s }));
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  v[off + 1] = 0;
  const trace = [];
  for (let d = 0; d <= max; d++) {
    // 只存这一轮会读到的 k ∈ [-d-1, d+1]
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return [...a.map((s) => ({ t: "-", s })), ...b.map((s) => ({ t: "+", s }))];
}

function backtrack(a, b, trace, D) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = D; d >= 0; d--) {
    const vp = trace[d];
    const get = (k) => vp[k + d + 1];
    const k = x - y;
    let prevK;
    if (d === 0) prevK = k;
    else prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: " ", s: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ t: "+", s: b[y - 1] });
        y--;
      } else {
        ops.push({ t: "-", s: a[x - 1] });
        x--;
      }
    }
  }
  return ops.reverse();
}

const NOEOL = "\u0000\u2400noeol";

/** 行数组：没有结尾换行时最后一行带上 NOEOL 标记，这样「只差结尾换行」也是一处普通的行差异。 */
function markedLines(text) {
  const t = splitText(text);
  const lines = t.lines.slice();
  if (lines.length && !t.finalNewline) lines[lines.length - 1] += NOEOL;
  return { lines, eol: t.eol };
}

function fromMarked(lines, eol) {
  if (!lines.length) return "";
  const last = lines[lines.length - 1];
  if (last.endsWith(NOEOL)) return [...lines.slice(0, -1), last.slice(0, -NOEOL.length)].join(eol);
  return lines.join(eol) + eol;
}

function emit(tag, s) {
  return s.endsWith(NOEOL) ? [`${tag}${s.slice(0, -NOEOL.length)}`, "\\ No newline at end of file"] : [`${tag}${s}`];
}

/** 两段文本的 unified diff；没有变化返回 ""。 */
function unifiedDiff(oldText, newText, options = {}) {
  const context = options.context ?? 3;
  const label = String(options.path || "file").replace(/^\/+/, "");
  const a = markedLines(oldText).lines;
  const b = markedLines(newText).lines;
  const ops = diffLines(a, b);
  const changes = [];
  ops.forEach((op, i) => {
    if (op.t !== " ") changes.push(i);
  });
  if (!changes.length) return "";
  const out = [`--- ${options.oldLabel ?? `a/${label}`}`, `+++ ${options.newLabel ?? `b/${label}`}`];
  let gi = 0;
  while (gi < changes.length) {
    const first = changes[gi];
    let last = first;
    while (gi + 1 < changes.length && changes[gi + 1] - last <= context * 2 + 1) last = changes[++gi];
    gi++;
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    let oldLine = 1;
    let newLine = 1;
    for (let i = 0; i < from; i++) {
      if (ops[i].t !== "+") oldLine++;
      if (ops[i].t !== "-") newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      body.push(...emit(op.t, op.s));
      if (op.t !== "+") oldCount++;
      if (op.t !== "-") newCount++;
    }
    out.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`, ...body);
  }
  return `${out.join("\n")}\n`;
}

/** 差异统计 { added, removed }。 */
function diffStat(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function stripPrefix(p) {
  const clean = String(p).trim().split("\t")[0].replace(/^"(.*)"$/, "$1");
  if (clean === "/dev/null") return null;
  return clean.replace(/^[ab]\//, "");
}

/**
 * 解析 unified diff（可含多个文件、git diff 头）。返回 [{ oldPath, newPath, hunks:[{oldStart, oldLines:[], newLines:[], lines:[]}] }]。
 */
function parsePatch(text) {
  const src = String(text).replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let file = null;
  let i = 0;
  while (i < src.length) {
    const line = src[i];
    if (line.startsWith("--- ") && i + 1 < src.length && src[i + 1].startsWith("+++ ")) {
      file = { oldPath: stripPrefix(line.slice(4)), newPath: stripPrefix(src[i + 1].slice(4)), hunks: [] };
      files.push(file);
      i += 2;
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      if (!file) throw new PatchError("补丁格式不对：@@ 之前缺少 --- / +++ 文件头。");
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      const hunk = { oldStart: Number(m[1]), newStart: Number(m[3]), oldLines: [], newLines: [] };
      i++;
      let o = 0;
      let n = 0;
      let lastSide = null;
      while (i < src.length && (o < oldCount || n < newCount || src[i].startsWith("\\"))) {
        const l = src[i];
        if (l.startsWith("\\")) {
          const mark = (arr) => {
            if (arr.length && !arr[arr.length - 1].endsWith(NOEOL)) arr[arr.length - 1] += NOEOL;
          };
          if (lastSide === "-" || lastSide === " ") mark(hunk.oldLines);
          if (lastSide === "+" || lastSide === " ") mark(hunk.newLines);
          i++;
          continue;
        }
        const tag = l[0];
        const body = l.slice(1);
        if (tag === " " || l === "") {
          hunk.oldLines.push(l === "" ? "" : body);
          hunk.newLines.push(l === "" ? "" : body);
          o++;
          n++;
          lastSide = " ";
        } else if (tag === "-") {
          hunk.oldLines.push(body);
          o++;
          lastSide = "-";
        } else if (tag === "+") {
          hunk.newLines.push(body);
          n++;
          lastSide = "+";
        } else break;
        i++;
      }
      if (o !== oldCount || n !== newCount)
        throw new PatchError(`补丁第 ${file.hunks.length + 1} 段（@@ -${m[1]} +${m[3]}）行数和 @@ 头不一致：头里写 -${oldCount}/+${newCount}，实际 -${o}/+${n}。`);
      file.hunks.push(hunk);
      continue;
    }
    i++;
  }
  if (!files.length) throw new PatchError("没有找到任何文件改动（需要 unified diff：--- a/路径、+++ b/路径、@@ -行,数 +行,数 @@）。");
  return files;
}

function findBlock(lines, block, around, loose) {
  if (!block.length) return Math.min(Math.max(around, 0), lines.length);
  const norm = loose ? (s) => s.replace(/\s+/g, " ").trim() : (s) => s;
  const target = block.map(norm);
  const fits = (pos) => {
    if (pos < 0 || pos + target.length > lines.length) return false;
    for (let j = 0; j < target.length; j++) if (norm(lines[pos + j]) !== target[j]) return false;
    return true;
  };
  const limit = Math.max(lines.length, 1);
  for (let delta = 0; delta <= limit; delta++) {
    if (fits(around + delta)) return around + delta;
    if (delta && fits(around - delta)) return around - delta;
  }
  return -1;
}

/** 把一个文件的若干段改动应用到内容上。返回新内容。 */
function applyHunks(content, hunks, label = "文件") {
  const { lines, eol } = markedLines(content);
  let shift = 0;
  hunks.forEach((hunk, index) => {
    const around = Math.max(0, hunk.oldStart - 1 + shift);
    let pos = findBlock(lines, hunk.oldLines, around, false);
    if (pos < 0) pos = findBlock(lines, hunk.oldLines, around, true);
    if (pos < 0) {
      const preview = hunk.oldLines.slice(0, 4).map((l) => `  ${l.replace(NOEOL, "")}`).join("\n");
      throw new PatchError(`${label} 第 ${index + 1} 段改动对不上（期望在第 ${hunk.oldStart} 行附近找到：\n${preview}${hunk.oldLines.length > 4 ? "\n  …" : ""}）。请先重新读取文件再生成补丁。`);
    }
    lines.splice(pos, hunk.oldLines.length, ...hunk.newLines);
    shift = pos - (hunk.oldStart - 1) + hunk.newLines.length - hunk.oldLines.length;
  });
  // 中间行不应带 NOEOL（补丁在末尾后又追加了行）
  for (let i = 0; i < lines.length - 1; i++) if (lines[i].endsWith(NOEOL)) lines[i] = lines[i].slice(0, -NOEOL.length);
  return fromMarked(lines, eol);
}

module.exports = { unifiedDiff, diffLines, diffStat, parsePatch, applyHunks, splitText, joinText, PatchError };
