import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

/** One CSV cell, quoted when it has to be. */
export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const csvLine = (values: unknown[]) => values.map((v) => csvCell(String(v ?? ''))).join(',');

/**
 * Stream what `lines` yields from inside one READ ONLY REPEATABLE READ
 * transaction (the /api/export pattern): every batch sees the same moment,
 * memory stays flat, and there is no size ceiling — Vercel's 4.5 MB limit
 * on a response body doesn't apply to a stream, so Cloud and self-hosted
 * export the same rows. The reader's pace sets the pace of the queries; a
 * failure part-way aborts the download instead of ending it looking whole.
 */
export function streamReadOnly(
  lines: (tx: Prisma.TransactionClient) => AsyncGenerator<string>,
  { timeoutMs }: { timeoutMs: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const chunks = new Promise<AsyncGenerator<string>>((resolve, reject) => {
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        resolve(lines(tx));
        await finished;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: timeoutMs },
    ).catch(reject);
  });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await (await chunks).next();
        if (done) {
          controller.close();
          finish();
        } else controller.enqueue(encoder.encode(value));
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel() {
      finish();
      await chunks.then((gen) => gen.return(undefined)).catch(() => {});
    },
  });
}

/** Rows per query while exporting. */
export const EXPORT_BATCH = 1_000;
