import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, notInArray } from "drizzle-orm";
import {
  type DeviceAuditEntry,
  type DeviceCapabilities,
  type DeviceView,
  defaultCapabilities,
  initialCapabilities,
  isFactoryOff,
  isMobilePlatform,
  MOBILE_PLATFORMS,
  normalizeCapabilities,
} from "../../../shared/devices";

/** 有人（网页 / 手机 / PC 本机）改过这台电脑配置时写的审计动作。系统自动迁移不算。 */
export const USER_CONFIG_ACTIONS = [
  "config_changed",
  "kill_switch_on",
  "kill_switch_off",
] as const;

import { redactText } from "../computer/activity-redact";
import type { Database } from "../db/client";
import { deviceAuditEvents, deviceBotAccess, devices } from "../db/schema";

/**
 * 设备登记表（docs/pc-node.md §4）。令牌形如 `cbd_<43 位 base64url>`，只存 SHA-256；
 * 明文只在登记时返回一次。
 */

export const DEVICE_TOKEN_PREFIX = "cbd_";
const MAX_ROOTS = 20;
const MAX_NAME = 64;

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

function sameHash(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function cleanName(value: unknown, fallback = "我的电脑"): string {
  const text =
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (text || fallback).slice(0, MAX_NAME);
}

export function cleanRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const root = item.trim();
    if (!root || root.length > 400 || root.includes("\0")) continue;
    // 只接受绝对路径：Windows 盘符 / UNC，或 POSIX 根。
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(root)) continue;
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
    if (roots.length >= MAX_ROOTS) break;
  }
  return roots;
}

function short(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type Row = typeof devices.$inferSelect;

export type DeviceRecord = Omit<
  DeviceView,
  "online" | "fullAccess" | "fullAccessRemainingMs" | "features"
> & {
  tokenHash: string;
};

type LastUse = DeviceView["lastUsedBy"];

function toRecord(
  row: Row,
  botIds: string[],
  lastUsedBy: LastUse = null,
  fullAccessUntil: string | null = null,
): DeviceRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    platform: row.platform,
    osVersion: row.osVersion,
    hostname: row.hostname,
    arch: row.arch,
    clientVersion: row.clientVersion,
    capabilities: normalizeCapabilities(row.capabilities),
    allowedRoots: cleanRoots(row.allowedRoots),
    paused: row.paused,
    revoked: row.revokedAt !== null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    lastIp: row.lastIp,
    createdAt: row.createdAt.toISOString(),
    botIds,
    lastUsedBy,
    fullAccessUntil: row.revokedAt ? null : fullAccessUntil,
    tokenHash: row.tokenHash,
  };
}

/** 完全访问现在是否生效（未到期）。 */
export function fullAccessActive(
  record: Pick<DeviceRecord, "paused" | "revoked"> & {
    fullAccessUntil?: string | null | undefined;
  },
  now = Date.now(),
): boolean {
  if (!record.fullAccessUntil || record.paused || record.revoked) return false;
  const until = Date.parse(record.fullAccessUntil);
  return Number.isFinite(until) && until > now;
}

export type DevicePatch = {
  name?: string;
  capabilities?: Partial<DeviceCapabilities>;
  allowedRoots?: string[];
  paused?: boolean;
  botIds?: string[];
  /** 完全访问到期时间（ISO）；null = 关闭。只有用户在网页上能打开（routes.ts），PC 本机只能关闭。 */
  fullAccessUntil?: string | null;
};

export type AuditInput = Omit<DeviceAuditEntry, "id" | "at"> & {
  ownerUserId: string;
};

export function createDeviceStore(database: Database) {
  async function botIdsFor(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    const rows = await database
      .select()
      .from(deviceBotAccess)
      .where(inArray(deviceBotAccess.deviceId, ids));
    for (const row of rows) {
      const list = map.get(row.deviceId) ?? [];
      list.push(row.botId);
      map.set(row.deviceId, list);
    }
    return map;
  }

  /** 每台设备最近一次由机器人发起的操作（审计表上 (device_id, at) 有索引）。 */
  async function lastBotUseFor(
    ids: string[],
  ): Promise<Map<string, NonNullable<LastUse>>> {
    const map = new Map<string, NonNullable<LastUse>>();
    if (!ids.length) return map;
    try {
      const rows = await database
        .selectDistinctOn([deviceAuditEvents.deviceId], {
          deviceId: deviceAuditEvents.deviceId,
          actorId: deviceAuditEvents.actorId,
          actorName: deviceAuditEvents.actorName,
          at: deviceAuditEvents.at,
        })
        .from(deviceAuditEvents)
        .where(
          and(
            inArray(deviceAuditEvents.deviceId, ids),
            eq(deviceAuditEvents.actorType, "bot"),
          ),
        )
        .orderBy(deviceAuditEvents.deviceId, desc(deviceAuditEvents.at));
      for (const row of rows)
        map.set(row.deviceId, {
          botId: row.actorId,
          botName: row.actorName,
          at: row.at.toISOString(),
        });
    } catch {
      /* 只是展示用的附加信息，读不到就不显示。 */
    }
    return map;
  }

  /**
   * 完全访问的到期时间放在 devices.full_access_until（开机时 ALTER TABLE … ADD COLUMN IF NOT EXISTS 建列，见 ensure）。
   * 不进 drizzle 表定义：可空新列，回滚到旧镜像时被忽略，不需要迁移。
   */
  async function fullAccessFor(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!ids.length || !fullAccessColumn) return map;
    try {
      const rows = (await database.$client.unsafe(
        // postgres.js 的 unsafe 不会把 JS 数组编码成 text[]（会变成 "a,b" → malformed array literal），所以用逗号拼接再拆。
        "SELECT id, full_access_until FROM devices WHERE id = ANY(string_to_array($1, ',')) AND full_access_until IS NOT NULL",
        [ids.join(",")],
      )) as unknown as { id: string; full_access_until: Date | string }[];
      for (const row of rows)
        map.set(row.id, new Date(row.full_access_until).toISOString());
    } catch {
      /* 列还没建好时当作都没开 */
    }
    return map;
  }

  let fullAccessColumn = false;

  async function setFullAccess(id: string, until: string | null) {
    if (!fullAccessColumn) await store.ensure();
    await database.$client.unsafe(
      "UPDATE devices SET full_access_until = $2 WHERE id = $1",
      [id, until ? new Date(until).toISOString() : null],
    );
  }

  async function hydrate(rows: Row[]): Promise<DeviceRecord[]> {
    const ids = rows.map((row) => row.id);
    const [bots, lastUse, full] = await Promise.all([
      botIdsFor(ids),
      lastBotUseFor(ids),
      fullAccessFor(ids),
    ]);
    return rows.map((row) =>
      toRecord(
        row,
        bots.get(row.id) ?? [],
        lastUse.get(row.id) ?? null,
        full.get(row.id) ?? null,
      ),
    );
  }

  async function get(id: string): Promise<DeviceRecord | null> {
    const [row] = await database
      .select()
      .from(devices)
      .where(eq(devices.id, id));
    if (!row) return null;
    return (await hydrate([row]))[0] ?? null;
  }

  const store = {
    get,

    /** 开机时调用一次：建完全访问列（幂等）。 */
    async ensure() {
      try {
        await database.$client.unsafe(
          "ALTER TABLE devices ADD COLUMN IF NOT EXISTS full_access_until timestamptz",
        );
        fullAccessColumn = true;
      } catch (error) {
        console.warn("devices.full_access_until column unavailable", error);
      }
    },

    async list(ownerUserId: string | null): Promise<DeviceRecord[]> {
      const rows = await database
        .select()
        .from(devices)
        .where(ownerUserId ? eq(devices.ownerUserId, ownerUserId) : undefined)
        .orderBy(desc(devices.createdAt));
      return hydrate(rows);
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
    }): Promise<{ device: DeviceRecord; token: string }> {
      const token = newDeviceToken();
      const id = `dev_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const hostname = short(input.hostname, 120);
      const platform = short(input.platform, 32) ?? "unknown";
      await database.insert(devices).values({
        id,
        ownerUserId: input.ownerUserId,
        name: cleanName(input.name, hostname ?? "我的电脑"),
        platform,
        osVersion: short(input.osVersion, 120),
        hostname,
        arch: short(input.arch, 32),
        clientVersion: short(input.clientVersion, 32),
        tokenHash: hashDeviceToken(token),
        // 电脑默认全部「询问」（每次审批）；手机不是节点，保持关闭。
        capabilities: (isMobilePlatform(platform)
          ? defaultCapabilities()
          : initialCapabilities()) as unknown as Record<string, unknown>,
        allowedRoots: [] as unknown as Record<string, unknown>,
        paused: false,
        lastIp: input.ip ?? null,
      });
      const device = await get(id);
      if (!device) throw new Error("设备登记失败。");
      return { device, token };
    },

    /** 用令牌找到未撤销的设备；不区分「不存在」和「已撤销」以外的原因。 */
    async authenticate(
      token: string,
    ): Promise<DeviceRecord | "revoked" | null> {
      if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 100)
        return null;
      const hash = hashDeviceToken(token);
      const [row] = await database
        .select()
        .from(devices)
        .where(eq(devices.tokenHash, hash));
      if (!row || !sameHash(row.tokenHash, hash)) return null;
      if (row.revokedAt) return "revoked";
      return (await hydrate([row]))[0] ?? null;
    },

    async touch(
      id: string,
      facts: {
        ip?: string | null;
        clientVersion?: unknown;
        platform?: unknown;
        osVersion?: unknown;
        hostname?: unknown;
        arch?: unknown;
      } = {},
    ) {
      const set: Partial<typeof devices.$inferInsert> = {
        lastSeenAt: new Date(),
      };
      if (facts.ip) set.lastIp = facts.ip;
      if (facts.clientVersion)
        set.clientVersion = short(facts.clientVersion, 32);
      if (facts.platform) set.platform = short(facts.platform, 32) ?? "unknown";
      if (facts.osVersion) set.osVersion = short(facts.osVersion, 120);
      if (facts.hostname) set.hostname = short(facts.hostname, 120);
      if (facts.arch) set.arch = short(facts.arch, 32);
      await database
        .update(devices)
        .set(set)
        .where(and(eq(devices.id, id), isNull(devices.revokedAt)));
    },

    async update(id: string, patch: DevicePatch): Promise<DeviceRecord | null> {
      const current = await get(id);
      if (!current || current.revoked) return null;
      const set: Partial<typeof devices.$inferInsert> = {};
      if (patch.name !== undefined)
        set.name = cleanName(patch.name, current.name);
      if (patch.capabilities)
        set.capabilities = normalizeCapabilities({
          ...current.capabilities,
          ...patch.capabilities,
        }) as unknown as Record<string, unknown>;
      if (patch.allowedRoots !== undefined)
        set.allowedRoots = cleanRoots(patch.allowedRoots) as unknown as Record<
          string,
          unknown
        >;
      if (patch.paused !== undefined) set.paused = patch.paused === true;
      if (Object.keys(set).length)
        await database.update(devices).set(set).where(eq(devices.id, id));
      // 紧急停止同时关掉完全访问（解除紧急停止不会自动恢复，要重新打开）。
      if (patch.paused === true && current.fullAccessUntil)
        await setFullAccess(id, null);
      else if (patch.fullAccessUntil !== undefined)
        await setFullAccess(id, patch.fullAccessUntil);
      if (patch.botIds !== undefined) {
        const botIds = [
          ...new Set(patch.botIds.filter((b) => typeof b === "string" && b)),
        ].slice(0, 100);
        await database
          .delete(deviceBotAccess)
          .where(eq(deviceBotAccess.deviceId, id));
        if (botIds.length)
          await database
            .insert(deviceBotAccess)
            .values(botIds.map((botId) => ({ deviceId: id, botId })));
      }
      return get(id);
    },

    async revoke(id: string): Promise<boolean> {
      const result = await database
        .update(devices)
        .set({ revokedAt: new Date(), paused: true })
        .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
        .returning({ id: devices.id });
      if (result.length) await setFullAccess(id, null).catch(() => {});
      return result.length > 0;
    },

    async remove(id: string) {
      await database.delete(devices).where(eq(devices.id, id));
      await database
        .delete(deviceAuditEvents)
        .where(eq(deviceAuditEvents.deviceId, id));
    },

    /**
     * 属于 owner 的全部未撤销设备。设备属于账号而不是某个机器人：用户的每个机器人都能使用它们
     * （能力开关、允许的文件夹、审批、紧急停止照常生效）。扫码绑定的手机只用来登录聊天，不算在内。
     */
    async forOwner(ownerUserId: string): Promise<DeviceRecord[]> {
      const rows = await database
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.ownerUserId, ownerUserId),
            isNull(devices.revokedAt),
            notInArray(devices.platform, [...MOBILE_PLATFORMS]),
          ),
        )
        .orderBy(desc(devices.createdAt));
      return hydrate(rows);
    },

    /** 旧版：某个机器人被单独勾选过的设备。已不用于授权，只留给迁移 / 旧测试。 */
    async forBot(ownerUserId: string, botId: string): Promise<DeviceRecord[]> {
      const rows = await database
        .select({ device: devices })
        .from(devices)
        .innerJoin(deviceBotAccess, eq(deviceBotAccess.deviceId, devices.id))
        .where(
          and(
            eq(devices.ownerUserId, ownerUserId),
            eq(deviceBotAccess.botId, botId),
            isNull(devices.revokedAt),
          ),
        );
      return hydrate(rows.map((row) => row.device));
    },

    /** 有没有人改过这台电脑的配置（能力 / 文件夹 / 名称 / 紧急停止）。 */
    async everConfigured(id: string): Promise<boolean> {
      const rows = await database
        .select({ id: deviceAuditEvents.id })
        .from(deviceAuditEvents)
        .where(
          and(
            eq(deviceAuditEvents.deviceId, id),
            inArray(deviceAuditEvents.action, [...USER_CONFIG_ACTIONS]),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /**
     * 一次性迁移（开机时跑，幂等）：旧版登记、能力仍是出厂「全部关闭」、而且从没被人改过配置的电脑，
     * 改成新的默认「全部询问」。用户自己关掉的（有 config_changed 记录）不动；手机、已撤销的不动。
     * 每台写一条审计「系统：默认权限改为每次询问」。返回改了的设备 id。
     */
    async adoptAskDefaults(): Promise<string[]> {
      const rows = await database
        .select()
        .from(devices)
        .where(
          and(
            isNull(devices.revokedAt),
            notInArray(devices.platform, [...MOBILE_PLATFORMS]),
          ),
        );
      const changed: string[] = [];
      for (const device of await hydrate(rows)) {
        if (!isFactoryOff(device.capabilities)) continue;
        if (await store.everConfigured(device.id)) continue;
        await database
          .update(devices)
          .set({
            capabilities: initialCapabilities() as unknown as Record<
              string,
              unknown
            >,
          })
          .where(eq(devices.id, device.id));
        await store.audit({
          deviceId: device.id,
          ownerUserId: device.ownerUserId,
          actorType: "system",
          actorId: null,
          actorName: "系统",
          action: "defaults_ask",
          summary:
            "默认权限改为「每次询问」：机器人可以申请使用这台电脑，每次操作都要你批准。不想要可在 权限 里改回「关闭」。",
          outcome: "succeeded",
          detail: null,
          durationMs: null,
        });
        changed.push(device.id);
      }
      return changed;
    },

    /**
     * PC 建议的默认文件夹（hello.suggestedRoots）：只在列表为空且从没被人改过配置时采用。返回是否采用。
     */
    async seedRoots(id: string, suggested: unknown): Promise<boolean> {
      const roots = cleanRoots(suggested).slice(0, 5);
      if (!roots.length) return false;
      const current = await get(id);
      if (!current || current.revoked || current.allowedRoots.length)
        return false;
      if (await store.everConfigured(id)) return false;
      await database
        .update(devices)
        .set({ allowedRoots: roots as unknown as Record<string, unknown> })
        .where(eq(devices.id, id));
      await store.audit({
        deviceId: id,
        ownerUserId: current.ownerUserId,
        actorType: "system",
        actorId: null,
        actorName: "系统",
        action: "defaults_roots",
        summary: `默认允许的文件夹：${roots.join("、")}`,
        outcome: "succeeded",
        detail: null,
        durationMs: null,
      });
      return true;
    },

    async audit(input: AuditInput): Promise<string> {
      const id = randomUUID();
      await database.insert(deviceAuditEvents).values({
        id,
        deviceId: input.deviceId,
        ownerUserId: input.ownerUserId,
        actorType: input.actorType,
        actorId: input.actorId,
        actorName: short(input.actorName, 80),
        action: input.action.slice(0, 64),
        summary: short(redactText(String(input.summary ?? "")), 500),
        outcome: input.outcome.slice(0, 32),
        detail: short(
          input.detail == null ? null : redactText(String(input.detail)),
          1000,
        ),
        durationMs: input.durationMs,
      });
      return id;
    },

    /** 把「进行中」的审计行改成最终结果：先写后做，崩溃也留下记录。 */
    async finishAudit(
      id: string,
      result: {
        outcome: string;
        detail?: string | null;
        durationMs?: number | null;
      },
    ): Promise<void> {
      await database
        .update(deviceAuditEvents)
        .set({
          outcome: result.outcome.slice(0, 32),
          detail: short(
            result.detail == null ? null : redactText(String(result.detail)),
            1000,
          ),
          durationMs: result.durationMs ?? null,
        })
        .where(eq(deviceAuditEvents.id, id));
    },

    async auditLog(
      deviceId: string,
      options: { limit?: number; before?: string } = {},
    ): Promise<DeviceAuditEntry[]> {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const before = options.before ? new Date(options.before) : null;
      const rows = await database
        .select()
        .from(deviceAuditEvents)
        .where(
          and(
            eq(deviceAuditEvents.deviceId, deviceId),
            before && !Number.isNaN(before.getTime())
              ? lt(deviceAuditEvents.at, before)
              : undefined,
          ),
        )
        .orderBy(desc(deviceAuditEvents.at))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        at: row.at.toISOString(),
        actorType: row.actorType as DeviceAuditEntry["actorType"],
        actorId: row.actorId,
        actorName: row.actorName,
        action: row.action,
        summary: row.summary,
        outcome: row.outcome,
        detail: row.detail,
        durationMs: row.durationMs,
      }));
    },
  };
  return store;
}

export type DeviceStore = ReturnType<typeof createDeviceStore>;
