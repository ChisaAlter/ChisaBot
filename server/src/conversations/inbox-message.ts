import type { Message } from "@ag-ui/client";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Database } from "../db/client";
import * as schema from "../db/schema";
import { attachmentIdsIn } from "../channels/attachment-parts";
import { loadAttachmentForTurn, recordAttachmentsSent } from "../channels/attachments";

type InboxContext = { skillIds: string[]; skillInstructions: string[] };
type WithContext = Message & { metadata?: Record<string, unknown> & { chisabotInbox?: InboxContext } };

export function inboxInstructions(messages: readonly Message[]): string[] {
  return messages.flatMap(message => (message as WithContext).metadata?.chisabotInbox?.skillInstructions ?? []);
}

/** Only a stored inbox row may supply this server-owned instruction context. */
export function stripInboxContext(message: Message): Message {
  const metadata = (message as WithContext).metadata;
  if (!metadata?.chisabotInbox) return message;
  const { chisabotInbox: _context, ...rest } = metadata;
  return { ...message, metadata: rest } as Message;
}

export async function resolveInboxMessage(database: Database, actorId: string, agentId: string, message: Message, skillIds: string[]): Promise<Message> {
  if (!skillIds.length) return stripInboxContext(message);
  const rows = await database.$client.unsafe<{ slug: string; instructions: string }[]>(`SELECT s.slug, s.instructions FROM skills s
    WHERE s.slug IN (SELECT jsonb_array_elements_text($1::text::jsonb))
    AND (s.owner_user_id IS NULL OR s.owner_user_id=$2 OR EXISTS
      (SELECT 1 FROM plugin_grants g WHERE g.kind='skill' AND g.agent_id=$3 AND g.ref=s.slug))`,
  [JSON.stringify(skillIds), actorId, agentId]);
  const byId = new Map(rows.map(row => [row.slug, row.instructions]));
  const accessible = skillIds.filter(id => byId.has(id));
  return { ...stripInboxContext(message), metadata: { chisabotInbox: {
    skillIds: accessible, skillInstructions: accessible.map(id => byId.get(id)!),
  } } } as Message;
}

/** Retain the exact typed refs under the same transaction that admits their durable message. */
export async function retainInboxAttachments(client: Database["$client"], turn: { actorId: string; threadId: string }, message: Message) {
  const ids = attachmentIdsIn(message.content);
  if (!ids.length) return;
  const database = drizzle({ client, schema });
  const channelIds: string[] = [];
  for (const id of ids) {
    if (id.startsWith("cf:")) {
      const fileId = id.slice(3);
      if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new Error("附件不存在或你没有访问权限，请重新添加。");
      const found = await client.unsafe("SELECT id FROM chisabot_chat_files WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [fileId, turn.actorId]);
      if (!found.length) throw new Error("附件不存在或你没有访问权限，请重新添加。");
    } else {
      if (!await loadAttachmentForTurn(database, turn, id)) throw new Error("附件不存在或你没有访问权限，请重新添加。");
      channelIds.push(id);
    }
  }
  await recordAttachmentsSent(database, turn, channelIds);
}
