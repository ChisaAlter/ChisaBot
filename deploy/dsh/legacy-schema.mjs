/** Host maintenance can inspect the still-running pre-migration image before a release swap. */
export async function conversationTables(sql) {
  const [row] = await sql.unsafe("select to_regclass('chisabot_local_threads') as current, to_regclass('openbot_local_threads') as legacy");
  if (row?.current && row?.legacy) throw new Error('Ambiguous conversation storage; finish the schema migration first.');
  if (row?.current) return { threads: 'chisabot_local_threads', events: 'chisabot_local_events' };
  if (row?.legacy) return { threads: 'openbot_local_threads', events: 'openbot_local_events' };
  throw new Error('Conversation storage is unavailable.');
}
