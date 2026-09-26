-- Role match criteria, and each evaluation's score against them.
ALTER TABLE "Posting" ADD COLUMN "matchCriteria" JSONB;
ALTER TABLE "AiEvaluation" ADD COLUMN "criteria" JSONB,
ADD COLUMN "matchScore" INTEGER;
