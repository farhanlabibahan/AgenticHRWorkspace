import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * Database suites run against TEST_DATABASE_URL, which is wiped and migrated
 * from scratch on every run — so it must be a local database with "test" in
 * its name. Without it, those suites skip and only unit tests run.
 *
 *   createdb source_test
 *   TEST_DATABASE_URL=postgresql://localhost/source_test npm test
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const { hostname, pathname } = new URL(url);
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname) || !pathname.includes('test')) {
    throw new Error('TEST_DATABASE_URL must be a local database whose name contains "test" — it is wiped on every run.');
  }
  const db = new PrismaClient({ datasources: { db: { url } } });
  await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await db.$executeRawUnsafe('CREATE SCHEMA public');
  await db.$disconnect();
  // The real migration path, so the tests also prove migrations apply cleanly.
  execFileSync('node', ['scripts/migrate.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, VERCEL: '' },
  });
}
