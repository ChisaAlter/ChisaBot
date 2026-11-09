-- Rename the original conversation tables in place: rows, sequences and foreign-key targets stay attached.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('openbot_local_threads', 'chisabot_local_threads'),
    ('openbot_local_runs', 'chisabot_local_runs'),
    ('openbot_local_events', 'chisabot_local_events')
  ) AS names(previous_name, current_name) LOOP
    IF to_regclass('public.' || item.previous_name) IS NOT NULL THEN
      IF to_regclass('public.' || item.current_name) IS NOT NULL THEN
        RAISE EXCEPTION 'Both conversation table generations exist: % and %', item.previous_name, item.current_name;
      END IF;
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', item.previous_name, item.current_name);
    END IF;
  END LOOP;
  FOR item IN
    SELECT c.conname, t.relname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname IN ('chisabot_local_threads','chisabot_local_runs','chisabot_local_events')
      AND c.conname LIKE 'openbot\_%' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', item.relname, item.conname, replace(item.conname,'openbot_','chisabot_'));
  END LOOP;
  FOR item IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='i' AND c.relname LIKE 'openbot\_local\_%' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', item.relname, replace(item.relname,'openbot_','chisabot_'));
  END LOOP;
  IF to_regclass('public.openbot_local_events_sequence_seq') IS NOT NULL THEN
    ALTER SEQUENCE public.openbot_local_events_sequence_seq RENAME TO chisabot_local_events_sequence_seq;
  END IF;
END $$;
--> statement-breakpoint
-- Keep the append-only contract while moving the retention session setting to the product namespace.
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE retention_days integer;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;
  BEGIN
    retention_days := nullif(current_setting('chisabot.audit_retention_days', true), '')::integer;
  EXCEPTION WHEN others THEN
    retention_days := NULL;
  END;
  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;
  IF OLD.created_at >= now() - (retention_days || ' days')::interval THEN
    RAISE EXCEPTION 'Audit events are append-only within the retention window';
  END IF;
  RETURN OLD;
END;
$$;
