-- Meeting notetakers over MCP: per-user connections, the shared OAuth client
-- registrations, sign-ins in progress, and the meetings that lined up with an
-- interview (see "Meeting notetakers over MCP" in schema.prisma). All new,
-- empty tables, so plain CREATE INDEX is fine.

-- CreateEnum
CREATE TYPE "NotetakerAuthType" AS ENUM ('OAUTH', 'API_KEY');

-- CreateEnum
CREATE TYPE "NotetakerStatus" AS ENUM ('PENDING', 'ACTIVE', 'NEEDS_RECONNECT', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ExternalMeetingStatus" AS ENUM ('ATTACHED', 'SUGGESTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "TranscriptConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "serverUrl" TEXT NOT NULL,
    "authType" "NotetakerAuthType" NOT NULL DEFAULT 'OAUTH',
    "credentials" TEXT,
    "redirectUri" TEXT,
    "status" "NotetakerStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncedAt" TIMESTAMP(3),
    "syncCursor" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthFlow" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "discoveryState" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalMeeting" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "attendeeEmails" TEXT[],
    "interviewId" TEXT,
    "status" "ExternalMeetingStatus" NOT NULL,
    "transcriptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TranscriptConnection_orgId_idx" ON "TranscriptConnection"("orgId");

-- CreateIndex
CREATE INDEX "TranscriptConnection_status_lastSyncedAt_idx" ON "TranscriptConnection"("status", "lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptConnection_userId_provider_key" ON "TranscriptConnection"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthClient_issuer_redirectUri_key" ON "McpOAuthClient"("issuer", "redirectUri");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthFlow_state_key" ON "McpOAuthFlow"("state");

-- CreateIndex
CREATE INDEX "McpOAuthFlow_connectionId_idx" ON "McpOAuthFlow"("connectionId");

-- CreateIndex
CREATE INDEX "McpOAuthFlow_expiresAt_idx" ON "McpOAuthFlow"("expiresAt");

-- CreateIndex
CREATE INDEX "ExternalMeeting_orgId_provider_externalId_idx" ON "ExternalMeeting"("orgId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "ExternalMeeting_connectionId_status_idx" ON "ExternalMeeting"("connectionId", "status");

-- CreateIndex
CREATE INDEX "ExternalMeeting_interviewId_idx" ON "ExternalMeeting"("interviewId");

-- CreateIndex
CREATE INDEX "ExternalMeeting_transcriptId_idx" ON "ExternalMeeting"("transcriptId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMeeting_connectionId_externalId_key" ON "ExternalMeeting"("connectionId", "externalId");

-- AddForeignKey
ALTER TABLE "TranscriptConnection" ADD CONSTRAINT "TranscriptConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptConnection" ADD CONSTRAINT "TranscriptConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthFlow" ADD CONSTRAINT "McpOAuthFlow_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TranscriptConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMeeting" ADD CONSTRAINT "ExternalMeeting_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMeeting" ADD CONSTRAINT "ExternalMeeting_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TranscriptConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMeeting" ADD CONSTRAINT "ExternalMeeting_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalMeeting" ADD CONSTRAINT "ExternalMeeting_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE SET NULL ON UPDATE CASCADE;

