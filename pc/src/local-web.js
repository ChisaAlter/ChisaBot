"use strict";
/**
 * 桌面端内置本地前端与「版本高者优先」同源拦截控制器（DESIGN.md §137）。
 *
 * 原则：
 *  1. 窗口地址始终保持服务器真实 origin，保证 HttpOnly Cookie、Origin 白名单与 web-preload 同源桥完全不变；
 *  2. /api、/auth、/login、/sign、/p、/downloads 等服务端路由与所有非 GET/HEAD 请求一律透传服务器；
 *  3. 当内置前端存在、且已知服务器版本不高于内置版本时，页面导航与静态资源直接从本机读取；
 *     一旦探测到服务器版本严格高于桌面端内置版本，立即切换为透传模式加载服务器更新的前端；
 *  4. 透传层使用 Chromium `net.request` + `redirect: "manual"`，保留原生 302 重定向、Set-Cookie、
 *     Range 响应、SSE 流式分块，并剥离已由 Chromium 解压的 gzip/br 编码头，避免 ERR_CONTENT_DECODING_FAILED。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { compareVersion } = require("./updater");

const META_NAME = "chisabot-web-meta.json";

/** 这些前缀永远由服务端/网关直接处理，即使在本地前端模式下也绝不拦截到本地文件。 */
const SERVER_ONLY_PREFIX_RE =
  /^\/(?:api|auth|login|sign|sign-in|logout|p|downloads|magpie|magpie-admin|workspace|node-agent|_chisabot|_internal|v1|v1beta)(?:\/|$)/;
/** 需要保留原生 302 重定向语义（触发 webContents will-redirect / Set-Cookie）的鉴权与会话路径。 */
const REDIRECT_SENSITIVE_PREFIX_RE =
  /^\/(?:auth|login|sign|sign-in|logout)(?:\/|$)/;

/** 本地 bundle 内存缓存阈值：单文件上限 2 MiB，总缓存上限 24 MiB。 */
const MAX_CACHE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_TOTAL_BYTES = 24 * 1024 * 1024;

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);
const SKIP_REQ_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);
const HOP_BY_HOP_RES_HEADERS = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "upgrade",
]);
const MAX_VERSION_SNIFF_BYTES = 64 * 1024;

const installedSessions = new WeakSet();

function contentTypeFor(filePath) {
  return (
    MIME_BY_EXT[path.extname(filePath).toLowerCase()] ||
    "application/octet-stream"
  );
}

function readHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return String(headers.get(name) || "");
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) {
      return Array.isArray(v) ? String(v[0] || "") : String(v || "");
    }
  }
  return "";
}

function readBundleMeta(bundleDir, localVersion, fsImpl = fs) {
  const indexFile = path.join(bundleDir, "index.html");
  const hasLocalBundle =
    Boolean(bundleDir) &&
    fsImpl.existsSync(indexFile) &&
    fsImpl.statSync(indexFile).isFile();
  let metaVersion = "";
  if (hasLocalBundle) {
    try {
      const parsed = JSON.parse(
        fsImpl.readFileSync(path.join(bundleDir, META_NAME), "utf8"),
      );
      if (typeof parsed?.version === "string" && parsed.version.trim()) {
        metaVersion = parsed.version.trim();
      }
    } catch {}
  }
  return {
    hasLocalBundle,
    bundledVersion: metaVersion || String(localVersion || "").trim(),
  };
}

/** 启动时预建本地 bundle 文件路由索引表（规范化 POSIX 路径 → 绝对文件路径），消除请求热路径同步 stat。 */
function buildBundleFileIndex(bundleDir, fsImpl = fs) {
  if (!bundleDir || typeof fsImpl.readdirSync !== "function") return null;
  const rootDir = path.resolve(bundleDir);
  const index = new Map();
  const walk = (dir, posixPrefix) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (!name || name === "." || name === "..") continue;
      const full = path.join(dir, name);
      const nextPosix = `${posixPrefix}/${name}`;
      let isDir = false;
      let isFile = false;
      if (typeof entry === "object" && entry !== null) {
        isDir = typeof entry.isDirectory === "function" && entry.isDirectory();
        isFile = typeof entry.isFile === "function" && entry.isFile();
      } else {
        try {
          const st = fsImpl.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        walk(full, nextPosix);
      } else if (isFile) {
        index.set(nextPosix, full);
      }
    }
  };
  walk(rootDir, "");
  return index;
}

/** 用预建索引表 O(1) 解析 URL pathname，拒绝 `..` 逃逸、反斜杠与空字节。 */
function lookupIndexedBundleFile(bundleIndex, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname || "/");
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/");
  const clean = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return null;
    clean.push(seg);
  }
  if (clean.length === 0) return null;
  return bundleIndex.get(`/${clean.join("/")}`) || null;
}

/** 将 URL pathname 安全映射到本地 web-bundle 目录下的普通文件，阻止 `..` 逃逸与空字节。 */
function resolveBundleFile(bundleDir, pathname, fsImpl = fs) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname || "/");
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0")) return null;
  const rel = decoded.replace(/^\/+/, "");
  if (!rel) return null;
  const rootDir = path.resolve(bundleDir);
  const candidate = path.resolve(rootDir, rel);
  const relative = path.relative(rootDir, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  try {
    if (fsImpl.existsSync(candidate) && fsImpl.statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function buildResponseHeaders(
  rawHeaders,
  { stripDecodedHeaders = false } = {},
) {
  const out = new Headers();
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP_RES_HEADERS.has(lk)) continue;
    if (
      stripDecodedHeaders &&
      (lk === "content-encoding" || lk === "content-length")
    ) {
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) out.append(k, String(item));
    } else if (v !== undefined) {
      out.append(k, String(v));
    }
  }
  return out;
}

function buildForwardRequestHeaders(request, { sameServer, origin }) {
  const headers = {};
  if (request.headers && typeof request.headers.entries === "function") {
    for (const [k, v] of request.headers.entries()) {
      if (SKIP_REQ_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
  }
  const method = String(request.method || "GET").toUpperCase();
  if (sameServer && method !== "GET" && method !== "HEAD" && origin) {
    const hasOrigin = Object.keys(headers).some(
      (k) => k.toLowerCase() === "origin",
    );
    if (!hasOrigin) headers.Origin = origin;
  }
  return headers;
}

function safeStatus(statusCode) {
  const code = Number(statusCode);
  if (!Number.isInteger(code) || code < 200 || code > 599) return 502;
  return code;
}

function createLocalWebController({
  bundleDir,
  localVersion = "",
  getServerOrigin,
  onModeChange,
  fsImpl = fs,
  netImpl,
} = {}) {
  const resolvedBundleDir = bundleDir ? path.resolve(bundleDir) : "";
  const { hasLocalBundle, bundledVersion } = readBundleMeta(
    resolvedBundleDir,
    localVersion,
    fsImpl,
  );
  const bundleIndex = hasLocalBundle
    ? buildBundleFileIndex(resolvedBundleDir, fsImpl)
    : null;
  const indexHtmlPath = hasLocalBundle
    ? bundleIndex?.get("/index.html") || path.join(resolvedBundleDir, "index.html")
    : "";
  /** 有界内存字节缓存（LRU 插入序）：热静态资源零磁盘 I/O，超出上限按最旧淘汰。 */
  const fileCache = new Map();
  const inflightReads = new Map();
  let fileCacheBytes = 0;
  const serverVersions = new Map();

  function rememberFileBytes(filePath, bytes) {
    if (!bytes || bytes.byteLength > MAX_CACHE_FILE_BYTES) return;
    if (fileCache.has(filePath)) {
      const prev = fileCache.get(filePath);
      fileCacheBytes -= prev.byteLength;
      fileCache.delete(filePath);
    }
    while (
      fileCache.size > 0 &&
      fileCacheBytes + bytes.byteLength > MAX_CACHE_TOTAL_BYTES
    ) {
      const oldestKey = fileCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = fileCache.get(oldestKey);
      fileCache.delete(oldestKey);
      fileCacheBytes -= oldest.byteLength;
    }
    fileCache.set(filePath, bytes);
    fileCacheBytes += bytes.byteLength;
  }

  async function readBundleBytes(filePath) {
    const cached = fileCache.get(filePath);
    if (cached) {
      fileCache.delete(filePath);
      fileCache.set(filePath, cached);
      return cached;
    }
    const existing = inflightReads.get(filePath);
    if (existing) return existing;
    const task = fsp
      .readFile(filePath)
      .then((bytes) => {
        rememberFileBytes(filePath, bytes);
        return bytes;
      })
      .finally(() => {
        inflightReads.delete(filePath);
      });
    inflightReads.set(filePath, task);
    return task;
  }

  function activeMode(origin) {
    if (!hasLocalBundle || !origin) return "remote";
    const served = serverVersions.get(origin);
    if (
      served &&
      bundledVersion &&
      compareVersion(served, bundledVersion) > 0
    ) {
      return "remote";
    }
    return "local";
  }

  function recordServerVersion(origin, version) {
    const cleanOrigin = typeof origin === "string" ? origin.trim() : "";
    const cleanVersion = typeof version === "string" ? version.trim() : "";
    if (!cleanOrigin || !cleanVersion) return false;
    const prevMode = activeMode(cleanOrigin);
    const prevVer = serverVersions.get(cleanOrigin);
    serverVersions.set(cleanOrigin, cleanVersion);
    const nextMode = activeMode(cleanOrigin);
    if (prevMode !== nextMode || prevVer !== cleanVersion) {
      onModeChange?.({
        origin: cleanOrigin,
        mode: nextMode,
        prevMode,
        serverVersion: cleanVersion,
      });
    }
    return true;
  }

  async function probeVersion({
    origin,
    fetchImpl,
    cookieHeader = "",
    timeoutMs = 2500,
  }) {
    if (!origin || typeof fetchImpl !== "function") return null;
    try {
      const response = await fetchImpl(`${origin}/api/version`, {
        method: "GET",
        cache: "no-store",
        headers: {
          accept: "application/json",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) return null;
      const body = await response.json().catch(() => null);
      const version =
        typeof body?.version === "string" ? body.version.trim() : "";
      if (!version) return null;
      recordServerVersion(origin, version);
      return version;
    } catch {
      return null;
    }
  }

  function statusFor(origin) {
    const cleanOrigin = typeof origin === "string" ? origin.trim() : "";
    const serverVersion = cleanOrigin
      ? serverVersions.get(cleanOrigin)
      : undefined;
    return {
      hasLocalBundle,
      mode: activeMode(cleanOrigin),
      bundledVersion,
      ...(serverVersion ? { serverVersion } : {}),
    };
  }

  function classifyRequest({ url, method = "GET", headers = {} }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return {
        action: "passthrough",
        sameServer: false,
        pathname: "",
        origin: "",
      };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        action: "passthrough",
        sameServer: false,
        pathname: parsed.pathname,
        origin: parsed.origin,
      };
    }
    const origin =
      typeof getServerOrigin === "function" ? getServerOrigin() || "" : "";
    const sameServer = Boolean(origin && parsed.origin === origin);
    if (!sameServer) {
      return {
        action: "passthrough",
        sameServer: false,
        pathname: parsed.pathname,
        origin: parsed.origin,
      };
    }
    const upperMethod = String(method || "GET").toUpperCase();
    if (upperMethod !== "GET" && upperMethod !== "HEAD") {
      return {
        action: "passthrough",
        sameServer: true,
        pathname: parsed.pathname,
        origin: parsed.origin,
      };
    }
    if (SERVER_ONLY_PREFIX_RE.test(parsed.pathname)) {
      return {
        action: "passthrough",
        sameServer: true,
        pathname: parsed.pathname,
        origin: parsed.origin,
      };
    }
    if (activeMode(origin) !== "local") {
      return {
        action: "passthrough",
        sameServer: true,
        pathname: parsed.pathname,
        origin: parsed.origin,
      };
    }

    if (parsed.pathname !== "/") {
      const filePath = bundleIndex
        ? lookupIndexedBundleFile(bundleIndex, parsed.pathname)
        : resolveBundleFile(resolvedBundleDir, parsed.pathname, fsImpl);
      if (filePath) {
        return {
          action: "local-file",
          sameServer: true,
          pathname: parsed.pathname,
          origin: parsed.origin,
          filePath,
          contentType: contentTypeFor(filePath),
          cacheControl: parsed.pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        };
      }
      if (parsed.pathname.startsWith("/assets/")) {
        return {
          action: "passthrough",
          sameServer: true,
          pathname: parsed.pathname,
          origin: parsed.origin,
        };
      }
    }

    const dest = readHeader(headers, "sec-fetch-dest").toLowerCase();
    const upgradeReq = readHeader(headers, "upgrade-insecure-requests");
    const accept = readHeader(headers, "accept").toLowerCase();
    const hasExt = Boolean(path.posix.extname(parsed.pathname));
    if (
      parsed.pathname === "/" ||
      dest === "document" ||
      upgradeReq === "1" ||
      (!hasExt && accept.includes("text/html"))
    ) {
      return {
        action: "local-file",
        sameServer: true,
        pathname: parsed.pathname,
        origin: parsed.origin,
        filePath: indexHtmlPath || path.join(resolvedBundleDir, "index.html"),
        contentType: "text/html; charset=utf-8",
        cacheControl: "no-cache",
      };
    }

    return {
      action: "passthrough",
      sameServer: true,
      pathname: parsed.pathname,
      origin: parsed.origin,
    };
  }

  async function forwardWithNetRequest(request, ses, decision) {
    const netMod = netImpl || require("electron").net;
    const method = String(request.method || "GET").toUpperCase();
    const headers = buildForwardRequestHeaders(request, decision);
    const bodyBuf =
      method !== "GET" && method !== "HEAD" && request.body
        ? Buffer.from(await request.arrayBuffer())
        : null;
    const sniffVersion =
      decision.sameServer &&
      method === "GET" &&
      decision.pathname === "/api/version";

    return new Promise((resolve, reject) => {
      const nr = netMod.request({
        method,
        url: request.url,
        session: ses,
        bypassCustomProtocolHandlers: true,
        redirect: "manual",
        credentials:
          decision.sameServer || request.credentials !== "omit"
            ? "include"
            : "omit",
        ...(decision.sameServer && decision.origin
          ? { origin: decision.origin }
          : {}),
        headers,
      });

      let settled = false;
      nr.on("redirect", (statusCode, _method, redirectUrl, responseHeaders) => {
        if (settled) return;
        settled = true;
        const outHeaders = buildResponseHeaders(responseHeaders);
        outHeaders.set("location", redirectUrl);
        try {
          nr.abort();
        } catch {}
        resolve(
          new Response(null, {
            status: safeStatus(statusCode),
            headers: outHeaders,
          }),
        );
      });

      nr.on("response", (res) => {
        if (settled) return;
        settled = true;
        const enc = readHeader(res.headers, "content-encoding")
          .trim()
          .toLowerCase();
        const isEncoded = Boolean(enc && enc !== "identity");
        const status = safeStatus(res.statusCode);
        const stripDecoded =
          method !== "HEAD" && !NO_BODY_STATUS.has(status) && isEncoded;
        const outHeaders = buildResponseHeaders(res.headers, {
          stripDecodedHeaders: stripDecoded,
        });

        if (NO_BODY_STATUS.has(status) || method === "HEAD") {
          res.on("data", () => {});
          resolve(new Response(null, { status, headers: outHeaders }));
          return;
        }

        const shouldSniff = sniffVersion && status >= 200 && status < 300;
        const versionChunks = shouldSniff ? [] : null;
        let versionBytes = 0;

        const stream = new ReadableStream({
          start(controller) {
            res.on("data", (chunk) => {
              if (
                versionChunks &&
                versionBytes + chunk.length <= MAX_VERSION_SNIFF_BYTES
              ) {
                const copy = Buffer.from(chunk);
                versionChunks.push(copy);
                versionBytes += copy.length;
              }
              try {
                controller.enqueue(chunk);
              } catch {}
            });
            res.on("end", () => {
              if (versionChunks && versionChunks.length > 0) {
                try {
                  const parsed = JSON.parse(
                    Buffer.concat(versionChunks).toString("utf8"),
                  );
                  if (typeof parsed?.version === "string") {
                    recordServerVersion(decision.origin, parsed.version);
                  }
                } catch {}
              }
              try {
                controller.close();
              } catch {}
            });
            res.on("error", (err) => {
              try {
                controller.error(err);
              } catch {}
            });
          },
          cancel() {
            try {
              nr.abort();
            } catch {}
          },
        });

        resolve(new Response(stream, { status, headers: outHeaders }));
      });

      nr.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      if (bodyBuf && bodyBuf.length > 0) nr.write(bodyBuf);
      nr.end();
    });
  }

  function needsManualRedirect(request, decision) {
    if (!decision.sameServer) return false;
    if (REDIRECT_SENSITIVE_PREFIX_RE.test(decision.pathname)) return true;
    const dest = readHeader(request.headers, "sec-fetch-dest").toLowerCase();
    const mode = readHeader(request.headers, "sec-fetch-mode").toLowerCase();
    const upgradeReq = readHeader(request.headers, "upgrade-insecure-requests");
    return dest === "document" || mode === "navigate" || upgradeReq === "1";
  }

  function resolveDirectFetch(ses) {
    if (ses && typeof ses.fetch === "function") {
      return (input, init) => ses.fetch(input, init);
    }
    if (netImpl && typeof netImpl.fetch === "function") {
      return (input, init) => netImpl.fetch(input, init);
    }
    return null;
  }

  /**
   * 零 JS chunk 拷贝透传（Electron Session.fetch / net.fetch + bypassCustomProtocolHandlers）：
   * 适用于非导航 API / 静态资源 / SSE / 外域请求；不经 EventEmitter 逐块过桥。
   * 对需要 302 will-redirect 语义的文档导航与鉴权路径仍走 forwardWithNetRequest（Electron fetch manual redirect 会 reject）。
   */
  async function forwardWithDirectFetch(request, directFetch, decision) {
    const method = String(request.method || "GET").toUpperCase();
    const sniffVersion =
      decision.sameServer &&
      method === "GET" &&
      decision.pathname === "/api/version";
    let fetchInput = request;
    if (
      decision.sameServer &&
      method !== "GET" &&
      method !== "HEAD" &&
      decision.origin &&
      !readHeader(request.headers, "origin")
    ) {
      const headers = new Headers(request.headers);
      headers.set("Origin", decision.origin);
      fetchInput = new Request(request, { headers });
    }
    const response = await directFetch(fetchInput, {
      bypassCustomProtocolHandlers: true,
    });
    if (sniffVersion && response.status >= 200 && response.status < 300) {
      try {
        const cloned = response.clone();
        void cloned
          .json()
          .then((parsed) => {
            if (typeof parsed?.version === "string") {
              recordServerVersion(decision.origin, parsed.version);
            }
          })
          .catch(() => {});
      } catch {}
    }
    const enc = readHeader(response.headers, "content-encoding")
      .trim()
      .toLowerCase();
    const isEncoded = Boolean(enc && enc !== "identity");
    if (method !== "HEAD" && !NO_BODY_STATUS.has(response.status) && isEncoded) {
      const outHeaders = new Headers(response.headers);
      outHeaders.delete("content-encoding");
      outHeaders.delete("content-length");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
      });
    }
    return response;
  }

  function installSessionProtocol(ses) {
    if (!ses?.protocol || typeof ses.protocol.handle !== "function") {
      return false;
    }
    // 无本地内置前端时无需劫持全站 http/https，直接走 Chromium 原生网络管线。
    if (!hasLocalBundle) return false;
    if (installedSessions.has(ses)) return false;
    installedSessions.add(ses);

    const directFetch = resolveDirectFetch(ses);

    const handle = async (request) => {
      const decision = classifyRequest({
        url: request.url,
        method: request.method,
        headers: request.headers,
      });

      if (decision.action === "local-file") {
        try {
          const isHead =
            String(request.method || "GET").toUpperCase() === "HEAD";
          if (isHead) {
            return new Response(null, {
              status: 200,
              headers: {
                "content-type": decision.contentType,
                "cache-control": decision.cacheControl,
              },
            });
          }
          const bytes = await readBundleBytes(decision.filePath);
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": decision.contentType,
              "cache-control": decision.cacheControl,
            },
          });
        } catch {
          // 读本地缓存失败时尝试直接流式 file:// 或回落网络透传，避免白屏。
          if (directFetch) {
            try {
              return await directFetch(pathToFileURL(decision.filePath).href, {
                bypassCustomProtocolHandlers: true,
              });
            } catch {}
          }
        }
      }

      if (directFetch && !needsManualRedirect(request, decision)) {
        return forwardWithDirectFetch(request, directFetch, decision);
      }

      return forwardWithNetRequest(request, ses, decision);
    };

    for (const scheme of ["https", "http"]) {
      ses.protocol.handle(scheme, handle);
    }
    return true;
  }

  return {
    hasLocalBundle,
    bundledVersion,
    activeMode,
    recordServerVersion,
    probeVersion,
    statusFor,
    classifyRequest,
    installSessionProtocol,
  };
}

module.exports = {
  META_NAME,
  SERVER_ONLY_PREFIX_RE,
  contentTypeFor,
  resolveBundleFile,
  createLocalWebController,
};
