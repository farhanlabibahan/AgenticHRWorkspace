import { PrismaClient } from '@prisma/client';

// A placeholder keeps DB-free surfaces (the marketing page) rendering on
// deployments that haven't configured a database yet; real queries still
// fail loudly until DATABASE_URL is set.
const UNCONFIGURED = 'postgresql://unconfigured:unconfigured@localhost:5432/unconfigured';

/**
 * Long-running Node (next dev / next start) should use Neon's direct
 * connection. The pooled host + Prisma `pgbouncer=true` wraps every query in
 * BEGIN / DEALLOCATE ALL / COMMIT — four round-trips. From Europe to
 * us-east-1 that's ~500ms per query vs ~130ms on a direct socket.
 *
 * Vercel serverless still needs the pooler (ephemeral processes would exhaust
 * compute connections otherwise).
 */
function resolveDatabaseUrl(): string {
  const pooled = process.env.DATABASE_URL ?? UNCONFIGURED;
  const direct = process.env.DIRECT_URL;
  const serverless = process.env.VERCEL === '1';
  const raw = !serverless && direct ? direct : pooled;

  try {
    const parsed = new URL(raw);
    const usingPooler =
      parsed.hostname.includes('-pooler.') || parsed.searchParams.get('pgbouncer') === 'true';
    if (usingPooler && !parsed.searchParams.has('pgbouncer')) {
      parsed.searchParams.set('pgbouncer', 'true');
    }
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', serverless ? '5' : '10');
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

const databaseUrl = resolveDatabaseUrl();

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
