-- The participants' names on a suggested notetaker meeting, so the review
-- card can show who was there and tell apart candidates with the same name.
-- Additive, with a constant default: no table rewrite.

-- AlterTable
ALTER TABLE "ExternalMeeting" ADD COLUMN "attendeeNames" TEXT[] DEFAULT ARRAY[]::TEXT[];
