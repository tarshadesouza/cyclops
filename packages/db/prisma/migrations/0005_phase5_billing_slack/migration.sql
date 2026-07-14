-- AlterTable
ALTER TABLE "installations" ADD COLUMN "billingStatus" TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE "installations" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "installations" ADD COLUMN "billingCancelAt" TIMESTAMP(3);
ALTER TABLE "installations" ADD COLUMN "marketplacePlanId" INTEGER;
ALTER TABLE "installations" ADD COLUMN "marketplacePlanName" TEXT;
ALTER TABLE "installations" ADD COLUMN "encryptedSlackToken" TEXT;
ALTER TABLE "installations" ADD COLUMN "slackTeamId" TEXT;
ALTER TABLE "installations" ADD COLUMN "slackTeamName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "installations_targetId_key" ON "installations"("targetId");
