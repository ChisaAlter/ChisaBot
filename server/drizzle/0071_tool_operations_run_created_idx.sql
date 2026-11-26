CREATE INDEX IF NOT EXISTS "chisabot_tool_operations_run_created_idx" ON "chisabot_tool_operations" USING btree ("run_id","created_at");
