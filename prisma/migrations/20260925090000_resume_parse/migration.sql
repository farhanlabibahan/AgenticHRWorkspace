-- Resume parsing (src/server/resume-parse). Every new column is nullable or
-- has a constant default, so adding them rewrites nothing, and the code
-- running during the deploy never reads them. StoredFile holds one row per
-- stored file, so these indexes build quickly (the same as its contactId one).

-- CreateEnum
CREATE TYPE "ParseStatus" AS ENUM ('QUEUED', 'OK', 'EMPTY', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "parseAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parseCheckedAt" TIMESTAMP(3),
ADD COLUMN     "parseError" TEXT,
ADD COLUMN     "parseModel" TEXT,
ADD COLUMN     "parseQueuedAt" TIMESTAMP(3),
ADD COLUMN     "parseStatus" "ParseStatus",
ADD COLUMN     "parsed" JSONB;

-- CreateIndex
CREATE INDEX "StoredFile_parseStatus_parseQueuedAt_idx" ON "StoredFile"("parseStatus", "parseQueuedAt");

-- CreateIndex
CREATE INDEX "StoredFile_parseCheckedAt_orgId_idx" ON "StoredFile"("parseCheckedAt", "orgId");

-- CreateIndex
CREATE INDEX "StoredFile_orgId_parseQueuedAt_idx" ON "StoredFile"("orgId", "parseQueuedAt");
