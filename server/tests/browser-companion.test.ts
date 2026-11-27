import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  BROWSER_COMPANION_OPERATIONS,
  type CompanionBootstrapResponse,
} from "../../shared/browser-companion";
import {
  BROWSER_EXTENSION_PLATFORM,
  defaultCapabilities,
  initialCapabilities,
  isBrowserExtensionPlatform,
} from "../../shared/devices";
import type { AppVariables } from "../src/auth/guards";
import { withToolImageCollector } from "../src/conversations/tool-images";
import {
  createBrowserCompanionService,
  detectLocalChromeIntent,
  extractBrowserCompanionProps,
  STALE_BROWSER_SNAPSHOT_ERROR,
} from "../src/devices/browser-companion";
import {
  createDeviceHub,
  type DeviceConfirmLink,
  DeviceRefusedError,
} from "../src/devices/hub";
import { createPairingStore } from "../src/devices/pairing";
import {
  type CompanionRouteBridge,
  createDeviceRoutes,
} from "../src/devices/routes";
import {
  browserExtensionCapabilities,
  type DevicePatch,
  type DeviceRecord,
  type DeviceStore,
  hashDeviceToken,
  newDeviceToken,
} from "../src/devices/store";
import { deviceTools } from "../src/devices/tools";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function createMemoryDeviceStore() {
  const rows = new Map<string, DeviceRecord>();
  const audits: Array<{
    id: string;
    deviceId: string;
    ownerUserId: string;
    actorType: string;
    actorId: string | null;
    actorName: string | null;
    action: string;
    summary: string | null;
    outcome: string;
    detail: string | null;
    durationMs: number | null;
    at: string;
  }> = [];

  const store = {
    async ensure() {},
    async get(id: string) {
      const found = rows.get(id);
      return found
        ? { ...found, capabilities: { ...found.capabilities } }
        : null;
    },
    async list(ownerUserId: string | null) {
      return [...rows.values()]
        .filter((d) => ownerUserId === null || d.ownerUserId === ownerUserId)
        .map((d) => ({ ...d, capabilities: { ...d.capabilities } }));
    },
    async enroll(input: {
      ownerUserId: string;
      name?: unknown;
      platform?: unknown;
      osVersion?: unknown;
      hostname?: unknown;
      arch?: unknown;
      clientVersion?: unknown;
      ip?: string | null;
    }) {
      const token = newDeviceToken();
      const id = `dev_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const platform =
        typeof input.platform === "string" && input.platform.trim()
          ? input.platform.trim()
          : "unknown";
      const isExt = isBrowserExtensionPlatform(platform);
      const isMobile = platform === "android" || platform === "ios";
      const device: DeviceRecord = {
        id,
        ownerUserId: input.ownerUserId,
        name:
          typeof input.name === "string" && input.name.trim()
            ? input.name.trim()
            : isExt
              ? "Chrome 浏览器扩展"
              : "我的电脑",
        platform,
        osVersion: typeof input.osVersion === "string" ? input.osVersion : null,
        hostname: typeof input.hostname === "string" ? input.hostname : null,
        arch: typeof input.arch === "string" ? input.arch : null,
        clientVersion:
          typeof input.clientVersion === "string" ? input.clientVersion : null,
        capabilities: isMobile
          ? defaultCapabilities()
          : isExt
            ? browserExtensionCapabilities()
            : initialCapabilities(),
        allowedRoots: [],
        paused: false,
        revoked: false,
        lastSeenAt: null,
        lastIp: input.ip ?? null,
        createdAt: new Date().toISOString(),
        botIds: [],
        lastUsedBy: null,
        fullAccessUntil: null,
        tokenHash: hashDeviceToken(token),
      };
      rows.set(id, device);
      return { device: { ...device }, token };
    },
    async authenticate(token: string) {
      const hash = hashDeviceToken(token);
      for (const device of rows.values()) {
        if (device.tokenHash === hash) {
          if (device.revoked) return "revoked" as const;
          return { ...device, capabilities: { ...device.capabilities } };
        }
      }
      return null;
    },
    async touch(id: string, facts: Record<string, unknown> = {}) {
      const found = rows.get(id);
      if (!found || found.revoked) return;
      found.lastSeenAt = new Date().toISOString();
      if (typeof facts.ip === "string") found.lastIp = facts.ip;
      if (typeof facts.clientVersion === "string")
        found.clientVersion = facts.clientVersion;
      if (typeof facts.platform === "string") found.platform = facts.platform;
      if (typeof facts.osVersion === "string")
        found.osVersion = facts.osVersion;
      if (typeof facts.hostname === "string") found.hostname = facts.hostname;
      if (typeof facts.arch === "string") found.arch = facts.arch;
    },
    async update(id: string, patch: DevicePatch) {
      const found = rows.get(id);
      if (!found || found.revoked) return null;
      if (patch.name !== undefined) found.name = patch.name;
      if (patch.capabilities) {
        found.capabilities = { ...found.capabilities, ...patch.capabilities };
      }
      if (patch.allowedRoots !== undefined)
        found.allowedRoots = [...patch.allowedRoots];
      if (patch.paused !== undefined) found.paused = patch.paused;
      if (patch.fullAccessUntil !== undefined)
        found.fullAccessUntil = patch.fullAccessUntil;
      if (patch.botIds !== undefined) found.botIds = [...patch.botIds];
      return { ...found, capabilities: { ...found.capabilities } };
    },
    async revoke(id: string) {
      const found = rows.get(id);
      if (!found || found.revoked) return false;
      found.revoked = true;
      found.paused = true;
      found.fullAccessUntil = null;
      return true;
    },
    async remove(id: string) {
      rows.delete(id);
    },
    async forOwner(ownerUserId: string) {
      return [...rows.values()]
        .filter(
          (d) =>
            d.ownerUserId === ownerUserId &&
            !d.revoked &&
            d.platform !== "android" &&
            d.platform !== "ios" &&
            !isBrowserExtensionPlatform(d.platform),
        )
        .map((d) => ({ ...d, capabilities: { ...d.capabilities } }));
    },
    async extensionsForOwner(ownerUserId: string) {
      return [...rows.values()]
        .filter(
          (d) =>
            d.ownerUserId === ownerUserId &&
            !d.revoked &&
            isBrowserExtensionPlatform(d.platform),
        )
        .map((d) => ({ ...d, capabilities: { ...d.capabilities } }));
    },
    async forBot() {
      return [];
    },
    async everConfigured() {
      return false;
    },
    async adoptAskDefaults() {
      return [];
    },
    async seedRoots() {
      return false;
    },
    async audit(input: {
      deviceId: string;
      ownerUserId: string;
      actorType: string;
      actorId: string | null;
      actorName: string | null;
      action: string;
      summary: string | null;
      outcome: string;
      detail: string | null;
      durationMs: number | null;
    }) {
      const id = `audit_${audits.length + 1}`;
      audits.push({
        id,
        ...input,
        at: new Date().toISOString(),
      });
      return id;
    },
    async finishAudit(
      id: string,
      result: {
        outcome: string;
        detail?: string | null;
        durationMs?: number | null;
      },
    ) {
      const target = audits.find((a) => a.id === id);
      if (!target) return;
      target.outcome = result.outcome;
      if (result.detail !== undefined) target.detail = result.detail;
      if (result.durationMs !== undefined)
        target.durationMs = result.durationMs;
    },
    async auditLog(deviceId: string) {
      return audits.filter((a) => a.deviceId === deviceId).reverse() as never;
    },
  };

  return {
    store: store as unknown as DeviceStore,
    rows,
    audits,
  };
}

function createFakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  let closedCode: number | undefined;
  let closedReason: string | undefined;
  return {
    sent,
    get closedCode() {
      return closedCode;
    },
    get closedReason() {
      return closedReason;
    },
    socket: {
      send(data: string) {
        sent.push(JSON.parse(data) as Record<string, unknown>);
      },
      close(code?: number, reason?: string) {
        closedCode = code;
        closedReason = reason;
      },
    },
  };
}

function makeHarness(options?: {
  confirm?: DeviceConfirmLink;
  saveScreenshot?: (
    ownerUserId: string,
    botId: string,
    id: string,
    frame: { base64: string; url?: string },
  ) => Promise<{ ok: boolean; shown?: boolean; url?: string | null }>;
  extensionZipPath?: string;
  companionBridge?: CompanionRouteBridge;
}) {
  const mem = createMemoryDeviceStore();
  const hub = createDeviceHub({
    store: mem.store,
    ...(options?.confirm ? { confirm: options.confirm } : {}),
  });
  const companion = createBrowserCompanionService({
    store: mem.store,
    hub,
    ...(options?.saveScreenshot
      ? { saveScreenshot: options.saveScreenshot }
      : {}),
  });
  hub.setCompanionHooks({
    getState: (id) => companion.getStateReport(id),
    onStateReport: (rec, report) => {
      companion.applyStateReport(rec, report);
    },
    onDisconnect: (id) => companion.onDisconnect(id),
    onKillSwitch: (id) => companion.onKillSwitch(id),
    onRevoke: (id) => companion.onRevoke(id),
  });

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const uid = context.req.header("x-test-user");
    if (!uid) return context.json({ error: "请先登录。" }, 401);
    context.set("actor", {
      id: uid,
      role: uid === "admin" ? "admin" : "user",
      name: `用户-${uid}`,
      email: `${uid}@example.com`,
    });
    await next();
  };

  const pairing = createPairingStore();
  const routes = createDeviceRoutes({
    store: mem.store,
    hub,
    requireUser,
    pairing,
    companion,
    ...(options?.companionBridge
      ? { companionBridge: options.companionBridge }
      : {}),
    ...(options?.extensionZipPath
      ? { extensionZipPath: options.extensionZipPath }
      : {}),
  });
  const app = new Hono();
  app.route("/api/devices", routes);

  return { mem, hub, companion, pairing, app };
}

describe("browser companion: enrollment, pairing, WS isolation, kill-switch & revoke", () => {
  test("enrolls browser_extension with isolated browser-only capabilities and pairs via kind=extension", async () => {
    const { app, mem } = makeHarness();

    // 1. 直接 /enroll 登记 browser_extension
    const enrollRes = await app.request("/api/devices/enroll", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-user": "u1",
      },
      body: JSON.stringify({
        name: "办公 Chrome",
        platform: BROWSER_EXTENSION_PLATFORM,
        clientVersion: "0.1.0",
      }),
    });
    expect(enrollRes.status).toBe(201);
    const enrolled = (await enrollRes.json()) as {
      device: {
        id: string;
        platform: string;
        capabilities: Record<string, string>;
      };
      token: string;
    };
    expect(enrolled.device.platform).toBe(BROWSER_EXTENSION_PLATFORM);
    expect(enrolled.device.capabilities.shell).toBe("off");
    expect(enrolled.device.capabilities.files_read).toBe("off");
    expect(enrolled.device.capabilities.files_write).toBe("off");
    expect(enrolled.device.capabilities.clipboard).toBe("off");
    expect(enrolled.device.capabilities.input).toBe("allow");
    expect(enrolled.token.startsWith("cbd_")).toBe(true);

    // 2. 一次性配对码 kind = "extension"
    const pairIssueRes = await app.request("/api/devices/pairing", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-user": "u1",
      },
      body: JSON.stringify({ kind: "extension" }),
    });
    expect(pairIssueRes.status).toBe(201);
    const issued = (await pairIssueRes.json()) as {
      code: string;
      kind: string;
      pairingId: string;
    };
    expect(issued.kind).toBe("extension");
    expect(issued.code.startsWith("cbp_")).toBe(true);

    const redeemRes = await app.request("/api/devices/agent/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: issued.code,
        name: "家用 Edge 扩展",
        browser: "Edge 131",
        clientVersion: "0.1.0",
      }),
    });
    expect(redeemRes.status).toBe(201);
    const redeemed = (await redeemRes.json()) as {
      device: { id: string; platform: string; name: string };
      token: string;
    };
    expect(redeemed.device.platform).toBe(BROWSER_EXTENSION_PLATFORM);
    expect(redeemed.device.name).toBe("家用 Edge 扩展");
    expect(redeemed.token.startsWith("cbd_")).toBe(true);

    // 重放配对码被拒绝 (410)
    const replayRes = await app.request("/api/devices/agent/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code }),
    });
    expect(replayRes.status).toBe(410);

    // PC forOwner() 严格隔离 browser_extension；extensionsForOwner() 只返回扩展
    expect(await mem.store.forOwner("u1")).toEqual([]);
    const exts = await mem.store.extensionsForOwner("u1");
    expect(exts.length).toBe(2);
  });

  test("never exposes PC shell tools for browser_extension and blocks cross-platform operations", async () => {
    const { mem, hub, app } = makeHarness();
    const { device: ext } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "Chrome 扩展",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const { device: pc } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "Windows 台式机",
      platform: "win32",
    });

    const extSock = createFakeSocket();
    const pcSock = createFakeSocket();
    const extHandlers = hub.attach(ext, extSock.socket, "127.0.0.1");
    hub.attach(pc, pcSock.socket, "127.0.0.1");

    // 即使有人硬把 browser_extension 传进 deviceTools，也不会产出 device_run_shell 等系统工具
    const toolsForExtOnly = deviceTools({
      store: mem.store,
      hub,
      botId: "bot1",
      actorId: "u1",
      devices: [ext],
    });
    expect(toolsForExtOnly).toEqual([]);

    // hello 里伪造 platform="win32" 不得覆盖 browser_extension 身份
    await extHandlers.onMessage(
      JSON.stringify({
        type: "hello",
        platform: "win32",
        clientVersion: "0.1.0",
        features: [...BROWSER_COMPANION_OPERATIONS],
        suggestedRoots: ["C:\\Windows"],
      }),
    );
    const refreshedExt = await mem.store.get(ext.id);
    expect(refreshedExt?.platform).toBe(BROWSER_EXTENSION_PLATFORM);
    expect(refreshedExt?.allowedRoots).toEqual([]);

    // 尝试对 browser_extension 执行 shell → 硬拒绝并写审计
    await expect(
      hub.invoke({
        device: refreshedExt ?? ext,
        operation: "shell",
        args: { command: "whoami" },
        bot: { id: "bot1", name: "助手" },
        summary: "尝试在扩展跑 shell",
      }),
    ).rejects.toThrow("浏览器伴侣扩展仅支持浏览器操作");

    // 尝试对 PC 节点执行 browser_click → 硬拒绝
    await expect(
      hub.invoke({
        device: pc,
        operation: "browser_click",
        args: { ref: "e1", snapshotId: 1 },
        bot: { id: "bot1", name: "助手" },
        summary: "尝试在 PC 节点跑扩展点击",
      }),
    ).rejects.toThrow("不是浏览器伴侣扩展");

    // PATCH /:id 禁止对 browser_extension 开启 PC fullAccess
    const fullRes = await app.request(`/api/devices/${ext.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-test-user": "u1",
      },
      body: JSON.stringify({ fullAccess: "1h" }),
    });
    expect(fullRes.status).toBe(400);
  });

  test("emergency stop and revoke immediately cancel in-flight calls, clear snapshots, and disconnect WS", async () => {
    const { mem, hub, companion, app } = makeHarness();
    const { device: ext, token } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "Chrome 扩展",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const sock = createFakeSocket();
    const handlers = hub.attach(ext, sock.socket, "127.0.0.1");

    // 上报 companion_state 并检查 DeviceView.companionState
    await handlers.onMessage(
      JSON.stringify({
        type: "companion_state",
        state: "controlling",
        tier: "cautious",
        allowRemoteDispatch: true,
        attached: true,
        attachedTabId: 42,
        activeTabId: 42,
        activeTabUrl: "https://example.com/dashboard",
        activeTabTitle: "Dashboard",
        tabGroupId: 9,
        tabCount: 2,
        currentStepLabel: "查看监控图表",
      }),
    );
    const viewOnline = hub.view(ext);
    expect(viewOnline.online).toBe(true);
    expect(viewOnline.companionState?.activeTabId).toBe(42);
    expect(viewOnline.companionState?.tabGroupId).toBe(9);
    expect(viewOnline.companionState?.tabCount).toBe(2);
    expect(viewOnline.companionState?.currentStepLabel).toBe("查看监控图表");

    // 缓存一份快照
    companion.snapshots.saveSnapshot({
      ownerUserId: "u1",
      deviceId: ext.id,
      snapshotId: 1,
      tabId: 42,
      url: "https://example.com/dashboard",
      title: "Dashboard",
      elements: [{ ref: "e1", role: "button", name: "刷新" }],
    });

    // 发起一个挂起的调用，然后触发紧急停止
    const pendingCall = companion.executeAction({
      ownerUserId: "u1",
      deviceId: ext.id,
      botId: "bot1",
      botName: "助手",
      operation: "browser_read",
      args: {},
    });
    await tick();

    const pauseRes = await app.request(`/api/devices/${ext.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-test-user": "u1",
      },
      body: JSON.stringify({ paused: true }),
    });
    expect(pauseRes.status).toBe(200);
    await expect(pendingCall).rejects.toThrow("紧急停止");
    expect(
      sock.sent.some(
        (m) => m.type === "companion_command" && m.command === "kill_switch",
      ),
    ).toBe(true);
    // 紧急停止后快照已被清空
    expect(companion.snapshots.resolveElement("u1", ext.id, 1, "e1").ok).toBe(
      false,
    );

    // 撤销设备：立即关闭 WS (4401) 并作废令牌
    const revokeRes = await app.request(`/api/devices/${ext.id}/revoke`, {
      method: "POST",
      headers: { "x-test-user": "u1" },
    });
    expect(revokeRes.status).toBe(200);
    expect(sock.closedCode).toBe(4401);
    expect(hub.isOnline(ext.id)).toBe(false);

    const selfAfterRevoke = await app.request("/api/devices/agent/self", {
      headers: { "x-device-token": token },
    });
    expect(selfAfterRevoke.status).toBe(401);
    const revokedJson = (await selfAfterRevoke.json()) as { revoked?: boolean };
    expect(revokedJson.revoked).toBe(true);
  });
});

describe("browser companion: dual-mode routing", () => {
  test("prioritizes attached sidepanel extension, honors allowRemoteDispatch, and falls back to cloud", async () => {
    const { mem, hub, companion } = makeHarness();
    const { device: ext } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "我的 Chrome",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const sock = createFakeSocket();
    hub.attach(ext, sock.socket, "127.0.0.1");

    // 1. 侧栏附着优先路由到扩展，并生成 browser_* + 双模 computer_* 浏览器工具
    const sidepanelRoute = await companion.resolveRoute({
      ownerUserId: "u1",
      attachedExtensionDeviceId: ext.id,
      attached: true,
      attachedTab: {
        tabId: 11,
        url: "https://console.example.com/metrics",
        title: "实例监控",
      },
      userPromptText: "帮我看看页面",
    });
    expect(sidepanelRoute.mode).toBe("extension");
    if (sidepanelRoute.mode === "extension") {
      expect(sidepanelRoute.reason).toBe("attached_sidepanel");
      expect(sidepanelRoute.device.id).toBe(ext.id);
      const tools = companion.toolsForRoute({
        route: sidepanelRoute,
        actorId: "u1",
        botId: "bot1",
        botName: "助手",
      });
      const names = tools.map((t) => t.name);
      expect(names).toContain("browser_snapshot");
      expect(names).toContain("browser_click");
      expect(names).toContain("computer_click");
      expect(names).toContain("computer_screenshot");
      expect(names).not.toContain("device_run_shell");
    }

    // 2. 侧栏关闭附着 → 回退云端
    const detachedRoute = await companion.resolveRoute({
      ownerUserId: "u1",
      attachedExtensionDeviceId: ext.id,
      attached: false,
      userPromptText: "查一下天气",
    });
    expect(detachedRoute.mode).toBe("cloud");
    if (detachedRoute.mode === "cloud") {
      expect(detachedRoute.reason).toBe("extension_detached");
    }

    // 3. 手机/网页端普通对话未点名本机 Chrome → 走云端
    const normalWeb = await companion.resolveRoute({
      ownerUserId: "u1",
      userPromptText: "帮我查一下今天的新闻",
    });
    expect(normalWeb.mode).toBe("cloud");
    if (normalWeb.mode === "cloud") {
      expect(normalWeb.reason).toBe("not_requested_local_chrome");
    }

    // 4. 手机/网页端点名本机 Chrome，但 allowRemoteDispatch 默认关闭 → 拦截并回退云端
    expect(
      detectLocalChromeIntent("帮我看看我本机 Chrome 里打开的后台页面"),
    ).toBe(true);
    const blockedRemote = await companion.resolveRoute({
      ownerUserId: "u1",
      userPromptText: "帮我看看我本机 Chrome 里打开的后台页面",
    });
    expect(blockedRemote.mode).toBe("cloud");
    if (blockedRemote.mode === "cloud") {
      expect(blockedRemote.reason).toBe("remote_dispatch_disabled");
    }

    // 5. 开启 allowRemoteDispatch → 跨端调度成功路由到本机 Chrome 扩展
    companion.updateConfig(ext, { allowRemoteDispatch: true });
    const allowedRemote = await companion.resolveRoute({
      ownerUserId: "u1",
      userPromptText: "去我本机 Chrome 看看刚才的标签页",
    });
    expect(allowedRemote.mode).toBe("extension");
    if (allowedRemote.mode === "extension") {
      expect(allowedRemote.reason).toBe("remote_dispatch_requested");
      expect(allowedRemote.device.id).toBe(ext.id);
    }

    // 6. 跨用户 attachedExtensionDeviceId 绝不能命中其他人的扩展
    const crossUser = await companion.resolveRoute({
      ownerUserId: "u2",
      attachedExtensionDeviceId: ext.id,
    });
    expect(crossUser.mode).toBe("cloud");

    // 7. 扩展离线 → 自动回退云端
    hub.kick(ext.id);
    const offlineRoute = await companion.resolveRoute({
      ownerUserId: "u1",
      userPromptText: "用我的 Chrome 浏览器打开一下",
    });
    expect(offlineRoute.mode).toBe("cloud");
    if (offlineRoute.mode === "cloud") {
      expect(offlineRoute.reason).toBe("no_extension_online");
    }

    // 8. extractBrowserCompanionProps 兼容扁平与嵌套格式
    expect(
      extractBrowserCompanionProps({
        attachedExtensionDeviceId: "dev_abc",
        attachedTab: { tabId: 7, url: "https://a.com", title: "A" },
      }),
    ).toEqual({
      attachedExtensionDeviceId: "dev_abc",
      attachedTab: { tabId: 7, url: "https://a.com", title: "A" },
    });
  });
});

describe("browser companion: anti-tamper ref resolution, risk gate, confirmation card, blocklist & screenshots", () => {
  test("ignores forged model labels/_approved, enforces payment lock even in full tier & auto confirm prefs, and injects _approved only after real approval", async () => {
    const openedCards: Array<Record<string, unknown>> = [];
    const confirm: DeviceConfirmLink = {
      linkable: () => true,
      // 模拟通用审批偏好为 "full" —— 浏览器风险评估裁决的 ask 严禁被它绕过！
      before: async () => "full",
      opened: async (card) => {
        openedCards.push(card as unknown as Record<string, unknown>);
      },
      closed: async () => {},
    };
    const { mem, hub, companion } = makeHarness({ confirm });
    const { device: ext } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "Chrome 扩展",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const sock = createFakeSocket();
    const handlers = hub.attach(ext, sock.socket, "127.0.0.1");

    // 即使切到 full 档位，付款按钮（含 Ant Design 空格中文「付 款」）依然必须弹确认卡！
    companion.updateConfig(ext, { tier: "full", attached: true });

    // 先抓一份真实快照（含密码框与真实付款按钮）
    const snapPromise = companion.executeAction({
      ownerUserId: "u1",
      deviceId: ext.id,
      botId: "bot1",
      botName: "购物助手",
      operation: "browser_snapshot",
      args: {},
    });
    await tick();
    const snapCall = sock.sent.find(
      (m) => m.type === "call" && m.operation === "browser_snapshot",
    ) as { id: string };
    await handlers.onMessage(
      JSON.stringify({
        type: "result",
        id: snapCall.id,
        ok: true,
        result: {
          snapshotId: 5,
          tabId: 101,
          url: "https://shop.example.com/checkout",
          title: "结算页",
          elements: [
            {
              ref: "e1",
              role: "button",
              name: "付 款",
              backendDOMNodeId: 9001,
            },
            {
              ref: "e2",
              role: "textbox",
              name: "登录密码",
              type: "password",
              value: "super-secret-password",
            },
          ],
          truncated: false,
        },
      }),
    );
    const snapResult = await snapPromise;
    // 密码框明文必须被抹除，且不向模型暴露内部 backendDOMNodeId
    const returnedElements = snapResult.elements as Array<
      Record<string, unknown>
    >;
    expect(returnedElements[1]?.value).toBeUndefined();
    expect(returnedElements[0]?.backendDOMNodeId).toBeUndefined();

    // 模型试图伪造无害标签 + 伪造 _approved: true 来绕过付款确认
    const payPromise = companion.executeAction({
      ownerUserId: "u1",
      deviceId: ext.id,
      botId: "bot1",
      botName: "购物助手",
      operation: "browser_click",
      args: {
        ref: "e1",
        snapshotId: 5,
        elementName: "Next Page",
        elementRole: "link",
        _approved: true,
      },
    });
    await tick();

    // 必须拦截在审批阶段，尚未向扩展发 browser_click 的 call
    expect(
      sock.sent.some(
        (m) => m.type === "call" && m.operation === "browser_click",
      ),
    ).toBe(false);
    const pendingApprovals = hub.listApprovals("u1");
    expect(pendingApprovals.length).toBe(1);
    expect(pendingApprovals[0]?.summary).toContain("付 款");
    expect(openedCards.length).toBe(1);

    // 用户批准后，服务端才放行并在出站 call.args 注入 _approved: true（同时已剥离伪造标签）
    expect(hub.decide(pendingApprovals[0]?.id ?? "", true, "device")).toBe(
      true,
    );
    await tick();
    const clickCall = sock.sent.find(
      (m) => m.type === "call" && m.operation === "browser_click",
    ) as { id: string; args: Record<string, unknown> };
    expect(clickCall).toBeDefined();
    expect(clickCall.args._approved).toBe(true);
    expect(clickCall.args.elementName).toBeUndefined();
    expect(clickCall.args.backendDOMNodeId).toBe(9001);

    await handlers.onMessage(
      JSON.stringify({
        type: "result",
        id: clickCall.id,
        ok: true,
        result: { clicked: true, url: "https://shop.example.com/paid" },
      }),
    );
    const clickRes = await payPromise;
    expect(clickRes.ok).toBe(true);
    expect(
      mem.audits.some(
        (a) => a.action === "browser_click" && a.outcome === "succeeded",
      ),
    ).toBe(true);
  });

  test("rejects stale snapshot refs, enforces cautious high-risk approval, and hard-denies builtin/custom blocked domains", async () => {
    const { mem, hub, companion } = makeHarness();
    const { device: ext } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "Chrome 扩展",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const sock = createFakeSocket();
    hub.attach(ext, sock.socket, "127.0.0.1");

    // 1. 过期/不存在的 snapshotId 直接拒绝并写审计
    await expect(
      companion.executeAction({
        ownerUserId: "u1",
        deviceId: ext.id,
        botId: "bot1",
        botName: "助手",
        operation: "browser_click",
        args: { ref: "e99", snapshotId: 999 },
      }),
    ).rejects.toThrow(STALE_BROWSER_SNAPSHOT_ERROR);
    expect(mem.audits.at(-1)?.outcome).toBe("refused");

    // 2. 内置黑名单 + 绕过编码变体 + 自定义黑名单在 full 档位下同样硬拒绝
    companion.updateConfig(ext, {
      tier: "full",
      blockedDomains: ["bank.internal.example"],
    });
    for (const badUrl of [
      "chrome://settings",
      "https://vault.1password.com/signin",
      "https://microsoftedge.microsoft.com/%61ddons/detail/%ZZ",
      "https://sub.bank.internal.example/transfer",
    ]) {
      await expect(
        companion.executeAction({
          ownerUserId: "u1",
          deviceId: ext.id,
          botId: "bot1",
          botName: "助手",
          operation: "browser_navigate",
          args: { url: badUrl },
        }),
      ).rejects.toThrow(DeviceRefusedError);
    }
    // 绝没有向扩展下发任何一次 browser_navigate
    expect(
      sock.sent.some(
        (m) => m.type === "call" && m.operation === "browser_navigate",
      ),
    ).toBe(false);

    // 3. cautious 档位点击高危按钮（删除实例）弹确认卡；用户拒绝后不执行并记录 denied 审计
    companion.updateConfig(ext, { tier: "cautious" });
    companion.snapshots.saveSnapshot({
      ownerUserId: "u1",
      deviceId: ext.id,
      snapshotId: 10,
      tabId: 3,
      url: "https://cloud.example.com/instances",
      title: "云服务器",
      elements: [{ ref: "e3", role: "button", name: "删 除" }],
    });
    const deletePromise = companion.executeAction({
      ownerUserId: "u1",
      deviceId: ext.id,
      botId: "bot1",
      botName: "运维助手",
      operation: "browser_click",
      args: { ref: "e3", snapshotId: 10 },
    });
    await tick();
    const [approval] = hub.listApprovals("u1");
    expect(approval).toBeDefined();
    hub.decide(approval?.id ?? "", false, "web");
    await expect(deletePromise).rejects.toThrow("拒绝");
    expect(mem.audits.at(-1)?.outcome).toBe("denied");
  });

  test("persists browser_screenshot frames to chat-shots, emits tool images, and strips raw base64", async () => {
    const savedShots: Array<{
      ownerUserId: string;
      botId: string;
      id: string;
      url?: string;
    }> = [];
    const { mem, hub, companion } = makeHarness({
      saveScreenshot: async (ownerUserId, botId, id, frame) => {
        savedShots.push({ ownerUserId, botId, id, url: frame.url });
        // 模拟真实 chatShots.saveScreenshot 在落库后回传视觉帧
        return { ok: true, shown: true, url: frame.url ?? null };
      },
    });
    const { device: ext } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "Chrome 扩展",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const sock = createFakeSocket();
    const handlers = hub.attach(ext, sock.socket, "127.0.0.1");

    const shotPromise = companion.executeAction({
      ownerUserId: "u1",
      deviceId: ext.id,
      botId: "bot1",
      botName: "助手",
      operation: "browser_screenshot",
      args: {},
      toolCallId: "call_shot_1",
    });
    await tick();
    const call = sock.sent.find(
      (m) => m.type === "call" && m.operation === "browser_screenshot",
    ) as { id: string };
    await handlers.onMessage(
      JSON.stringify({
        type: "result",
        id: call.id,
        ok: true,
        result: {
          base64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2d8AAAAASUVORK5CYII=",
          mimeType: "image/png",
          url: "https://example.com/charts",
          title: "图表页",
          tabId: 8,
        },
      }),
    );
    const out = await shotPromise;
    expect(out.ok).toBe(true);
    expect(out.source).toBe("extension");
    expect(out.base64).toBeUndefined();
    expect(out.shotId).toBe("call_shot_1");
    expect(out.shotUrl).toBe("/api/chat-shots/call_shot_1");
    expect(out.companionShotUrl).toBe(
      "/api/devices/agent/companion/shots/call_shot_1",
    );
    expect(savedShots).toEqual([
      {
        ownerUserId: "u1",
        botId: "bot1",
        id: "call_shot_1",
        url: "https://example.com/charts",
      },
    ]);

    // 当未提供 saveScreenshot 时，也会自动通过 emitToolImage 回传视觉帧
    const noDbHarness = makeHarness();
    const { device: ext2 } = await noDbHarness.mem.store.enroll({
      ownerUserId: "u1",
      name: "Chrome 2",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const sock2 = createFakeSocket();
    const h2 = noDbHarness.hub.attach(ext2, sock2.socket, "127.0.0.1");
    const collected = await withToolImageCollector(
      { supportsImages: true },
      async () => {
        const p = noDbHarness.companion.executeAction({
          ownerUserId: "u1",
          deviceId: ext2.id,
          botId: "bot1",
          botName: "助手",
          operation: "browser_read",
          args: {},
          toolCallId: "call_step_2",
        });
        await tick();
        const c = sock2.sent.find(
          (m) => m.type === "call" && m.operation === "browser_read",
        ) as { id: string };
        await h2.onMessage(
          JSON.stringify({
            type: "result",
            id: c.id,
            ok: true,
            result: {
              text: "hello",
              screenshotBase64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2d8AAAAASUVORK5CYII=",
              url: "https://example.com/a",
              title: "A",
            },
          }),
        );
        const res = await p;
        expect(res.screenshotBase64).toBeUndefined();
        expect(res.shotId).toBe("call_step_2");
        return JSON.stringify(res);
      },
    );
    expect(collected.images?.length).toBe(1);
    expect(collected.images?.[0]?.mediaType).toBe("image/png");
  });
});

describe("browser companion: /api/devices/agent/companion/* auth, isolation & /extension/{meta,download}", () => {
  test("enforces device token auth, browser_extension platform guard, cross-user approval/shot isolation, and settings sync", async () => {
    const ownedShots = new Map<
      string,
      { mime: string; data: Uint8Array; url: string | null }
    >([
      [
        "u1:shot_1",
        {
          mime: "image/jpeg",
          data: new Uint8Array([1, 2, 3]),
          url: "https://a.com",
        },
      ],
    ]);
    const confirmedIds: string[] = [];

    const bridge: CompanionRouteBridge = {
      async bootstrap(device): Promise<CompanionBootstrapResponse> {
        return {
          user: { id: device.ownerUserId, name: "测试用户", role: "user" },
          device: {
            id: device.id,
            name: device.name,
            platform: device.platform,
            paused: device.paused,
            revoked: device.revoked,
          },
          bots: [{ id: "bot1", name: "主助手" }],
          defaultBotId: "bot1",
          appearance: { theme: "sky", colorMode: "system", material: "glass" },
        };
      },
      async openThread(device, input) {
        if (
          input.threadId === "other-user-thread" &&
          device.ownerUserId !== "u1"
        ) {
          return { ok: false, status: 404, error: "找不到这段对话。" };
        }
        return {
          ok: true,
          data: {
            channelId: "ch_1",
            threadId: input.threadId ?? "th_1",
            botId: input.botId ?? "bot1",
            botName: "主助手",
            running: false,
            messages: [],
          },
        };
      },
      async send(_device, input) {
        return {
          ok: true,
          status: 202,
          body: {
            accepted: true,
            commandId: "cmd_1",
            runId: "run_1",
            threadId: input.threadId ?? "th_1",
            attachedTab: input.attachedTab ?? null,
          },
        };
      },
      async events(_device, input) {
        return {
          ok: true,
          response: new Response(`data: {"threadId":"${input.threadId}"}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
        };
      },
      async stop() {
        return { ok: true, stopped: true };
      },
      async decideConfirmation(ownerUserId, requestId, decision) {
        if (ownerUserId === "u1" && requestId === "confirm_u1") {
          confirmedIds.push(`${requestId}:${decision}`);
          return true;
        }
        return false;
      },
      async readShot(ownerUserId, shotId) {
        return ownedShots.get(`${ownerUserId}:${shotId}`) ?? null;
      },
    };

    const { mem, hub, companion, app } = makeHarness({
      companionBridge: bridge,
    });
    const { device: extU1, token: extU1Token } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "U1 Chrome",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const { token: extU2Token } = await mem.store.enroll({
      ownerUserId: "u2",
      name: "U2 Chrome",
      platform: BROWSER_EXTENSION_PLATFORM,
    });
    const { token: pcToken } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "U1 PC",
      platform: "win32",
    });

    const sockU1 = createFakeSocket();
    hub.attach(extU1, sockU1.socket, "127.0.0.1");

    // 1. 无令牌 → 401
    expect(
      (await app.request("/api/devices/agent/companion/bootstrap")).status,
    ).toBe(401);

    // 2. PC 节点令牌调扩展侧栏接口 → 403
    expect(
      (
        await app.request("/api/devices/agent/companion/bootstrap", {
          headers: { "x-device-token": pcToken },
        })
      ).status,
    ).toBe(403);

    // 3. 合法扩展令牌调 bootstrap / open-thread / send / events / stop
    const bootRes = await app.request(
      "/api/devices/agent/companion/bootstrap",
      {
        headers: { "x-device-token": extU1Token },
      },
    );
    expect(bootRes.status).toBe(200);
    const boot = (await bootRes.json()) as CompanionBootstrapResponse;
    expect(boot.user.id).toBe("u1");
    expect(boot.defaultBotId).toBe("bot1");

    const openRes = await app.request(
      "/api/devices/agent/companion/open-thread",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-token": extU1Token,
        },
        body: JSON.stringify({ botId: "bot1" }),
      },
    );
    expect(openRes.status).toBe(200);

    const sendRes = await app.request("/api/devices/agent/companion/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-token": extU1Token,
      },
      body: JSON.stringify({
        botId: "bot1",
        text: "帮我看下这页报错",
        attachedTab: {
          tabId: 9,
          url: "https://example.com/err",
          title: "错误详情",
        },
      }),
    });
    expect(sendRes.status).toBe(202);

    const eventsRes = await app.request("/api/devices/agent/companion/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-token": extU1Token,
      },
      body: JSON.stringify({ threadId: "th_1" }),
    });
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.headers.get("content-type")).toContain(
      "text/event-stream",
    );

    const stopRes = await app.request("/api/devices/agent/companion/stop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-token": extU1Token,
      },
      body: JSON.stringify({ threadId: "th_1" }),
    });
    expect(stopRes.status).toBe(200);

    // 4. PATCH /settings 校验 + 同步给服务端与 WS 扩展
    const badSettings = await app.request(
      "/api/devices/agent/companion/settings",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-device-token": extU1Token,
        },
        body: JSON.stringify({ tier: "godmode" }),
      },
    );
    expect(badSettings.status).toBe(400);

    const okSettings = await app.request(
      "/api/devices/agent/companion/settings",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-device-token": extU1Token,
        },
        body: JSON.stringify({
          tier: "observe",
          blockedDomains: ["bank.example.com"],
          allowRemoteDispatch: true,
        }),
      },
    );
    expect(okSettings.status).toBe(200);
    expect(companion.getConfig(extU1.id).tier).toBe("observe");
    expect(companion.getConfig(extU1.id).allowRemoteDispatch).toBe(true);
    expect(
      sockU1.sent.some(
        (m) => m.type === "companion_command" && m.command === "sync_config",
      ),
    ).toBe(true);

    // 5. 审批越权隔离：u2 的扩展不能批准 u1 的审批或确认卡
    companion.snapshots.saveSnapshot({
      ownerUserId: "u1",
      deviceId: extU1.id,
      snapshotId: 1,
      tabId: 9,
      url: "https://example.com",
      title: "Page",
      elements: [{ ref: "e1", role: "button", name: "确认" }],
    });
    const pendingOp = companion.executeAction({
      ownerUserId: "u1",
      deviceId: extU1.id,
      botId: "bot1",
      botName: "助手",
      operation: "browser_click",
      args: { ref: "e1", snapshotId: 1 },
    });
    await tick();
    const [u1Approval] = hub.listApprovals("u1");
    expect(u1Approval).toBeDefined();

    const crossApproveRes = await app.request(
      `/api/devices/agent/companion/approvals/${u1Approval?.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-token": extU2Token,
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(crossApproveRes.status).toBe(404);

    // 本人拒绝成功
    const selfDenyRes = await app.request(
      `/api/devices/agent/companion/approvals/${u1Approval?.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-token": extU1Token,
        },
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    expect(selfDenyRes.status).toBe(200);
    await expect(pendingOp).rejects.toThrow("拒绝");

    // 通用确认卡回退与隔离
    expect(
      (
        await app.request("/api/devices/agent/companion/approvals/confirm_u1", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-token": extU2Token,
          },
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/api/devices/agent/companion/approvals/confirm_u1", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-token": extU1Token,
          },
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    ).toBe(200);
    expect(confirmedIds).toEqual(["confirm_u1:approve"]);

    // 6. 截图接口按 ownerUserId 隔离
    expect(
      (
        await app.request("/api/devices/agent/companion/shots/shot_1", {
          headers: { "x-device-token": extU2Token },
        })
      ).status,
    ).toBe(404);
    const shotRes = await app.request(
      "/api/devices/agent/companion/shots/shot_1",
      {
        headers: { "x-device-token": extU1Token },
      },
    );
    expect(shotRes.status).toBe(200);
    expect(new Uint8Array(await shotRes.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    // 7. query ?token= 仅限 /agent/ws 握手鉴权，常规 HTTP 接口仍严禁 query 令牌
    expect(
      (
        await app.request(
          `/api/devices/agent/companion/bootstrap?token=${encodeURIComponent(extU1Token)}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          `/api/devices/agent/self?token=${encodeURIComponent(extU1Token)}`,
        )
      ).status,
    ).toBe(401);
    const { token: phoneToken } = await mem.store.enroll({
      ownerUserId: "u1",
      name: "U1 Phone",
      platform: "android",
    });
    expect(
      (
        await app.request(
          `/api/devices/agent/ws?token=${encodeURIComponent(phoneToken)}`,
        )
      ).status,
    ).toBe(403);
    // POST /:id/test 对扩展设备走 browser_tabs(list) 而不是 system_info
    const testPromise = app.request(`/api/devices/${extU1.id}/test`, {
      method: "POST",
      headers: { "x-test-user": "u1" },
    });
    await tick();
    const tabsCall = sockU1.sent.find(
      (m) => m.type === "call" && m.operation === "browser_tabs",
    ) as { id: string; args: Record<string, unknown> };
    expect(tabsCall).toBeDefined();
    expect(tabsCall.args.action).toBe("list");
    // 结束挂起的 test 调用避免未完成 promise 泄漏
    hub.cancelAllFor(extU1.id, "done");
    expect((await testPromise).status).toBe(409);
  });

  test("serves /api/devices/extension/meta and /download with sha256 & cleans temp fixtures", async () => {
    // 1. 缺失安装包时 meta 返回 available:false，download 返回 404
    const missingHarness = makeHarness({
      extensionZipPath: join(tmpdir(), `chisabot-missing-${randomUUID()}.zip`),
    });
    expect(
      (await missingHarness.app.request("/api/devices/extension/meta")).status,
    ).toBe(401);
    const missingMetaRes = await missingHarness.app.request(
      "/api/devices/extension/meta",
      { headers: { "x-test-user": "u1" } },
    );
    expect(missingMetaRes.status).toBe(200);
    const missingMeta = (await missingMetaRes.json()) as {
      available: boolean;
      version: string | null;
      filename: string;
      bytes: number | null;
      sha256: string | null;
      downloadUrl: string;
    };
    expect(missingMeta).toEqual({
      available: false,
      version: null,
      filename: "chisabot-chrome-extension.zip",
      bytes: null,
      sha256: null,
      downloadUrl: "/api/devices/extension/download",
    });
    expect(
      (
        await missingHarness.app.request("/api/devices/extension/download", {
          headers: { "x-test-user": "u1" },
        })
      ).status,
    ).toBe(404);

    // 2. 存在打包好的 ZIP + manifest.json 时返回真实元数据并流式下载
    const tempRoot = await mkdtemp(join(tmpdir(), "chisabot-ext-test-"));
    try {
      const distDir = join(tempRoot, "dist");
      await mkdir(distDir, { recursive: true });
      const zipPayload = Buffer.from("PK\x03\x04fake-extension-zip-bytes-v1");
      const zipPath = join(distDir, "chisabot-chrome-extension.zip");
      await writeFile(zipPath, zipPayload);
      await writeFile(
        join(distDir, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "ChisaBot",
          version: "0.2.3",
        }),
      );

      const okHarness = makeHarness({ extensionZipPath: zipPath });
      const metaRes = await okHarness.app.request(
        "/api/devices/extension/meta",
        { headers: { "x-test-user": "u1" } },
      );
      expect(metaRes.status).toBe(200);
      const meta = (await metaRes.json()) as {
        available: boolean;
        version: string | null;
        filename: string;
        bytes: number | null;
        sha256: string | null;
        downloadUrl: string;
      };
      expect(meta).toEqual({
        available: true,
        version: "0.2.3",
        filename: "chisabot-chrome-extension.zip",
        bytes: zipPayload.byteLength,
        sha256: createHash("sha256").update(zipPayload).digest("hex"),
        downloadUrl: "/api/devices/extension/download",
      });

      const dlRes = await okHarness.app.request(
        "/api/devices/extension/download",
        { headers: { "x-test-user": "u1" } },
      );
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get("content-type")).toBe("application/zip");
      expect(dlRes.headers.get("content-disposition")).toContain(
        'filename="chisabot-chrome-extension.zip"',
      );
      expect(Buffer.from(await dlRes.arrayBuffer())).toEqual(zipPayload);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
