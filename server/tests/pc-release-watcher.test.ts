import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { defaultCapabilities } from "../../shared/devices";
import type { AppVariables } from "../src/auth/guards";
import { createDeviceHub } from "../src/devices/hub";
import {
  createPcReleaseWatcher,
  DEFAULT_PC_UPDATE_FEED_URL,
  normalizePcUpdateFeedUrl,
  parseLatestYmlVersion,
} from "../src/devices/pc-release-watcher";
import { createDeviceRoutes } from "../src/devices/routes";
import type { DeviceRecord } from "../src/devices/store";

function makeDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev_1",
    ownerUserId: "u1",
    name: "测试电脑",
    platform: "win32",
    osVersion: null,
    hostname: "WIN-TEST",
    arch: "x64",
    clientVersion: "0.1.171",
    capabilities: defaultCapabilities(),
    allowedRoots: [],
    paused: false,
    revoked: false,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "hash",
    ...overrides,
  };
}

function makeFakeStore(devices: DeviceRecord[]) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  return {
    get: async (id: string) => byId.get(id) ?? null,
    list: async () => [...byId.values()],
    touch: async (id: string, facts: Record<string, unknown>) => {
      const existing = byId.get(id);
      if (existing && typeof facts.clientVersion === "string") {
        byId.set(id, { ...existing, clientVersion: facts.clientVersion });
      }
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const existing = byId.get(id);
      if (!existing) return null;
      const next = { ...existing, ...(patch as Partial<DeviceRecord>) };
      byId.set(id, next);
      return next;
    },
    audit: async () => "audit_1",
    finishAudit: async () => {},
  };
}

function makeFakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    socket: {
      send: (data: string) => sent.push(JSON.parse(data)),
      close: () => {},
    },
  };
}

describe("pc release watcher & push update", () => {
  test("parses latest.yml version and normalizes feed URLs", () => {
    expect(
      parseLatestYmlVersion(
        "version: 0.1.172\nfiles:\n  - url: ChisaBot-0.1.172-x64-setup.exe\n",
      ),
    ).toBe("0.1.172");
    expect(parseLatestYmlVersion("  version: 9.9.9\nversion: 'v0.1.173' # tag\n")).toBe(
      "0.1.173",
    );
    expect(parseLatestYmlVersion("files:\n  - url: setup.exe\n")).toBeNull();

    expect(normalizePcUpdateFeedUrl(undefined)).toBe(DEFAULT_PC_UPDATE_FEED_URL);
    expect(normalizePcUpdateFeedUrl("off")).toBe("");
    expect(normalizePcUpdateFeedUrl("https://cdn.example.com/pc/")).toBe(
      "https://cdn.example.com/pc/latest.yml",
    );
    expect(
      normalizePcUpdateFeedUrl("https://cdn.example.com/pc/latest.yml"),
    ).toBe("https://cdn.example.com/pc/latest.yml");
  });

  test("skips polling when no desktop devices are online, then broadcasts once on new release with ETag caching", async () => {
    const oldDev = makeDevice({ id: "dev_old", clientVersion: "0.1.171" });
    const newDev = makeDevice({ id: "dev_new", clientVersion: "0.1.172" });
    const hub = createDeviceHub({
      store: makeFakeStore([oldDev, newDev]) as never,
    });

    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    let remoteVersion = "0.1.172";
    let remoteEtag = '"etag-172"';

    const watcher = createPcReleaseWatcher({
      hub,
      runningVersion: "0.1.171",
      fetchFn: async (url, opts) => {
        const headers = opts.headers ?? {};
        requests.push({ url, headers });
        if (headers["if-none-match"] === remoteEtag) {
          return { status: 304, headers: {}, body: Buffer.alloc(0) };
        }
        return {
          status: 200,
          headers: { etag: remoteEtag },
          body: Buffer.from(`version: ${remoteVersion}\n`, "utf8"),
        };
      },
      logger: { warn: () => {}, info: () => {} },
    });

    // 1. 零在线设备：不发外部请求
    const idle = await watcher.checkNow();
    expect(idle.checked).toBe(false);
    expect(requests.length).toBe(0);

    // 2. 两台桌面端连上（一旧一新）
    const sOld = makeFakeSocket();
    const sNew = makeFakeSocket();
    const cOld = hub.attach(oldDev, sOld.socket, "127.0.0.1");
    const cNew = hub.attach(newDev, sNew.socket, "127.0.0.1");
    await cOld.onMessage(
      JSON.stringify({ type: "hello", clientVersion: "0.1.171", platform: "win32" }),
    );
    await cNew.onMessage(
      JSON.stringify({ type: "hello", clientVersion: "0.1.172", platform: "win32" }),
    );
    sOld.sent.length = 0;
    sNew.sent.length = 0;

    // 3. 首次检测到 0.1.172：只推给旧设备，跳过已是 0.1.172 的设备
    const first = await watcher.checkNow();
    expect(first).toMatchObject({
      checked: true,
      version: "0.1.172",
      changed: true,
      notified: 1,
      skipped: 1,
      totalOnline: 2,
    });
    expect(sOld.sent).toEqual([
      { type: "check_update", version: "0.1.172", reason: "release_watch" },
    ]);
    expect(sNew.sent).toEqual([]);

    // 4. 二次轮询携带 If-None-Match，收到 304 不重复推送
    sOld.sent.length = 0;
    const second = await watcher.checkNow();
    expect(requests[1]?.headers["if-none-match"]).toBe('"etag-172"');
    expect(second.notified).toBe(0);
    expect(sOld.sent).toEqual([]);

    // 5. 远端发版 0.1.173：立即广播给全部两台设备
    remoteVersion = "0.1.173";
    remoteEtag = '"etag-173"';
    const third = await watcher.checkNow();
    expect(third).toMatchObject({
      version: "0.1.173",
      changed: true,
      notified: 2,
      skipped: 0,
    });
    expect(sOld.sent).toEqual([
      { type: "check_update", version: "0.1.173", reason: "release_watch" },
    ]);
    expect(sNew.sent).toEqual([
      { type: "check_update", version: "0.1.173", reason: "release_watch" },
    ]);

    cOld.onClose();
    cNew.onClose();
  });

  test("device hello receives immediate check_update when clientVersion is behind latest known version", async () => {
    const dev = makeDevice({ id: "dev_behind", clientVersion: "0.1.170" });
    const hub = createDeviceHub({
      store: makeFakeStore([dev]) as never,
      getLatestClientVersion: () => "0.1.172",
    });

    const sock = makeFakeSocket();
    const conn = hub.attach(dev, sock.socket, "127.0.0.1");
    await conn.onMessage(
      JSON.stringify({ type: "hello", clientVersion: "0.1.170", platform: "win32" }),
    );
    expect(
      sock.sent.find((m) => m.type === "check_update"),
    ).toEqual({
      type: "check_update",
      version: "0.1.172",
      reason: "hello_behind",
    });

    // 若设备已是最新，不推 check_update
    sock.sent.length = 0;
    await conn.onMessage(
      JSON.stringify({ type: "hello", clientVersion: "0.1.172", platform: "win32" }),
    );
    expect(sock.sent.find((m) => m.type === "check_update")).toBeUndefined();
    conn.onClose();
  });

  test("POST /push-update requires admin and broadcasts check_update to online lagging devices", async () => {
    const dev = makeDevice({ id: "dev_admin_test", clientVersion: "0.1.171" });
    const store = makeFakeStore([dev]);
    const hub = createDeviceHub({ store: store as never });
    const sock = makeFakeSocket();
    const conn = hub.attach(dev, sock.socket, "127.0.0.1");
    await conn.onMessage(
      JSON.stringify({ type: "hello", clientVersion: "0.1.171", platform: "win32" }),
    );
    sock.sent.length = 0;

    const watcher = createPcReleaseWatcher({
      hub,
      runningVersion: "0.1.171",
      fetchFn: async () => ({
        status: 200,
        headers: {},
        body: Buffer.from("version: 0.1.172\n", "utf8"),
      }),
      logger: { warn: () => {}, info: () => {} },
    });

    const authAs = (
      role: "admin" | "member",
    ): MiddlewareHandler<{ Variables: AppVariables }> =>
      async (context, next) => {
        context.set("actor", {
          id: role === "admin" ? "admin_1" : "user_1",
          email: `${role}@example.com`,
          name: role,
          role,
        });
        await next();
      };

    const memberApp = createDeviceRoutes({
      store: store as never,
      hub,
      requireUser: authAs("member"),
      checkPcRelease: (opts) => watcher.checkNow(opts),
    });
    const denied = await memberApp.request("/push-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);
    expect(sock.sent).toEqual([]);

    const adminApp = createDeviceRoutes({
      store: store as never,
      hub,
      requireUser: authAs("admin"),
      checkPcRelease: (opts) => watcher.checkNow(opts),
    });
    const ok = await adminApp.request("/push-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      version: "0.1.172",
      notified: 1,
      skipped: 0,
      totalOnline: 1,
    });
    expect(sock.sent).toEqual([
      { type: "check_update", version: "0.1.172", reason: "admin_push" },
    ]);

    conn.onClose();
  });
});
