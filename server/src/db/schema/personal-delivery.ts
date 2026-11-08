import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Personal notifications/SMTP use the same send protocol as IM, without requiring an IM chat. */
export const personalDeliveries = pgTable('chisabot_personal_deliveries', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  kind: text('kind').notNull(),
  connectionVersion: text('connection_version').notNull(),
  payload: jsonb('payload').notNull(),
  threadId: text('thread_id'),
  runId: text('run_id'),
  agentId: text('agent_id'),
  state: text('state').notNull().default('queued'),
  receipt: jsonb('receipt'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('chisabot_personal_deliveries_pending').on(table.kind).where(sql`${table.state} IN ('queued','sending')`),
  index('chisabot_personal_deliveries_owner').on(table.ownerUserId, table.createdAt),
]);
