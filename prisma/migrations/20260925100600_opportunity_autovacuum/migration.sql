-- Vacuum and analyze after 2% churn instead of 20%, so the visibility map
-- stays current and the tile counts stay index-only on large tables.
ALTER TABLE "Opportunity" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
