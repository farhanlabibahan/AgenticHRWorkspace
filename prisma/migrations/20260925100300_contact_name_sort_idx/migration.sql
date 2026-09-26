-- Pipeline sorted by name: walk contacts in name order instead of sorting them all.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_name_sort_idx" ON "Contact"("orgId", "name", "id");
