"use strict";
/**
 * 权限档位在节点这边的判定（和 shared/local-agents.ts 的 profileAllows 逐条对应）。
 * 内置 agent 的每个工具调用先问这里：档位之内直接做，之外向服务器要审批（网页 / 手机的审批卡片）。
 * 这里按真实路径（解析符号链接）判断，服务器那份只做字面判断。
 */
const fs = require("node:fs");
const path = require("node:path");

function real(p, depth = 0) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    if (depth < 16) {
      try {
        if (fs.lstatSync(p).isSymbolicLink()) {
          return real(path.resolve(path.dirname(p), fs.readlinkSync(p)), depth + 1);
        }
      } catch {}
    }
    // 还不存在的文件：解析它的父目录。
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(real(parent, depth), path.basename(p));
  }
}

function isInside(target, roots, platform = process.platform) {
  if (!target || !roots || !roots.length) return false;
  const win = platform === "win32";
  const norm = (p) => {
    const value = path.resolve(real(p));
    return win ? value.toLowerCase() : value;
  };
  const t = norm(target);
  return roots.some((root) => {
    const base = norm(root);
    return t === base || t.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  });
}

const READ_TOOLS = new Set(["list_files", "read_file", "search"]);

/** 内置 agent 工具在档位里算不算「之内」。返回 null = 之内；字符串 = 之外的原因。 */
function builtinToolGate(profile, tool, args, ctx) {
  if (profile === "full") return null;
  const roots = ctx.roots && ctx.roots.length ? ctx.roots : [ctx.workdir];
  // 在一次性副本里：只有副本本身是工作区（原文件夹里的改动要等用户点「应用改动」）；直接模式下是工作区文件夹。
  const scope = ctx.disposable ? [ctx.workdir] : [ctx.workdir, ...roots];
  if (READ_TOOLS.has(tool)) {
    const target = path.resolve(ctx.workdir, String(args.path || "."));
    return isInside(target, scope) ? null : "要读的位置不在工作区文件夹里";
  }
  if (profile === "readonly") return "当前是「只读」档位，这一步会改动电脑";
  if (tool === "write_file" || tool === "edit_file") {
    const target = path.resolve(ctx.workdir, String(args.path || ""));
    return isInside(target, scope) ? null : "要改的文件不在工作区文件夹里";
  }
  if (tool === "run") {
    // 一次性副本里，命令还提到原文件夹 = 想绕过「应用改动」直接改它：先问。
    if (ctx.disposable && ctx.origin && String(args.command || "").includes(ctx.origin)) return "命令要动原文件夹，不是一次性副本";
    return null; // 命令的工作目录固定是工作目录（在工作区里，见 index.js 的检查）
  }
  return "这个操作不在工作区档位里";
}

module.exports = { isInside, builtinToolGate, real };
