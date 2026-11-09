import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import {
  defaultCapabilities,
  isMobilePlatform,
  pairingUri,
} from "../../shared/devices";
import { createDeviceHub } from "../src/devices/hub";
import {
  createPairingStore,
  isPairingCode,
  PAIRING_TTL_MS,
} from "../src/devices/pairing";
import { createDeviceRoutes } from "../src/devices/routes";
import {
  type DeviceRecord,
  type DeviceStore,
  hashDeviceToken,
  newDeviceToken,
} from "../src/devices/store";

describe("pairing store", () => {
  test("issues single-use codes bound to the issuer", () => {
    const store = createPairingStore();
    const ticket = store.issue("u1");
    expect(isPairingCode(ticket.code)).toBe(true);
    expect(ticket.ttlSeconds).toBe(300);
    expect(store.status(ticket.id, "u2")).toBeNull();
    expect(store.status(ticket.id, "u1")?.state).toBe("pending");
    const first = store.redeem(ticket.code);
    expect(first).toEqual({
      ok: true,
      pairingId: ticket.id,
      ownerUserId: "u1",
      kind: "phone",
    });
    expect(store.redeem(ticket.code)).toEqual({ ok: false, reason: "used" });
    store.complete(ticket.id, { id: "dev_x", name: "Pixel 8" });
    expect(store.status(ticket.id, "u1")).toMatchObject({
      state: "bound",
      device: { id: "dev_x", name: "Pixel 8" },
    });
    expect(store.redeem(ticket.code)).toEqual({ ok: false, reason: "used" });
  });

  test("expires after the ttl and rejects garbage", () => {
    let time = 1_000_000;
    const store = createPairingStore({ now: () => time });
    const ticket = store.issue("u1");
    time += PAIRING_TTL_MS + 1;
    expect(store.status(ticket.id, "u1")?.state).toBe("expired");
    expect(store.redeem(ticket.code)).toEqual({ ok: false, reason: "expired" });
    expect(store.redeem("cbp_short")).toEqual({ ok: false, reason: "invalid" });
    expect(store.redeem(`cbp_${"A".repeat(32)}`)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(store.redeem(42)).toEqual({ ok: false, reason: "invalid" });
  });

  test("keeps at most three pending codes per person and cancels on request", () => {
    const store = createPairingStore();
    const tickets = [1, 2, 3, 4].map(() => store.issue("u1"));
    expect(store.status(tickets[0]!.id, "u1")?.state).toBe("cancelled");
    expect(store.redeem(tickets[0]!.code)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(store.cancel(tickets[3]!.id, "u2")).toBe(false);
    expect(store.cancel(tickets[3]!.id, "u1")).toBe(true);
    expect(store.redeem(tickets[3]!.code)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(store.redeem(tickets[2]!.code).ok).toBe(true);
  });

  test("failed enrolment burns the code", () => {
    const store = createPairingStore();
    const ticket = store.issue("u1");
    const result = store.redeem(ticket.code);
    if (!result.ok) throw new Error("expected ok");
    store.fail(result.pairingId);
    expect(store.status(ticket.id, "u1")?.state).toBe("cancelled");
    expect(store.redeem(ticket.code)).toEqual({ ok: false, reason: "expired" });
  });

  test("qr payload and platform helpers", () => {
    expect(pairingUri("https://chisabot.example.com:8443", "cbp_abc")).toBe(
      "chisabot://pair?server=https%3A%2F%2Fchisabot.example.com%3A8443&code=cbp_abc",
    );
    expect(isMobilePlatform("android")).toBe(true);
    expect(isMobilePlatform("win32")).toBe(false);
    expect(isMobilePlatform(null)).toBe(false);
  });
});

/** 只实现 routes 用到的部分的内存设备表。 */
function memoryStore() {
  const rows = new Map<string, DeviceRecord>();
  const audits: Array<Record<string, unknown>> = [];
  let n = 0;
  const store = {
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async list(owner: string | null) {
      return [...rows.values()].filter(
        (row) => !owner || row.ownerUserId === owner,
      );
    },
    async enroll(input: Record<string, unknown>) {
      const token = newDeviceToken();
      const id = `dev_${++n}`;
      const record: DeviceRecord = {
        id,
        ownerUserId: String(input.ownerUserId),
        name: String(input.name),
        platform: String(input.platform),
        osVersion: (input.osVersion as string) ?? null,
        hostname: (input.hostname as string) ?? null,
        arch: null,
        clientVersion: (input.clientVersion as string) ?? null,
        capabilities: defaultCapabilities(),
        allowedRoots: [],
        paused: false,
        revoked: false,
        lastSeenAt: null,
        lastIp: (input.ip as string) ?? null,
        createdAt: new Date().toISOString(),
        botIds: [],
        lastUsedBy: null,
        tokenHash: hashDeviceToken(token),
      };
      rows.set(id, record);
      return { device: record, token };
    },
    async authenticate(token: string) {
      const hash = hashDeviceToken(token);
      const row = [...rows.values()].find((item) => item.tokenHash === hash);
      if (!row) return null;
      return row.revoked ? ("revoked" as const) : row;
    },
    async touch(id: string) {
      const row = rows.get(id);
      if (row && !row.revoked) row.lastSeenAt = new Date().toISOString();
    },
    async revoke(id: string) {
      const row = rows.get(id);
      if (!row || row.revoked) return false;
      row.revoked = true;
      row.paused = true;
      return true;
    },
    async audit(input: Record<string, unknown>) {
      audits.push(input);
      return String(audits.length);
    },
    async forOwner() {
      return [];
    },
  };
  return { rows, audits, store: store as unknown as DeviceStore };
}

function setup() {
  const memory = memoryStore();
  const hub = createDeviceHub({ store: memory.store });
  const pairing = createPairingStore();
  let actor = {
    id: "u1",
    role: "admin",
    name: "主人",
    email: null as string | null,
  };
  const requireUser: MiddlewareHandler = async (context, next) => {
    context.set("actor" as never, actor as never);
    await next();
  };
  const routes = createDeviceRoutes({
    store: memory.store,
    hub,
    requireUser: requireUser as never,
    pairing,
  });
  const call = (
    path: string,
    init: RequestInit & { json?: unknown; ip?: string } = {},
  ) =>
    routes.request(path, {
      ...init,
      headers: {
        ...(init.json !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...(init.ip === undefined
          ? { "x-forwarded-for": "203.0.113.9" }
          : init.ip
            ? { "x-forwarded-for": init.ip }
            : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  return {
    memory,
    pairing,
    call,
    setActor: (next: typeof actor) => (actor = next),
  };
}

describe("/api/devices pairing routes", () => {
  test("web issues a code, the phone redeems it once and becomes an android device of that person", async () => {
    const { call, memory } = setup();
    const issued = await call("/pairing", { method: "POST" });
    expect(issued.status).toBe(201);
    const ticket = (await issued.json()) as { id: string; code: string };
    expect((await (await call(`/pairing/${ticket.id}`)).json()).state).toBe(
      "pending",
    );

    const redeemed = await call("/agent/pair", {
      method: "POST",
      json: {
        code: ticket.code,
        name: "Pixel 8",
        model: "Google Pixel 8",
        osVersion: "Android 15",
        clientVersion: "0.1.2",
      },
    });
    expect(redeemed.status).toBe(201);
    const body = (await redeemed.json()) as {
      device: {
        id: string;
        platform: string;
        ownerUserId: string;
        online: boolean;
        name: string;
      };
      token: string;
    };
    expect(body.token).toMatch(/^cbd_[A-Za-z0-9_-]{43}$/);
    expect(body.device).toMatchObject({
      platform: "android",
      ownerUserId: "u1",
      name: "Pixel 8",
      online: true,
    });
    expect(memory.audits.some((entry) => entry.action === "enrolled")).toBe(
      true,
    );

    const status = await (await call(`/pairing/${ticket.id}`)).json();
    expect(status).toMatchObject({
      state: "bound",
      device: { id: body.device.id, name: "Pixel 8" },
    });

    const again = await call("/agent/pair", {
      method: "POST",
      json: { code: ticket.code },
    });
    expect(again.status).toBe(410);
    expect((await again.json()).reason).toBe("used");
  });

  test("invalid codes are refused and rate limited per IP", async () => {
    const { call } = setup();
    const bad = await call("/agent/pair", {
      method: "POST",
      json: { code: "nope" },
      ip: "198.51.100.1",
    });
    expect(bad.status).toBe(400);
    let last = 0;
    for (let i = 0; i < 40; i++)
      last = (
        await call("/agent/pair", {
          method: "POST",
          json: { code: "nope" },
          ip: "198.51.100.1",
        })
      ).status;
    expect(last).toBe(429);
    // 其它 IP 不受影响。
    expect(
      (
        await call("/agent/pair", {
          method: "POST",
          json: { code: "nope" },
          ip: "198.51.100.2",
        })
      ).status,
    ).toBe(400);
  });

  test("someone else cannot read my pairing status", async () => {
    const { call, setActor } = setup();
    const ticket = (await (
      await call("/pairing", { method: "POST" })
    ).json()) as { id: string };
    setActor({ id: "u2", role: "member", name: "别人", email: null });
    expect((await call(`/pairing/${ticket.id}`)).status).toBe(404);
  });

  test("session exchange only accepts phone tokens; state answers only direct (gateway) calls; revoke ends it", async () => {
    const { call, memory } = setup();
    const ticket = (await (
      await call("/pairing", { method: "POST" })
    ).json()) as { code: string };
    const { device, token } = (await (
      await call("/agent/pair", {
        method: "POST",
        json: { code: ticket.code, model: "Xiaomi 14" },
      })
    ).json()) as {
      device: { id: string; name: string };
      token: string;
    };
    expect(device.name).toBe("Xiaomi 14");

    const session = await call("/agent/session", {
      method: "POST",
      headers: { "x-device-token": token },
      json: {},
    });
    expect(session.status).toBe(200);
    expect((await session.json()).device).toMatchObject({
      id: device.id,
      ownerUserId: "u1",
    });

    // PC 令牌不能换手机会话。
    const pc = await memory.store.enroll({
      ownerUserId: "u1",
      name: "PC",
      platform: "win32",
    });
    expect(
      (
        await call("/agent/session", {
          method: "POST",
          headers: { "x-device-token": pc.token },
          json: {},
        })
      ).status,
    ).toBe(403);
    // 手机令牌不能当电脑节点接入。
    expect(
      (await call("/agent/ws", { headers: { "x-device-token": token } }))
        .status,
    ).toBe(403);

    // 经过公网代理（带 X-Forwarded-For）问状态：404。
    expect((await call(`/agent/state/${device.id}`)).status).toBe(404);
    // 网关直连：有效。
    expect(
      await (await call(`/agent/state/${device.id}`, { ip: "" })).json(),
    ).toEqual({ active: true });
    expect(
      await (await call(`/agent/state/${pc.device.id}`, { ip: "" })).json(),
    ).toEqual({ active: false });
    expect(
      await (await call("/agent/state/dev_missing", { ip: "" })).json(),
    ).toEqual({ active: false });

    // 网页撤销 → 状态变无效、令牌换会话被拒（revoked）。
    expect(
      (await call(`/${device.id}/revoke`, { method: "POST" })).status,
    ).toBe(200);
    expect(
      await (await call(`/agent/state/${device.id}`, { ip: "" })).json(),
    ).toEqual({ active: false });
    const after = await call("/agent/session", {
      method: "POST",
      headers: { "x-device-token": token },
      json: {},
    });
    expect(after.status).toBe(401);
    expect((await after.json()).revoked).toBe(true);
  });

  test("phone logout unenrolls itself with a phone-worded audit line", async () => {
    const { call, memory } = setup();
    const ticket = (await (
      await call("/pairing", { method: "POST" })
    ).json()) as { code: string };
    const { device, token } = (await (
      await call("/agent/pair", { method: "POST", json: { code: ticket.code } })
    ).json()) as {
      device: { id: string; name: string };
      token: string;
    };
    expect(device.name).toBe("我的手机");
    expect(
      (
        await call("/agent/unenroll", {
          method: "POST",
          headers: { "x-device-token": token },
        })
      ).status,
    ).toBe(200);
    expect(memory.rows.get(device.id)?.revoked).toBe(true);
    expect(memory.audits.at(-1)).toMatchObject({
      action: "unenrolled",
      summary: "在手机上退出登录，令牌已作废",
    });
  });
});
