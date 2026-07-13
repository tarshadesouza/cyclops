-- 0003_phase2: Add findings, token_usages, encryptedApiKey

ALTER TABLE "installations" ADD COLUMN "encryptedApiKey" TEXT;

CREATE TABLE "findings" (
  "id"               TEXT          NOT NULL,
  "installationId"   INTEGER       NOT NULL,
  "repositoryId"     INTEGER       NOT NULL,
  "workflowRunId"    INTEGER       NOT NULL,
  "checkRunId"       INTEGER       NOT NULL,
  "detectorType"     TEXT          NOT NULL,
  "sha"              TEXT          NOT NULL,
  "ref"              TEXT          NOT NULL,
  "violations"       JSONB         NOT NULL DEFAULT '[]',
  "rawExcerpt"       TEXT,
  "confidence"       DOUBLE PRECISION,
  "evidence"         TEXT[]        NOT NULL DEFAULT '{}',
  "caveat"           TEXT,
  "rootCause"        TEXT,
  "suggestedFix"     TEXT,
  "affectedFiles"    TEXT[]        NOT NULL DEFAULT '{}',
  "severity"         TEXT,
  "aiEnrichedAt"     TIMESTAMP(3),
  "advancedToAction" BOOLEAN       NOT NULL DEFAULT false,
  "budgetExceeded"   BOOLEAN       NOT NULL DEFAULT false,
  "deletedAt"        TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "token_usages" (
  "id"             TEXT          NOT NULL,
  "installationId" INTEGER       NOT NULL,
  "detectorId"     TEXT          NOT NULL,
  "model"          TEXT          NOT NULL,
  "inputTokens"    INTEGER       NOT NULL,
  "outputTokens"   INTEGER       NOT NULL,
  "timestamp"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "token_usages_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "findings_installationId_idx" ON "findings"("installationId");
CREATE INDEX "findings_workflowRunId_idx" ON "findings"("workflowRunId");
CREATE INDEX "findings_installationId_createdAt_idx" ON "findings"("installationId", "createdAt");
CREATE INDEX "token_usages_installationId_idx" ON "token_usages"("installationId");
CREATE INDEX "token_usages_installationId_timestamp_idx" ON "token_usages"("installationId", "timestamp");

-- Foreign keys
ALTER TABLE "findings" ADD CONSTRAINT "findings_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "installations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "token_usages" ADD CONSTRAINT "token_usages_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "installations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (same pattern as 0002_rls)
ALTER TABLE "findings"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "token_usages"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "findings"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "token_usages"  FORCE ROW LEVEL SECURITY;

CREATE POLICY "findings_tenant_isolation" ON "findings"
  USING ("installationId" = current_installation_id());

CREATE POLICY "token_usages_tenant_isolation" ON "token_usages"
  USING ("installationId" = current_installation_id());

CREATE POLICY "findings_service_bypass" ON "findings"
  TO "postgres" USING (true);

CREATE POLICY "token_usages_service_bypass" ON "token_usages"
  TO "postgres" USING (true);
