import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

/**
 * PC 节点（设备）。一台装了 ChisaBot 桌面客户端的电脑一行；令牌只存 SHA-256。
 * 见 docs/pc-node.md。
 */
export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    osVersion: text("os_version"),
    hostname: text("hostname"),
    arch: text("arch"),
    clientVersion: text("client_version"),
    tokenHash: text("token_hash").notNull(),
    capabilities: jsonb("capabilities").notNull(),
    allowedRoots: jsonb("allowed_roots").notNull(),
    paused: boolean("paused").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastIp: text("last_ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("devices_owner_idx").on(t.ownerUserId),
    index("devices_token_hash_idx").on(t.tokenHash),
  ],
);

/** 哪些机器人可以使用哪台设备。没有行 = 不能用。 */
export const deviceBotAccess = pgTable(
  "device_bot_access",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.botId] })],
);

/** 设备上的每个远程操作和每次配置改动。 */
export const deviceAuditEvents = pgTable(
  "device_audit_events",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    summary: text("summary"),
    outcome: text("outcome").notNull(),
    detail: text("detail"),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("device_audit_device_at_idx").on(t.deviceId, t.at)],
);
