ALTER TABLE "live_panels" ADD COLUMN "data_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "live_panels" ADD COLUMN "source_state" jsonb DEFAULT '{}'::jsonb NOT NULL;
