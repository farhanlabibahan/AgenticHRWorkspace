-- AlterTable
ALTER TABLE "Posting" ADD COLUMN     "ownerId" TEXT;

-- CreateIndex
CREATE INDEX "Posting_ownerId_idx" ON "Posting"("ownerId");

-- AddForeignKey
ALTER TABLE "Posting" ADD CONSTRAINT "Posting_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

