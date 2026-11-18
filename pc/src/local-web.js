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
const { compareVersion } = require("./updater");

const META_NAME = "chisabot-web-meta.json";

/** 这些前缀永远由服务端/网关直接处理，即使在本地前端模式下也绝不拦截到本地文件。 */
const SERVER_ONLY_PREFIX_RE =
  /^\/(?:api|auth|login|sign|sign-in|logout|p|downloads|magpie|magpie-admin|workspace|node-agent|_chisabot|_internal|v1|v1beta)(?:\/|$)/;

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
  const serverVersions = new Map();

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
      const filePath = resolveBundleFile(
        resolvedBundleDir,
        parsed.pathname,
        fsImpl,
      );
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
        filePath: path.join(resolvedBundleDir, "index.html"),
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

  function installSessionProtocol(ses) {
    if (!ses?.protocol || typeof ses.protocol.handle !== "function") {
      return false;
    }
    if (installedSessions.has(ses)) return false;
    installedSessions.add(ses);

    const handle = async (request) => {
      const decision = classifyRequest({
        url: request.url,
        method: request.method,
        headers: request.headers,
      });

      if (decision.action === "local-file") {
        try {
          const bytes = await fsp.readFile(decision.filePath);
          const isHead =
            String(request.method || "GET").toUpperCase() === "HEAD";
          return new Response(isHead ? null : bytes, {
            status: 200,
            headers: {
              "content-type": decision.contentType,
              "cache-control": decision.cacheControl,
            },
          });
        } catch {
          // 读取失败时回落网络透传，避免白屏。
        }
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
