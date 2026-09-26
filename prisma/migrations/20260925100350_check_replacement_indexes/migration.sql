-- Stop here, before the two drops that follow, unless the indexes replacing
-- them were really built. CREATE INDEX CONCURRENTLY IF NOT EXISTS skips a
-- half-built (INVALID) index left by an interrupted build, and dropping the
-- old index then would leave the lists with neither. npm run db:deploy drops
-- such an index before migrating, so this only fires on a bare
-- `prisma migrate deploy`. Fix: DROP INDEX CONCURRENTLY the invalid index,
-- `prisma migrate resolve --rolled-back` this migration, npm run db:deploy.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(want, ', ') INTO bad
  FROM unnest(ARRAY['Opportunity_pipeline_stage_idx', 'Contact_list_created_idx']) AS want
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = want AND n.nspname = current_schema() AND i.indisvalid AND i.indisready
  );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Missing or INVALID index: % (an interrupted CREATE INDEX CONCURRENTLY). Not dropping the indexes it replaces.', bad
      USING HINT = 'DROP INDEX CONCURRENTLY the invalid index, run prisma migrate resolve --rolled-back 20260925100350_check_replacement_indexes, then npm run db:deploy.';
  END IF;
END $$;
