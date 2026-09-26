/**
 * The indexes our migrations build with CREATE INDEX CONCURRENTLY, and how
 * to tell whether the database really has them.
 *
 * A concurrent build that is interrupted (a cancelled deploy, a dropped
 * connection, a lock wait that timed out) leaves the index behind marked
 * INVALID: queries never use it, and the migration's IF NOT EXISTS would skip
 * it on every later run. Used by scripts/check-indexes.mjs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CREATE = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
const DROP = /DROP\s+INDEX\s+CONCURRENTLY\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;

/** A migration's SQL without `--` comments, so commented-out statements don't count. */
function migrationSql(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/**
 * Index name → the migration that builds it concurrently, in migration
 * order, minus indexes a later migration drops. With `applied`, only those
 * migrations count (what this database should have right now).
 */
export function concurrentIndexes(root, applied = null) {
  const dir = path.join(root, 'prisma', 'migrations');
  const out = new Map();
  const names = readdirSync(dir)
    .filter((d) => existsSync(path.join(dir, d, 'migration.sql')))
    .sort();
  for (const name of names) {
    if (applied && !applied.has(name)) continue;
    const sql = migrationSql(path.join(dir, name, 'migration.sql'));
    for (const m of sql.matchAll(CREATE)) out.set(m[1], name);
    for (const m of sql.matchAll(DROP)) out.delete(m[1]);
  }
  return out;
}

/** Migrations recorded as applied (none on a database Prisma hasn't migrated yet). */
export async function appliedMigrations(db) {
  try {
    const rows = await db.$queryRaw`
      SELECT migration_name AS name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

/** INVALID indexes in this schema, and whether a concurrent build is running on each right now. */
export async function invalidIndexes(db) {
  return db.$queryRaw`
    SELECT c.relname AS "index", t.relname AS "table",
      EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = i.indexrelid) AS building
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT i.indisvalid AND n.nspname = current_schema()`;
}

/** Of `names`, the ones this schema has no index for. */
export async function missingIndexes(db, names) {
  if (!names.length) return [];
  const rows = await db.$queryRaw`
    SELECT c.relname AS "index"
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i' AND n.nspname = current_schema() AND c.relname = ANY(${names}::text[])`;
  const have = new Set(rows.map((r) => r.index));
  return names.filter((name) => !have.has(name));
}
