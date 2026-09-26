-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('DISCOVERING', 'REVIEW', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "contactId" TEXT;

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'DISCOVERING',
    "accountName" TEXT,
    "credentials" TEXT,
    "options" JSONB NOT NULL,
    "catalog" JSONB,
    "mapping" JSONB,
    "phase" TEXT,
    "cursor" JSONB,
    "stats" JSONB,
    "issues" JSONB,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRef" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "internalId" TEXT NOT NULL,
    "created" BOOLEAN NOT NULL DEFAULT true,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_orgId_createdAt_idx" ON "ImportJob"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_status_leaseUntil_idx" ON "ImportJob"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "ImportRef_jobId_kind_idx" ON "ImportRef"("jobId", "kind");

-- CreateIndex
CREATE INDEX "ImportRef_internalId_idx" ON "ImportRef"("internalId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRef_orgId_provider_kind_externalId_key" ON "ImportRef"("orgId", "provider", "kind", "externalId");

-- CreateIndex
CREATE INDEX "StoredFile_contactId_idx" ON "StoredFile"("contactId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRef" ADD CONSTRAINT "ImportRef_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

