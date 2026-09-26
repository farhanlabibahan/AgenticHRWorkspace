-- The open-source launch list: an email per person who asked to be told.
CREATE TABLE "LaunchSignup" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LaunchSignup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LaunchSignup_email_key" ON "LaunchSignup"("email");
