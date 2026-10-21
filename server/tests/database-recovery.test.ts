import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { recoveringSql } from "../src/db/recovery";
import type { SQL } from "bun";

const int16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstring = (text: string) => Buffer.from(text + "\0");
const packet = (tag: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(tag), int32(body.length + 4), body]);
};
const ready = (transaction = false) => packet("Z", Buffer.from(transaction ? "T" : "I"));
const column = (binary = false) => packet("T", int16(1), cstring("ok"), int32(0), int16(0), int32(23), int16(4), int32(-1), int16(binary ? 1 : 0));
const row = (simple: boolean) => packet("D", int16(1), int32(simple ? 1 : 4), simple ? Buffer.from("1") : int32(1));
const error = (code: string) => packet("E", Buffer.from("SERROR\0VERROR\0C" + code + "\0Mbind message supplies 1 parameters, but prepared statement \"\" requires 8\0\0"));

type Peer = { socket: Socket; connection: number; command: string; transaction: boolean };

// A loopback-only PostgreSQL peer. It records work that actually reached the wire, including COMMIT.
// It deliberately never opens an application or development database.
async function fakePostgres(onCommand: (peer: Peer) => "ok" | "silence" | "eof" | "protocol") {
  const commands: Array<{ connection: number; sql: string }> = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  let closed = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    const peer: Peer = { socket, connection: ++connections, command: "", transaction: false };
    let input = Buffer.alloc(0);
    let startup = true;
    let failed = false;
    let silent = false;
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); closed++; });
    const execute = (simple: boolean) => {
      commands.push({ connection: peer.connection, sql: peer.command });
      const mode = onCommand(peer);
      if (mode === "silence") { silent = true; return; }
      if (mode === "eof") { socket.end(); return; }
      if (mode === "protocol") { socket.write(error("08P01")); failed = true; if (simple) socket.write(ready(peer.transaction)); return; }
      if (/^BEGIN/i.test(peer.command)) peer.transaction = true;
      if (/^(COMMIT|ROLLBACK)/i.test(peer.command)) peer.transaction = false;
      const select = /^SELECT/i.test(peer.command);
      socket.write(Buffer.concat([...(select ? [...(simple ? [column()] : []), row(simple)] : []), packet("C", cstring(select ? "SELECT 1" : peer.command.split(" ")[0] || "OK")), ...(simple ? [ready(peer.transaction)] : [])]));
    };
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= (startup ? 4 : 5)) {
        const length = input.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (input.length < length) return;
        const message = input.subarray(0, length);
        input = input.subarray(length);
        if (startup) {
          if (message.readInt32BE(4) === 80877102) { socket.end(); return; } // CancelRequest
          startup = false;
          socket.write(Buffer.concat([packet("R", int32(0)), packet("S", cstring("server_version"), cstring("16.0")), packet("S", cstring("client_encoding"), cstring("UTF8")), packet("K", int32(peer.connection), int32(42)), ready()]));
          continue;
        }
        const tag = String.fromCharCode(message[0]!);
        const body = message.subarray(5);
        if (tag === "X") { socket.end(); continue; }
        if (silent) continue;
        if (tag === "Q") { peer.command = body.toString().replace(/\0$/, ""); execute(true); }
        if (tag === "P") {
          const end = body.indexOf(0);
          peer.command = body.subarray(end + 1, body.indexOf(0, end + 1)).toString();
          socket.write(packet("1"));
        }
        if (tag === "D") {
          if (body[0] === 83) socket.write(packet("t", int16((peer.command.match(/\$\d+/g) ?? []).length), ...Array.from(peer.command.matchAll(/\$\d+/g), () => int32(23))));
          socket.write(/^SELECT/i.test(peer.command) ? column(body[0] === 80) : packet("n"));
        }
        if (tag === "B") socket.write(packet("2"));
        if (tag === "E" && !failed) execute(false);
        if (tag === "S" && !silent) { socket.write(ready(peer.transaction)); failed = false; }
        if (tag === "C") socket.write(packet("3"));
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  return {
    url: `postgres://t:t@127.0.0.1:${address.port}/fake_test`, commands,
    get connections() { return connections; },
    get closed() { return closed; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

async function observed<T>(promise: PromiseLike<T>, timeoutMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({ status: "resolved" as const, value }), (error: unknown) => ({ status: "rejected" as const, error })),
      new Promise<{ status: "pending" }>((resolve) => { timer = setTimeout(() => resolve({ status: "pending" }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

describe("Bun SQL recovery", () => {
  test("a numeric network errno rejects immediately without a second error in the rejection handler", async () => {
    const network = Object.assign(new Error("Connection refused"), { errno: -111, code: "ECONNREFUSED" });
    const client = recoveringSql(() => ({
      unsafe: () => Promise.reject(network),
      close: async () => {},
    }) as unknown as SQL, 1000);
    try {
      const outcome = await observed(client.unsafe("SELECT 1"), 100);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.error).toBe(network);
    } finally { await client.close(); }
  });

  test("a silent single connection fails current and queued work, closes the old socket and recovers", async () => {
    const fake = await fakePostgres((peer) => peer.connection === 1 ? "silence" : "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 80 });
    try {
      const first = observed(database.execute(sql`SELECT 1`), 1000);
      const start = performance.now();
      while (fake.commands.length === 0 && performance.now() - start < 500) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(fake.commands).toHaveLength(1);
      const queued = observed(database.$client.unsafe("INSERT INTO probe VALUES (2)"), 1000);
      const results = await Promise.all([first, queued]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(fake.commands.map((command) => command.sql)).toEqual(["SELECT 1"]);
      expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
      expect(fake.connections).toBe(2);
      expect(fake.closed).toBeGreaterThanOrEqual(1);
      expect(fake.commands.filter((command) => /^INSERT/.test(command.sql))).toHaveLength(0);
    } finally { await database.$client.close(); await fake.close(); }
  });

  test("a protocol violation retires the pool immediately without repeating an ambiguous write", async () => {
    const fake = await fakePostgres((peer) => peer.connection === 1 ? "protocol" : "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 1000 });
    try {
      const outcome = await observed(database.$client.unsafe("INSERT INTO probe VALUES ($1)", [1]), 500);
      expect(outcome.status).toBe("rejected");
      expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
      expect(fake.connections).toBe(2);
      expect(fake.commands.filter((command) => /^INSERT/.test(command.sql))).toHaveLength(1);
    } finally { await database.$client.close(); await fake.close(); }
  });

  test.each(["eof", "silence"] as const)("an unacknowledged COMMIT (%s) rejects once and later requests recover", async (mode) => {
    const fake = await fakePostgres((peer) => /^COMMIT/i.test(peer.command) ? mode : "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 80 });
    let calls = 0;
    try {
      const outcome = await observed(database.transaction(async (tx) => {
        calls++;
        await tx.execute(sql`INSERT INTO probe VALUES (1)`);
      }), 1000);
      expect(outcome.status).toBe("rejected");
      expect(calls).toBe(1);
      expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
      expect(fake.commands.filter((command) => /^INSERT/.test(command.sql))).toHaveLength(1);
      expect(fake.commands.filter((command) => /^COMMIT/.test(command.sql))).toHaveLength(1);
      expect(fake.commands.filter((command) => /^ROLLBACK/.test(command.sql))).toHaveLength(0);
    } finally { await database.$client.close(); await fake.close(); }
  });

  test("a normal transaction callback can wait longer than one database deadline", async () => {
    const fake = await fakePostgres(() => "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 80 });
    try {
      const rows = await database.transaction(async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return await tx.execute(sql`SELECT 1`);
      });
      expect(rows[0]?.ok).toBe(1);
      expect(fake.connections).toBe(1);
      expect(fake.commands.map((command) => command.sql)).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    } finally { await database.$client.close(); await fake.close(); }
  });

  test("a pool waiter expires even while a transaction callback holds the sole connection", async () => {
    const fake = await fakePostgres(() => "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 80 });
    let release!: () => void;
    let acquired!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    let late: unknown;
    try {
      const held = observed(database.$client.begin(async (tx) => {
        acquired();
        await hold;
        try { await tx.unsafe("INSERT INTO probe VALUES (3)"); } catch (error) { late = error; }
      }), 1000);
      await ready;
      const waiter = await observed(database.$client.unsafe("INSERT INTO probe VALUES (2)"), 1000);
      expect(waiter.status).toBe("rejected");
      expect((await held).status).toBe("rejected");
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(late).toBeDefined();
      expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
      expect(fake.commands.filter((command) => /^(INSERT|COMMIT)/.test(command.sql))).toHaveLength(0);
    } finally { release(); await database.$client.close(); await fake.close(); }
  });

  test("reserve also has a finite pool wait and no late connection escapes the retired pool", async () => {
    const fake = await fakePostgres(() => "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 80 });
    try {
      const reserved = await database.$client.reserve();
      const outcome = await observed(database.$client.reserve(), 1000);
      expect(outcome.status).toBe("rejected");
      expect((await observed(Promise.resolve().then(() => reserved.unsafe("SELECT 1")))).status).toBe("rejected");
      expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
      expect(fake.connections).toBe(2);
    } finally { await database.$client.close(); await fake.close(); }
  });

  test("ROLLBACK response loss and silence before BEGIN finish both fail finitely", async () => {
    for (const phase of ["BEGIN", "ROLLBACK"]) {
      const fake = await fakePostgres((peer) => peer.command === phase ? "silence" : "ok");
      const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 80 });
      let calls = 0;
      try {
        const result = await observed(database.$client.begin(async () => { calls++; throw new Error("abort"); }), 1000);
        expect(result.status).toBe("rejected");
        expect(calls).toBe(phase === "BEGIN" ? 0 : 1);
        expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
      } finally { await database.$client.close(); await fake.close(); }
    }
  });

  test("lazy queries created in a finished or retired scope never run on a new connection", async () => {
    const fake = await fakePostgres((peer) => peer.connection === 1 && /^SELECT/.test(peer.command) ? "silence" : "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 80 });
    try {
      let escaped!: ReturnType<typeof database.$client.unsafe>;
      await database.$client.begin(async (tx) => { escaped = tx.unsafe("INSERT INTO probe VALUES (7)"); });
      expect((await observed(escaped)).status).toBe("rejected");
      const stale = database.$client.unsafe("INSERT INTO probe VALUES (8)");
      expect((await observed(database.execute(sql`SELECT 1`), 1000)).status).toBe("rejected");
      expect((await observed(stale)).status).toBe("rejected");
      expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
      expect(fake.commands.filter((command) => /^INSERT/.test(command.sql))).toHaveLength(0);
    } finally { await database.$client.close(); await fake.close(); }
  });

  test("assigned SQL methods and Function.call keep their normal callable object semantics", async () => {
    const fake = await fakePostgres(() => "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 1000 });
    try {
      const original = database.$client.unsafe;
      let calls = 0;
      database.$client.unsafe = ((...args: Parameters<typeof original>) => { calls++; return original(...args); }) as typeof original;
      expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
      expect(calls).toBe(1);
      database.$client.unsafe = original;
      expect(database.$client.call(undefined, { ok: 1 })).toBeDefined();
      expect((await database.execute(sql`SELECT 1`))[0]?.ok).toBe(1);
    } finally { await database.$client.close(); await fake.close(); }
  });

  test("reserve, lazy execution, tagged values and result modes preserve Bun's public surface", async () => {
    const fake = await fakePostgres(() => "ok");
    const database = createDatabase(fake.url, { max: 1, queryTimeoutMs: 1000 });
    try {
      expect(await database.$client.connect()).toBe(database.$client);
      const query = database.$client`SELECT ${1}::int AS ok`;
      expect(fake.commands).toHaveLength(0);
      expect((await query.values())[0]).toEqual([1]);
      const reserved = await database.$client.reserve();
      expect((await reserved.unsafe("SELECT 1"))[0]?.ok).toBe(1);
      await reserved.begin(async (tx) => { expect((await tx.unsafe("SELECT 1"))[0]?.ok).toBe(1); });
      await reserved.release();
      expect((await database.$client.unsafe("SELECT 1").simple().execute())[0]?.ok).toBe(1);
      expect(fake.connections).toBe(1);
    } finally { await database.$client.close(); await fake.close(); }
  });
});
