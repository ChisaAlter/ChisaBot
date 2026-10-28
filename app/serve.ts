/**
 * Serve the built app, and pass its API calls to the server.
 *
 * NOT VITE. `vite preview` was doing this, run through `bun --bun` so that a machine with bun and
 * no Node could start it at all, and the combination is broken in a way that looks like the whole
 * product failing: Vite's proxy calls `socket.destroySoon()` when an upstream response ends, bun's
 * sockets do not implement it, and the process dies with `TypeError: socket.destroySoon is not a
 * function` on the FIRST call the app makes. So the app served its page, died, and the shell's
 * window went on saying "ChisaBot is running" with nothing on the port. Measured on a real install.
 *
 * A development server was never the right thing to run in an installed application, which is what
 * the shell's own comment about this process already said. This serves a directory and forwards one
 * prefix, needs no Node, and has nothing in it that a dev server needs and an install does not.
 */

import { join, normalize, sep } from "node:path";
import { file, type ServerWebSocket } from "bun";
import {
  CSP_REPORT_ONLY_HEADER,
  createAppCspReader,
} from "../shared/content-security-policy";
import { listenPort } from "../shared/listen-port";
import { DICTATION_HTTP_IDLE_SECONDS } from "../shared/dictation";

const DIST = join(import.meta.dir, "dist");
const appPort = listenPort(process.env.APP_PORT, 3010);
if (!appPort.ok) {
  throw new Error(appPort.reason.replace(/^PORT /, "APP_PORT "));
}
const serverPort = listenPort(process.env.SERVER_PORT, 3001);
if (!serverPort.ok) {
  throw new Error(serverPort.reason.replace(/^PORT /, "SERVER_PORT "));
}
const PORT = appPort.port;
const SERVER = `http://127.0.0.1:${serverPort.port}`;

/**
 * Which file answers a path, or `null` when the app's own router should.
 *
 * Anything under `/assets` is a built file and a miss there is a genuine 404: answering index.html
 * would hand a script tag some HTML and fail in the console instead of in the network panel. Every
 * other miss is a client route (`/channel/...`), which is index.html.
 *
 * Pure, and tested, because the traversal guard lives here: a path is normalised and then checked
 * to be inside the directory, so `/../.env` cannot be served.
 */
export function fileFor(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  if (decoded.includes("\0")) return null;
  const wanted = normalize(join(DIST, decoded));
  if (wanted !== DIST && !wanted.startsWith(`${DIST}${sep}`)) return null;
  if (wanted === DIST || pathname.endsWith("/"))
    return join(DIST, "index.html");
  return wanted;
}

/** Whether the app's router should answer instead of the file system. */
export function isClientRoute(pathname: string): boolean {
  return !pathname.startsWith("/assets/") && !pathname.includes(".");
}

/**
 * Response headers that must not be passed on from the server's response.
 *
 * Bun's `fetch` has already decoded a gzip/br body by the time we hold it, so passing on
 * `Content-Encoding` makes the browser try to decode plain bytes again
 * (`ERR_CONTENT_DECODING_FAILED`, `/api/me` fails in the installed PC app), and the upstream
 * `Content-Length` describes the compressed size, not the body we send. The rest are hop-by-hop
 * headers (RFC 9110 §7.6.1) that describe the upstream connection, not this one.
 */
const STRIPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "trailer",
  "upgrade",
];

/** The server's response headers as this proxy may pass them on; every Set-Cookie is kept. */
export function proxiedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream) {
    if (name === "set-cookie") continue;
    headers.append(name, value);
  }
  for (const cookie of upstream.getSetCookie()) headers.append("set-cookie", cookie);
  const listed = upstream.get("connection");
  const extra = listed ? listed.split(",").map((n) => n.trim().toLowerCase()) : [];
  for (const name of [...STRIPPED_RESPONSE_HEADERS, ...extra]) {
    if (name) headers.delete(name);
  }
  return headers;
}

/** Whether this is a call for the server rather than the app. */
export function isApiCall(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function upstreamWebSocketHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers();
  for (const name of ["authorization", "cookie", "origin"]) {
    const value = requestHeaders.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/**
 * Bun's WebSocket client: the DOM one, plus the two things Bun adds and the browser does not.
 *
 * `bun-types` hands the global `WebSocket` over to `lib.dom` whenever DOM is in `lib`, and this
 * project has DOM in `lib` for the browser code that is the rest of `app/`. What is left describes
 * the BROWSER's client, which has no `terminate()` and takes subprotocols where Bun takes options.
 * This file only ever runs under Bun and uses both.
 *
 * Stated as an extension of the DOM type rather than by reaching for `Bun.WebSocket`, because that
 * interface is written for projects WITHOUT DOM in `lib` and degrades to `{}` here — its events
 * come back untyped, which costs more than the two members it would buy. Same socket either way;
 * this is a type-level correction, not a different client.
 */
export type BunWebSocket = WebSocket & { terminate(): void };
export const BunWebSocket = globalThis.WebSocket as unknown as {
  new (url: string | URL, options?: { headers?: HeadersInit }): BunWebSocket;
  readonly OPEN: number;
};

type WebSocketBridge = {
  upstream: BunWebSocket;
  attach: (downstream: ServerWebSocket<WebSocketBridge>) => void;
  dispose: () => void;
};

/** Own the upstream before awaiting its handshake, including any immediate welcome frames. */
function prepareWebSocketBridge(upstream: BunWebSocket, signal: AbortSignal) {
  upstream.binaryType = "arraybuffer";
  let downstream: ServerWebSocket<WebSocketBridge> | undefined;
  const pending: (string | ArrayBuffer)[] = [];
  let pendingBytes = 0;
  let disposed = false;
  let timedOut = false;
  const { promise: opened, resolve } = Promise.withResolvers<boolean>();
  const timeout = setTimeout(() => {
    timedOut = true;
    dispose();
  }, 5_000);

  function finishHandshake(success: boolean) {
    clearTimeout(timeout);
    upstream.removeEventListener("open", onOpen);
    signal.removeEventListener("abort", dispose);
    resolve(success);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    finishHandshake(false);
    upstream.removeEventListener("message", onMessage);
    upstream.removeEventListener("error", onError);
    upstream.removeEventListener("close", onClose);
    pending.length = 0;
    pendingBytes = 0;
    // close() can wait for a handshake or a close reply that will never arrive.
    upstream.terminate();
  }

  function onOpen() {
    finishHandshake(true);
  }

  function onError() {
    downstream?.close(1011, "Upstream connection failed");
    dispose();
  }

  function onClose(event: CloseEvent) {
    downstream?.close(event.code === 1000 ? 1000 : 1011);
    dispose();
  }

  function onMessage(event: MessageEvent<string | ArrayBuffer>) {
    if (downstream) {
      downstream.send(event.data);
      return;
    }
    // Only bridge-transition frames are buffered, never input for a peer that has not accepted.
    // Bound both frame count and bytes so an upstream cannot grow this queue indefinitely.
    const size =
      typeof event.data === "string"
        ? Buffer.byteLength(event.data)
        : event.data.byteLength;
    if (pending.length >= 64 || pendingBytes + size > 8 * 1024 * 1024) {
      onError();
      return;
    }
    pending.push(event.data);
    pendingBytes += size;
  }

  upstream.addEventListener("open", onOpen);
  upstream.addEventListener("message", onMessage);
  upstream.addEventListener("error", onError);
  upstream.addEventListener("close", onClose);
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();

  const data: WebSocketBridge = {
    upstream,
    dispose,
    attach(socket) {
      downstream = socket;
      if (disposed) {
        socket.close(1011, "Upstream connection closed");
        return;
      }
      for (const message of pending) socket.send(message);
      pending.length = 0;
      pendingBytes = 0;
    },
  };
  return { data, opened, failureStatus: () => (timedOut ? 504 : 502) };
}

const appCsp = createAppCspReader(join(DIST, "index.html"));

/** 安全响应头；页面（HTML）另带应用 CSP（先 Report-Only，见 shared/content-security-policy.ts）。 */
export async function withSecurityHeaders(
  body: BodyInit,
  status = 200,
  options: { html?: boolean } = {},
): Promise<Response> {
  const response = new Response(body, { status });
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (options.html)
    response.headers.set(CSP_REPORT_ONLY_HEADER, await appCsp());
  return response;
}

if (import.meta.main) {
  Bun.serve<WebSocketBridge>({
    port: PORT,
    // Both loopbacks, which is what `::` gets you: a dual-stack socket answers on 127.0.0.1 and
    // ::1 alike. Bound to one, whoever is told the URL has no way to know which they were given.
    hostname: "::",
    // `ws: true` on the old proxy was required for the live screen, so the upgrade is forwarded
    // rather than answered with the app's HTML, which failed with an opaque socket error.
    websocket: {
      open(ws) {
        ws.data.attach(ws);
      },
      message(ws, message) {
        const { upstream } = ws.data;
        if (upstream.readyState === BunWebSocket.OPEN) {
          upstream.send(message);
        } else {
          ws.close(1011, "Upstream connection closed");
          ws.data.dispose();
        }
      },
      close(ws) {
        ws.data.dispose();
      },
    },
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/api/audio/transcriptions") {
        server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
      }
      // 计算机工具（打开网页、执行命令、接管）常常超过 Bun 默认的 10 秒空闲超时，被切断后用户看到
      // “计算机无法访问”而浏览器其实还在工作。由 agent-computer 自己的超时兜底。
      if (url.pathname.startsWith("/api/computers/") && !request.headers.get("upgrade")) server.timeout(request, 0);
      // §102：网页聊天里的计算机动作（含最长 600 秒的前台命令）经审批网关同步执行，同样不设空闲超时。
      if (url.pathname.startsWith("/api/approvals/computer/")) server.timeout(request, 0);

      if (isApiCall(url.pathname)) {
        const target = SERVER + url.pathname + url.search;
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const upstream = new BunWebSocket(target.replace(/^http/, "ws"), {
            headers: upstreamWebSocketHeaders(request.headers),
          });
          const bridge = prepareWebSocketBridge(upstream, request.signal);
          if (
            !(await bridge.opened) ||
            upstream.readyState !== BunWebSocket.OPEN
          ) {
            bridge.data.dispose();
            return new Response("Could not connect to the upstream WebSocket", {
              status: bridge.failureStatus(),
            });
          }
          if (server.upgrade(request, { data: bridge.data })) return undefined;
          bridge.data.dispose();
          return new Response("expected a websocket upgrade", { status: 400 });
        }
        // The body is streamed rather than buffered, and redirects are left to the caller so a
        // 302 from the server is not silently followed to a different origin.
        try {
          const upstream = await fetch(target, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: "manual",
            signal: request.signal,
            // @ts-expect-error duplex is required by fetch for a streamed body and is not yet typed.
            duplex: "half",
          });
          return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: proxiedResponseHeaders(upstream.headers),
          });
        } catch {
          return Response.json(
            { error: "Upstream server unavailable" },
            { status: 502 },
          );
        }
      }

      const wanted = fileFor(url.pathname);
      if (!wanted) return withSecurityHeaders("not found", 404);

      const found = file(wanted);
      if (await found.exists())
        return withSecurityHeaders(found, 200, {
          html: wanted.endsWith(".html"),
        });
      if (isClientRoute(url.pathname)) {
        return withSecurityHeaders(file(join(DIST, "index.html")), 200, {
          html: true,
        });
      }
      return withSecurityHeaders("not found", 404);
    },
  });

  console.log(
    `ChisaBot app on http://127.0.0.1:${PORT} and http://[::1]:${PORT}`,
  );
}
