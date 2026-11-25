"use strict";
/**
 * 检测这台电脑上装了哪些命令行 agent、有哪些沙盒可用（docs/local-agents.md §3），
 * 并支持对单个智能体提供方实例按自定义路径、环境变量、影子 Home 与 ACP 协议做精准探活。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { inspectHomeAuth } = require("./shadow-home");
const {
  probeAcpAgent,
  sanitizeAntigravityEnv,
  killTree,
  spawnCommand,
} = require("./acp-client");
const {
  readManagedAntigravityBinary,
  resolveAntigravityToolsDir,
  resolveAntigravityIsolation,
  ensureAntigravityHomeDirs,
  inspectManagedAntigravityAuth,
} = require("./antigravity-managed");

const WHICH_CACHE_TTL_MS = 30_000;
const WHICH_CACHE_MAX_ENTRIES = 512;
const whichCache = new Map();

function clearWhichCache() {
  whichCache.clear();
}

const AGENT_BINARIES = {
  claude: ["claude"],
  codex: ["codex"],
  antigravity: ["agy", "antigravity"],
  opencode: ["opencode"],
  gemini: ["gemini"],
  aider: ["aider"],
};

function stripWrappingQuotes(value) {
  if (typeof value !== "string") return "";
  let text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function getOwnEnvCaseInsensitive(envObj, key) {
  if (!envObj || typeof envObj !== "object") return undefined;
  if (process.platform !== "win32") {
    return Object.hasOwn(envObj, key) ? envObj[key] : undefined;
  }
  const lower = key.toLowerCase();
  let matched;
  let found = false;
  for (const k of Object.keys(envObj)) {
    if (k.toLowerCase() === lower && envObj[k] !== undefined) {
      matched = envObj[k];
      found = true;
    }
  }
  return found ? matched : undefined;
}

function getEnvValue(customEnv, key) {
  const fromCustom = getOwnEnvCaseInsensitive(customEnv, key);
  if (fromCustom !== undefined) return String(fromCustom);
  const fromProcess = process.env[key];
  return fromProcess !== undefined ? String(fromProcess) : undefined;
}

function getHomeDir(customEnv) {
  const win = process.platform === "win32";
  const customHome = win
    ? getOwnEnvCaseInsensitive(customEnv, "USERPROFILE") ||
      getOwnEnvCaseInsensitive(customEnv, "HOME")
    : getOwnEnvCaseInsensitive(customEnv, "HOME");
  if (customHome && String(customHome).trim()) {
    return stripWrappingQuotes(String(customHome));
  }
  return os.homedir();
}

function expandHomeWithEnv(rawPath, customEnv) {
  const trimmed = stripWrappingQuotes(rawPath);
  if (!trimmed) return null;
  const home = getHomeDir(customEnv);
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(home, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

/** 跑一个命令拿输出（Windows .cmd/.bat 经安全启动封装，超时杀整棵进程树并及时返回）。 */
function capture(file, args, { timeoutMs = 6000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    let settled = false;
    const win = process.platform === "win32";
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnCommand(file, args, {
        cwd,
        env: env || process.env,
        windowsHide: true,
        detached: !win,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({ code: -1, out: "" });
      return;
    }
    timer = setTimeout(() => {
      killTree(child);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {}
      finish({ code: -1, out: out.slice(0, 4000), timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (out.length < 16_000) out += String(d);
    });
    child.stderr.on("data", (d) => {
      if (out.length < 16_000) out += String(d);
    });
    child.on("error", () => {
      finish({ code: -1, out: out.slice(0, 4000) });
    });
    child.on("close", (code) => {
      finish({ code: code ?? -1, out: out.slice(0, 4000) });
    });
  });
}

function extraSearchDirs(customEnv) {
  const win = process.platform === "win32";
  const home = getHomeDir(customEnv);
  const dirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".antigravity", "bin"),
  ];
  if (win) {
    const customHomeOverride = Boolean(
      getOwnEnvCaseInsensitive(customEnv, "USERPROFILE") ||
        getOwnEnvCaseInsensitive(customEnv, "HOME"),
    );
    const appData =
      getOwnEnvCaseInsensitive(customEnv, "APPDATA") ||
      (!customHomeOverride ? process.env.APPDATA : undefined) ||
      path.join(home, "AppData", "Roaming");
    const localAppData =
      getOwnEnvCaseInsensitive(customEnv, "LOCALAPPDATA") ||
      (!customHomeOverride ? process.env.LOCALAPPDATA : undefined) ||
      path.join(home, "AppData", "Local");
    if (appData) dirs.push(path.join(appData, "npm"));
    if (localAppData) {
      // 官方 Windows install.ps1 默认目录 %LOCALAPPDATA%\agy\bin；
      // 严禁加入 %LOCALAPPDATA%\Programs\antigravity（Electron 桌面 GUI 目录）。
      dirs.push(
        path.join(localAppData, "agy", "bin"),
        path.join(localAppData, "Programs", "Antigravity", "bin"),
        path.join(localAppData, "Antigravity", "bin"),
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

/** 在 PATH 里找可执行文件（Windows 也认 .exe / .cmd / .bat）。支持直接传入路径或 ~/ 路径，按 PATH/PATHEXT 短 TTL 缓存。 */
function which(name, customEnv, options = {}) {
  if (!name || typeof name !== "string") return null;
  const trimmed = stripWrappingQuotes(name);
  if (!trimmed) return null;
  const filter = typeof options.filter === "function" ? options.filter : null;
  const win = process.platform === "win32";
  const pathExtRaw = win
    ? getEnvValue(customEnv, "PATHEXT") || ".EXE;.CMD;.BAT"
    : "";
  const exts = win
    ? [
        ...new Set(
          pathExtRaw
            .split(";")
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean)
            .map((e) => (e.startsWith(".") ? e : `.${e}`)),
        ),
      ]
    : [""];
  if (win && exts.length === 0) {
    exts.push(".exe", ".cmd", ".bat");
  }

  // 如果包含路径分隔符或以 ~ 开头，按显式路径解析
  if (
    trimmed.startsWith("~") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    (win && /^[a-zA-Z]:/.test(trimmed))
  ) {
    const expanded = expandHomeWithEnv(trimmed, customEnv);
    if (!expanded) return null;
    // Windows 无扩展名显式路径优先匹配可执行扩展名（.exe/.cmd/.bat），最后才回退无扩展名文件（防误命中同名 POSIX sh 脚本）
    const candidates =
      win && !path.extname(expanded)
        ? [...exts.map((ext) => expanded + ext), expanded]
        : [expanded];
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile() && (!filter || filter(c))) return c;
      } catch {}
    }
    return null;
  }

  const pathVar = getEnvValue(customEnv, "PATH") ?? "";
  const extraDirs = extraSearchDirs(customEnv);
  const cacheKey = filter
    ? null
    : `${process.platform}\0${pathVar}\0${pathExtRaw}\0${extraDirs.join(path.delimiter)}\0${win ? trimmed.toLowerCase() : trimmed}`;
  const now = Date.now();
  if (cacheKey) {
    const cached = whichCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const seenDirs = new Set();
  const dirs = [];
  for (const rawDir of [...pathVar.split(path.delimiter), ...extraDirs]) {
    const dir = stripWrappingQuotes(rawDir);
    if (!dir) continue;
    const norm = win ? dir.toLowerCase() : dir;
    if (seenDirs.has(norm)) continue;
    seenDirs.add(norm);
    dirs.push(dir);
  }

  let found = null;
  const hasExplicitExt = win && Boolean(path.extname(trimmed));
  for (const dir of dirs) {
    if (hasExplicitExt) {
      const direct = path.join(dir, trimmed);
      try {
        if (fs.statSync(direct).isFile() && (!filter || filter(direct))) {
          found = direct;
          break;
        }
      } catch {}
    }
    for (const ext of exts) {
      const candidate = path.join(dir, win ? trimmed + ext : trimmed);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (!filter || filter(candidate))) {
          found = candidate;
          break;
        }
      } catch {}
    }
    if (found) break;
  }

  if (cacheKey) {
    if (whichCache.size >= WHICH_CACHE_MAX_ENTRIES) {
      whichCache.clear();
    }
    whichCache.set(cacheKey, {
      value: found,
      expiresAt: now + WHICH_CACHE_TTL_MS,
    });
  }
  return found;
}

function resolveExecutable(commandPath, defaultNames = [], customEnv) {
  const cleaned = stripWrappingQuotes(
    commandPath !== null && commandPath !== undefined
      ? String(commandPath)
      : "",
  );
  if (cleaned) {
    return which(cleaned, customEnv);
  }
  for (const name of defaultNames) {
    const found = which(name, customEnv);
    if (found) return found;
  }
  return null;
}

function isDefaultAntigravityAlias(rawCommandPath) {
  const cleaned = stripWrappingQuotes(rawCommandPath || "");
  if (!cleaned) return true;
  return /^(?:agy|antigravity)(?:\.(?:exe|cmd|bat))?$/i.test(cleaned);
}

function isStandaloneAcpServerBinary(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  return /^agy_acp_server(?:\.(?:exe|cmd|bat|par))?$/i.test(
    path.basename(filePath),
  );
}

/**
 * 防止把 Antigravity Electron 桌面端 GUI 或内部 language_server 误识别为 CLI/ACP 可执行文件。
 */
function isAntigravityDesktopGuiPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)programs\/antigravity\/antigravity\.exe$/i.test(norm)) {
    return true;
  }
  if (
    /(?:^|\/)antigravity\.app\/contents\/macos\/(?:antigravity|electron)$/i.test(
      norm,
    )
  ) {
    return true;
  }
  if (/(?:^|\/)resources\/bin\/language_server(?:\.exe)?$/i.test(norm)) {
    return true;
  }
  if (/(?:^|\/)antigravity\/bin\/agy-node(?:\.cmd)?$/i.test(norm)) {
    return true;
  }
  // 额外结构检查：若文件名是 antigravity.exe 且同目录有 Electron 桌面壳特征文件，拒绝当作 CLI
  if (path.basename(norm) === "antigravity.exe") {
    const dir = path.dirname(filePath);
    try {
      if (
        fs.existsSync(path.join(dir, "resources", "bin", "language_server.exe")) ||
        fs.existsSync(path.join(dir, "chrome_100_percent.pak"))
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}

function isValidAntigravityBinary(filePath) {
  return Boolean(filePath) && !isAntigravityDesktopGuiPath(filePath);
}

function isInsideToolsDir(filePath, toolsDir) {
  if (!filePath || !toolsDir) return false;
  const win = process.platform === "win32";
  const a = win ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
  const b = win ? path.resolve(toolsDir).toLowerCase() : path.resolve(toolsDir);
  if (a === b) return true;
  const prefix = b.endsWith(path.sep) ? b : `${b}${path.sep}`;
  return a.startsWith(prefix);
}

/**
 * 仅查找系统安装的官方 Antigravity CLI（PATH 及常见官方目录中的 agy / antigravity），
 * 自动过滤桌面 GUI 与 ChisaBot 自身托管目录。
 */
function findSystemAntigravityBinary(customEnv) {
  const toolsDir = resolveAntigravityToolsDir(customEnv);
  const filter = (candidate) =>
    isValidAntigravityBinary(candidate) &&
    !isInsideToolsDir(candidate, toolsDir);
  const byAgy = which("agy", customEnv, { filter });
  if (byAgy) return byAgy;
  return which("antigravity", customEnv, { filter });
}

/**
 * Antigravity 专用可执行文件发现（带来源标识）：
 * 1) 显式非默认 commandPath -> 仅查该路径（source: "custom"，依然拒桌面 GUI）；
 * 2) ChisaBot 托管安装目录 -> readManagedAntigravityBinary（source: "managed"）；
 * 3) 标准官方系统安装 -> which("agy") -> which("antigravity")（source: "system"，拒桌面 GUI）。
 */
function resolveAntigravityExecutableWithSource(commandPath, customEnv) {
  const cleaned = stripWrappingQuotes(
    commandPath !== null && commandPath !== undefined
      ? String(commandPath)
      : "",
  );
  if (cleaned && !isDefaultAntigravityAlias(cleaned)) {
    const file = which(cleaned, customEnv, {
      filter: isValidAntigravityBinary,
    });
    return { file, source: file ? "custom" : null };
  }
  const managedFile = readManagedAntigravityBinary(customEnv);
  if (managedFile && isValidAntigravityBinary(managedFile)) {
    return { file: managedFile, source: "managed" };
  }
  const systemFile = findSystemAntigravityBinary(customEnv);
  if (systemFile) {
    return { file: systemFile, source: "system" };
  }
  return { file: null, source: null };
}

function resolveAntigravityExecutable(commandPath, customEnv) {
  return resolveAntigravityExecutableWithSource(commandPath, customEnv).file;
}

function buildAntigravityMissingReason(rawCommandPath, _modePref, customEnv) {
  const cleaned = stripWrappingQuotes(rawCommandPath || "");
  if (cleaned && !isDefaultAntigravityAlias(cleaned)) {
    const rawFound = which(cleaned, customEnv);
    if (rawFound && isAntigravityDesktopGuiPath(rawFound)) {
      return `指定路径是 Antigravity 桌面端应用而非 CLI/ACP 可执行文件（${cleaned}）`;
    }
    return `未找到指定的 Antigravity 可执行文件（${cleaned}）`;
  }
  return "未安装 Antigravity 运行时，可在下方一键安装或手动指定可执行路径";
}

/**
 * 解析 Antigravity 或通用 ACP 驱动的启动命令与参数。
 * 返回 { mode: "acp" | "cli", file: string | null, args: string[], runtimeSource?, homePath?, isolation?, missingReason?: string }
 */
function resolveAcpCommand(driver, config = {}, customEnv = {}, instance = null) {
  const extraArgs = Array.isArray(config.extraArgs)
    ? config.extraArgs.map(String)
    : [];
  if (driver === "antigravity") {
    const modePref = config.protocolMode || "auto";
    const rawCommandPath = stripWrappingQuotes(
      config.commandPath !== null && config.commandPath !== undefined
        ? String(config.commandPath)
        : "",
    );
    const hasExplicitCustom =
      Boolean(rawCommandPath) && !isDefaultAntigravityAlias(rawCommandPath);
    const effectiveInstance = instance || {
      driver: "antigravity",
      config,
      env: {},
    };
    const isolation = resolveAntigravityIsolation(effectiveInstance, customEnv);
    const { file: resolvedBin, source: runtimeSource } =
      resolveAntigravityExecutableWithSource(rawCommandPath, customEnv);

    if (modePref === "cli") {
      if (!resolvedBin) {
        return {
          mode: "cli",
          file: null,
          args: [],
          runtimeSource: null,
          homePath: isolation.homeDir,
          isolation,
          missingReason: buildAntigravityMissingReason(
            rawCommandPath,
            modePref,
            customEnv,
          ),
        };
      }
      if (isStandaloneAcpServerBinary(resolvedBin)) {
        return {
          mode: "cli",
          file: null,
          args: [],
          runtimeSource,
          homePath: isolation.homeDir,
          isolation,
          missingReason: `所选可执行文件仅支持 ACP 模式（${path.basename(resolvedBin)}），请切换协议模式为 auto 或 acp`,
        };
      }
      return {
        mode: "cli",
        file: resolvedBin,
        args: [...extraArgs],
        runtimeSource,
        homePath: isolation.homeDir,
        isolation,
      };
    }

    // protocolMode === "auto" | "acp"
    if (hasExplicitCustom) {
      if (!resolvedBin) {
        return {
          mode: "acp",
          file: null,
          args: [],
          runtimeSource: null,
          homePath: isolation.homeDir,
          isolation,
          missingReason: buildAntigravityMissingReason(
            rawCommandPath,
            modePref,
            customEnv,
          ),
        };
      }
      if (isStandaloneAcpServerBinary(resolvedBin)) {
        return {
          mode: "acp",
          file: resolvedBin,
          args: [...extraArgs],
          runtimeSource,
          homePath: isolation.homeDir,
          isolation,
        };
      }
      const siblingAcp = which(
        path.join(path.dirname(resolvedBin), "agy_acp_server"),
        customEnv,
        { filter: isValidAntigravityBinary },
      );
      if (siblingAcp) {
        return {
          mode: "acp",
          file: siblingAcp,
          args: [...extraArgs],
          runtimeSource,
          homePath: isolation.homeDir,
          isolation,
        };
      }
      return {
        mode: "acp",
        file: resolvedBin,
        args: ["acp", ...isolation.acpExtraArgs, ...extraArgs],
        runtimeSource,
        homePath: isolation.homeDir,
        isolation,
      };
    }

    // 默认路径模式：优先 ChisaBot 托管版现代 CLI，其次系统版（兼容同目录或 PATH 旧版独立 agy_acp_server）
    if (runtimeSource === "managed" && resolvedBin) {
      return {
        mode: "acp",
        file: resolvedBin,
        args: ["acp", ...isolation.acpExtraArgs, ...extraArgs],
        runtimeSource: "managed",
        homePath: isolation.homeDir,
        isolation,
      };
    }
    if (resolvedBin && isStandaloneAcpServerBinary(resolvedBin)) {
      return {
        mode: "acp",
        file: resolvedBin,
        args: [...extraArgs],
        runtimeSource,
        homePath: isolation.homeDir,
        isolation,
      };
    }
    const siblingAcp = resolvedBin
      ? which(
          path.join(path.dirname(resolvedBin), "agy_acp_server"),
          customEnv,
          { filter: isValidAntigravityBinary },
        )
      : null;
    const pathAcp = which("agy_acp_server", customEnv, {
      filter: isValidAntigravityBinary,
    });
    const standaloneAcp = siblingAcp || pathAcp;
    if (standaloneAcp) {
      return {
        mode: "acp",
        file: standaloneAcp,
        args: [...extraArgs],
        runtimeSource: runtimeSource || "system",
        homePath: isolation.homeDir,
        isolation,
      };
    }
    if (resolvedBin) {
      return {
        mode: "acp",
        file: resolvedBin,
        args: ["acp", ...isolation.acpExtraArgs, ...extraArgs],
        runtimeSource,
        homePath: isolation.homeDir,
        isolation,
      };
    }
    return {
      mode: "acp",
      file: null,
      args: [],
      runtimeSource: null,
      homePath: isolation.homeDir,
      isolation,
      missingReason: buildAntigravityMissingReason(
        rawCommandPath,
        modePref,
        customEnv,
      ),
    };
  }

  // driver === "acp"
  const explicitCmd = stripWrappingQuotes(
    config.commandPath !== null && config.commandPath !== undefined
      ? String(config.commandPath)
      : "",
  );
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

/**
 * 兼容别名：无副作用检查 Antigravity 隔离目录登录/凭据就绪状态（绝不读宿主全局 ~/.gemini 或 Keyring）。
 */
function inspectAntigravityAuth(instanceOrEnv, mergedEnv) {
  if (
    instanceOrEnv &&
    typeof instanceOrEnv === "object" &&
    ("driver" in instanceOrEnv ||
      "config" in instanceOrEnv ||
      "id" in instanceOrEnv ||
      "slug" in instanceOrEnv)
  ) {
    return inspectManagedAntigravityAuth(instanceOrEnv, mergedEnv || {});
  }
  return inspectManagedAntigravityAuth(
    { driver: "antigravity" },
    instanceOrEnv || {},
  );
}

function firstVersion(text) {
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?)/.exec(text || "");
  return match ? match[1] : null;
}

/**
 * 针对单个提供方实例执行探活（检查文件存在、版本号、ACP 握手或凭据就绪状态）。
 * @param {{ id?: string, slug?: string, driver: string, config?: object, env?: Record<string, string> }} spec
 */
async function probeInstance(spec = {}) {
  clearWhichCache();
  const driver = spec.driver || "builtin";
  const config = spec.config || {};
  const mergedEnv = { ...process.env, ...(spec.env || {}) };

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
    const lookupEnv = sanitizeAntigravityEnv(
      mergedEnv,
      config.fixProxy !== false,
    );
    const modePref = config.protocolMode || "auto";
    const resolved = resolveAcpCommand("antigravity", config, lookupEnv, spec);
    const isolation = resolved.isolation;
    if (!resolved.file) {
      return {
        status: "missing",
        version: null,
        resolvedPath: null,
        authenticated: null,
        authLabel: null,
        runtimeSource: null,
        homePath: isolation.homeDir,
        message:
          resolved.missingReason ||
          "未安装 Antigravity 运行时，可在下方一键安装或手动指定可执行路径",
      };
    }

    ensureAntigravityHomeDirs(isolation);
    const isStandaloneAcp = isStandaloneAcpServerBinary(resolved.file);
    const localAuth = inspectManagedAntigravityAuth(spec, lookupEnv);
    if (resolved.mode === "acp") {
      const acpProbe = await probeAcpAgent({
        file: resolved.file,
        args: resolved.args,
        env: isolation.env,
        timeoutMs: 8000,
      });
      if (acpProbe.status === "available") {
        let version = acpProbe.version;
        if (!version && !isStandaloneAcp) {
          const verRes = await capture(resolved.file, ["--version"], {
            env: isolation.env,
            timeoutMs: 6000,
          });
          version = firstVersion(verRes.out);
        }
        // 登录态严格由隔离目录与 API Key 决定，绝不误把宿主 Keyring 当成 ChisaBot 已登录
        const authenticated = localAuth.authenticated;
        const authLabel =
          localAuth.authenticated === true
            ? localAuth.authLabel
            : acpProbe.authLabel || "ACP 就绪";
        return {
          status: "available",
          version,
          resolvedPath: resolved.file,
          authenticated,
          authLabel,
          runtimeSource: resolved.runtimeSource,
          homePath: isolation.homeDir,
          message: "可用",
        };
      }
      // protocolMode === "acp" 或独立 agy_acp_server 握手失败时，绝不降级误报 CLI 可用
      if (modePref === "acp" || isStandaloneAcp) {
        return {
          status: "error",
          version: null,
          resolvedPath: resolved.file,
          authenticated: localAuth.authenticated,
          authLabel: localAuth.authLabel,
          runtimeSource: resolved.runtimeSource,
          homePath: isolation.homeDir,
          message: acpProbe.message || "Antigravity ACP 握手失败",
        };
      }
      // protocolMode === "auto" 且 ACP 握手失败：尝试 CLI --version 降级
      const verRes = await capture(resolved.file, ["--version"], {
        env: isolation.env,
        timeoutMs: 6000,
      });
      const cliVersion = firstVersion(verRes.out);
      if (verRes.code === 0 || cliVersion) {
        return {
          status: "available",
          version: cliVersion,
          resolvedPath: resolved.file,
          authenticated: localAuth.authenticated,
          authLabel: localAuth.authLabel || "CLI 可用",
          runtimeSource: resolved.runtimeSource,
          homePath: isolation.homeDir,
          message: "可用",
        };
      }
      return {
        status: "error",
        version: null,
        resolvedPath: resolved.file,
        authenticated: localAuth.authenticated,
        authLabel: localAuth.authLabel,
        runtimeSource: resolved.runtimeSource,
        homePath: isolation.homeDir,
        message: (
          acpProbe.message ||
          verRes.out ||
          "无法运行 Antigravity"
        )
          .trim()
          .slice(0, 240),
      };
    }

    // resolved.mode === "cli"
    const verRes = await capture(resolved.file, ["--version"], {
      env: isolation.env,
      timeoutMs: 6000,
    });
    const cliVersion = firstVersion(verRes.out);
    if (verRes.code === 0 || cliVersion) {
      return {
        status: "available",
        version: cliVersion,
        resolvedPath: resolved.file,
        authenticated: localAuth.authenticated,
        authLabel: localAuth.authLabel || "CLI 可用",
        runtimeSource: resolved.runtimeSource,
        homePath: isolation.homeDir,
        message: "可用",
      };
    }
    return {
      status: "error",
      version: null,
      resolvedPath: resolved.file,
      authenticated: localAuth.authenticated,
      authLabel: localAuth.authLabel,
      runtimeSource: resolved.runtimeSource,
      homePath: isolation.homeDir,
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
  clearWhichCache();
  const found = [{ kind: "builtin", version: null, path: null }];
  const checks = Object.entries(AGENT_BINARIES).map(async ([kind, names]) => {
    if (kind === "antigravity") {
      const lookupEnv = sanitizeAntigravityEnv(process.env, true);
      const resolved = resolveAcpCommand("antigravity", {}, lookupEnv);
      if (!resolved.file) return;
      const isolatedEnv = resolved.isolation?.env || lookupEnv;
      if (isStandaloneAcpServerBinary(resolved.file)) {
        const acpProbe = await probeAcpAgent({
          file: resolved.file,
          args: resolved.args,
          env: isolatedEnv,
          timeoutMs: 8000,
        });
        if (acpProbe.status === "available") {
          found.push({
            kind,
            version: acpProbe.version,
            path: resolved.file,
          });
        }
        return;
      }
      const result = await capture(resolved.file, ["--version"], {
        env: isolatedEnv,
      });
      if (result.code === 0 || firstVersion(result.out)) {
        found.push({
          kind,
          version: firstVersion(result.out),
          path: resolved.file,
        });
        return;
      }
      const acpProbe = await probeAcpAgent({
        file: resolved.file,
        args: resolved.args,
        env: isolatedEnv,
        timeoutMs: 8000,
      });
      if (acpProbe.status === "available") {
        found.push({
          kind,
          version: acpProbe.version,
          path: resolved.file,
        });
      }
      return;
    }
    const env = process.env;
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

async function detectSandboxes(options = {}) {
  const platform = options.platform || process.platform;
  const captureImpl = options.capture || capture;
  const whichImpl = options.which || which;
  const existsAsync =
    options.exists ||
    ((targetPath) =>
      fsp.access(targetPath).then(
        () => true,
        () => false,
      ));

  const tasks = [
    [
      "git",
      captureImpl(whichImpl("git") || "git", ["--version"]).then(
        (res) => res?.code === 0,
      ),
    ],
  ];

  if (platform === "linux") {
    const bwrap = whichImpl("bwrap");
    // 能装上不等于能用（容器里没有 user namespace）：真的跑一次 /bin/true。
    tasks.push([
      "bwrap",
      bwrap
        ? captureImpl(bwrap, [
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--",
            "true",
          ]).then((res) => res?.code === 0)
        : Promise.resolve(false),
    ]);
  }

  if (platform === "darwin") {
    tasks.push(["sandbox-exec", existsAsync("/usr/bin/sandbox-exec")]);
  }

  for (const engine of ["docker", "podman"]) {
    const file = whichImpl(engine);
    tasks.push([
      engine,
      file
        ? captureImpl(file, ["info", "--format", "{{.ServerVersion}}"], {
            timeoutMs: 8000,
          }).then((res) => res?.code === 0)
        : Promise.resolve(false),
    ]);
  }

  if (platform === "win32") {
    const wsl = whichImpl("wsl");
    tasks.push([
      "wsl",
      wsl
        ? captureImpl(wsl, ["--status"], { timeoutMs: 8000 }).then(
            (res) => res?.code === 0,
          )
        : Promise.resolve(false),
    ]);
    tasks.push([
      "windows-sandbox",
      existsAsync(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsSandbox.exe",
        ),
      ),
    ]);
  }

  const settled = await Promise.allSettled(tasks.map(([, promise]) => promise));
  const has = {
    git: false,
    worktree: false,
    copy: true,
    none: true,
  };
  for (let i = 0; i < tasks.length; i += 1) {
    const key = tasks[i][0];
    const outcome = settled[i];
    has[key] = outcome.status === "fulfilled" && Boolean(outcome.value);
  }
  has.worktree = has.git;
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
  resolveAntigravityExecutable,
  resolveAntigravityExecutableWithSource,
  findSystemAntigravityBinary,
  isStandaloneAcpServerBinary,
  resolveAcpCommand,
  isAntigravityDesktopGuiPath,
  inspectAntigravityAuth,
  inspectManagedAntigravityAuth,
  resolveAntigravityIsolation,
  extraSearchDirs,
  which,
  clearWhichCache,
  capture,
  firstVersion,
  AGENT_BINARIES,
};
