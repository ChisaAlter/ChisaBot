-- Backfill IM connection owners for deployments that created connections before the owner list
-- existed (#465 QR-bound connections upgraded past RV-02: empty owner_users + empty allow_users
-- meant the bot silently ignored everyone).
--
-- Why a migration: owner_users lives in a DB column (chisabot_im_connections.owner_users), so the
-- backfill is a one-time data fix and belongs here rather than in the idempotent startup path.
-- The im_* tables themselves are still lazily created by the service's ensure() (they predate and
-- stay outside drizzle's schema), so this migration guards with to_regclass and adds owner_users
-- only if it is missing -- on a fresh install the tables don't exist yet when migrate runs.
--
-- Backfill source: every adapter reports a private chat's chatId == the sender's platform user id,
-- so `private:<id>` chat keys in chisabot_im_chats name exactly the people who were already chatting
-- with the bot. Under the pre-#467 semantics (empty lists = everyone may chat and approve) those
-- senders already had full access, so making them owners restores -- and narrows -- their previous
-- access rather than widening it.
DO $$
BEGIN
  IF to_regclass('chisabot_im_connections') IS NULL OR to_regclass('chisabot_im_chats') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE chisabot_im_connections ADD COLUMN IF NOT EXISTS owner_users jsonb NOT NULL DEFAULT '[]'::jsonb;
  UPDATE chisabot_im_connections c
  SET owner_users = sub.owners
  FROM (
    SELECT connection_id, jsonb_agg(DISTINCT substr(chat_key, 9)) AS owners
    FROM chisabot_im_chats
    WHERE chat_key LIKE 'private:%'
    GROUP BY connection_id
  ) sub
  WHERE c.id = sub.connection_id
    AND c.owner_users = '[]'::jsonb;
END $$;
