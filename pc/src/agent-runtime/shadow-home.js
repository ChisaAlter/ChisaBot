"use strict";
/**
 * 账号隔离与影子 Home 布局（参考 T3 Code CodexHomeLayout）：
 * - 在 Windows 使用目录 Junction（无需管理员权限），在 macOS / Linux 使用目录 Symlink；
 * - 共享 skills / sessions / plugins / cache 等大体积状态目录，同时将 auth.json / 凭据文件独立保存在影子目录本地，
 *   实现同一台机器上多个账号实例（如个人号与工作号）并存互不覆盖。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_SHARED_DIRS = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
];

const CODEX_SEED_FILES = ["config.toml", "AGENTS.md", "instructions.md"];

const CLAUDE_SHARED_DIRS = ["commands", "agents", "skills", "plugins", "projects", "todos"];
const CLAUDE_SEED_FILES = ["settings.json", "CLAUDE.md"];

function expandHome(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function sameOrNested(a, b) {
  const win = process.platform === "win32";
  const na = win ? path.resolve(a).toLowerCase() : path.resolve(a);
  const nb = win ? path.resolve(b).toLowerCase() : path.resolve(b);
  if (na === nb) return "same";
  const sep = path.sep;
  if (na.startsWith(nb.endsWith(sep) ? nb : nb + sep)) return "nested";
  if (nb.startsWith(na.endsWith(sep) ? na : na + sep)) return "nested";
  return null;
}

function linkSharedDir(baseDir, shadowDir, subName) {
  const target = path.join(baseDir, subName);
  const linkPath = path.join(shadowDir, subName);
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    return;
  }
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) return;
  } catch {
    // linkPath 尚不存在，继续创建链接
  }
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // 极端文件系统不支持链接时退化为空目录，不阻断启动
    try {
      fs.mkdirSync(linkPath, { recursive: true });
    } catch {}
  }
}

function copySeedFileIfMissing(baseDir, shadowDir, fileName) {
  const src = path.join(baseDir, fileName);
  const dst = path.join(shadowDir, fileName);
  try {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return;
    const stat = fs.statSync(src);
    if (stat.isFile() && stat.size < 2 * 1024 * 1024) {
      fs.copyFileSync(src, dst);
    }
  } catch {}
}

/**
 * 准备实例的 Home / 影子 Home 目录并返回需注入子进程的环境变量。
 * @param {{ driver: string, homePath?: string | null, shadowHomePath?: string | null }} options
 * @returns {{ env: Record<string, string>, effectiveHome: string | null, notes: string[] }}
 */
function prepareShadowHome(options = {}) {
  const driver = options.driver || "";
  const rawHome = options.homePath || null;
  const rawShadow = options.shadowHomePath || null;
  const notes = [];

  if (driver === "codex") {
    const baseHome = expandHome(rawHome) || path.join(os.homedir(), ".codex");
    const shadowHome = expandHome(rawShadow);
    if (!shadowHome) {
      if (rawHome) {
        fs.mkdirSync(baseHome, { recursive: true });
        return { env: { CODEX_HOME: baseHome }, effectiveHome: baseHome, notes };
      }
      return { env: {}, effectiveHome: baseHome, notes };
    }
    const relation = sameOrNested(baseHome, shadowHome);
    if (relation === "same") {
      fs.mkdirSync(baseHome, { recursive: true });
      return { env: { CODEX_HOME: baseHome }, effectiveHome: baseHome, notes };
    }
    if (relation === "nested") {
      throw new Error(`影子 Home 路径（${shadowHome}）不能与主 CODEX_HOME（${baseHome}）互为父子目录。`);
    }
    fs.mkdirSync(baseHome, { recursive: true });
    fs.mkdirSync(shadowHome, { recursive: true });
    for (const dir of CODEX_SHARED_DIRS) linkSharedDir(baseHome, shadowHome, dir);
    for (const file of CODEX_SEED_FILES) copySeedFileIfMissing(baseHome, shadowHome, file);
    notes.push(`已启用影子 CODEX_HOME：${shadowHome}`);
    return { env: { CODEX_HOME: shadowHome }, effectiveHome: shadowHome, notes };
  }

  if (driver === "claude") {
    const baseHome = expandHome(rawHome) || path.join(os.homedir(), ".claude");
    const shadowHome = expandHome(rawShadow);
    if (!shadowHome) {
      if (rawHome) {
        fs.mkdirSync(baseHome, { recursive: true });
        return { env: { CLAUDE_CONFIG_DIR: baseHome }, effectiveHome: baseHome, notes };
      }
      return { env: {}, effectiveHome: baseHome, notes };
    }
    const relation = sameOrNested(baseHome, shadowHome);
    if (relation === "same") {
      fs.mkdirSync(baseHome, { recursive: true });
      return { env: { CLAUDE_CONFIG_DIR: baseHome }, effectiveHome: baseHome, notes };
    }
    if (relation === "nested") {
      throw new Error(`影子配置目录（${shadowHome}）不能与主配置目录（${baseHome}）互为父子目录。`);
    }
    fs.mkdirSync(baseHome, { recursive: true });
    fs.mkdirSync(shadowHome, { recursive: true });
    for (const dir of CLAUDE_SHARED_DIRS) linkSharedDir(baseHome, shadowHome, dir);
    for (const file of CLAUDE_SEED_FILES) copySeedFileIfMissing(baseHome, shadowHome, file);
    notes.push(`已启用影子 CLAUDE_CONFIG_DIR：${shadowHome}`);
    return { env: { CLAUDE_CONFIG_DIR: shadowHome }, effectiveHome: shadowHome, notes };
  }

  return { env: {}, effectiveHome: expandHome(rawShadow || rawHome), notes };
}

/**
 * 无副作用地读取凭据存在状态（用于探活展示「已认证」标签，绝不读取或回传密钥内容）。
 */
function inspectHomeAuth({ driver, homePath, shadowHomePath, env = {} }) {
  const mergedEnv = { ...process.env, ...env };
  if (driver === "codex") {
    if (mergedEnv.OPENAI_API_KEY) return { authenticated: true, authLabel: "已配置 API Key" };
    const dir = expandHome(shadowHomePath) || expandHome(homePath) || expandHome(mergedEnv.CODEX_HOME) || path.join(os.homedir(), ".codex");
    const authFile = path.join(dir, "auth.json");
    try {
      const raw = fs.readFileSync(authFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.tokens || parsed.OPENAI_API_KEY || Object.keys(parsed).length > 0)) {
        return { authenticated: true, authLabel: shadowHomePath ? "已认证 · 独立账号" : "已认证" };
      }
    } catch {}
    return { authenticated: null, authLabel: null };
  }

  if (driver === "claude") {
    if (mergedEnv.ANTHROPIC_API_KEY || mergedEnv.ANTHROPIC_AUTH_TOKEN) {
      return { authenticated: true, authLabel: "已配置 API Key" };
    }
    const dir = expandHome(shadowHomePath) || expandHome(homePath) || expandHome(mergedEnv.CLAUDE_CONFIG_DIR) || path.join(os.homedir(), ".claude");
    const credFile = path.join(dir, ".credentials.json");
    const legacyJson = path.join(os.homedir(), ".claude.json");
    try {
      if (fs.existsSync(credFile) && fs.statSync(credFile).size > 4) {
        return { authenticated: true, authLabel: shadowHomePath ? "已认证 · 独立账号" : "已认证" };
      }
      if (!shadowHomePath && fs.existsSync(legacyJson) && fs.statSync(legacyJson).size > 10) {
        return { authenticated: true, authLabel: "已认证" };
      }
    } catch {}
    return { authenticated: null, authLabel: null };
  }

  if (driver === "gemini" && (mergedEnv.GEMINI_API_KEY || mergedEnv.GOOGLE_API_KEY)) {
    return { authenticated: true, authLabel: "已配置 API Key" };
  }

  return { authenticated: null, authLabel: null };
}

module.exports = {
  prepareShadowHome,
  inspectHomeAuth,
  expandHome,
  CODEX_SHARED_DIRS,
  CLAUDE_SHARED_DIRS,
};
