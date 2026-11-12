"use strict";
/**
 * 检测这台电脑上装了哪些命令行 agent、有哪些沙盒可用（docs/local-agents.md §3），
 * 并支持对单个智能体提供方实例按自定义路径、环境变量、影子 Home 与 ACP 协议做精准探活。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { expandHome, inspectHomeAuth } = require("./shadow-home");
const { probeAcpAgent, sanitizeAntigravityEnv } = require("./acp-client");

const AGENT_BINARIES = {
  claude: ["claude"],
  codex: ["codex"],
  antigravity: ["agy", "antigravity"],
  opencode: ["opencode"],
  gemini: ["gemini"],
  aider: ["aider"],
};

/** 跑一个命令拿输出（不经过 shell，Windows 上 .cmd 例外）。 */
function capture(file, args, { timeoutMs = 6000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    const win = process.platform === "win32";
    try {
      child = spawn(file, args, {
        cwd,
        env: env || process.env,
        windowsHide: true,
        shell: win && /\.(cmd|bat)$/i.test(file),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ code: -1, out: "" });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.slice(0, 4000) });
    });
  });
}

function extraSearchDirs() {
  const win = process.platform === "win32";
  const home = os.homedir();
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".antigravity", "bin"),
  ];
  if (win) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) {
      dirs.push(
        path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity", "bin"),
        path.join(process.env.LOCALAPPDATA, "Antigravity", "bin"),
      );
    }
  } else {
    dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    if (process.platform === "darwin") {
      dirs.push("/Applications/Antigravity.app/Contents/Resources/app/bin");
    }
  }
  return dirs;
}

/** 在 PATH 里找可执行文件（Windows 也认 .cmd / .exe）。支持直接传入路径或 ~/ 路径。 */
function which(name, customEnv) {
  if (!name || typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const win = process.platform === "win32";
  const exts = win
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT")
        .split(";")
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [""];

  // 如果包含路径分隔符或以 ~ 开头，按显式路径解析
  if (trimmed.startsWith("~") || trimmed.includes("/") || trimmed.includes("\\") || (win && /^[a-zA-Z]:/.test(trimmed))) {
    const expanded = expandHome(trimmed);
    if (!expanded) return null;
    const candidates = [expanded, ...(win && !path.extname(expanded) ? exts.map((ext) => expanded + ext) : [])];
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {}
    }
    return null;
  }

  const pathVar = (customEnv && (customEnv.PATH || customEnv.Path)) || process.env.PATH || "";
  const dirs = [...pathVar.split(path.delimiter).filter(Boolean), ...extraSearchDirs()];
  for (const dir of dirs) {
    if (win && path.extname(trimmed)) {
      const direct = path.join(dir, trimmed);
      try {
        if (fs.statSync(direct).isFile()) return direct;
      } catch {}
    }
    for (const ext of exts) {
      const candidate = path.join(dir, win ? trimmed + ext : trimmed);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function resolveExecutable(commandPath, defaultNames = [], customEnv) {
  if (commandPath && String(commandPath).trim()) {
    return which(String(commandPath).trim(), customEnv);
  }
  for (const name of defaultNames) {
    const found = which(name, customEnv);
    if (found) return found;
  }
  return null;
}

/**
 * 解析 Antigravity 或通用 ACP 驱动的启动命令与参数。
 * 返回 { mode: "acp" | "cli", file: string | null, args: string[], missingReason?: string }
 */
function resolveAcpCommand(driver, config = {}, customEnv = {}) {
  const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs.map(String) : [];
  if (driver === "antigravity") {
    const modePref = config.protocolMode || "auto";
    if (modePref !== "cli") {
      // 优先查找同目录或 PATH 下的 agy_acp_server，或 agy acp 子命令
      const explicit = config.commandPath ? which(config.commandPath, customEnv) : null;
      const siblingAcp = explicit ? which(path.join(path.dirname(explicit), "agy_acp_server"), customEnv) : null;
      const acpBin = siblingAcp || which("agy_acp_server", customEnv);
      if (acpBin) {
        return { mode: "acp", file: acpBin, args: [...extraArgs] };
      }
      if (modePref === "acp") {
        const agy = explicit || which("agy", customEnv) || which("antigravity", customEnv);
        if (agy) return { mode: "acp", file: agy, args: ["acp", ...extraArgs] };
        return { mode: "acp", file: null, args: [], missingReason: "未找到 Antigravity ACP 服务（agy_acp_server 或 agy）" };
      }
    }
    const cliFile = resolveExecutable(config.commandPath, ["agy", "antigravity"], customEnv);
    return {
      mode: "cli",
      file: cliFile,
      args: extraArgs,
      missingReason: cliFile ? undefined : "未找到 Antigravity 可执行文件（agy）",
    };
  }

  // driver === "acp"
  const explicitCmd = config.commandPath && String(config.commandPath).trim();
  if (explicitCmd) {
    const foundLocal = which(explicitCmd, customEnv);
    if (foundLocal) {
      return { mode: "acp", file: foundLocal, args: extraArgs };
    }
  }
  const agentId = config.acpAgentId || "";
  if (agentId && !explicitCmd) {
    const byId = which(agentId, customEnv);
    if (byId) {
      return { mode: "acp", file: byId, args: extraArgs.length ? extraArgs : ["--acp"] };
    }
  }
  if (config.acpLauncher === "npx" && config.acpPackage) {
    const npx = which("npx", customEnv);
    if (!npx) {
      return { mode: "acp", file: null, args: [], missingReason: "未找到 npx，无法运行 npm 分发的 ACP 智能体" };
    }
    return {
      mode: "acp",
      file: npx,
      args: ["-y", config.acpPackage, ...(extraArgs.length ? extraArgs : ["--acp"])],
      viaLauncher: "npx",
    };
  }
  if (config.acpLauncher === "uvx" && config.acpPackage) {
    const uvx = which("uvx", customEnv);
    if (!uvx) {
      return { mode: "acp", file: null, args: [], missingReason: "未找到 uvx，无法运行 Python 分发的 ACP 智能体" };
    }
    return {
      mode: "acp",
      file: uvx,
      args: [config.acpPackage, ...extraArgs],
      viaLauncher: "uvx",
    };
  }
  const label = agentId || explicitCmd || "ACP";
  return {
    mode: "acp",
    file: null,
    args: [],
    missingReason: agentId
      ? `ACP Registry 智能体 '${agentId}' 尚未安装在本机 PATH 中`
      : `未找到可执行文件：${label}`,
  };
}

function firstVersion(text) {
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?)/.exec(text || "");
  return match ? match[1] : null;
}

/**
 * 针对单个提供方实例执行探活（检查文件存在、版本号、ACP 握手或凭据就绪状态）。
 * @param {{ driver: string, config?: object, env?: Record<string, string> }} spec
 */
async function probeInstance(spec = {}) {
  const driver = spec.driver || "builtin";
  const config = spec.config || {};
  let mergedEnv = { ...process.env, ...(spec.env || {}) };

  if (driver === "builtin") {
    return {
      status: "available",
      version: null,
      resolvedPath: null,
      authenticated: true,
      authLabel: "内置引擎",
      message: "可用",
    };
  }

  if (driver === "antigravity") {
    mergedEnv = sanitizeAntigravityEnv(mergedEnv, config.fixProxy !== false);
    const resolved = resolveAcpCommand("antigravity", config, mergedEnv);
    if (!resolved.file) {
      return {
        status: "missing",
        version: null,
        resolvedPath: null,
        authenticated: null,
        authLabel: null,
        message: resolved.missingReason || "未找到 Antigravity",
      };
    }
    const agyCli = resolveExecutable(config.commandPath, ["agy", "antigravity"], mergedEnv) || resolved.file;
    const verRes = await capture(agyCli, ["--version"], { env: mergedEnv, timeoutMs: 6000 });
    const cliVersion = firstVersion(verRes.out);
    if (resolved.mode === "acp") {
      const acpProbe = await probeAcpAgent({
        file: resolved.file,
        args: resolved.args,
        env: mergedEnv,
        timeoutMs: 8000,
      });
      if (acpProbe.status === "available") {
        return {
          status: "available",
          version: acpProbe.version || cliVersion,
          resolvedPath: resolved.file,
          authenticated: acpProbe.authenticated,
          authLabel: acpProbe.authLabel || "ACP 可用",
          message: "可用",
        };
      }
    }
    if (verRes.code === 0 || cliVersion) {
      return {
        status: "available",
        version: cliVersion,
        resolvedPath: agyCli,
        authenticated: null,
        authLabel: "CLI 可用",
        message: "可用",
      };
    }
    return {
      status: "error",
      version: null,
      resolvedPath: resolved.file,
      authenticated: null,
      authLabel: null,
      message: (verRes.out || "无法运行 Antigravity").trim().slice(0, 240),
    };
  }

  if (driver === "acp") {
    const resolved = resolveAcpCommand("acp", config, mergedEnv);
    if (!resolved.file) {
      return {
        status: "missing",
        version: null,
        resolvedPath: null,
        authenticated: null,
        authLabel: null,
        message: resolved.missingReason || "未找到 ACP 智能体",
      };
    }
    // 如果是 npx / uvx 按需启动器，先快速检查启动器本身版本，避免探活时长时间后台下载大包
    if (resolved.viaLauncher) {
      return {
        status: "available",
        version: null,
        resolvedPath: resolved.file,
        authenticated: null,
        authLabel: `通过 ${resolved.viaLauncher} 启动`,
        message: `将按需运行 ${config.acpPackage}`,
      };
    }
    const verRes = await capture(resolved.file, ["--version"], { env: mergedEnv, timeoutMs: 5000 });
    const binVer = firstVersion(verRes.out);
    const acpProbe = await probeAcpAgent({
      file: resolved.file,
      args: resolved.args,
      env: mergedEnv,
      timeoutMs: 8000,
    });
    if (acpProbe.status === "available" || verRes.code === 0 || binVer) {
      return {
        status: "available",
        version: acpProbe.version || binVer,
        resolvedPath: resolved.file,
        authenticated: acpProbe.authenticated,
        authLabel: acpProbe.authLabel || "可用",
        message: "可用",
      };
    }
    return {
      status: "error",
      version: binVer,
      resolvedPath: resolved.file,
      authenticated: null,
      authLabel: null,
      message: acpProbe.message || "ACP 握手失败",
    };
  }

  if (driver === "custom") {
    const file = resolveExecutable(config.commandPath, [], mergedEnv);
    if (!file) {
      return {
        status: "missing",
        version: null,
        resolvedPath: null,
        authenticated: null,
        authLabel: null,
        message: config.commandPath ? `未找到可执行文件：${config.commandPath}` : "尚未配置可执行文件路径",
      };
    }
    return {
      status: "available",
      version: null,
      resolvedPath: file,
      authenticated: null,
      authLabel: "自定义命令",
      message: "可用",
    };
  }

  // 标准 CLI 驱动：codex / claude / opencode / gemini / aider
  const defaults = AGENT_BINARIES[driver] || [driver];
  const file = resolveExecutable(config.commandPath, defaults, mergedEnv);
  if (!file) {
    return {
      status: "missing",
      version: null,
      resolvedPath: null,
      authenticated: null,
      authLabel: null,
      message: `未在 PATH 中找到 ${config.commandPath || defaults[0]}`,
    };
  }
  const verRes = await capture(file, ["--version"], { env: mergedEnv, timeoutMs: 6000 });
  const version = firstVersion(verRes.out);
  if (verRes.code !== 0 && !version) {
    return {
      status: "error",
      version: null,
      resolvedPath: file,
      authenticated: null,
      authLabel: null,
      message: (verRes.out || `执行 --version 失败（退出码 ${verRes.code}）`).trim().slice(0, 240),
    };
  }
  const auth = inspectHomeAuth({
    driver,
    homePath: config.homePath,
    shadowHomePath: config.shadowHomePath,
    env: spec.env || {},
  });
  return {
    status: "available",
    version,
    resolvedPath: file,
    authenticated: auth.authenticated,
    authLabel: auth.authLabel,
    message: auth.authLabel || "可用",
  };
}

async function detectAgents() {
  const found = [{ kind: "builtin", version: null, path: null }];
  const checks = Object.entries(AGENT_BINARIES).map(async ([kind, names]) => {
    const env = kind === "antigravity" ? sanitizeAntigravityEnv(process.env, true) : process.env;
    for (const name of names) {
      const file = which(name, env);
      if (!file) continue;
      const result = await capture(file, ["--version"], { env });
      if (result.code === 0 || firstVersion(result.out)) {
        found.push({ kind, version: firstVersion(result.out), path: file });
        return;
      }
    }
  });
  await Promise.all(checks);
  return found;
}

async function detectSandboxes() {
  const platform = process.platform;
  const has = {};
  has.git = (await capture(which("git") || "git", ["--version"])).code === 0;
  has.worktree = has.git;
  has.copy = true;
  has.none = true;
  if (platform === "linux") {
    const bwrap = which("bwrap");
    // 能装上不等于能用（容器里没有 user namespace）：真的跑一次 /bin/true。
    has.bwrap = !!bwrap && (await capture(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "true"])).code === 0;
  }
  if (platform === "darwin") has["sandbox-exec"] = fs.existsSync("/usr/bin/sandbox-exec");
  for (const engine of ["docker", "podman"]) {
    const file = which(engine);
    has[engine] = !!file && (await capture(file, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 8000 })).code === 0;
  }
  if (platform === "win32") {
    const wsl = which("wsl");
    has.wsl = !!wsl && (await capture(wsl, ["--status"], { timeoutMs: 8000 })).code === 0;
    has["windows-sandbox"] = fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsSandbox.exe"));
  }
  return has;
}

async function detectAll() {
  const [agents, sandboxes] = await Promise.all([detectAgents(), detectSandboxes()]);
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  return { agents, sandboxes, platform: process.platform, root };
}

module.exports = {
  detectAll,
  detectAgents,
  detectSandboxes,
  probeInstance,
  resolveExecutable,
  resolveAcpCommand,
  which,
  capture,
  firstVersion,
  AGENT_BINARIES,
};
