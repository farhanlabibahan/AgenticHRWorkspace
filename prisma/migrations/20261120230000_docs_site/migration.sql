CREATE TABLE "DocsSite" (
  "orgId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "content" JSONB NOT NULL,
  "team" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocsSite_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "DocsSite" ADD CONSTRAINT "DocsSite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
