import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import {
  type GuardedSocketLike,
  openGuardedSocket,
} from "../../shared/net/guarded-socket";

async function serve(onConnection: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function closed(socket: GuardedSocketLike) {
  return new Promise<{ code?: number }>((resolve) => {
    socket.onclose = resolve;
  });
}

function frame(opcode: number, body: Buffer, fin = true) {
  const header = Buffer.alloc(
    body.length < 126 ? 2 : body.length < 65536 ? 4 : 10,
  );
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (header.length === 2) header[1] = body.length;
  else if (header.length === 4) {
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function upgrade(socket: Socket, frames: Buffer) {
  let request = "";
  const receive = (chunk: Buffer) => {
    request += chunk.toString("latin1");
    if (!request.includes("\r\n\r\n")) return;
    socket.off("data", receive);
    const key = /sec-websocket-key:\s*([^\r\n]+)/i.exec(request)?.[1];
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      Buffer.concat([
        Buffer.from(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        ),
        frames,
      ]),
    );
  };
  socket.on("data", receive);
}

describe("guarded WebSocket connection lifecycle", () => {
  test("close immediately prevents even starting DNS resolution", async () => {
    let resolutions = 0;
    const socket = openGuardedSocket("ws://im.example/", {
      resolve: async () => {
        resolutions++;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    const done = closed(socket);
    socket.close();
    expect((await done).code).toBe(1000);
    await Promise.resolve();
    expect(resolutions).toBe(0);
  });

  test("a TLS protocol error reports one failure and closes without throwing", async () => {
    const server = await serve((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    });
    try {
      const socket = openGuardedSocket(`wss://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
        handshakeTimeoutMs: 1000,
      });
      const errors: unknown[] = [];
      socket.onerror = (event) =>
        errors.push((event as { error: unknown }).error);
      expect((await closed(socket)).code).toBe(1006);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(errors[0]).not.toBeInstanceOf(ReferenceError);
      expect(socket.readyState).toBe(3);
    } finally {
      await server.stop();
    }
  });

  test("the deadline destroys a stream stuck in TLS negotiation", async () => {
    let peerClosed!: () => void;
    const released = new Promise<void>((resolve) => {
      peerClosed = resolve;
    });
    const server = await serve((socket) => {
      socket.on("data", () => {});
      socket.once("close", peerClosed);
    });
    try {
      const socket = openGuardedSocket(`wss://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
        handshakeTimeoutMs: 100,
      });
      const errors: unknown[] = [];
      socket.onerror = (event) => errors.push(event);
      expect((await closed(socket)).code).toBe(1006);
      await released;
      expect(errors).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test("close during TLS negotiation releases the actual connection", async () => {
    let receivedHello!: () => void;
    let peerClosed!: () => void;
    const hello = new Promise<void>((resolve) => {
      receivedHello = resolve;
    });
    const released = new Promise<void>((resolve) => {
      peerClosed = resolve;
    });
    const server = await serve((socket) => {
      socket.once("data", receivedHello);
      socket.once("close", peerClosed);
    });
    try {
      const socket = openGuardedSocket(`wss://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
        handshakeTimeoutMs: 2000,
      });
      const done = closed(socket);
      const errors: unknown[] = [];
      socket.onerror = (event) => errors.push(event);
      await hello;
      socket.close();
      expect((await done).code).toBe(1000);
      await released;
      expect(errors).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  test("a peer closing during HTTP upgrade reports closure without waiting for the deadline", async () => {
    const server = await serve((socket) => {
      socket.once("data", () => socket.end());
    });
    try {
      const socket = openGuardedSocket(`ws://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
        handshakeTimeoutMs: 2000,
      });
      const errors: Error[] = [];
      socket.onerror = (event) =>
        errors.push((event as { error: Error }).error);
      await closed(socket);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("握手完成前关闭");
    } finally {
      await server.stop();
    }
  });

  test("a first message coalesced with the upgrade is not counted as HTTP headers", async () => {
    const message = "x".repeat(256 * 1024);
    const server = await serve((socket) =>
      upgrade(
        socket,
        Buffer.concat([
          frame(1, Buffer.from(message)),
          frame(8, Buffer.from([3, 232])),
        ]),
      ),
    );
    try {
      const socket = openGuardedSocket(`ws://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
      });
      const messages: unknown[] = [];
      const errors: unknown[] = [];
      socket.onmessage = (event) => messages.push(event.data);
      socket.onerror = (event) => errors.push(event);
      await closed(socket);
      expect(errors).toHaveLength(0);
      expect(messages).toEqual([message]);
    } finally {
      await server.stop();
    }
  });

  test("text and binary messages round-trip over a real socket and close normally", async () => {
    const server = await serve((socket) => {
      upgrade(socket, Buffer.alloc(0));
      let sawRequest = false;
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        if (!sawRequest) {
          sawRequest = true;
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 6) {
          const length = pending[1]! & 0x7f;
          if (length >= 126 || pending.length < length + 6) return;
          const body = Buffer.from(pending.subarray(6, length + 6));
          for (let i = 0; i < body.length; i++)
            body[i] = body[i]! ^ pending[2 + (i & 3)]!;
          const opcode = pending[0]! & 15;
          pending = Buffer.from(pending.subarray(length + 6));
          if (opcode === 8) socket.end(frame(opcode, body));
          else socket.write(frame(opcode, body));
        }
      });
    });
    try {
      const socket = openGuardedSocket(`ws://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
      });
      const messages: unknown[] = [];
      const errors: unknown[] = [];
      socket.onerror = (event) => errors.push(event);
      socket.onopen = () => {
        socket.send("你好 IM");
        socket.send(new Uint8Array([1, 2, 3]));
      };
      socket.onmessage = (event) => {
        messages.push(event.data);
        if (messages.length === 2) socket.close();
      };
      expect((await closed(socket)).code).toBe(1000);
      expect(errors).toHaveLength(0);
      expect(messages).toEqual(["你好 IM", new Uint8Array([1, 2, 3])]);
    } finally {
      await server.stop();
    }
  });

  test("fragmented messages retain their byte limit across empty continuation frames", async () => {
    const frames = [frame(1, Buffer.from("a"), false)];
    for (let i = 0; i < 200; i++) frames.push(frame(0, Buffer.alloc(0), false));
    frames.push(frame(0, Buffer.from("bc")), frame(8, Buffer.from([3, 232])));
    const server = await serve((socket) =>
      upgrade(socket, Buffer.concat(frames)),
    );
    try {
      const socket = openGuardedSocket(`ws://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
        maxFrameBytes: 3,
      });
      const messages: unknown[] = [];
      socket.onmessage = (event) => messages.push(event.data);
      await closed(socket);
      expect(messages).toEqual(["abc"]);
    } finally {
      await server.stop();
    }
  });

  test("a fragmented message exceeding the byte limit is refused before delivery", async () => {
    let receivedCode!: (value: number) => void;
    const refusal = new Promise<number>((resolve) => {
      receivedCode = resolve;
    });
    const server = await serve((socket) => {
      upgrade(
        socket,
        Buffer.concat([
          frame(1, Buffer.from("ab"), false),
          frame(0, Buffer.from("cd")),
        ]),
      );
      let seenUpgrade = false;
      socket.on("data", (chunk: Buffer) => {
        if (!seenUpgrade) {
          seenUpgrade = true;
          return;
        }
        // The client close frame is masked: the first two payload bytes encode the code.
        if (chunk[0] !== 0x88 || chunk.length < 8) return;
        const code = ((chunk[6]! ^ chunk[2]!) << 8) | (chunk[7]! ^ chunk[3]!);
        receivedCode(code);
        socket.end(frame(8, Buffer.from([code >> 8, code & 255])));
      });
    });
    try {
      const socket = openGuardedSocket(`ws://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
        maxFrameBytes: 3,
      });
      const messages: unknown[] = [];
      socket.onmessage = (event) => messages.push(event.data);
      const done = closed(socket);
      expect(await refusal).toBe(1009);
      await done;
      expect(messages).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  test("a redirect toward metadata is blocked before the second connection", async () => {
    const server = await serve((socket) => {
      socket.once("data", () =>
        socket.end(
          "HTTP/1.1 302 Found\r\nLocation: ws://169.254.169.254/\r\nContent-Length: 0\r\n\r\n",
        ),
      );
    });
    try {
      const socket = openGuardedSocket(`ws://127.0.0.1:${server.port}/`, {
        allowPrivate: true,
      });
      const errors: Error[] = [];
      socket.onerror = (event) =>
        errors.push((event as { error: Error }).error);
      await closed(socket);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("不能访问内网地址");
    } finally {
      await server.stop();
    }
  });
});
