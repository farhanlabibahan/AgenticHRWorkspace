-- Re-imports: what each imported record looked like at the vendor when it
-- was last read (see ImportRef in schema.prisma). Nullable, so refs from
-- earlier imports stay valid.
ALTER TABLE "ImportRef" ADD COLUMN "fingerprint" TEXT,
ADD COLUMN "snapshot" JSONB,
ADD COLUMN "syncedAt" TIMESTAMP(3);
