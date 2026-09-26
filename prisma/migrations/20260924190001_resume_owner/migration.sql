-- Careers-page resumes were stored without an owner. Give every current
-- resume its contact, so that once a re-application replaces it, the old file
-- is still theirs and anonymizing them deletes it (retention already deletes
-- the current resume through Contact.resumeFileId). Resumes replaced before
-- this ran have no link left to their contact, so this can't reach them.
-- Its own migration: Prisma runs each file in one transaction, and here the
-- update holds only row locks, not the ALTER TABLE's lock on all of StoredFile.
UPDATE "StoredFile" sf SET "contactId" = c."id"
FROM "Contact" c
WHERE c."resumeFileId" = sf."id" AND sf."contactId" IS NULL;
