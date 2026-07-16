-- 0008_fix_sessions: agentic fix-loop session state (Phase 6 step 2)

CREATE TABLE "fix_sessions" (
  "id"             TEXT          NOT NULL,
  "installationId" INTEGER       NOT NULL,
  "repositoryId"   INTEGER       NOT NULL,
  "findingId"      TEXT          NOT NULL,
  "detectorType"   TEXT          NOT NULL,
  "mode"           TEXT          NOT NULL,
  "branchName"     TEXT          NOT NULL,
  "baseBranch"     TEXT          NOT NULL,
  "prNumber"       INTEGER,
  "commentId"      BIGINT,
  "status"         TEXT          NOT NULL DEFAULT 'running',
  "iteration"      INTEGER       NOT NULL DEFAULT 0,
  "maxIterations"  INTEGER       NOT NULL DEFAULT 5,
  "lastSha"        TEXT,
  "lastFailureSig" TEXT,
  "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "fix_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fix_sessions_installationId_idx"
  ON "fix_sessions"("installationId");
CREATE INDEX "fix_sessions_installationId_repositoryId_branchName_idx"
  ON "fix_sessions"("installationId", "repositoryId", "branchName");
CREATE INDEX "fix_sessions_installationId_findingId_idx"
  ON "fix_sessions"("installationId", "findingId");
CREATE INDEX "fix_sessions_status_idx"
  ON "fix_sessions"("status");

ALTER TABLE "fix_sessions"
  ADD CONSTRAINT "fix_sessions_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "installations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (same pattern as 0002_rls / 0004_phase3_action_tables)
ALTER TABLE "fix_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fix_sessions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "fix_sessions_tenant_isolation" ON "fix_sessions"
  USING ("installationId" = current_installation_id());

CREATE POLICY "fix_sessions_service_bypass" ON "fix_sessions"
  TO "postgres"
  USING (true);
