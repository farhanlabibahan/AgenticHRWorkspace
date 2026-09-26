#!/usr/bin/env node
/**
 * Keep the concurrently built indexes honest around a deploy.
 *
 * Big-table indexes are built with CREATE INDEX CONCURRENTLY IF NOT EXISTS
 * (see CONTRIBUTING). If a build is interrupted — a deploy cancelled, a
 * connection dropped, a lock wait timed out — Postgres keeps the half-built
 * index marked INVALID. Queries never use it, and IF NOT EXISTS would skip it
 * on every later deploy, so the index would silently never exist.
 *
 *   --before   (scripts/migrate.mjs, before `migrate deploy`) Repair:
 *              drop INVALID indexes that one of our migrations builds
 *              (unless a build of it is running right now), and build again
 *              any index an applied migration built that isn't there. A
 *              pending migration builds its own; an applied one would never
 *              run again.
 *   --repair   (scripts/migrate.mjs, after it) Repair, then check.
 *   (none)     Check only: exit 1, with the fix, on an INVALID index or a
 *              missing one.
 *
 *   node --env-file-if-exists=.env scripts/check-indexes.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { appliedMigrations, concurrentIndexes, invalidIndexes, missingIndexes } from './lib/concurrent-indexes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prisma = path.join(root, 'node_modules', '.bin', 'prisma');
const mode = process.argv.includes('--before') ? 'before' : process.argv.includes('--repair') ? 'repair' : 'check';
const tag = '[check-indexes]';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url || url.includes('unconfigured')) {
  console.log(`${tag} No DATABASE_URL — skipping.`);
  process.exit(0);
}

const migrationFile = (name) => path.join('prisma', 'migrations', name, 'migration.sql');

/**
 * Run one migration's SQL again (one CONCURRENTLY statement: outside a
 * transaction). The URL goes through the environment, never argv, where
 * any process listing would show its password.
 */
function rebuild(name) {
  const res = spawnSync(prisma, ['db', 'execute', '--file', migrationFile(name), '--schema', 'prisma/schema.prisma'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
  return res.status === 0;
}

const db = new PrismaClient({ datasources: { db: { url } } });
try {
  const ours = concurrentIndexes(root);
  const expected = concurrentIndexes(root, await appliedMigrations(db));

  if (mode !== 'check') {
    for (const row of await invalidIndexes(db)) {
      if (!ours.has(row.index)) continue; // not ours to drop: the check reports it
      if (row.building) {
        console.log(`${tag} "${row.index}" is being built by another session right now; leaving it.`);
        continue;
      }
      console.log(`${tag} Dropping INVALID index "${row.index}" (an interrupted build) so it is built again.`);
      await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${row.index.replaceAll('"', '""')}"`);
    }
    for (const name of await missingIndexes(db, [...expected.keys()])) {
      const migration = expected.get(name);
      console.log(`${tag} "${name}" is missing although ${migration} is applied; building it again.`);
      if (!rebuild(migration)) console.error(`${tag} Building "${name}" failed.`);
    }
  }

  if (mode !== 'before') {
    const invalid = await invalidIndexes(db);
    const missing = await missingIndexes(db, [...expected.keys()]);
    if (invalid.length || missing.length) {
      for (const row of invalid) console.error(`${tag} INVALID index "${row.index}" on "${row.table}" (an interrupted CREATE INDEX CONCURRENTLY).`);
      for (const name of missing) console.error(`${tag} Missing index "${name}" (${expected.get(name)} is recorded as applied).`);
      const lines = ['Fix, when no long export or import is running (a concurrent build waits for every older transaction):'];
      for (const row of invalid) lines.push(`  DROP INDEX CONCURRENTLY "${row.index}";`);
      lines.push('  then: npm run db:deploy   (it builds each dropped or missing index again)');
      const files = [...new Set([...invalid.map((r) => ours.get(r.index)), ...missing.map((n) => expected.get(n))].filter(Boolean))];
      if (files.length) {
        lines.push('  or by hand, for each:');
        for (const name of files) {
          lines.push(`    DATABASE_URL="$DIRECT_URL" npx prisma db execute --schema prisma/schema.prisma --file ${migrationFile(name)}`);
        }
      }
      console.error(lines.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`${tag} All indexes valid.`);
    }
  }
} catch (error) {
  console.error(`${tag} Could not check indexes:`, error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
