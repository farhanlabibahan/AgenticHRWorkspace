-- Same as for Opportunity: keep the visibility map and statistics current.
ALTER TABLE "Contact" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
