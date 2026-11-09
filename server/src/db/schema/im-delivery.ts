import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Connection IDs are retained after deletion so delivery history can still be reconciled. */
export const imInbox = pgTable(
  "chisabot_im_inbox",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    inbound: jsonb("inbound").notNull(),
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chisabot_im_inbox_pending")
      .on(table.connectionId)
      .where(sql`${table.state}='pending'`),
  ],
);

export const imOutbox = pgTable(
  "chisabot_im_outbox",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    inbound: jsonb("inbound").notNull(),
    text: text("text").notNull(),
    chunks: jsonb("chunks").notNull(),
    state: text("state").notNull().default("queued"),
    receipt: jsonb("receipt"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chisabot_im_outbox_pending")
      .on(table.connectionId)
      .where(sql`${table.state} IN ('queued','sending')`),
  ],
);
