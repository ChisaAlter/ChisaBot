import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";

/** 前台心跳有效期：超过 60 秒未续期即视为不在前台。 */
export const FOREGROUND_HEARTBEAT_TTL_MS = 60_000;

/** 单用户最多追踪的活跃客户端/标签页条目数，防止恶意或异常 deviceId 撑爆内存。 */
const MAX_DEVICES_PER_USER = 32;

const FOREGROUND_BODY_LIMIT_BYTES = 16 * 1024;

export type ForegroundPresence = {
  deviceId: string;
  channelId: string | null;
  active: boolean;
  updatedAt: number;
};

export type ForegroundRegistryOptions = {
  /** 心跳有效期，默认 60_000ms。 */
  ttlMs?: number;
  /** 可选时钟注入，供测试稳定推进时间。 */
  now?: () => number;
  /**
   * 外部活连接查询（例如 `channelEvents.connectionCount(userId) > 0`），
   * 当连接尚未携带独立 `deviceId` 时作为用户级活连接兜底。
   */
  hasUserLiveConnection?: (userId: string) => boolean;
};

const heartbeatBodySchema = z.strictObject({
  deviceId: z.string().trim().min(1).max(128),
  channelId: z.string().trim().min(1).max(200).nullable(),
  active: z.boolean(),
});

/**
 * 精确前台抑制注册表：按 `(userId, deviceId)` 记录最近心跳（60s TTL）、当前活跃 `channelId`
 * 与 SSE/WS 活连接状态。
 *
 * 与单一全局 `viewedAgentId` 不同：用户在频道 A 前台活跃时，只抑制频道 A，
 * 绝不吞掉频道 B 或其他 Bot 的回复通知。
 */
export function createForegroundRegistry(
  options: ForegroundRegistryOptions = {},
) {
  const ttlMs = options.ttlMs ?? FOREGROUND_HEARTBEAT_TTL_MS;
  const clock = options.now ?? (() => Date.now());

  const presenceByUser = new Map<string, Map<string, ForegroundPresence>>();
  /** 按 `(userId, deviceId)` 精确记录该设备/标签页的活连接计数。 */
  const deviceConnections = new Map<string, Map<string, number>>();
  /** 按 `userId` 记录未绑定具体 deviceId 的匿名活连接计数。 */
  const anonymousConnections = new Map<string, number>();

  function pruneUser(
    userId: string,
    now: number,
  ): Map<string, ForegroundPresence> | undefined {
    const devices = presenceByUser.get(userId);
    if (!devices) return undefined;
    for (const [deviceId, entry] of devices) {
      if (now - entry.updatedAt >= ttlMs) {
        devices.delete(deviceId);
      }
    }
    if (devices.size === 0) {
      presenceByUser.delete(userId);
      return undefined;
    }
    return devices;
  }

  function hasLiveConnectionForDevice(
    userId: string,
    deviceId: string,
  ): boolean {
    const userDevices = deviceConnections.get(userId);
    if (userDevices && userDevices.size > 0) {
      if ((userDevices.get(deviceId) ?? 0) > 0) return true;
      // 如果该用户已有其他按 deviceId 追踪的连接，但当前 deviceId 没有活连接，
      // 仅当同时存在匿名连接（如尚未携带 deviceId 的旧客户端）时才放行兜底。
      if ((anonymousConnections.get(userId) ?? 0) > 0) return true;
      return false;
    }
    if ((anonymousConnections.get(userId) ?? 0) > 0) return true;
    return options.hasUserLiveConnection?.(userId) ?? false;
  }

  function heartbeat(input: {
    userId: string;
    deviceId: string;
    channelId: string | null;
    active: boolean;
    now?: number;
  }): ForegroundPresence {
    const timestamp = input.now ?? clock();
    let devices = pruneUser(input.userId, timestamp);
    if (!devices) {
      devices = new Map<string, ForegroundPresence>();
      presenceByUser.set(input.userId, devices);
    }

    // 超过单用户上限时淘汰最旧的一条
    if (!devices.has(input.deviceId) && devices.size >= MAX_DEVICES_PER_USER) {
      let oldestId: string | null = null;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [candidateId, candidate] of devices) {
        if (candidate.updatedAt < oldestTime) {
          oldestTime = candidate.updatedAt;
          oldestId = candidateId;
        }
      }
      if (oldestId !== null) {
        devices.delete(oldestId);
      }
    }

    const entry: ForegroundPresence = {
      deviceId: input.deviceId,
      channelId: input.active ? input.channelId : null,
      active: input.active,
      updatedAt: timestamp,
    };
    devices.set(input.deviceId, entry);
    return entry;
  }

  function clearDevice(userId: string, deviceId: string): void {
    const devices = presenceByUser.get(userId);
    if (!devices) return;
    devices.delete(deviceId);
    if (devices.size === 0) presenceByUser.delete(userId);
  }

  /**
   * 绑定一条 SSE/WS 活连接；连接关闭时调用返回的释放函数。
   * 传 `deviceId` 时按设备精确记账；未传时计入该用户的用户级活连接计数。
   */
  function trackConnection(userId: string, deviceId?: string): () => void {
    const cleanDevice = deviceId?.trim();
    let released = false;

    if (cleanDevice) {
      let map = deviceConnections.get(userId);
      if (!map) {
        map = new Map<string, number>();
        deviceConnections.set(userId, map);
      }
      map.set(cleanDevice, (map.get(cleanDevice) ?? 0) + 1);
      return () => {
        if (released) return;
        released = true;
        const current = deviceConnections.get(userId);
        if (!current) return;
        const nextCount = (current.get(cleanDevice) ?? 0) - 1;
        if (nextCount <= 0) current.delete(cleanDevice);
        else current.set(cleanDevice, nextCount);
        if (current.size === 0) deviceConnections.delete(userId);
      };
    }

    anonymousConnections.set(
      userId,
      (anonymousConnections.get(userId) ?? 0) + 1,
    );
    return () => {
      if (released) return;
      released = true;
      const nextCount = (anonymousConnections.get(userId) ?? 0) - 1;
      if (nextCount <= 0) anonymousConnections.delete(userId);
      else anonymousConnections.set(userId, nextCount);
    };
  }

  /**
   * 双保险判定：用户存在活 SSE/WS 连接 + 心跳未过期（< 60s）+ 正在前台查看该精确 `channelId`。
   */
  function isChannelForeground(
    userId: string,
    channelId: string,
    now = clock(),
  ): boolean {
    if (!userId || !channelId) return false;
    const devices = pruneUser(userId, now);
    if (!devices) return false;

    for (const entry of devices.values()) {
      if (!entry.active) continue;
      if (entry.channelId !== channelId) continue;
      if (now - entry.updatedAt >= ttlMs) continue;
      if (hasLiveConnectionForDevice(userId, entry.deviceId)) {
        return true;
      }
    }
    return false;
  }

  function getActiveChannels(userId: string, now = clock()): string[] {
    const devices = pruneUser(userId, now);
    if (!devices) return [];
    const channels = new Set<string>();
    for (const entry of devices.values()) {
      if (
        entry.active &&
        entry.channelId &&
        now - entry.updatedAt < ttlMs &&
        hasLiveConnectionForDevice(userId, entry.deviceId)
      ) {
        channels.add(entry.channelId);
      }
    }
    return [...channels];
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);

    app.get("/", (context) => {
      const userId = context.var.actor.id;
      const now = clock();
      return context.json({
        activeChannels: getActiveChannels(userId, now),
        ttlMs,
      });
    });

    app.post(
      "/",
      bodyLimit({ maxSize: FOREGROUND_BODY_LIMIT_BYTES }),
      async (context) => {
        const parsed = heartbeatBodySchema.safeParse(
          await context.req.json().catch(() => undefined),
        );
        if (!parsed.success) {
          return context.json(
            {
              error:
                "请提供合法的 deviceId、channelId（或 null）和 active 状态。",
            },
            400,
          );
        }
        const presence = heartbeat({
          userId: context.var.actor.id,
          deviceId: parsed.data.deviceId,
          channelId: parsed.data.channelId,
          active: parsed.data.active,
        });
        return context.json({
          presence,
          ttlMs,
        });
      },
    );

    app.delete("/:deviceId", (context) => {
      const deviceId = context.req.param("deviceId").trim();
      if (!deviceId || deviceId.length > 128) {
        return context.json({ error: "deviceId 无效。" }, 400);
      }
      clearDevice(context.var.actor.id, deviceId);
      return context.body(null, 204);
    });

    return app;
  }

  return {
    heartbeat,
    clearDevice,
    trackConnection,
    isChannelForeground,
    getActiveChannels,
    routes,
  };
}

export type ForegroundRegistry = ReturnType<typeof createForegroundRegistry>;
