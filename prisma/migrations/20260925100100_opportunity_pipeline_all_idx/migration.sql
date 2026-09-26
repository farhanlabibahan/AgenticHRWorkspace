-- "All stages" keyset scans.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Opportunity_pipeline_all_idx" ON "Opportunity"("orgId", "status", "stageChangedAt", "id");
