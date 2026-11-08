ALTER TABLE "openbot_local_runs" ADD COLUMN IF NOT EXISTS "execution" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.chisabot_local_agent_tasks') IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='chisabot_local_agent_tasks'::regclass AND attname='capacity_active' AND NOT attisdropped) THEN
      ALTER TABLE chisabot_local_agent_tasks ADD COLUMN capacity_active boolean NOT NULL DEFAULT false;
      UPDATE chisabot_local_agent_tasks SET capacity_active=true WHERE status IN ('starting','running');
    END IF;
  END IF;
END $$;
