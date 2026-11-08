-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "candidateAccountId" TEXT;

-- CreateTable
CREATE TABLE "CandidateAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "candidateAccountId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmploymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAccount_email_key" ON "CandidateAccount"("email");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentRecord_opportunityId_key" ON "EmploymentRecord"("opportunityId");

-- CreateIndex
CREATE INDEX "EmploymentRecord_candidateAccountId_idx" ON "EmploymentRecord"("candidateAccountId");

-- CreateIndex
CREATE INDEX "EmploymentRecord_orgId_idx" ON "EmploymentRecord"("orgId");

-- CreateIndex
CREATE INDEX "Contact_candidateAccountId_idx" ON "Contact"("candidateAccountId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_candidateAccountId_fkey" FOREIGN KEY ("candidateAccountId") REFERENCES "CandidateAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_candidateAccountId_fkey" FOREIGN KEY ("candidateAccountId") REFERENCES "CandidateAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
