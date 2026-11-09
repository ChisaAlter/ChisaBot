import { randomUUID } from "node:crypto";
import type { ConversationBinding } from "../../../shared/conversations";
import type { Database } from "../db/client";

type BindingRow = {
  id: string;
  revision: number;
  owner_user_id: string;
  thread_id: string;
  bot_id: string;
  runtime_id: string;
  session_id: string;
};
const valueOf = (row: BindingRow): ConversationBinding => ({
  bindingId: row.id,
  revision: row.revision,
  ownerUserId: row.owner_user_id,
  threadId: row.thread_id,
  botId: row.bot_id,
  runtimeId: row.runtime_id,
  sessionId: row.session_id,
});

export function createConversationBindings(database: Database) {
  const sql = database.$client;
  return {
    async ensure() {
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_runtime_bindings (
        id text PRIMARY KEY, thread_id text NOT NULL, revision integer NOT NULL,
        owner_user_id text NOT NULL, bot_id text NOT NULL, runtime_id text NOT NULL,
        session_id text NOT NULL, kernel text NOT NULL DEFAULT 'dsh',
        active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(thread_id,revision), UNIQUE(runtime_id,session_id)
      )`);
      await sql.unsafe(
        "CREATE UNIQUE INDEX IF NOT EXISTS chisabot_runtime_binding_active ON chisabot_runtime_bindings(thread_id) WHERE active",
      );
    },
    async get(threadId: string): Promise<ConversationBinding | null> {
      const [row] = await sql.unsafe<BindingRow[]>(
        "SELECT * FROM chisabot_runtime_bindings WHERE thread_id=$1 AND active",
        [threadId],
      );
      return row ? valueOf(row) : null;
    },
    async getOrCreate(input: {
      threadId: string;
      ownerUserId: string;
      botId: string;
      runtimeId: string;
      revision?: number;
    }): Promise<ConversationBinding> {
      const revision = input.revision ?? 1;
      await sql.begin(async (tx) => {
        // Serializes the first binding too, before a row exists to lock.
        await tx.unsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [input.threadId],
        );
        const [current] = await tx.unsafe<BindingRow[]>(
          "SELECT * FROM chisabot_runtime_bindings WHERE thread_id=$1 AND active FOR UPDATE",
          [input.threadId],
        );
        if (
          current &&
          (current.owner_user_id !== input.ownerUserId ||
            current.bot_id !== input.botId ||
            current.runtime_id !== input.runtimeId ||
            current.revision > revision)
        )
          throw new Error(
            "Conversation binding conflicts with the requested revision.",
          );
        if (current?.revision === revision) return;
        if (current)
          await tx.unsafe(
            "UPDATE chisabot_runtime_bindings SET active=false WHERE id=$1",
            [current.id],
          );
        await tx.unsafe(
          `INSERT INTO chisabot_runtime_bindings(id,thread_id,revision,owner_user_id,bot_id,runtime_id,session_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            input.threadId,
            revision,
            input.ownerUserId,
            input.botId,
            input.runtimeId,
            randomUUID(),
          ],
        );
      });
      const binding = await this.get(input.threadId);
      if (
        !binding ||
        binding.ownerUserId !== input.ownerUserId ||
        binding.botId !== input.botId ||
        binding.runtimeId !== input.runtimeId
      ) {
        throw new Error(
          "This thread is bound to a different owner, Bot or runtime.",
        );
      }
      return binding;
    },
  };
}
export type ConversationBindings = ReturnType<
  typeof createConversationBindings
>;
