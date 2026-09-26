-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- DropIndex
DROP INDEX "Contact_orgId_emails_idx";

-- DropIndex
DROP INDEX "StageTransition_opportunityId_idx";

-- DropIndex
DROP INDEX "Transcript_orgId_idx";

-- CreateIndex
CREATE INDEX "Contact_orgId_createdAt_idx" ON "Contact"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Contact_emails_idx" ON "Contact" USING GIN ("emails");

-- CreateIndex
CREATE INDEX "Contact_tags_idx" ON "Contact" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "Contact_name_trgm_idx" ON "Contact" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_headline_trgm_idx" ON "Contact" USING GIN ("headline" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_location_trgm_idx" ON "Contact" USING GIN ("location" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_resumeText_trgm_idx" ON "Contact" USING GIN ("resumeText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Opportunity_orgId_stageChangedAt_idx" ON "Opportunity"("orgId", "stageChangedAt");

-- CreateIndex
CREATE INDEX "Opportunity_orgId_createdAt_idx" ON "Opportunity"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "StageTransition_opportunityId_occurredAt_idx" ON "StageTransition"("opportunityId", "occurredAt");

-- CreateIndex
CREATE INDEX "StageTransition_toStageId_idx" ON "StageTransition"("toStageId");

-- CreateIndex
CREATE INDEX "Note_orgId_createdAt_idx" ON "Note"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Note_body_trgm_idx" ON "Note" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Interview_orgId_startAt_idx" ON "Interview"("orgId", "startAt");

-- CreateIndex
CREATE INDEX "Transcript_orgId_createdAt_idx" ON "Transcript"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Transcript_content_trgm_idx" ON "Transcript" USING GIN ("content" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Transcript_title_trgm_idx" ON "Transcript" USING GIN ("title" gin_trgm_ops);

