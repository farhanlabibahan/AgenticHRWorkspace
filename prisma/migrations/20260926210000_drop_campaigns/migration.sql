-- Nurture campaigns left the open-source core: multi-step sequences are a
-- Source ATS feature. Production had no campaigns when these were dropped.
DROP TABLE IF EXISTS "CampaignEnrollment";
DROP TABLE IF EXISTS "CampaignStep";
DROP TABLE IF EXISTS "Campaign";
