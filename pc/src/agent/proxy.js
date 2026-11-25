"use strict";
/**
 * 主进程网络走系统代理（2026-10-13「设备链接有问题，我在用桌面端，但是显示离线」）。
 *
 * 聊天窗口是 Chromium，自动用系统代理（Clash / v2rayN 的「系统代理」模式）；可设备节点的 WebSocket（ws 包）
 * 和登记 / 校验令牌的请求（Node fetch）跑在 Node 里，从来不看系统代理。直连服务器不通的网络里
 * 就成了：窗口里聊天一切正常，节点却一次都连不上服务器，网页设备页显示离线。
 *
 * 做法：用 Electron 的 session.resolveProxy() 问出 Chromium 对这个地址用的代理（PAC / 系统代理 / 命令行都算），
 * 然后自己建隧道：HTTP / HTTPS 代理用 CONNECT，SOCKS5 用无认证 CONNECT（域名交给代理解析），再在隧道上做 TLS。
 * 代理列表里的项依次尝试，「DIRECT」就是直连；全部失败才报错。没有代理（DIRECT）时与以前完全一样。
 */
const net = require("node:net");
const tls = require("node:tls");
const https = require("node:https");
const http = require("node:http");

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** "PROXY user:pass@127.0.0.1:7890; SOCKS5 user:pass@[::1]:1080; DIRECT" → [{type, host, port, username?, password?}…]。 */
function parseProxyList(text) {
  const out = [];
  for (const part of String(text || "DIRECT").split(";")) {
    const item = part.trim();
    if (!item) continue;
    const splitAt = item.search(/\s/);
    const kind = (splitAt >= 0 ? item.slice(0, splitAt) : item).toUpperCase();
    const address = splitAt >= 0 ? item.slice(splitAt + 1).trim() : "";
    if (kind === "DIRECT") {
      out.push({ type: "direct" });
      continue;
    }
    if (!address) continue;
    const atIdx = address.lastIndexOf("@");
    const authPart = atIdx >= 0 ? address.slice(0, atIdx) : "";
    const hostPort = atIdx >= 0 ? address.slice(atIdx + 1) : address;
    const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d+)$/.exec(hostPort);
    if (!match) continue;
    const host = match[1] || match[2];
    const port = Number(match[3]);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) continue;

    let credentials;
    if (atIdx >= 0 && authPart.length > 0) {
      const colonIdx = authPart.indexOf(":");
      credentials =
        colonIdx >= 0
          ? {
              username: safeDecodeURIComponent(authPart.slice(0, colonIdx)),
              password: safeDecodeURIComponent(authPart.slice(colonIdx + 1)),
            }
          : {
              username: safeDecodeURIComponent(authPart),
              password: "",
            };
    }

    if (kind === "PROXY" || kind === "HTTP") {
      out.push({ type: "http", host, port, ...credentials });
    } else if (kind === "HTTPS") {
      out.push({ type: "https", host, port, ...credentials });
    } else if (kind === "SOCKS" || kind === "SOCKS5") {
      out.push({ type: "socks5", host, port, ...credentials });
    }
    // SOCKS4 很少见，跳过（会退到列表里的下一项）。
  }
  if (!out.length) out.push({ type: "direct" });
  return out;
}

function maskProxyHost(host) {
  const raw = String(host || "");
  const atIdx = raw.lastIndexOf("@");
  return atIdx >= 0 ? `***@${raw.slice(atIdx + 1)}` : raw;
}

function describeProxy(proxy) {
  if (!proxy || proxy.type === "direct") return "直连";
  const label =
    proxy.type === "socks5"
      ? "SOCKS5"
      : proxy.type === "https"
        ? "HTTPS"
        : "HTTP";
  const hasAuth =
    (typeof proxy.username === "string" && proxy.username.length > 0) ||
    (typeof proxy.password === "string" && proxy.password.length > 0);
  const safeHost = maskProxyHost(proxy.host);
  const target =
    hasAuth && !safeHost.startsWith("***@") ? `***@${safeHost}` : safeHost;
  return `${label} 代理 ${target}:${proxy.port}`;
}

/** 一直读到 predicate(buffer) 为真；全程只挂一个 data 监听，读完暂停，多出来的字节由调用方 unshift 回去。 */
function readUntil(socket, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error("代理握手超时")), timeoutMs);
    function done(error) {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.pause();
      if (error) reject(error);
      else resolve(buffer);
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16 * 1024) return done(new Error("代理回应过长"));
      if (predicate(buffer)) done(null);
    }
    const onError = (error) => done(error);
    const onClose = () => done(new Error("代理关闭了连接"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function connectSocket({ host, port, secure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
          ALPNProtocols: ["http/1.1"],
        })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    socket.once(secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function hasProxyCredentials(proxy) {
  return (
    proxy &&
    ((typeof proxy.username === "string" && proxy.username.length > 0) ||
      (typeof proxy.password === "string" && proxy.password.length > 0))
  );
}

/** 经代理打通到 target 的 TCP 隧道（不含目标 TLS）。 */
async function openTunnel(proxy, target, timeoutMs = 15_000) {
  if (proxy.type === "http" || proxy.type === "https") {
    const socket = await connectSocket({
      host: proxy.host,
      port: proxy.port,
      secure: proxy.type === "https",
      timeoutMs,
    });
    const authority = `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`;
    const authHeader = hasProxyCredentials(proxy)
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`, "utf8").toString("base64")}\r\n`
      : "";
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authHeader}Proxy-Connection: keep-alive\r\n\r\n`,
    );
    const head = await readUntil(
      socket,
      (b) => b.includes("\r\n\r\n"),
      timeoutMs,
    ).catch((error) => {
      socket.destroy();
      throw error;
    });
    const end = head.indexOf("\r\n\r\n");
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(
      head.subarray(0, end).toString("latin1"),
    );
    if (status?.[1] === "407") {
      socket.destroy();
      throw new Error("代理需要认证或账密无效（407）");
    }
    if (status?.[1] !== "200") {
      socket.destroy();
      throw new Error(`代理拒绝了连接（${status ? status[1] : "回应无效"}）`);
    }
    if (head.length > end + 4) socket.unshift(head.subarray(end + 4));
    socket.resume();
    return socket;
  }
  if (proxy.type === "socks5") {
    const socket = await connectSocket({
      host: proxy.host,
      port: proxy.port,
      secure: false,
      timeoutMs,
    });
    try {
      const withAuth = hasProxyCredentials(proxy);
      socket.write(
        Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]),
      );
      const hello = await readUntil(socket, (b) => b.length >= 2, timeoutMs);
      if (hello.length > 2) socket.unshift(hello.subarray(2));
      if (hello[0] !== 0x05) {
        throw new Error("SOCKS5 代理回应协议版本无效");
      }
      if (hello[1] === 0x02) {
        if (!withAuth) {
          throw new Error("SOCKS5 代理需要用户名和密码认证");
        }
        const user = Buffer.from(String(proxy.username || ""), "utf8");
        const pass = Buffer.from(String(proxy.password || ""), "utf8");
        if (user.length > 255 || pass.length > 255) {
          throw new Error("SOCKS5 代理用户名或密码过长");
        }
        socket.write(
          Buffer.concat([
            Buffer.from([0x01, user.length]),
            user,
            Buffer.from([pass.length]),
            pass,
          ]),
        );
        const authReply = await readUntil(
          socket,
          (b) => b.length >= 2,
          timeoutMs,
        );
        if (authReply.length > 2) socket.unshift(authReply.subarray(2));
        if (authReply[0] !== 0x01 || authReply[1] !== 0x00) {
          throw new Error("SOCKS5 代理认证失败：账密无效");
        }
      } else if (hello[1] !== 0x00) {
        throw new Error("SOCKS5 代理需要认证或不支持");
      }

      const host = Buffer.from(target.host, "utf8");
      if (host.length > 255) {
        throw new Error("目标主机名过长");
      }
      const port = Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]);
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          port,
        ]),
      );
      const reply = await readUntil(
        socket,
        (b) => {
          if (b.length < 5) return false;
          const atyp = b[3];
          const len = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1 + b[4];
          return b.length >= 4 + len + 2;
        },
        timeoutMs,
      );
      if (reply[0] !== 0x05 || reply[1] !== 0x00) {
        throw new Error(`SOCKS5 代理拒绝了连接（代码 ${reply[1]}）`);
      }
      const atyp = reply[3];
      const used =
        4 + (atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1 + reply[4]) + 2;
      if (reply.length > used) socket.unshift(reply.subarray(used));
      socket.resume();
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  throw new Error(`不支持的代理类型 ${proxy.type}`);
}

/**
 * 给 ws / https.request 用的 Agent：按代理列表依次尝试，最后在隧道上做目标 TLS。
 * 列表只有 DIRECT 时返回 undefined（用 Node 默认行为，和以前一样）。
 */
function createProxyAgent(
  proxies,
  { secure = true, timeoutMs = 15_000, onRoute } = {},
) {
  if (!proxies.some((p) => p.type !== "direct")) return undefined;
  const Base = secure ? https.Agent : http.Agent;
  const agent = new Base({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const target = {
      host: options.host || options.hostname,
      port: Number(options.port) || (secure ? 443 : 80),
    };
    (async () => {
      const errors = [];
      for (const proxy of proxies) {
        try {
          let socket;
          if (proxy.type === "direct")
            socket = await connectSocket({
              host: target.host,
              port: target.port,
              secure: false,
              timeoutMs,
            });
          else socket = await openTunnel(proxy, target, timeoutMs);
          if (secure) {
            const servername =
              options.servername ||
              (net.isIP(target.host) ? undefined : target.host);
            socket = tls.connect({
              socket,
              servername,
              ALPNProtocols: options.ALPNProtocols || ["http/1.1"],
              ...(options.rejectUnauthorized === false
                ? { rejectUnauthorized: false }
                : {}),
            });
            await new Promise((resolve, reject) => {
              socket.once("secureConnect", resolve);
              socket.once("error", reject);
            });
            socket.removeAllListeners("error");
          }
          onRoute?.(proxy);
          return socket;
        } catch (error) {
          errors.push(
            `${describeProxy(proxy)}：${error?.message ? error.message : error}`,
          );
        }
      }
      throw new Error(errors.join("；"));
    })().then(
      (socket) => callback(null, socket),
      (error) => callback(error),
    );
  };
  return agent;
}

function normalizeHeaders(inputHeaders) {
  const headers = {};
  if (!inputHeaders) return headers;
  if (typeof inputHeaders.forEach === "function") {
    inputHeaders.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }
  if (Array.isArray(inputHeaders)) {
    for (const [key, value] of inputHeaders) {
      headers[key] = value;
    }
    return headers;
  }
  for (const [key, value] of Object.entries(inputHeaders)) {
    headers[key] = value;
  }
  return headers;
}

/**
 * 最小的 fetch：走 https.request + 上面的 Agent，返回标准 Response（auth.js 只用 status / ok / json / text /
 * headers.get / headers.getSetCookie）。不跟随重定向（auth.js 都是 redirect: "manual"）。
 * 无代理时优先使用传入的 directFetch（默认退回全局 fetch）。
 */
function createAgentFetch(getAgent, { directFetch } = {}) {
  const fallbackFetch = typeof directFetch === "function" ? directFetch : fetch;
  return async function agentFetch(input, init = {}) {
    const url = new URL(String(input));
    const agent = await getAgent(url);
    if (!agent) return fallbackFetch(input, init);
    const lib = url.protocol === "http:" ? http : https;
    const headers = normalizeHeaders(init.headers);
    const body = init.body == null ? null : Buffer.from(String(init.body));
    if (body) headers["Content-Length"] = String(body.length);
    return await new Promise((resolve, reject) => {
      const request = lib.request(
        url,
        { method: init.method || "GET", headers, agent },
        (response) => {
          const chunks = [];
          response.on("data", (c) => chunks.push(c));
          response.on("end", () => {
            const out = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2)
              out.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
            const status = response.statusCode || 0;
            const payload =
              status === 204 ||
              status === 205 ||
              status === 304 ||
              init.method === "HEAD"
                ? null
                : Buffer.concat(chunks);
            resolve(
              new Response(payload, {
                status: status < 200 ? 502 : status,
                headers: out,
              }),
            );
          });
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      const signal = init.signal;
      if (signal) {
        if (signal.aborted)
          request.destroy(signal.reason || new Error("aborted"));
        else
          signal.addEventListener(
            "abort",
            () =>
              request.destroy(
                Object.assign(new Error("请求超时"), { name: "TimeoutError" }),
              ),
            { once: true },
          );
      }
      if (body) request.write(body);
      request.end();
    });
  };
}

module.exports = {
  parseProxyList,
  describeProxy,
  openTunnel,
  createProxyAgent,
  createAgentFetch,
};
