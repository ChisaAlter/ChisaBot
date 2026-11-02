import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import {
  BlockedUrlError,
  createGuardedFetchLike,
} from "../../shared/net/guarded-fetch";
import {
  checkPublicWsUrl,
  type GuardedSocketLike,
  openGuardedSocket,
} from "../../shared/net/guarded-socket";
import {
  isBlockedAddress,
  isBlockedAddressAllowPrivate,
  isBlockedHostnameAllowPrivate,
} from "../../shared/net/ssrf";
import { imGuardedFetch, imGuardedWs } from "../src/im/net";

/**
 * RV-01：IM 出站链路（HTTP + WebSocket）的 SSRF 防护回归测试。
 * 用 mock DNS 模拟「公网域名解析到内网」；用 127.0.0.1 上的真实服务器扮演「公网服务」
 * （isBlocked 注入放宽 loopback，其余仍走真实黑名单表）。
 */

const allowLoopback = (address: string) =>
  address !== "127.0.0.1" && isBlockedAddress(address);
const loopbackResolve = async () => [{ address: "127.0.0.1", family: 4 }];

function httpServer(
  handler: (req: unknown, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handler(req, res));
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    );
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** 测试用最小 WebSocket 服务端：回显收到的每一帧，收到 close 就回 close。 */
function wsEchoServer(): Promise<{
  server: Server;
  port: number;
  received: string[];
}> {
  const received: string[] = [];
  const serverFrame = (opcode: number, payload: Buffer) => {
    let header: Buffer;
    if (payload.length < 126)
      header = Buffer.from([0x80 | opcode, payload.length]);
    else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([header, payload]);
  };
  const server = createServer();
  server.on("upgrade", (req, socket: Socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0]!;
        const b1 = buf[1]!;
        let length = b1 & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buf.length < 4) return;
          length = buf.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buf.length < 10) return;
          length = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLength = b1 & 0x80 ? 4 : 0;
        if (buf.length < offset + maskLength + length) return;
        const payload = Buffer.from(
          buf.subarray(offset + maskLength, offset + maskLength + length),
        );
        if (maskLength) {
          const maskKey = buf.subarray(offset, offset + 4);
          for (let index = 0; index < payload.length; index += 1)
            payload[index] = payload[index]! ^ maskKey[index & 3]!;
        }
        buf = Buffer.from(buf.subarray(offset + maskLength + length));
        const opcode = b0 & 0x0f;
        if (opcode === 0x8) return socket.end(serverFrame(0x8, payload));
        if (opcode === 0x9) {
          socket.write(serverFrame(0xa, payload));
          continue;
        }
        if (opcode === 0x1 || opcode === 0x2) {
          received.push(
            opcode === 0x1
              ? payload.toString("utf8")
              : `[binary ${payload.length}]`,
          );
          socket.write(serverFrame(opcode, payload));
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: (server.address() as { port: number }).port,
        received,
      }),
    );
  });
}

function waitSocket(
  socket: GuardedSocketLike,
  ms = 3000,
): Promise<{ code?: number; reason?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等 socket 关闭超时")), ms);
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event);
    };
  });
}

describe("RV-01: guarded fetch（IM 出站 HTTP）", () => {
  const guarded = createGuardedFetchLike({
    timeoutMs: 5000,
    maxBytes: 1024 * 1024,
    resolve: loopbackResolve,
    isBlocked: allowLoopback,
  });

  test("解析到内网的域名（169.254.169.254.nip.io）被拒", async () => {
    const nipIo = createGuardedFetchLike({
      timeoutMs: 5000,
      maxBytes: 1024,
      resolve: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    await expect(
      nipIo("http://169.254.169.254.nip.io/latest/meta-data/"),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(
      nipIo("http://10.0.0.9.in-addr.arpa.example/x"),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  test("字面内网地址根本不发请求", async () => {
    await expect(
      guarded("http://169.254.169.254/latest/meta-data"),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(guarded("http://192.168.1.1/admin")).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(guarded("http://localhost:8080/")).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  test("302 重定向到内网被拒（每一跳重新校验）", async () => {
    for (const location of [
      "http://169.254.169.254/latest/",
      "http://metadata.internal/secret",
      "ws://10.0.0.1/",
    ]) {
      const { server, port } = await httpServer((_req, res) => {
        res.writeHead(302, { Location: location });
        res.end();
      });
      try {
        await expect(
          guarded(`http://public.example:${port}/start`),
        ).rejects.toBeInstanceOf(BlockedUrlError);
      } finally {
        await closeServer(server);
      }
    }
  });

  test("正常公网地址可用，Response 形状和标准 fetch 一致", async () => {
    const { server, port } = await httpServer((req, res) => {
      expect(
        (req as import("node:http").IncomingMessage).headers["x-test"],
      ).toBe("1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          url: (req as import("node:http").IncomingMessage).url,
        }),
      );
    });
    try {
      const res = await guarded(`http://api.example:${port}/v1/ping?a=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test": "1" },
        body: JSON.stringify({ hello: "world" }),
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(body).toEqual({ ok: true, url: "/v1/ping?a=1" });
    } finally {
      await closeServer(server);
    }
  });

  test("公网 302 跟到另一个公网地址能正常返回", async () => {
    // 第一跳重定向到自己服务器的 /final（同源，仍是公网地址）。
    const server = createServer((req, res) => {
      if (req.url === "/final") {
        res.writeHead(200);
        res.end("done");
      } else {
        res.writeHead(302, { Location: "/final" });
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      const res = await guarded(`http://cdn.example:${port}/go`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("done");
    } finally {
      await closeServer(server);
    }
  });
});

describe("RV-01: guarded WebSocket（IM 出站 WS）", () => {
  const wsDeps = { resolve: loopbackResolve, isBlocked: allowLoopback };

  test("checkPublicWsUrl：只放行 ws/wss，字面内网直接拒", () => {
    expect(checkPublicWsUrl("ws://public.example/chat").ok).toBe(true);
    expect(checkPublicWsUrl("wss://api.example/socket").ok).toBe(true);
    expect(checkPublicWsUrl("http://api.example/").ok).toBe(false);
    expect(checkPublicWsUrl("ws://127.0.0.1:3001/").ok).toBe(false);
    expect(checkPublicWsUrl("ws://192.168.1.10:3001/").ok).toBe(false);
    expect(checkPublicWsUrl("ws://localhost/").ok).toBe(false);
    expect(checkPublicWsUrl("ws://user:pass@public.example/").ok).toBe(false);
  });

  test("解析到内网的域名在连接前就拒（169.254.169.254.nip.io）", async () => {
    const socket = openGuardedSocket("ws://169.254.169.254.nip.io:9000/path", {
      resolve: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    const errors: unknown[] = [];
    socket.onerror = (event) => errors.push(event);
    const closed = await waitSocket(socket);
    expect(closed.code).toBe(1006);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { error: unknown }).error).toBeInstanceOf(
      BlockedUrlError,
    );
    expect(socket.readyState).toBe(3);
  });

  test("握手被 302 到内网：跟随前重新校验，拒绝", async () => {
    const { server, port } = await httpServer((_req, res) => {
      res.writeHead(302, { Location: "ws://169.254.169.254:9000/" });
      res.end();
    });
    try {
      const socket = openGuardedSocket(`ws://edge.example:${port}/`, wsDeps);
      const errors: unknown[] = [];
      socket.onerror = (event) => errors.push(event);
      await waitSocket(socket);
      expect(errors).toHaveLength(1);
      expect((errors[0] as { error: unknown }).error).toBeInstanceOf(
        BlockedUrlError,
      );
    } finally {
      await closeServer(server);
    }
  });

  test("正常公网地址能连：握手、收发文本/二进制、双向关闭（mock DNS 钉到本地服务）", async () => {
    const { server, port, received } = await wsEchoServer();
    try {
      const socket = openGuardedSocket(`ws://im.example:${port}/ws`, wsDeps);
      const opened = new Promise<void>(
        (resolve) => (socket.onopen = () => resolve()),
      );
      const closed = waitSocket(socket);
      await opened;
      expect(socket.readyState).toBe(1);
      const echoed = new Promise<string>((resolve) => {
        const messages: string[] = [];
        socket.onmessage = (event) => {
          messages.push(String(event.data));
          if (messages.length === 1) resolve(messages[0]!);
        };
      });
      socket.send("你好 IM");
      expect(await echoed).toBe("你好 IM");
      // 二进制：binaryType 不设时按 Uint8Array 给。
      const binaryEcho = new Promise<unknown>((resolve) => {
        socket.onmessage = (event) => resolve(event.data);
      });
      socket.send(new Uint8Array([1, 2, 3]));
      const data = await binaryEcho;
      expect(data).toBeInstanceOf(Uint8Array);
      expect([...(data as Uint8Array)]).toEqual([1, 2, 3]);
      socket.close(1000);
      const event = await closed;
      expect(event.code).toBe(1000);
      expect(received).toEqual(["你好 IM", "[binary 3]"]);
    } finally {
      await closeServer(server);
    }
  });

  test("binaryType=arraybuffer 时二进制按 ArrayBuffer 给", async () => {
    const { server, port } = await wsEchoServer();
    try {
      const socket = openGuardedSocket(`ws://im.example:${port}/ws`, wsDeps);
      socket.binaryType = "arraybuffer";
      const opened = new Promise<void>(
        (resolve) => (socket.onopen = () => resolve()),
      );
      const closed = waitSocket(socket);
      await opened;
      const echo = new Promise<unknown>(
        (resolve) => (socket.onmessage = (event) => resolve(event.data)),
      );
      socket.send(new Uint8Array([9, 8]).buffer);
      const data = await echo;
      expect(data).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([9, 8]);
      socket.close();
      await closed;
    } finally {
      await closeServer(server);
    }
  });
});

describe("RV-01: IM 默认出站实现就是带防护的那份", () => {
  test("imGuardedFetch / imGuardedWs 暴露给 service 作为默认注入", async () => {
    expect(typeof imGuardedFetch).toBe("function");
    expect(typeof imGuardedWs).toBe("function");
    // 字面内网地址：不发请求就拒。
    await expect(
      imGuardedFetch("http://169.254.169.254/"),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    const socket = imGuardedWs("ws://10.255.0.1:1234/");
    const event = await waitSocket(socket);
    expect(event.code).toBe(1006);
  });
});

describe("RV-01 放宽项：allowPrivate（管理员给连接开的「允许内网地址」）", () => {
  test("地址判定：本机 / RFC1918 / ULA 放行，云元数据和保留段照样拦", () => {
    for (const allowed of [
      "127.0.0.1",
      "10.0.0.9",
      "172.17.0.2",
      "192.168.1.10",
      "::1",
      "fd00::8",
      "fc00::1",
    ])
      expect(isBlockedAddressAllowPrivate(allowed)).toBe(false);
    for (const blocked of [
      "169.254.169.254", // AWS/GCP/Azure 元数据
      "169.254.0.1",
      "100.100.100.200", // 阿里云元数据
      "fd00:ec2::254", // AWS IPv6 元数据
      "::ffff:169.254.169.254",
      "::169.254.169.254",
      "64:ff9b::a9fe:a9fe", // NAT64 包着的元数据
      "0.0.0.0",
      "224.0.0.1",
      "198.51.100.7",
      "not-an-ip",
    ])
      expect(isBlockedAddressAllowPrivate(blocked)).toBe(true);
    // 主机名：单段容器名 / localhost 放行（解析结果仍过 IP 判定），元数据主机名照样拦
    expect(isBlockedHostnameAllowPrivate("napcat")).toBe(false);
    expect(isBlockedHostnameAllowPrivate("localhost")).toBe(false);
    expect(isBlockedHostnameAllowPrivate("service.internal")).toBe(false);
    expect(isBlockedHostnameAllowPrivate("metadata.google.internal")).toBe(
      true,
    );
    expect(isBlockedHostnameAllowPrivate("")).toBe(true);
  });

  test("checkPublicWsUrl：字面内网只在 allowPrivate 下才过", () => {
    expect(
      checkPublicWsUrl("ws://127.0.0.1:3001/", { allowPrivate: true }).ok,
    ).toBe(true);
    expect(
      checkPublicWsUrl("ws://napcat:3001/", { allowPrivate: true }).ok,
    ).toBe(true);
    expect(checkPublicWsUrl("ws://127.0.0.1:3001/").ok).toBe(false);
    expect(checkPublicWsUrl("ws://napcat:3001/").ok).toBe(false);
    // 开关开着也够不到云元数据
    expect(
      checkPublicWsUrl("ws://169.254.169.254/", { allowPrivate: true }).ok,
    ).toBe(false);
    expect(
      checkPublicWsUrl("ws://metadata.google.internal/", { allowPrivate: true })
        .ok,
    ).toBe(false);
  });

  test("guarded fetch：allowPrivate 能连本机 HTTP，不开就拒；元数据永远拒", async () => {
    const { server, port } = await httpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    try {
      const open = createGuardedFetchLike({
        timeoutMs: 5000,
        maxBytes: 1024,
        allowPrivate: true,
      });
      const res = await open(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("ok");
      const strict = createGuardedFetchLike({
        timeoutMs: 5000,
        maxBytes: 1024,
      });
      await expect(strict(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(
        BlockedUrlError,
      );
      // 解析到元数据的域名：开关开着也拒
      const meta = createGuardedFetchLike({
        timeoutMs: 5000,
        maxBytes: 1024,
        allowPrivate: true,
        resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      });
      await expect(
        meta("http://169.254.169.254.nip.io/latest/"),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    } finally {
      await closeServer(server);
    }
  });

  test("guarded socket：allowPrivate 能连本机 WS，不开就拒", async () => {
    const { server, port } = await wsEchoServer();
    try {
      const socket = openGuardedSocket(`ws://127.0.0.1:${port}/ws`, {
        allowPrivate: true,
      });
      const opened = new Promise<void>(
        (resolve) => (socket.onopen = () => resolve()),
      );
      const closed = waitSocket(socket);
      await opened;
      expect(socket.readyState).toBe(1);
      socket.close();
      await closed;
      const denied = openGuardedSocket(`ws://127.0.0.1:${port}/ws`);
      const event = await waitSocket(denied);
      expect(event.code).toBe(1006);
    } finally {
      await closeServer(server);
    }
  });
});
