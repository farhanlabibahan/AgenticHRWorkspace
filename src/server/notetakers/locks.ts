import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * Postgres advisory locks for the notetaker sync, transaction-scoped so they
 * work through a transaction-mode pooler (Neon's pgbouncer): a lock lives in
 * an interactive transaction and is released when it ends, even if the
 * process dies. Keys are (namespace, hashtext(id)).
 */

const NAMESPACE = {
  /** One sync or attach per connection at a time: OAuth refresh tokens rotate. */
  connection: 72_001,
  /** One client registration per authorization server and redirect URI. */
  registration: 72_002,
  /** One attach per external meeting across connections: never two transcripts. */
  meeting: 72_003,
} as const;

export type LockNamespace = keyof typeof NAMESPACE;

/** Waits for the lock; released when `tx` ends. */
export async function lockInTransaction(tx: Prisma.TransactionClient, ns: LockNamespace, key: string) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${NAMESPACE[ns]}::int4, hashtext(${key}))`);
}

/**
 * Runs `fn` while holding the connection's lock, or returns { locked: false }
 * at once when another run holds it. `fn` does its own queries (on other
 * pooled connections); the transaction only holds the lock.
 */
export async function withConnectionLock<T>(
  connectionId: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<{ locked: true; value: T } | { locked: false }> {
  return db.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ locked: boolean }[]>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(${NAMESPACE.connection}::int4, hashtext(${connectionId})) AS locked`,
      );
      if (!row?.locked) return { locked: false } as const;
      return { locked: true, value: await fn() } as const;
    },
    { timeout: opts.timeoutMs ?? 290_000, maxWait: 10_000 },
  );
}
