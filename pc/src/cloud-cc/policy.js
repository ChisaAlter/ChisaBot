"use strict";
/**
 * 云端 Claude Code 的权限判断（docs/cloud-claude-code.md §3.3）。纯函数，节点主进程在 PreToolUse 钩子里调用。
 *
 * 结果：{ decision: "allow" | "deny" | "ask", reason, rule? }
 * - allow：直接放行（只读、会话目录里的编辑、只读命令白名单、本会话已经「总是允许」的）
 * - deny：一律拒绝（推送、gh、改 remote、ssh、sudo、改 ~/.claude、会话目录外的写入）
 * - ask：弹审批卡（其他命令、会话目录外的读取、第一次访问的域名、MCP、不认识的工具）
 *   rule = 用户选「本会话总是允许」时要记下的规则 { kind: "bash", value } / { kind: "domain", value } / { kind: "tool", value }
 */
const path = require("node:path");

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** 不碰文件和网络、只影响 Claude 自己的工具。 */
const SAFE_TOOLS = new Set(["TodoWrite", "TodoRead", "Task", "Agent", "ExitPlanMode", "BashOutput", "KillShell", "KillBash", "SlashCommand", "Skill", "ToolSearch", "EnterPlanMode", "AskUserQuestion"]);

/** 只读命令白名单（第一个词）；git 只允许这些子命令。 */
const READONLY_COMMANDS = new Set(["ls", "cat", "rg", "grep", "pwd", "head", "tail", "wc", "echo", "which", "tree", "file", "stat", "du", "df", "date", "whoami", "uname", "env", "printenv", "true", "sort", "uniq", "cut", "basename", "dirname", "realpath", "diff", "less", "more", "nl", "jq"]);
const READONLY_GIT = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "blame", "remote-v", "describe", "shortlog", "grep", "tag-l"]);

function normalize(p) {
  return path.posix.normalize(String(p || "").replace(/\\/g, "/"));
}

function inside(root, target, cwd) {
  if (!root) return false;
  const base = normalize(root).replace(/\/+$/, "");
  let t = normalize(target);
  if (!t.startsWith("/")) t = normalize(`${cwd || base}/${t}`);
  return t === base || t.startsWith(`${base}/`);
}

function insideWorkspaceWork(root, target, cwd) {
  if (!root) return false;
  const base = normalize(root).replace(/\/+$/, "");
  if (!/\/trees\/[^/]+$/.test(base)) return false;
  const workRoot = normalize(`${base}/../../work`);
  return inside(workRoot, target, cwd);
}

function pathOf(input) {
  if (!input || typeof input !== "object") return null;
  return input.file_path || input.notebook_path || input.path || null;
}

/** 推送 / 远端 / 提权 / 凭据：一律拒绝。 */
function forbidden(command) {
  const c = ` ${command} `;
  if (/(^|[\s;&|(])git\s+(-[^\s]+\s+)*push\b/.test(c)) return "不能直接推送。请用「推送并开 PR」。";
  if (/(^|[\s;&|(])git\s+(-[^\s]+\s+)*remote\s+(add|set-url|remove|rm|rename)\b/.test(c)) return "不能修改远端。请用「推送并开 PR」。";
  if (/(^|[\s;&|(])gh\s/.test(c)) return "不能用 gh。请用「推送并开 PR」。";
  if (/(^|[\s;&|(])(ssh|scp|sftp|rsync)\s/.test(c)) return "不能用 ssh / scp / rsync 连到别的机器。";
  if (/(^|[\s;&|(])(sudo|su|doas)\s/.test(c)) return "不能提权（sudo）。";
  if (/(^|[\s;&|(])curl\s[^|;&]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|--upload-file|-T\s|-F\s|--form)/i.test(c)) return "不能用 curl 往外发数据。";
  if (/(^|[\s"'=])~?\/?(home\/[^/\s]+\/)?\.claude(\/|\s|$)/.test(c) && /(>|rm\s|mv\s|cp\s|tee\s|chmod|sed\s+-i|truncate)/.test(c)) return "不能修改 Claude 自己的配置和凭据（~/.claude）。";
  return null;
}

/** 一条命令是不是只读：按 ; && || | 拆开，每一段的第一个词都在白名单里，而且没有重定向、命令替换。 */
function readonlyCommand(command) {
  const text = String(command || "").trim();
  if (!text || text.length > 2000) return false;
  if (/[`<>]|\$\(|\n/.test(text.replace(/2>&1|2>\/dev\/null|>\s*\/dev\/null/g, ""))) return false;
  const parts = text.split(/\|\||&&|;|\|/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  for (const part of parts) {
    const words = part.split(/\s+/);
    let first = words[0];
    if (first === "cd") continue;
    if (first === "git") {
      const sub = words.slice(1).find((w) => !w.startsWith("-"));
      if (!sub) return false;
      if (sub === "remote" && words.includes("-v")) continue;
      if (sub === "tag" && (words.includes("-l") || words.length === 2)) continue;
      if (sub === "branch" && words.some((w) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force)/.test(w))) return false;
      if (!READONLY_GIT.has(sub)) return false;
      continue;
    }
    if (first === "sed") {
      if (words.some((w) => /^-i/.test(w) || w === "--in-place")) return false;
      if (!words.includes("-n")) return false;
      continue;
    }
    if (first === "find") {
      if (words.some((w) => /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)$/.test(w))) return false;
      continue;
    }
    if (!READONLY_COMMANDS.has(first)) return false;
  }
  return true;
}

function domainOf(input) {
  const url = input && (input.url || input.query);
  if (!url) return null;
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hasRule(rules, kind, value) {
  return (rules || []).some((r) => r && r.kind === kind && r.value === value);
}

/**
 * @param {{ tool: string, input: object, root: string, cwd?: string, rules?: Array<{kind:string,value:string}> }} q
 */
function decide(q) {
  const tool = String(q.tool || "");
  const input = q.input || {};
  const root = q.root;
  const cwd = q.cwd || root;
  if (SAFE_TOOLS.has(tool)) return { decision: "allow", reason: "不碰文件" };
  if (READ_TOOLS.has(tool)) {
    const p = pathOf(input);
    if (!p || inside(root, p, cwd) || (insideWorkspaceWork(root, p, cwd) && !/(^|\/)\.git(\/|$)/.test(normalize(p)))) return { decision: "allow", reason: "会话或主工作目录里的只读操作" };
    if (/(^|\/)\.claude(\/|$)/.test(normalize(p))) return { decision: "deny", reason: "不能读 Claude 自己的凭据目录。" };
    if (hasRule(q.rules, "read", normalize(p))) return { decision: "allow", reason: "本会话已允许" };
    return { decision: "ask", reason: `要读会话目录之外的文件：${p}`, rule: { kind: "read", value: normalize(p) } };
  }
  if (EDIT_TOOLS.has(tool)) {
    const p = pathOf(input);
    if (p && inside(root, p, cwd) && !/(^|\/)\.git(\/|$)/.test(normalize(p))) return { decision: "allow", reason: "会话目录里的编辑（可以撤销这一轮）" };
    return { decision: "deny", reason: `只能改会话目录里的文件${p ? `（${p} 不在里面）` : ""}。` };
  }
  if (tool === "Bash") {
    const command = String(input.command || "").trim();
    const no = forbidden(command);
    if (no) return { decision: "deny", reason: no };
    if (readonlyCommand(command)) return { decision: "allow", reason: "只读命令" };
    if (hasRule(q.rules, "bash", command)) return { decision: "allow", reason: "本会话已允许这条命令" };
    return { decision: "ask", reason: `运行命令：${command.slice(0, 300)}`, rule: { kind: "bash", value: command } };
  }
  if (tool === "WebFetch" || tool === "WebSearch") {
    const domain = tool === "WebSearch" ? "（网页搜索）" : domainOf(input);
    if (!domain) return { decision: "ask", reason: `${tool === "WebSearch" ? "网页搜索" : "打开网页"}`, rule: { kind: "domain", value: "（未知）" } };
    if (hasRule(q.rules, "domain", domain)) return { decision: "allow", reason: "本会话已允许这个域名" };
    return { decision: "ask", reason: tool === "WebSearch" ? `网页搜索：${String(input.query || "").slice(0, 200)}` : `打开网页：${domain}`, rule: { kind: "domain", value: domain } };
  }
  if (tool.startsWith("mcp__")) {
    if (hasRule(q.rules, "tool", tool)) return { decision: "allow", reason: "本会话已允许" };
    return { decision: "ask", reason: `使用 MCP 工具 ${tool}`, rule: { kind: "tool", value: tool } };
  }
  if (hasRule(q.rules, "tool", tool)) return { decision: "allow", reason: "本会话已允许" };
  return { decision: "ask", reason: `使用工具 ${tool}`, rule: { kind: "tool", value: tool } };
}

module.exports = { decide, readonlyCommand, forbidden, inside };
