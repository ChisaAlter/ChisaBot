-- Rename the channel mapping table in place so existing channel-thread links stay attached.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('intelligence_channel_mappings', 'chisabot_channel_mappings')
  ) AS names(previous_name, current_name) LOOP
    IF to_regclass('public.' || item.previous_name) IS NOT NULL THEN
      IF to_regclass('public.' || item.current_name) IS NOT NULL THEN
        RAISE EXCEPTION 'Both channel mapping table generations exist: % and %', item.previous_name, item.current_name;
      END IF;
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', item.previous_name, item.current_name);
    END IF;
  END LOOP;
  FOR item IN
    SELECT c.conname, t.relname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'chisabot_channel_mappings'
      AND c.conname LIKE 'intelligence\_channel\_mappings\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
      item.relname,
      item.conname,
      replace(item.conname, 'intelligence_channel_mappings_', 'chisabot_channel_mappings_')
    );
  END LOOP;
  FOR item IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'i'
      AND c.relname LIKE 'intelligence\_channel\_mappings\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER INDEX public.%I RENAME TO %I',
      item.relname,
      replace(item.relname, 'intelligence_channel_mappings_', 'chisabot_channel_mappings_')
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- Migrate structural envelope keys and legacy kernel tags in place without touching user message text.
DO $migration$
BEGIN
  CREATE OR REPLACE FUNCTION pg_temp.chisabot_clean_forwarded_props(props jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  IMMUTABLE
  AS $fn$
  DECLARE
    result jsonb := props;
    pair record;
  BEGIN
    IF result IS NULL OR jsonb_typeof(result) <> 'object' THEN
      RETURN result;
    END IF;
    FOR pair IN SELECT * FROM (VALUES
      ('openbotRun', 'chisabotRun'),
      ('openbotBotId', 'chisabotBotId'),
      ('openbotDeploymentTools', 'chisabotDeploymentTools'),
      ('openbotModelOnly', 'chisabotModelOnly'),
      ('openbotWorker', 'chisabotWorker'),
      ('openbotWorkerDelivery', 'chisabotWorkerDelivery')
    ) AS keys(old_key, new_key) LOOP
      IF result ? pair.old_key THEN
        IF NOT (result ? pair.new_key) THEN
          result := jsonb_set(result, ARRAY[pair.new_key], result -> pair.old_key, true);
        END IF;
        result := result - pair.old_key;
      END IF;
    END LOOP;
    RETURN result;
  END;
  $fn$;

  CREATE OR REPLACE FUNCTION pg_temp.chisabot_clean_run_input(input_doc jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  IMMUTABLE
  AS $fn$
  DECLARE
    result jsonb := input_doc;
  BEGIN
    IF result IS NULL OR jsonb_typeof(result) <> 'object' THEN
      RETURN result;
    END IF;
    IF result ? 'forwardedProps' AND jsonb_typeof(result -> 'forwardedProps') = 'object' THEN
      result := jsonb_set(
        result,
        '{forwardedProps}',
        pg_temp.chisabot_clean_forwarded_props(result -> 'forwardedProps'),
        true
      );
    END IF;
    RETURN result;
  END;
  $fn$;

  CREATE OR REPLACE FUNCTION pg_temp.chisabot_clean_interrupts(arr jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  IMMUTABLE
  AS $fn$
  DECLARE
    result jsonb;
  BEGIN
    IF arr IS NULL OR jsonb_typeof(arr) <> 'array' THEN
      RETURN arr;
    END IF;
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN jsonb_typeof(item.elem) = 'object'
            AND jsonb_typeof(item.elem -> 'metadata') = 'object'
            AND (item.elem -> 'metadata') ? 'openbotWaiting'
          THEN jsonb_set(
            item.elem,
            '{metadata}',
            (
              CASE
                WHEN (item.elem -> 'metadata') ? 'chisabotWaiting'
                  THEN (item.elem -> 'metadata') - 'openbotWaiting'
                ELSE jsonb_set(
                  item.elem -> 'metadata',
                  '{chisabotWaiting}',
                  (item.elem -> 'metadata') -> 'openbotWaiting',
                  true
                ) - 'openbotWaiting'
              END
            ),
            true
          )
          ELSE item.elem
        END
        ORDER BY item.ord
      ),
      '[]'::jsonb
    )
    INTO result
    FROM jsonb_array_elements(arr) WITH ORDINALITY AS item(elem, ord);
    RETURN result;
  END;
  $fn$;

  CREATE OR REPLACE FUNCTION pg_temp.chisabot_clean_local_event(ev jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  IMMUTABLE
  AS $fn$
  DECLARE
    result jsonb := ev;
  BEGIN
    IF result IS NULL OR jsonb_typeof(result) <> 'object' THEN
      RETURN result;
    END IF;
    IF result ->> 'name' = 'openbot.headless.waiting' THEN
      result := jsonb_set(result, '{name}', '"chisabot.headless.waiting"'::jsonb, true);
    END IF;
    IF result ? 'forwardedProps' AND jsonb_typeof(result -> 'forwardedProps') = 'object' THEN
      result := jsonb_set(
        result,
        '{forwardedProps}',
        pg_temp.chisabot_clean_forwarded_props(result -> 'forwardedProps'),
        true
      );
    END IF;
    IF result ? 'input' AND jsonb_typeof(result -> 'input') = 'object' THEN
      result := jsonb_set(
        result,
        '{input}',
        pg_temp.chisabot_clean_run_input(result -> 'input'),
        true
      );
    END IF;
    IF result ? 'snapshot'
      AND jsonb_typeof(result -> 'snapshot') = 'object'
      AND (result -> 'snapshot') ? 'interrupts'
      AND jsonb_typeof(result #> '{snapshot,interrupts}') = 'array'
    THEN
      result := jsonb_set(
        result,
        '{snapshot,interrupts}',
        pg_temp.chisabot_clean_interrupts(result #> '{snapshot,interrupts}'),
        true
      );
    END IF;
    RETURN result;
  END;
  $fn$;

  IF to_regclass('public.chisabot_local_events') IS NOT NULL THEN
    UPDATE public.chisabot_local_events
    SET event = pg_temp.chisabot_clean_local_event(event)
    WHERE event::text LIKE '%openbot%'
      AND pg_temp.chisabot_clean_local_event(event) IS DISTINCT FROM event;
  END IF;

  IF to_regclass('public.chisabot_local_threads') IS NOT NULL THEN
    UPDATE public.chisabot_local_threads
    SET state = jsonb_set(state, '{interrupts}', pg_temp.chisabot_clean_interrupts(state -> 'interrupts'), true)
    WHERE jsonb_typeof(state) = 'object'
      AND state ? 'interrupts'
      AND (state -> 'interrupts')::text LIKE '%openbotWaiting%'
      AND pg_temp.chisabot_clean_interrupts(state -> 'interrupts') IS DISTINCT FROM (state -> 'interrupts');
  END IF;

  IF to_regclass('public.chisabot_conversation_commands') IS NOT NULL THEN
    UPDATE public.chisabot_conversation_commands
    SET input = pg_temp.chisabot_clean_run_input(input)
    WHERE input::text LIKE '%openbot%'
      AND pg_temp.chisabot_clean_run_input(input) IS DISTINCT FROM input;
  END IF;

  IF to_regclass('public.chisabot_dsh_runs') IS NOT NULL THEN
    UPDATE public.chisabot_dsh_runs
    SET input = pg_temp.chisabot_clean_run_input(input)
    WHERE input::text LIKE '%openbot%'
      AND pg_temp.chisabot_clean_run_input(input) IS DISTINCT FROM input;
  END IF;

  IF to_regclass('public.chisabot_conversation_interactions') IS NOT NULL THEN
    UPDATE public.chisabot_conversation_interactions
    SET answer_input = pg_temp.chisabot_clean_run_input(answer_input)
    WHERE answer_input IS NOT NULL
      AND answer_input::text LIKE '%openbot%'
      AND pg_temp.chisabot_clean_run_input(answer_input) IS DISTINCT FROM answer_input;
  END IF;

  IF to_regclass('public.chisabot_tool_operations') IS NOT NULL THEN
    UPDATE public.chisabot_tool_operations
    SET result = (
      CASE
        WHEN result ? 'chisabotAuthRequired' THEN result - 'openbotAuthRequired'
        ELSE jsonb_set(result, '{chisabotAuthRequired}', result -> 'openbotAuthRequired', true) - 'openbotAuthRequired'
      END
    )
    WHERE result IS NOT NULL
      AND jsonb_typeof(result) = 'object'
      AND result ? 'openbotAuthRequired';
  END IF;

  IF to_regclass('public.chisabot_runtime_bindings') IS NOT NULL THEN
    UPDATE public.chisabot_runtime_bindings
    SET kernel = 'dsh'
    WHERE kernel = 'hermes';
  END IF;

  DROP FUNCTION pg_temp.chisabot_clean_local_event(jsonb);
  DROP FUNCTION pg_temp.chisabot_clean_interrupts(jsonb);
  DROP FUNCTION pg_temp.chisabot_clean_run_input(jsonb);
  DROP FUNCTION pg_temp.chisabot_clean_forwarded_props(jsonb);
END $migration$;
--> statement-breakpoint
DROP TABLE IF EXISTS "chisabot_legacy_imports" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "demonstrations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "learning_settings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "learning_thread_bindings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "memory_sources" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "personal_memories" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "proactive_settings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "proactive_suggestions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "team_bot_assignments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "team_bot_audience" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "team_bot_consent_defaults" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "team_bot_consents" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "team_bot_publications" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "voice_sessions" CASCADE;
