-- The launch list moved to the marketing site's own database (PR #148);
-- nothing here writes to it any more, and it was empty when dropped.
DROP TABLE IF EXISTS "LaunchSignup";
