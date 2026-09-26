#!/usr/bin/env node
/**
 * Apply database migrations — the one entry point for builds, Docker, and
 * self-hosters (`npm run db:deploy`).
 *
 * Databases created before versioned migrations existed were synced with
 * `prisma db push`, so they have tables but no `_prisma_migrations` history
 * and `migrate deploy` refuses them (P3005). For those we do exactly what the
 * old startup did — push the schema as it stood at the baseline — then mark
 * the baseline applied and let every later migration run normally. This is a
 * one-time step per database.
 *
 * Skips cleanly when no database is configured, and on Vercel preview builds,
 * which share the production database: a pull request must never migrate it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the latter keeps %20 for paths with spaces.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Local CLI only — a global Prisma 7 rejects this schema's datasource block.
const prisma = path.join(root, 'node_modules', '.bin', 'prisma');
const BASELINE = '0_init';
const BASELINE_SCHEMA = path.join(root, 'scripts', 'lib', 'baseline.prisma');

/** scripts/check-indexes.mjs in one of its modes; true when it passed. */
function indexes(mode) {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-indexes.mjs'), ...(mode ? [mode] : [])], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
  return res.status === 0;
}

/**
 * After migrating: rebuild any concurrently built index that went missing,
 * and refuse to carry on with a half-built (INVALID) one.
 */
function checkIndexes() {
  process.exit(indexes('--repair') ? 0 : 1);
}

function run(args, { capture = false } = {}) {
  const res = spawnSync(prisma, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });
  if (capture) {
    process.stdout.write(res.stdout ?? '');
    process.stderr.write(res.stderr ?? '');
  }
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url || url.includes('unconfigured')) {
  console.log('[migrate] No DATABASE_URL — skipping migrations.');
  process.exit(0);
}
if (process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'production') {
  console.log(`[migrate] Vercel ${process.env.VERCEL_ENV ?? 'unknown'} build — skipping migrations.`);
  process.exit(0);
}
if (!existsSync(prisma)) {
  console.error('[migrate] node_modules/.bin/prisma not found — run npm ci first.');
  process.exit(1);
}

// An interrupted CREATE INDEX CONCURRENTLY leaves an INVALID index that its
// migration's IF NOT EXISTS would skip: drop it first so the migration (or
// the repair after it) builds it for real.
if (!indexes('--before')) {
  console.error('[migrate] Could not check for half-built indexes.');
  process.exit(1);
}

const first = run(['migrate', 'deploy'], { capture: true });
if (first.ok) checkIndexes();

if (!first.output.includes('P3005')) {
  console.error('[migrate] migrate deploy failed.');
  if (/P3009|P3018/.test(first.output)) {
    console.error(
      [
        '[migrate] A migration failed part-way. If it was a CREATE INDEX CONCURRENTLY that was',
        '  interrupted (a cancelled deploy, a dropped connection), mark it rolled back and deploy again:',
        '    npx prisma migrate resolve --rolled-back <the failed migration>',
        '    npm run db:deploy',
        '  The half-built index is dropped and built again. Deploy index migrations when no long export',
        '  or import is running: a concurrent build waits for every older transaction.',
      ].join('\n'),
    );
  }
  process.exit(1);
}

console.log(`[migrate] Existing db-push database — baselining at ${BASELINE}.`);
const steps = [
  ['db', 'push', '--schema', BASELINE_SCHEMA, '--skip-generate'],
  ['migrate', 'resolve', '--applied', BASELINE],
  ['migrate', 'deploy'],
];
for (const args of steps) {
  if (!run(args).ok) {
    console.error(`[migrate] "prisma ${args.join(' ')}" failed.`);
    process.exit(1);
  }
}
checkIndexes();
