-- OCR for scanned resumes (src/server/resume-ocr.ts). Every new column is
-- nullable or has a constant default, so adding them rewrites nothing, and
-- the code running during the deploy never reads them. The OCR queue is
-- read like the resume-text one, without an index of its own.

-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('OK', 'LOW_CONFIDENCE', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "ocrAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ocrCheckedAt" TIMESTAMP(3),
ADD COLUMN     "ocrConfidence" INTEGER,
ADD COLUMN     "ocrError" TEXT,
ADD COLUMN     "ocrStatus" "OcrStatus",
ADD COLUMN     "ocrVersion" INTEGER;
