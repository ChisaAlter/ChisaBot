"use strict";
/**
 * 本机配置与本机审计日志（userData 目录）。
 * 设备令牌用 Electron safeStorage（Windows 上是 DPAPI）加密后保存；不可用时才明文保存并在设置页提示。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  hardenFilePermissions,
  hardenFilePermissionsSync,
  readFileNoFollow,
  renameWithRetrySync,
  writeFileAtomicSafe,
} = require("./safe-fs");

const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
const AUDIT_KEEP_LINES = 2000;

const DEFAULTS = {
  serverUrl: "",
  username: "",
  /** 登录页「服务器地址」的历史（最近用过的在前，最多 6 个）。 */
  recentServers: [],
  /** 登录页「记住登录」上次的选择。密码从不保存：记住登录 = 服务器发 30 天的会话 Cookie。 */
  remember: true,
  deviceId: "",
  deviceName: "",
  tokenEnc: "",
  tokenPlain: "",
  autoStart: false,
  forceLocalApproval: true,
  localPaused: false,
  startHidden: false,
  /** 在线更新（updater.js）：开着时启动后和每 4 小时自动检查并在后台下载。 */
  autoUpdate: true,
  /** 上次刷新快捷方式 / 图标缓存时的外壳指纹（src/shell-refresh.js）；和当前版本不同就再刷新一次。 */
  shellHash: "",
  /** 主窗口里网页的外观（深浅色 / 主题 / 材质 / 画布 / 时间天空），本机窗口跟着它走；dark 为 null 时跟随系统。 */
  appearance: {
    dark: null,
    theme: "sky",
    material: "glass",
    canvas: "sky",
    sky: true,
  },
  /** 硬件加速开关（重启客户端后生效）；遇到显卡兼容黑屏/花屏时可关闭。 */
  hardwareAcceleration: true,
  /** 渲染进程拼写检查开关（配合原生右键菜单拼写建议）。 */
  spellcheck: true,
  /** 显式时区覆盖（IANA 时区如 Asia/Shanghai；留空跟随系统时区）。 */
  timezone: "",
  /** 渲染进程出口域名白名单（除已配服务器与 loopback 外显式放行的域名或 *.domain.tld）。 */
  allowedEgressDomains: [],
};

function readConfigFileStrictSync(filePath) {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("拒绝读取非普通文件或符号链接的配置文件。");
  }
  if (process.platform !== "win32" && (Number(before.mode) & 0o777) !== 0o600) {
    throw new Error("配置文件权限不是 0600，已拒绝读取。");
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== info.dev || before.ino !== info.ino || !info.isFile()) {
      throw new Error("配置文件在打开期间发生变动，已拒绝读取。");
    }
    if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== 0o600) {
      throw new Error("配置文件句柄权限不是 0600，已拒绝读取。");
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function createConfig({
  dir,
  safeStorage,
  asyncSave = false,
  initialConfig = null,
}) {
  const file = path.join(dir, "config.json");
  const auditFile = path.join(dir, "audit.jsonl");
  let data = { ...DEFAULTS };
  if (
    initialConfig &&
    typeof initialConfig === "object" &&
    !Array.isArray(initialConfig)
  ) {
    data = { ...DEFAULTS, ...initialConfig };
  } else {
    try {
      data = { ...DEFAULTS, ...JSON.parse(readConfigFileStrictSync(file)) };
    } catch {}
  }

  /** 内存解密缓存：仅随当前加密密文命中，不落盘，令牌变更或清空时即时失效。 */
  let hasCachedToken = false;
  let cachedTokenEnc = "";
  let cachedTokenValue = null;

  /** 配置变更监听器（供主进程按变更刷新预编译出网策略等派生缓存）。 */
  const changeListeners = new Set();

  /** 串行异步配置保存状态（仅 asyncSave 模式下激活，减少主进程事件循环同步阻塞）。 */
  let configDirReady = false;
  let pendingConfigText = null;
  let configFlushPromise = null;

  /** 审计日志异步串行写盘队列 + 读合并状态 + 磁盘行缓存。 */
  let auditDirReady = false;
  let auditFileHardened = false;
  let auditBytes = null;
  let pendingAudit = [];
  let inflightAudit = [];
  let inflightBaseBytes = 0;
  let inflightTotalBytes = 0;
  let auditFlushPromise = null;
  let cachedDiskAuditLines = null;
  let cachedDiskAuditSize = -1;
  let cachedDiskAuditMtimeMs = -1;

  // 初始化阶段异步收敛配置目录、配置文件与既有审计日志权限（不阻塞同步启动热路径）
  void (async () => {
    await hardenFilePermissions(dir, 0o700).catch(() => {});
    await hardenFilePermissions(file, 0o600).catch(() => {});
    await hardenFilePermissions(auditFile, 0o600).catch(() => {});
  })();

  function invalidateTokenCache() {
    hasCachedToken = false;
    cachedTokenEnc = "";
    cachedTokenValue = null;
  }

  function notifyChange() {
    for (const listener of changeListeners) {
      try {
        listener(data);
      } catch {}
    }
  }

  function saveSync(serialized = JSON.stringify(data, null, 2)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    hardenFilePermissionsSync(dir, 0o700);
    configDirReady = true;
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    let renamed = false;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, serialized);
      if (process.platform !== "win32") {
        fs.fchmodSync(fd, 0o600);
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      renameWithRetrySync(tmp, file);
      renamed = true;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      if (!renamed) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
    }
  }

  function drainSaveQueue() {
    if (configFlushPromise) return configFlushPromise;
    configFlushPromise = (async () => {
      try {
        while (pendingConfigText !== null) {
          const text = pendingConfigText;
          pendingConfigText = null;
          if (!configDirReady) {
            await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
            await hardenFilePermissions(dir, 0o700);
            configDirReady = true;
          }
          await writeFileAtomicSafe(file, text, {
            mode: 0o600,
            fsync: false,
          });
          await hardenFilePermissions(file, 0o600).catch(() => {});
        }
      } catch {
        configDirReady = false;
      } finally {
        configFlushPromise = null;
        if (pendingConfigText !== null) {
          void drainSaveQueue();
        }
      }
    })();
    return configFlushPromise;
  }

  function save() {
    const serialized = JSON.stringify(data, null, 2);
    if (!asyncSave) {
      saveSync(serialized);
      return;
    }
    pendingConfigText = serialized;
    void drainSaveQueue();
  }

  function flushSave() {
    return (
      configFlushPromise ||
      (pendingConfigText !== null ? drainSaveQueue() : Promise.resolve())
    );
  }

  function flushSaveSync() {
    if (pendingConfigText === null && !configFlushPromise) return;
    const text =
      pendingConfigText !== null
        ? pendingConfigText
        : JSON.stringify(data, null, 2);
    pendingConfigText = null;
    try {
      saveSync(text);
    } catch {}
  }

  const encryptionBackend = () => {
    try {
      if (!safeStorage) return "none";
      const selected =
        typeof safeStorage.getSelectedStorageBackend === "function"
          ? safeStorage.getSelectedStorageBackend()
          : "";
      if (selected === "basic_text") return "basic_text";
      if (!safeStorage.isEncryptionAvailable?.()) {
        return typeof selected === "string" && selected ? selected : "none";
      }
      if (typeof selected === "string" && selected) return selected;
      if (process.platform === "win32") return "dpapi";
      if (process.platform === "darwin") return "keychain";
      return "keyring";
    } catch {
      return "none";
    }
  };

  const encryptionAvailable = () => {
    try {
      if (!safeStorage?.isEncryptionAvailable()) return false;
      if (
        typeof safeStorage.getSelectedStorageBackend === "function" &&
        safeStorage.getSelectedStorageBackend() === "basic_text"
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  /** 允许解密既有密文（含历史 Linux basic_text 密文），而新写入令牌仍受 encryptionAvailable() 严格把关。 */
  const canDecryptStorage = () => {
    try {
      return !!safeStorage && !!safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  function drainAuditQueue() {
    if (auditFlushPromise) return auditFlushPromise;
    auditFlushPromise = (async () => {
      try {
        while (pendingAudit.length > 0) {
          if (!auditDirReady) {
            await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
            await hardenFilePermissions(dir, 0o700);
            auditDirReady = true;
          }
          if (auditBytes === null) {
            const st = await fsp.lstat(auditFile).catch(() => null);
            if (st?.isSymbolicLink()) {
              throw new Error("拒绝向符号链接写入审计日志");
            }
            auditBytes = st ? st.size : 0;
          }
          const batch = pendingAudit;
          pendingAudit = [];
          const chunk = `${batch.map((item) => item.line).join("\n")}\n`;
          const chunkBytes = Buffer.byteLength(chunk, "utf8");
          inflightAudit = batch;
          inflightBaseBytes = auditBytes;
          inflightTotalBytes = chunkBytes;
          await fsp.appendFile(auditFile, chunk, {
            encoding: "utf8",
            mode: 0o600,
          });
          if (!auditFileHardened) {
            await hardenFilePermissions(auditFile, 0o600);
            auditFileHardened = true;
          }
          auditBytes += chunkBytes;
          if (cachedDiskAuditLines !== null) {
            for (const item of batch) cachedDiskAuditLines.push(item.line);
            cachedDiskAuditSize = auditBytes;
            const postSt = await fsp.stat(auditFile).catch(() => null);
            if (postSt) cachedDiskAuditMtimeMs = postSt.mtimeMs;
          }
          inflightAudit = [];
          inflightTotalBytes = 0;

          if (auditBytes > AUDIT_MAX_BYTES) {
            const readRes = await readFileNoFollow(auditFile);
            const lines = readRes.buffer
              .toString("utf8")
              .trim()
              .split("\n")
              .filter(Boolean);
            const kept = lines.slice(-AUDIT_KEEP_LINES);
            const rotated = `${kept.join("\n")}\n`;
            await writeFileAtomicSafe(auditFile, rotated, {
              mode: 0o600,
              fsync: false,
              expectedStat: readRes.stat,
            });
            await hardenFilePermissions(auditFile, 0o600);
            auditBytes = Buffer.byteLength(rotated, "utf8");
            cachedDiskAuditLines = kept;
            cachedDiskAuditSize = auditBytes;
            const postRotSt = await fsp.stat(auditFile).catch(() => null);
            cachedDiskAuditMtimeMs = postRotSt ? postRotSt.mtimeMs : -1;
          }
        }
      } catch {
        inflightAudit = [];
        inflightTotalBytes = 0;
        auditBytes = null;
        auditDirReady = false;
        auditFileHardened = false;
      } finally {
        auditFlushPromise = null;
        if (pendingAudit.length > 0) {
          void drainAuditQueue();
        }
      }
    })();
    return auditFlushPromise;
  }

  function flushAuditSync() {
    if (pendingAudit.length === 0 && inflightAudit.length === 0) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      hardenFilePermissionsSync(dir, 0o700);
      auditDirReady = true;
      let auditLstat = null;
      try {
        auditLstat = fs.lstatSync(auditFile);
      } catch {}
      if (auditLstat?.isSymbolicLink()) return;
      const diskSize = auditLstat ? auditLstat.size : 0;
      const toWrite = [];
      if (
        inflightAudit.length > 0 &&
        diskSize < inflightBaseBytes + inflightTotalBytes
      ) {
        toWrite.push(...inflightAudit);
        inflightAudit = [];
        inflightTotalBytes = 0;
      }
      if (pendingAudit.length > 0) {
        toWrite.push(...pendingAudit);
        pendingAudit = [];
      }
      if (toWrite.length > 0) {
        const chunk = `${toWrite.map((item) => item.line).join("\n")}\n`;
        fs.appendFileSync(auditFile, chunk, { encoding: "utf8", mode: 0o600 });
        hardenFilePermissionsSync(auditFile, 0o600);
        auditFileHardened = true;
        auditBytes = diskSize + Buffer.byteLength(chunk, "utf8");
        cachedDiskAuditLines = null;
        cachedDiskAuditSize = -1;
        cachedDiskAuditMtimeMs = -1;
      }
    } catch {}
  }

  function setToken(token) {
    if (!token) {
      data.tokenEnc = "";
      data.tokenPlain = "";
      invalidateTokenCache();
    } else if (encryptionAvailable()) {
      const enc = safeStorage.encryptString(token).toString("base64");
      data.tokenEnc = enc;
      data.tokenPlain = "";
      cachedTokenEnc = enc;
      cachedTokenValue = String(token);
      hasCachedToken = true;
    } else {
      data.tokenEnc = "";
      data.tokenPlain = token;
      invalidateTokenCache();
    }
    save();
    notifyChange();
  }

  async function securityAudit(opts = {}) {
    await flushSave();
    const targetPlatform = opts?.platform || process.platform;
    const isWin = targetPlatform === "win32";
    const targets = [
      { name: "config.json", filePath: file },
      { name: "audit.jsonl", filePath: auditFile },
    ];
    const files = await Promise.all(
      targets.map(async ({ name, filePath }) => {
        try {
          const st = await fsp.lstat(filePath);
          const isSymlink = st.isSymbolicLink();
          const isRegular = st.isFile();
          const mode = Number(st.mode) & 0o777;
          const secure = isWin
            ? !isSymlink && isRegular
            : !isSymlink && isRegular && mode === 0o600;
          return {
            name,
            exists: true,
            mode,
            secure,
            isSymlink,
          };
        } catch (err) {
          if (err?.code === "ENOENT") {
            return {
              name,
              exists: false,
              mode: null,
              secure: true,
              isSymlink: false,
            };
          }
          return {
            name,
            exists: false,
            mode: null,
            secure: false,
            isSymlink: false,
          };
        }
      }),
    );
    return {
      platform: targetPlatform,
      tokenProtected: !!data.tokenEnc,
      encryptionBackend: encryptionBackend(),
      files,
    };
  }

  async function hardenPermissions(opts = {}) {
    const targetPlatform = opts?.platform || process.platform;
    await hardenFilePermissions(dir, 0o700, { platform: targetPlatform });
    await hardenFilePermissions(file, 0o600, { platform: targetPlatform });
    await hardenFilePermissions(auditFile, 0o600, { platform: targetPlatform });
    return securityAudit({ platform: targetPlatform });
  }

  return {
    get: () => ({ ...data }),
    /** 内部只读访问当前配置对象（避免热路径整对象浅拷贝；调用方严禁修改返回对象）。 */
    peek: () => data,
    onChange(listener) {
      if (typeof listener !== "function") return () => {};
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    set(patch) {
      if (patch && ("tokenEnc" in patch || "tokenPlain" in patch)) {
        invalidateTokenCache();
      }
      data = { ...data, ...patch };
      save();
      notifyChange();
      return { ...data };
    },
    getToken() {
      if (data.tokenEnc && canDecryptStorage()) {
        if (hasCachedToken && cachedTokenEnc === data.tokenEnc) {
          return cachedTokenValue;
        }
        try {
          const decrypted = safeStorage.decryptString(
            Buffer.from(data.tokenEnc, "base64"),
          );
          cachedTokenEnc = data.tokenEnc;
          cachedTokenValue = decrypted;
          hasCachedToken = true;
          return decrypted;
        } catch {
          invalidateTokenCache();
          return data.tokenPlain || null;
        }
      }
      invalidateTokenCache();
      return data.tokenPlain || null;
    },
    setToken,
    clearToken() {
      setToken(null);
    },
    tokenProtected: () => !!data.tokenEnc,
    encryptionAvailable,
    encryptionBackend,
    securityAudit,
    hardenPermissions,
    appendAudit(entry) {
      try {
        const line = JSON.stringify(entry);
        pendingAudit.push({ line });
        void drainAuditQueue();
      } catch {}
    },
    flush: flushSave,
    flushSync: flushSaveSync,
    flushAudit() {
      return (
        auditFlushPromise ||
        (pendingAudit.length > 0 ? drainAuditQueue() : Promise.resolve())
      );
    },
    flushAuditSync,
    readAudit(limit = 200) {
      try {
        let diskLines = [];
        let diskSize = 0;
        try {
          const st = fs.statSync(auditFile);
          diskSize = st.size;
          if (
            cachedDiskAuditLines !== null &&
            cachedDiskAuditSize === st.size &&
            cachedDiskAuditMtimeMs === st.mtimeMs
          ) {
            diskLines = cachedDiskAuditLines;
          } else if (diskSize > 0) {
            const buf = fs.readFileSync(auditFile);
            diskSize = buf.length;
            diskLines = buf.toString("utf8").trim().split("\n").filter(Boolean);
            cachedDiskAuditLines = diskLines;
            cachedDiskAuditSize = diskSize;
            cachedDiskAuditMtimeMs = st.mtimeMs;
          } else {
            cachedDiskAuditLines = [];
            cachedDiskAuditSize = 0;
            cachedDiskAuditMtimeMs = st.mtimeMs;
          }
        } catch {
          cachedDiskAuditLines = [];
          cachedDiskAuditSize = 0;
          cachedDiskAuditMtimeMs = -1;
        }

        const merged = diskLines.slice();
        if (
          inflightAudit.length > 0 &&
          diskSize < inflightBaseBytes + inflightTotalBytes
        ) {
          for (const item of inflightAudit) merged.push(item.line);
        }
        if (pendingAudit.length > 0) {
          for (const item of pendingAudit) merged.push(item.line);
        }
        if (merged.length === 0) return [];
        const take =
          Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
        return merged
          .slice(-take)
          .reverse()
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    async readAuditAsync(limit = 200) {
      try {
        let diskLines = [];
        let diskSize = 0;
        try {
          const st = await fsp.stat(auditFile);
          diskSize = st.size;
          if (
            cachedDiskAuditLines !== null &&
            cachedDiskAuditSize === st.size &&
            cachedDiskAuditMtimeMs === st.mtimeMs
          ) {
            diskLines = cachedDiskAuditLines;
          } else if (diskSize > 0) {
            const buf = await fsp.readFile(auditFile);
            diskSize = buf.length;
            diskLines = buf.toString("utf8").trim().split("\n").filter(Boolean);
            cachedDiskAuditLines = diskLines;
            cachedDiskAuditSize = diskSize;
            cachedDiskAuditMtimeMs = st.mtimeMs;
          } else {
            cachedDiskAuditLines = [];
            cachedDiskAuditSize = 0;
            cachedDiskAuditMtimeMs = st.mtimeMs;
          }
        } catch {
          cachedDiskAuditLines = [];
          cachedDiskAuditSize = 0;
          cachedDiskAuditMtimeMs = -1;
        }

        const merged = diskLines.slice();
        if (
          inflightAudit.length > 0 &&
          diskSize < inflightBaseBytes + inflightTotalBytes
        ) {
          for (const item of inflightAudit) merged.push(item.line);
        }
        if (pendingAudit.length > 0) {
          for (const item of pendingAudit) merged.push(item.line);
        }
        if (merged.length === 0) return [];
        const take =
          Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
        return merged
          .slice(-take)
          .reverse()
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

module.exports = { createConfig, DEFAULTS };
