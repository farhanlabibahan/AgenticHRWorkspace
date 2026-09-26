-- CreateEnum
CREATE TYPE "TextStatus" AS ENUM ('OK', 'EMPTY', 'UNSUPPORTED', 'ENCRYPTED', 'TOO_LARGE', 'MISSING', 'FAILED');

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "textAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "textCheckedAt" TIMESTAMP(3),
ADD COLUMN     "textError" TEXT,
ADD COLUMN     "textStatus" "TextStatus",
ADD COLUMN     "textVersion" INTEGER;

-- CreateTable
CREATE TABLE "CronLease" (
    "name" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,

    CONSTRAINT "CronLease_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "Contact_resumeFileId_idx" ON "Contact"("resumeFileId");
