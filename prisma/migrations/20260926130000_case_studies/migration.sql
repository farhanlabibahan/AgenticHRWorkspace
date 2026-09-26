-- Case studies on a candidate, for their presentation.
CREATE TABLE "CaseStudy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "imageUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseStudy_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CaseStudy_contactId_position_idx" ON "CaseStudy"("contactId", "position");
CREATE INDEX "CaseStudy_orgId_idx" ON "CaseStudy"("orgId");
ALTER TABLE "CaseStudy" ADD CONSTRAINT "CaseStudy_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
