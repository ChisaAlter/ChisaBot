import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  FULL_ACCESS_DURATIONS,
  FULL_ACCESS_FOREVER,
  type FullAccessDuration,
  DEVICE_CAPABILITIES,
  type DeviceCapabilities,
} from "../../../shared/devices";
import { type AuditStore, recordAuditEvent } from "../audit";
import { localCallerAuthorized, trustUnsignedLocal } from "../auth/gateway-identity";
import type { AppVariables } from "../auth/guards";
import { upgradeWebSocket } from "../channels/socket";
import { DeviceRefusedError, type DeviceHub, describeChange } from "./hub";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { createPairingStore, isMobilePlatform, type PairingStore } from "./pairing";
import { type DevicePatch, type DeviceRecord, type DeviceStore, fullAccessActive } from "./store";
import { installScript, readNodeBundle } from "./node-install";

const NODE_PLATFORMS = new Set(["linux", "darwin", "win32", "freebsd", "openbsd", "sunos", "aix"]);

/**
 * /api/devices（docs/pc-node.md §6）。
 *
 * 两类调用方：
 *  - 已登录的人（网页 / 手机 / PC 客户端里的聊天窗口）：requireUser，管理自己的设备；管理员可看全部。
 *  - PC 节点本身：/agent/*，用登记时拿到的设备令牌（请求头 X-Device-Token）。公网网关对 /api/devices/agent/
 *    不做会话校验，所以这里的令牌校验就是这条路唯一的门，失败要限速。
 */

type Variables = AppVariables & { device: DeviceRecord };
type SyncTunnelSocket = { send: (data: Uint8Array) => void; close: (code?: number, reason?: string) => void };
type SyncTunnelHandlers = { onMessage: (data: unknown) => void; onClose: () => void };

const failures = new Map<string, { count: number; until: number }>();
const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 10 * 60_000;

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : null;
}

function limited(ip: string | null) {
  const entry = failures.get(ip ?? "?");
  return !!entry && entry.until > Date.now() && entry.count >= FAIL_LIMIT;
}

function fail(ip: string | null) {
  const key = ip ?? "?";
  const entry = failures.get(key);
  if (!entry || entry.until < Date.now())
    failures.set(key, { count: 1, until: Date.now() + FAIL_WINDOW_MS });
  else entry.count++;
  if (failures.size > 5000) failures.clear();
}

const pairAttempts = new Map<string, { count: number; until: number }>();
const PAIR_LIMIT = 30;

function pairLimited(ip: string | null) {
  const entry = pairAttempts.get(ip ?? "?");
  return !!entry && entry.until > Date.now() && entry.count >= PAIR_LIMIT;
}

function countPair(ip: string | null) {
  const key = ip ?? "?";
  const entry = pairAttempts.get(key);
  if (!entry || entry.until < Date.now()) pairAttempts.set(key, { count: 1, until: Date.now() + FAIL_WINDOW_MS });
  else entry.count++;
  if (pairAttempts.size > 5000) pairAttempts.clear();
}

function parsePatch(body: unknown): DevicePatch | string {
  if (!body || typeof body !== "object") return "请求格式无效。";
  const input = body as Record<string, unknown>;
  const patch: DevicePatch = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) return "名称不能为空。";
    patch.name = input.name;
  }
  if (input.capabilities !== undefined) {
    if (!input.capabilities || typeof input.capabilities !== "object") return "能力设置无效。";
    const caps: Partial<DeviceCapabilities> = {};
    for (const [key, value] of Object.entries(input.capabilities as Record<string, unknown>)) {
      if (!(DEVICE_CAPABILITIES as readonly string[]).includes(key)) return `未知能力：${key}`;
      if (value !== "off" && value !== "ask" && value !== "allow") return `能力 ${key} 的取值无效。`;
      caps[key as keyof DeviceCapabilities] = value;
    }
    patch.capabilities = caps;
  }
  if (input.allowedRoots !== undefined) {
    if (!Array.isArray(input.allowedRoots)) return "允许的文件夹必须是列表。";
    patch.allowedRoots = input.allowedRoots.map(String);
  }
  if (input.paused !== undefined) {
    if (typeof input.paused !== "boolean") return "紧急停止的取值无效。";
    patch.paused = input.paused;
  }
  if (input.botIds !== undefined) {
    if (!Array.isArray(input.botIds)) return "机器人列表无效。";
    patch.botIds = input.botIds.map(String);
  }
  // 完全访问（docs/pc-node.md §13）：只有这里能打开——设备主人在网页上，机器人没有任何工具能调到这里。
  if (input.fullAccess !== undefined) {
    if (input.fullAccess === "off") patch.fullAccessUntil = null;
    else if (typeof input.fullAccess === "string" && input.fullAccess in FULL_ACCESS_DURATIONS) {
      const ms = FULL_ACCESS_DURATIONS[input.fullAccess as FullAccessDuration];
      patch.fullAccessUntil = ms === null ? FULL_ACCESS_FOREVER : new Date(Date.now() + ms).toISOString();
    } else return "完全访问的时长无效（1h / 24h / permanent / off）。";
  }
  return patch;
}

export function createDeviceRoutes(options: {
  store: DeviceStore;
  hub: DeviceHub;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  auditStore?: AuditStore;
  /** 这个人跑某个机器人时会拿到的设备工具（与聊天里完全同一条路径，index.ts 的 deviceToolsFor）。 */
  toolsFor?: (actorId: string, botId: string) => Promise<GrantedTool[]>;
  /** 手机扫码绑定的一次性绑定码（默认放在本进程内存里）。 */
  pairing?: PairingStore;
  /** 网页构建目录：服务器节点程序 node-agent/chisabot-node.cjs 在里面。 */
  appDistDir?: string;
  /** 这台设备不许开完全访问时给出原因（云端工作区节点，docs/cloud-claude-code.md）。 */
  refuseFullAccess?: (device: DeviceRecord) => string | null;
  /** 电脑文件夹同步（server/src/cloud-cc/sync.ts）：/agent/sync/* 接口、/agent/sync-tunnel 隧道、撤销时收回。 */
  sync?: {
    mountAgent: (routes: { route: (path: string, sub: never) => unknown }, requireDevice: MiddlewareHandler) => void;
    attachPc: (device: DeviceRecord, ticket: string, socket: SyncTunnelSocket) => SyncTunnelHandlers | null;
    attachNode: (device: DeviceRecord, tunnelId: string, socket: SyncTunnelSocket) => SyncTunnelHandlers | null;
    onDeviceRevoked: (deviceId: string) => Promise<unknown>;
    closeDeviceTunnels: (deviceId: string) => number;
  } | null;
  /**
   * 配了网关密钥时：/agent/state 也要求 X-ChisaBot-Local-Caller（与 resolveGatewayRequest 同一把钥匙）。
   * 未配 = 保持旧行为（仅拦带 X-Forwarded-For 的公网探测）。
   */
  localCallerSecret?: string;
}) {
  const { store, hub, requireUser, auditStore, toolsFor } = options;
  const pairing = options.pairing ?? createPairingStore();
  const routes = new Hono<{ Variables: Variables }>();
  const userGuard = requireUser as unknown as MiddlewareHandler<{ Variables: Variables }>;

  async function mainAudit(actorUserId: string, deviceId: string, change: string, detail?: string) {
    if (!auditStore) return;
    try {
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "device",
        targetId: deviceId,
        actorUserId,
        payload: { change, ...(detail ? { detail: detail.slice(0, 400) } : {}) },
      });
    } catch {
      /* 设备自己的审计表才是这条记录的主存处。 */
    }
  }

  const requireDevice: MiddlewareHandler<{ Variables: Variables }> = async (context, next) => {
    const ip = clientIp(context.req.raw);
    if (limited(ip)) return context.json({ error: "失败次数过多，请稍后再试。" }, 429);
    const token = context.req.header("x-device-token")?.trim() ?? "";
    const device = token ? await store.authenticate(token) : null;
    if (device === "revoked") return context.json({ error: "这台设备已被撤销，请重新登录。", revoked: true }, 401);
    if (!device) {
      fail(ip);
      return context.json({ error: "设备令牌无效，请重新登录。" }, 401);
    }
    context.set("device", device);
    await next();
  };

  // ---- PC 节点 ----

  routes.get(
    "/agent/ws",
    requireDevice,
    async (context, next) => {
      // 扫码绑定的手机只用来登录聊天，不能作为机器人可操作的节点接入。
      if (isMobilePlatform(context.get("device").platform))
        return context.json({ error: "手机设备不能作为电脑节点连接。" }, 403);
      await next();
    },
    upgradeWebSocket((context) => {
      const device = context.get("device") as DeviceRecord;
      const ip = clientIp(context.req.raw);
      let handlers: ReturnType<DeviceHub["attach"]> | null = null;
      return {
        onOpen: (_event, ws) => {
          handlers = hub.attach(
            device,
            { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
            ip,
          );
        },
        onMessage: (event) => {
          if (typeof event.data === "string" && event.data.length < 24 * 1024 * 1024)
            void handlers?.onMessage(event.data).catch(() => {});
        },
        onClose: () => handlers?.onClose(),
        onError: () => handlers?.onClose(),
      };
    }),
  );

  // ---- 电脑文件夹同步（P4，docs/cloud-claude-code.md §5.4） ----
  const sync = options.sync ?? null;
  if (sync) {
    sync.mountAgent(routes as unknown as { route: (path: string, sub: never) => unknown }, requireDevice as unknown as MiddlewareHandler);
    // 电脑：?ticket=（一次性隧道票）；云端节点：?tunnel=（服务器刚让它开的那条）。两边都要设备令牌。
    routes.get(
      "/agent/sync-tunnel",
      requireDevice,
      upgradeWebSocket((context) => {
        const device = context.get("device") as DeviceRecord;
        const ticket = context.req.query("ticket") ?? "";
        const tunnel = context.req.query("tunnel") ?? "";
        let handlers: SyncTunnelHandlers | null = null;
        return {
          onOpen: (_event, ws) => {
            const socket: SyncTunnelSocket = {
              send: (data) => ws.send(data as unknown as ArrayBuffer),
              close: (code, reason) => ws.close(code, reason),
            };
            handlers = ticket ? sync.attachPc(device, ticket, socket) : tunnel ? sync.attachNode(device, tunnel, socket) : null;
            if (!handlers) ws.close(4403, "refused");
          },
          onMessage: (event) => handlers?.onMessage(event.data),
          onClose: () => handlers?.onClose(),
          onError: () => handlers?.onClose(),
        };
      }),
    );
  }

  routes.get("/agent/self", requireDevice, (context) =>
    context.json({ device: hub.view(context.get("device")) }),
  );

  /** PC 端「退出登录」：设备自己作废自己的令牌。 */
  routes.post("/agent/unenroll", requireDevice, async (context) => {
    const device = context.get("device");
    const mobile = isMobilePlatform(device.platform);
    await store.revoke(device.id);
    await options.sync?.onDeviceRevoked(device.id).catch(() => 0);
    await store.audit({
      deviceId: device.id,
      ownerUserId: device.ownerUserId,
      actorType: "device",
      actorId: device.id,
      actorName: mobile ? "手机客户端" : "PC 客户端",
      action: "unenrolled",
      summary: mobile ? "在手机上退出登录，令牌已作废" : "在 PC 上退出登录，令牌已作废",
      outcome: "succeeded",
      detail: null,
      durationMs: null,
    });
    hub.kick(device.id);
    return context.json({ ok: true });
  });

  // ---- 手机扫码绑定（DESIGN.md §33） ----

  /**
   * 手机扫码后调用（公开路径，网关不校验会话）：一次性绑定码 → 在签发人名下登记一台手机，返回设备令牌。
   * 绑定码 192 bit，失败按 IP 计数限速（与设备令牌同一个计数器）；另外每个 IP 每 10 分钟最多尝试 30 次。
   */
  routes.post("/agent/pair", async (context) => {
    const ip = clientIp(context.req.raw);
    if (limited(ip) || pairLimited(ip)) return context.json({ error: "尝试次数过多，请稍后再试。" }, 429);
    countPair(ip);
    const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return context.json({ error: "请求格式无效。" }, 400);
    const result = pairing.redeem(body.code);
    if (!result.ok) {
      fail(ip);
      const error =
        result.reason === "used"
          ? "这个二维码已经用过了，请在网页上刷新二维码后重新扫码。"
          : result.reason === "expired"
            ? "二维码已过期，请在网页上刷新二维码后重新扫码。"
            : "二维码无效，请扫描 ChisaBot 网页「设置 → 设备 → 绑定手机」里的二维码。";
      return context.json({ error, reason: result.reason }, result.reason === "invalid" ? 400 : 410);
    }
    if (result.kind === "node") {
      try {
        const platform = typeof body.platform === "string" && NODE_PLATFORMS.has(body.platform) ? body.platform : "linux";
        const { device, token } = await store.enroll({
          ownerUserId: result.ownerUserId,
          name: body.name ?? body.hostname ?? "我的服务器",
          platform,
          osVersion: body.osVersion,
          hostname: body.hostname,
          arch: body.arch,
          clientVersion: body.clientVersion,
          ip,
        });
        await store.touch(device.id, { ip });
        pairing.complete(result.pairingId, device);
        await store.audit({
          deviceId: device.id,
          ownerUserId: result.ownerUserId,
          actorType: "device",
          actorId: device.id,
          actorName: "服务器节点",
          action: "enrolled",
          summary: `安装命令登记服务器节点「${device.name}」（${platform}${body.hostname ? ` · ${String(body.hostname).slice(0, 80)}` : ""}）`,
          outcome: "succeeded",
          detail: null,
          durationMs: null,
        });
        await mainAudit(result.ownerUserId, device.id, "device_enrolled", device.name);
        const fresh = (await store.get(device.id)) ?? device;
        return context.json({ device: hub.view(fresh), token }, 201);
      } catch {
        pairing.fail(result.pairingId);
        return context.json({ error: "登记失败，请在网页上重新生成安装命令后重试。" }, 500);
      }
    }
    try {
      const model = typeof body.model === "string" ? body.model : null;
      const { device, token } = await store.enroll({
        ownerUserId: result.ownerUserId,
        name: body.name ?? model ?? "我的手机",
        platform: body.platform === "ios" ? "ios" : "android",
        osVersion: body.osVersion,
        hostname: model,
        arch: null,
        clientVersion: body.clientVersion,
        ip,
      });
      await store.touch(device.id, { ip });
      pairing.complete(result.pairingId, device);
      await store.audit({
        deviceId: device.id,
        ownerUserId: result.ownerUserId,
        actorType: "device",
        actorId: device.id,
        actorName: "手机客户端",
        action: "enrolled",
        summary: `扫码绑定手机「${device.name}」（${device.platform}${device.osVersion ? ` · ${device.osVersion}` : ""}）`,
        outcome: "succeeded",
        detail: null,
        durationMs: null,
      });
      await mainAudit(result.ownerUserId, device.id, "device_enrolled", device.name);
      const fresh = (await store.get(device.id)) ?? device;
      return context.json({ device: hub.view(fresh), token }, 201);
    } catch {
      pairing.fail(result.pairingId);
      return context.json({ error: "绑定失败，请在网页上刷新二维码后重试。" }, 500);
    }
  });

  /**
   * 登录网关用手机的设备令牌换会话时调用（deploy/public/auth/server.ts 的 /auth/device-session）。
   * 只接受手机设备；顺便记一次「最后在线」。
   */
  routes.post("/agent/session", requireDevice, async (context) => {
    const device = context.get("device");
    if (!isMobilePlatform(device.platform)) return context.json({ error: "只有手机设备可以这样登录。" }, 403);
    const facts = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
    await store.touch(device.id, {
      ip: clientIp(context.req.raw) ?? device.lastIp,
      clientVersion: facts?.clientVersion,
      osVersion: facts?.osVersion,
    });
    return context.json({ device: { id: device.id, name: device.name, ownerUserId: device.ownerUserId } });
  });

  /**
   * 网关定期（约 30 秒）问一次：这台手机还有效吗？撤销后网关立刻作废它的会话，手机回到登录页。
   * 只回答直连本服务的请求：经过公网 Nginx 的请求都带 X-Forwarded-For，一律 404。
   * 配了 localCallerSecret 时还要带 X-ChisaBot-Local-Caller（CR-P1-02 / CR-P2-01）：共享 Docker
   * 网络上的兄弟容器不能靠「没有代理头」枚举设备。
   */
  routes.get("/agent/state/:id", async (context) => {
    if (context.req.header("x-forwarded-for") || context.req.header("x-real-ip"))
      return context.json({ error: "页面不存在。" }, 404);
    const secret = options.localCallerSecret;
    if (secret && !localCallerAuthorized(secret, context.req.raw.headers) && !trustUnsignedLocal())
      return context.json({ error: "页面不存在。" }, 404);
    const device = await store.get(context.req.param("id"));
    const active = !!device && !device.revoked && isMobilePlatform(device.platform);
    if (active && device) await store.touch(device.id);
    return context.json({ active });
  });

  // ---- 服务器节点 chisabot-node（docs/pc-node.md §14）：公开的安装脚本和节点程序（不含密钥，配对靠一次性安装码） ----

  routes.get("/agent/node/install.sh", (context) => {
    const proto = context.req.header("x-forwarded-proto") ?? new URL(context.req.url).protocol.replace(":", "");
    const host = context.req.header("x-forwarded-host") ?? context.req.header("host") ?? new URL(context.req.url).host;
    return context.body(installScript(`${proto}://${host}`), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  routes.get("/agent/node/chisabot-node.cjs", async (context) => {
    const bundle = await readNodeBundle(options.appDistDir);
    if (!bundle) return context.json({ error: "这个部署没有打包服务器节点程序（node-agent/chisabot-node.cjs）。" }, 404);
    return context.body(new Uint8Array(bundle), 200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  // ---- 已登录的人 ----

  async function owned(context: { var: Variables }, id: string): Promise<DeviceRecord | null> {
    const device = await store.get(id);
    if (!device) return null;
    const actor = context.var.actor;
    // 多账号（CB-040）：设备只归它的主人管，管理员也不能操作朋友的电脑 / 手机。
    if (device.ownerUserId !== actor.id) return null;
    return device;
  }

  routes.get("/", userGuard, async (context) => {
    const actor = context.var.actor;
    const all = context.req.query("all") === "1" && actor.role === "admin";
    const list = await store.list(all ? null : actor.id);
    return context.json({
      devices: list.map((device) => hub.view(device)),
      approvals: hub.listApprovals(actor.id),
    });
  });

  /** PC 客户端登录后调用：用当前会话登记这台电脑，返回一次性明文令牌。 */
  routes.post("/enroll", userGuard, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return context.json({ error: "请求格式无效。" }, 400);
    const actor = context.var.actor;
    const { device, token } = await store.enroll({
      ownerUserId: actor.id,
      name: body.name,
      platform: body.platform,
      osVersion: body.osVersion,
      hostname: body.hostname,
      arch: body.arch,
      clientVersion: body.clientVersion,
      ip: clientIp(context.req.raw),
    });
    await store.audit({
      deviceId: device.id,
      ownerUserId: actor.id,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name ?? actor.email ?? null,
      action: "enrolled",
      summary: `登记设备「${device.name}」（${device.platform}${device.hostname ? ` · ${device.hostname}` : ""}）`,
      outcome: "succeeded",
      detail: null,
      durationMs: null,
    });
    await mainAudit(actor.id, device.id, "device_enrolled", device.name);
    return context.json({ device: hub.view(device), token }, 201);
  });

  /** 网页「绑定手机」：签发一次性绑定码（5 分钟），网页把它和服务器地址一起画成二维码。 */
  routes.post("/pairing", userGuard, async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => null)) as { kind?: unknown } | null;
    const kind = body?.kind === "node" ? "node" : "phone";
    const issued = pairing.issue(actor.id, kind);
    return context.json({ ...issued, kind }, 201);
  });

  routes.get("/pairing/:pairingId", userGuard, (context) => {
    const status = pairing.status(context.req.param("pairingId"), context.var.actor.id);
    if (!status) return context.json({ error: "这个二维码不存在或已过期。" }, 404);
    return context.json(status);
  });

  routes.delete("/pairing/:pairingId", userGuard, (context) => {
    pairing.cancel(context.req.param("pairingId"), context.var.actor.id);
    return context.json({ ok: true });
  });

  routes.get("/approvals", userGuard, (context) => {
    const actor = context.var.actor;
    return context.json({ approvals: hub.listApprovals(actor.id) });
  });

  routes.post("/approvals/:approvalId", userGuard, async (context) => {
    const id = context.req.param("approvalId");
    const actor = context.var.actor;
    const owner = hub.approvalOwner(id);
    if (!owner || owner !== actor.id)
      return context.json({ error: "这个审批已经处理过或已过期。" }, 404);
    const body = (await context.req.json().catch(() => null)) as { decision?: unknown } | null;
    const decision = body?.decision;
    if (decision !== "approve" && decision !== "deny")
      return context.json({ error: "decision 必须是 approve 或 deny。" }, 400);
    const done = hub.decide(id, decision === "approve", "web");
    if (!done) return context.json({ error: "这个审批已经处理过或已过期。" }, 404);
    return context.json({ ok: true });
  });

  /**
   * 无对话自检（docs/pc-node.md §7）：某个机器人此刻会拿到哪些设备工具、看到哪些设备。只读，不写任何会话。
   * POST 版（仅管理员）再用这个机器人的 device_system_info 读一次系统信息，走与聊天完全相同的工具、
   * 能力、审批与审计（审计里记为这个机器人），用来验证「设备由所有机器人共用」。
   */
  routes.get("/bot-tools/:botId", userGuard, async (context) => {
    if (!toolsFor) return context.json({ error: "不可用。" }, 404);
    const actor = context.var.actor;
    const botId = context.req.param("botId");
    const tools = await toolsFor(actor.id, botId);
    const list = tools.find((tool) => tool.name === "device_list");
    const devices = list ? JSON.parse(String(await list.execute({}))).devices : [];
    // guidance = 这次运行里机器人会读到的「用户的电脑」提示词（在线 / 离线 / 开了哪些能力）。
    return context.json({ botId, tools: tools.map((tool) => tool.name), devices, guidance: list?.guidance ?? null });
  });

  routes.post("/bot-tools/:botId/probe", userGuard, async (context) => {
    if (!toolsFor) return context.json({ error: "不可用。" }, 404);
    const actor = context.var.actor;
    if (actor.role !== "admin") return context.json({ error: "只有管理员可以运行自检。" }, 403);
    const body = (await context.req.json().catch(() => null)) as {
      deviceId?: unknown;
      tool?: unknown;
      args?: unknown;
    } | null;
    const tools = await toolsFor(actor.id, context.req.param("botId"));
    // 默认跑 device_system_info；管理员也可以点名别的 device_* 工具（走同一条能力 / 审批 / 审计路径，
    // 「询问」会真的弹审批），用来不发聊天就验证整条链路（2026-10-14）。
    const toolName = typeof body?.tool === "string" && body.tool.startsWith("device_") ? body.tool : "device_system_info";
    const info = tools.find((tool) => tool.name === toolName);
    if (!info)
      return context.json(
        { ok: false, error: `这个机器人现在没有 ${toolName}（没有在线设备，或这项能力在所有在线设备上都关闭）。`, tools: tools.map((tool) => tool.name) },
        409,
      );
    const args =
      body?.args && typeof body.args === "object" && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    const result = String(
      await info.execute({ ...args, ...(typeof body?.deviceId === "string" ? { deviceId: body.deviceId } : {}) }),
    );
    const failed = result.startsWith(REFUSAL_MARKER) || result.startsWith("设备操作失败");
    return context.json({ ok: !failed, result }, failed ? 409 : 200);
  });

  routes.get("/:id", userGuard, async (context) => {
    const device = await owned(context, context.req.param("id"));
    if (!device) return context.json({ error: "没有这台设备。" }, 404);
    return context.json({ device: hub.view(device) });
  });

  routes.patch("/:id", userGuard, async (context) => {
    const before = await owned(context, context.req.param("id"));
    if (!before) return context.json({ error: "没有这台设备。" }, 404);
    if (before.revoked) return context.json({ error: "这台设备已被撤销，不能再修改。" }, 409);
    const patch = parsePatch(await context.req.json().catch(() => null));
    if (typeof patch === "string") return context.json({ error: patch }, 400);
    const actor = context.var.actor;
    if (patch.fullAccessUntil) {
      if (before.ownerUserId !== actor.id) return context.json({ error: "完全访问只能由设备的主人自己打开。" }, 403);
      if (isMobilePlatform(before.platform)) return context.json({ error: "手机不是可操作的设备。" }, 400);
      const refused = options.refuseFullAccess?.(before);
      if (refused) return context.json({ error: refused }, 400);
      if (before.paused && patch.paused !== false) return context.json({ error: "这台设备在紧急停止中，先解除紧急停止。" }, 409);
    }
    const after = await store.update(before.id, patch);
    if (!after) return context.json({ error: "没有这台设备。" }, 404);
    const fullBefore = fullAccessActive(before);
    const fullAfter = fullAccessActive(after);
    const fullChange =
      patch.fullAccessUntil !== undefined || fullBefore !== fullAfter
        ? fullAfter
          ? `完全访问：开（${after.fullAccessUntil === FULL_ACCESS_FOREVER ? "永久，直到手动关闭" : `到 ${after.fullAccessUntil}`}）`
          : fullBefore
            ? "完全访问：关"
            : null
        : null;
    const change = [describeChange(before, after), fullChange].filter((part) => part && part !== "无变化").join("；") || "无变化";
    const pausedChanged = before.paused !== after.paused;
    await store.audit({
      deviceId: after.id,
      ownerUserId: after.ownerUserId,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name ?? actor.email ?? null,
      action: pausedChanged
        ? after.paused
          ? "kill_switch_on"
          : "kill_switch_off"
        : fullChange
          ? fullAfter
            ? "full_access_on"
            : "full_access_off"
          : "config_changed",
      summary: change,
      outcome: "succeeded",
      detail: "网页",
      durationMs: null,
    });
    await mainAudit(actor.id, after.id, "device_updated", change);
    if (after.paused) hub.cancelAllFor(after.id, "已在网页上紧急停止。");
    if (after.paused) options.sync?.closeDeviceTunnels(after.id);
    await hub.pushConfig(after.id);
    return context.json({ device: hub.view(after) });
  });

  routes.post("/:id/revoke", userGuard, async (context) => {
    const device = await owned(context, context.req.param("id"));
    if (!device) return context.json({ error: "没有这台设备。" }, 404);
    const actor = context.var.actor;
    await store.revoke(device.id);
    await options.sync?.onDeviceRevoked(device.id).catch(() => 0);
    await store.audit({
      deviceId: device.id,
      ownerUserId: device.ownerUserId,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name ?? actor.email ?? null,
      action: "revoked",
      summary: "撤销设备令牌",
      outcome: "succeeded",
      detail: "网页",
      durationMs: null,
    });
    await mainAudit(actor.id, device.id, "device_revoked", device.name);
    hub.kick(device.id);
    const after = await store.get(device.id);
    return context.json({ device: after ? hub.view(after) : null });
  });

  routes.delete("/:id", userGuard, async (context) => {
    const device = await owned(context, context.req.param("id"));
    if (!device) return context.json({ error: "没有这台设备。" }, 404);
    hub.kick(device.id);
    await options.sync?.onDeviceRevoked(device.id).catch(() => 0);
    await store.remove(device.id);
    await mainAudit(context.var.actor.id, device.id, "device_deleted", device.name);
    return context.json({ ok: true });
  });

  /**
   * 设备页「正在运行」：节点上的后台命令（实时问设备）+ 最近的文件改动（审计记录里 edit_file / apply_patch / write_file）。
   */
  routes.get("/:id/activity", userGuard, async (context) => {
    const device = await owned(context, context.req.param("id"));
    if (!device) return context.json({ error: "没有这台设备。" }, 404);
    const log = await store.auditLog(device.id, { limit: 200 });
    const edits = log
      .filter((entry) => ["edit_file", "apply_patch", "write_file", "file_upload"].includes(entry.action) && entry.outcome === "succeeded")
      .slice(0, 20);
    let live: unknown = null;
    let liveError: string | null = null;
    if (hub.isOnline(device.id) && hub.supports(device.id, "activity")) {
      try {
        live = await hub.direct(device, "activity", {}, 10_000);
      } catch (error) {
        liveError = error instanceof Error ? error.message : String(error);
      }
    } else liveError = hub.isOnline(device.id) ? "客户端版本太旧，看不到运行中的命令（需要 0.1.8+）。" : "设备离线。";
    return context.json({ live, liveError, edits });
  });

  /** 设备主人在设备页上结束一个后台命令。 */
  routes.post("/:id/jobs/:jobId/kill", userGuard, async (context) => {
    const device = await owned(context, context.req.param("id"));
    if (!device) return context.json({ error: "没有这台设备。" }, 404);
    const actor = context.var.actor;
    const jobId = context.req.param("jobId");
    try {
      const result = await hub.direct(device, "exec_kill", { jobId }, 15_000);
      await store.audit({
        deviceId: device.id,
        ownerUserId: device.ownerUserId,
        actorType: "user",
        actorId: actor.id,
        actorName: actor.name ?? actor.email ?? null,
        action: "exec_kill",
        summary: `在网页上结束后台命令 ${jobId}`,
        outcome: "succeeded",
        detail: null,
        durationMs: null,
      });
      return context.json({ ok: true, job: result });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  routes.get("/:id/audit", userGuard, async (context) => {
    const device = await owned(context, context.req.param("id"));
    if (!device) return context.json({ error: "没有这台设备。" }, 404);
    const limit = Number(context.req.query("limit") ?? 50);
    const entries = await store.auditLog(device.id, {
      limit: Number.isFinite(limit) ? limit : 50,
      before: context.req.query("before") ?? undefined,
    });
    return context.json({ entries });
  });

  /** 从网页对设备做一次无害的连通性测试（读取系统信息），同样走审计。 */
  routes.post("/:id/test", userGuard, async (context) => {
    const device = await owned(context, context.req.param("id"));
    if (!device) return context.json({ error: "没有这台设备。" }, 404);
    const actor = context.var.actor;
    try {
      const result = await hub.invoke({
        device,
        operation: "system_info",
        args: {},
        bot: { id: actor.id, name: "网页连通性测试" },
        actorType: "user",
        summary: "网页上点击「测试连接」",
        timeoutMs: 15_000,
      });
      return context.json({ ok: true, result });
    } catch (error) {
      return context.json(
        { ok: false, error: error instanceof DeviceRefusedError ? error.message : "测试失败。" },
        error instanceof DeviceRefusedError ? 409 : 500,
      );
    }
  });

  routes.get("/:id/screenshots/:shotId", userGuard, async (context) => {
    const device = await owned(context, context.req.param("id"));
    if (!device) return context.json({ error: "没有这台设备。" }, 404);
    const png = hub.screenshot(device.id, context.req.param("shotId"));
    if (!png) return context.json({ error: "截图已过期（只保留 30 分钟）。" }, 404);
    return new Response(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=1800" },
    });
  });

  return routes;
}
