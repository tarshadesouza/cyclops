-- 0004_phase3_action_tables: Add cyclopsCheckRunId to findings, add pr_comments, action_dedups, autofix_prs, tracked_issues

ALTER TABLE "findings" ADD COLUMN "cyclopsCheckRunId" BIGINT;

CREATE TABLE "pr_comments" (
  "id"              TEXT          NOT NULL,
  "installationId"  INTEGER       NOT NULL,
  "repositoryId"    INTEGER       NOT NULL,
  "prNumber"        INTEGER       NOT NULL,
  "githubCommentId" BIGINT        NOT NULL,
  "createdAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "pr_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "action_dedups" (
  "id"             TEXT          NOT NULL,
  "installationId" INTEGER       NOT NULL,
  "repositoryId"   INTEGER       NOT NULL,
  "detectorType"   TEXT          NOT NULL,
  "ref"            TEXT          NOT NULL,
  "actionType"     TEXT          NOT NULL,
  "expiresAt"      TIMESTAMP(3)  NOT NULL,
  "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "action_dedups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "autofix_prs" (
  "id"             TEXT          NOT NULL,
  "installationId" INTEGER       NOT NULL,
  "repositoryId"   INTEGER       NOT NULL,
  "detectorType"   TEXT          NOT NULL,
  "sha"            TEXT          NOT NULL,
  "branchName"     TEXT          NOT NULL,
  "prNumber"       INTEGER       NOT NULL,
  "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "autofix_prs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tracked_issues" (
  "id"                TEXT          NOT NULL,
  "installationId"    INTEGER       NOT NULL,
  "repositoryId"      INTEGER       NOT NULL,
  "detectorType"      TEXT          NOT NULL,
  "ref"               TEXT          NOT NULL,
  "githubIssueNumber" INTEGER       NOT NULL,
  "createdAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tracked_issues_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "pr_comments_installationId_repositoryId_prNumber_key"
  ON "pr_comments"("installationId", "repositoryId", "prNumber");

CREATE UNIQUE INDEX "action_dedups_installationId_repositoryId_detectorType_ref_actionType_key"
  ON "action_dedups"("installationId", "repositoryId", "detectorType", "ref", "actionType");

CREATE UNIQUE INDEX "autofix_prs_installationId_repositoryId_detectorType_sha_key"
  ON "autofix_prs"("installationId", "repositoryId", "detectorType", "sha");

CREATE UNIQUE INDEX "tracked_issues_installationId_repositoryId_detectorType_ref_key"
  ON "tracked_issues"("installationId", "repositoryId", "detectorType", "ref");

-- Indexes
CREATE INDEX "pr_comments_installationId_idx"    ON "pr_comments"("installationId");
CREATE INDEX "action_dedups_expiresAt_idx"        ON "action_dedups"("expiresAt");
CREATE INDEX "autofix_prs_installationId_idx"     ON "autofix_prs"("installationId");
CREATE INDEX "tracked_issues_installationId_idx"  ON "tracked_issues"("installationId");

-- RLS (same pattern as 0002_rls and 0003_phase2)
ALTER TABLE "pr_comments"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "action_dedups"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "autofix_prs"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracked_issues" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "pr_comments"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "action_dedups"  FORCE ROW LEVEL SECURITY;
ALTER TABLE "autofix_prs"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "tracked_issues" FORCE ROW LEVEL SECURITY;

CREATE POLICY "pr_comments_tenant_isolation" ON "pr_comments"
  USING ("installationId" = current_installation_id());

CREATE POLICY "action_dedups_tenant_isolation" ON "action_dedups"
  USING ("installationId" = current_installation_id());

CREATE POLICY "autofix_prs_tenant_isolation" ON "autofix_prs"
  USING ("installationId" = current_installation_id());

CREATE POLICY "tracked_issues_tenant_isolation" ON "tracked_issues"
  USING ("installationId" = current_installation_id());

CREATE POLICY "pr_comments_service_bypass" ON "pr_comments"
  TO "postgres" USING (true);

CREATE POLICY "action_dedups_service_bypass" ON "action_dedups"
  TO "postgres" USING (true);

CREATE POLICY "autofix_prs_service_bypass" ON "autofix_prs"
  TO "postgres" USING (true);

CREATE POLICY "tracked_issues_service_bypass" ON "tracked_issues"
  TO "postgres" USING (true);
