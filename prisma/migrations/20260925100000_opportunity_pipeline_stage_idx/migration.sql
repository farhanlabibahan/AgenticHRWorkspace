-- Stage-tab keyset scans and index-only tile counts. CONCURRENTLY: no write lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Opportunity_pipeline_stage_idx" ON "Opportunity"("orgId", "status", "stageId", "stageChangedAt", "id", "snoozedUntil");
