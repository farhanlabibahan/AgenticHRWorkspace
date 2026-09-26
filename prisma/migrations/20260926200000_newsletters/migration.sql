-- Newsletters: one email to every candidate (src/server/newsletters.ts), and
-- per-contact bulk-email suppression. The two Contact columns are nullable
-- with no default, so adding them doesn't rewrite the table.

-- CreateEnum
CREATE TYPE "NewsletterStatus" AS ENUM ('DRAFT', 'SENDING', 'SENT');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "emailBouncedAt" TIMESTAMP(3),
ADD COLUMN     "emailOptOutAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Newsletter" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "postingIds" TEXT[],
    "baseUrl" TEXT,
    "status" "NewsletterStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "sentById" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "sendStartedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Newsletter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsletterRecipient" (
    "id" TEXT NOT NULL,
    "newsletterId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'PENDING',
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "NewsletterRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Newsletter_orgId_createdAt_idx" ON "Newsletter"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "NewsletterRecipient_newsletterId_status_idx" ON "NewsletterRecipient"("newsletterId", "status");

-- CreateIndex
CREATE INDEX "NewsletterRecipient_orgId_contactId_idx" ON "NewsletterRecipient"("orgId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "NewsletterRecipient_newsletterId_contactId_key" ON "NewsletterRecipient"("newsletterId", "contactId");

-- AddForeignKey
ALTER TABLE "Newsletter" ADD CONSTRAINT "Newsletter_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsletterRecipient" ADD CONSTRAINT "NewsletterRecipient_newsletterId_fkey" FOREIGN KEY ("newsletterId") REFERENCES "Newsletter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

