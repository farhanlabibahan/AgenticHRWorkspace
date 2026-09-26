import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { db } from '@/lib/db';

/**
 * The list indexes exist after a from-scratch migrate (global setup runs the
 * real deploy script), the ones they replace are gone, and the deploy-time
 * guard catches a half-built index.
 */
describe.skipIf(!hasDb)('list indexes', () => {
  const url = () => process.env.TEST_DATABASE_URL!;
  const checkIndexes = (...args: string[]) =>
    spawnSync(process.execPath, ['scripts/check-indexes.mjs', ...args], {
      env: { ...process.env, DATABASE_URL: url(), DIRECT_URL: url() },
      encoding: 'utf8',
    });
  const indexState = async (name: string) =>
    (
      await db.$queryRaw<{ table: string; valid: boolean }[]>`
        SELECT i.indrelid::regclass::text AS "table", i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ${name}`
    )[0] ?? null;
  /** A failed unique build over duplicates: an INVALID index named `name`. */
  async function halfBuilt(name: string) {
    await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_index_guard_probe" (x int)');
    await db.$executeRawUnsafe('TRUNCATE "_index_guard_probe"');
    await db.$executeRawUnsafe('INSERT INTO "_index_guard_probe" VALUES (1), (1)');
    await expect(
      db.$executeRawUnsafe(`CREATE UNIQUE INDEX CONCURRENTLY "${name}" ON "_index_guard_probe" (x)`),
    ).rejects.toThrow();
    expect(await indexState(name)).toEqual({ table: '_index_guard_probe', valid: false });
  }

  afterAll(async () => {
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS "_index_guard_probe"');
    // Leave the real index as the migrations built it, whatever a test did.
    expect(checkIndexes('--repair').status).toBe(0);
  });

  it('has the keyset and count indexes, and not the prefixes they replace', async () => {
    const rows = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename IN ('Opportunity', 'Contact')`;
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'Opportunity_pipeline_stage_idx',
        'Opportunity_pipeline_all_idx',
        'Contact_list_created_idx',
        'Contact_name_sort_idx',
      ]),
    );
    expect(names).not.toContain('Opportunity_orgId_status_stageId_idx');
    expect(names).not.toContain('Contact_orgId_createdAt_idx');
    const invalid = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_index WHERE NOT indisvalid`;
    expect(invalid[0].n).toBe(0);
  });

  it('check-indexes fails the deploy on an INVALID index', async () => {
    expect(checkIndexes().status).toBe(0);
    await halfBuilt('_index_guard_probe_idx');
    const failed = checkIndexes();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('_index_guard_probe_idx');
    expect(failed.stderr).toContain('DROP INDEX CONCURRENTLY');
    // Not built by one of our migrations: reported, never dropped for you.
    checkIndexes('--before');
    expect(await indexState('_index_guard_probe_idx')).not.toBeNull();
    await db.$executeRawUnsafe('DROP INDEX CONCURRENTLY "_index_guard_probe_idx"');
  });

  it('builds again an index its migration left INVALID, even once recorded as applied', async () => {
    // The interrupted-build case: IF NOT EXISTS would skip this forever.
    await db.$executeRawUnsafe('DROP INDEX CONCURRENTLY "Contact_name_sort_idx"');
    await halfBuilt('Contact_name_sort_idx');
    const check = checkIndexes();
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('20260925100300_contact_name_sort_idx/migration.sql');

    const before = checkIndexes('--before');
    expect(before.status, before.stderr).toBe(0);
    expect(await indexState('Contact_name_sort_idx')).toEqual({ table: '"Contact"', valid: true });
    expect(checkIndexes().status).toBe(0);
  });

  it('fails the check on a missing index its applied migration built, and repairs it', async () => {
    await db.$executeRawUnsafe('DROP INDEX CONCURRENTLY "Opportunity_pipeline_all_idx"');
    const check = checkIndexes();
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('Missing index "Opportunity_pipeline_all_idx"');
    const repair = checkIndexes('--repair');
    expect(repair.status, repair.stderr).toBe(0);
    expect(await indexState('Opportunity_pipeline_all_idx')).toEqual({ table: '"Opportunity"', valid: true });
  });

  it('stops a bare migrate deploy before the drops when a replacement index is missing', async () => {
    const guard = readFileSync('prisma/migrations/20260925100350_check_replacement_indexes/migration.sql', 'utf8');
    await expect(db.$executeRawUnsafe(guard)).resolves.toBeDefined();
    await db.$executeRawUnsafe('DROP INDEX CONCURRENTLY "Opportunity_pipeline_stage_idx"');
    await expect(db.$executeRawUnsafe(guard)).rejects.toThrow(/Opportunity_pipeline_stage_idx/);
    await halfBuilt('Opportunity_pipeline_stage_idx');
    await expect(db.$executeRawUnsafe(guard)).rejects.toThrow(/Opportunity_pipeline_stage_idx/);
    expect(checkIndexes('--repair').status).toBe(0);
    await expect(db.$executeRawUnsafe(guard)).resolves.toBeDefined();
  });
});
