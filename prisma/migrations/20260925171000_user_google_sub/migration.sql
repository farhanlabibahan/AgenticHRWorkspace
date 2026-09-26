-- Google sign-in: the Google account (its OIDC "sub") bound to a user on
-- their first Google sign-in. Nullable, so the code still serving during
-- the deploy is unaffected. User is a small table: plain index builds.
ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;

-- One Google account can sign in to several workspaces, as one user in each.
CREATE UNIQUE INDEX "User_orgId_googleSub_key" ON "User"("orgId", "googleSub");

CREATE INDEX "User_googleSub_idx" ON "User"("googleSub");
