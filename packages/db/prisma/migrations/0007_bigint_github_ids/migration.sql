-- GitHub workflow-run and check-run IDs now exceed 32-bit int range (~29B/87B).
-- Widen the columns to BIGINT. (repositoryId still fits int4 for now — tracked separately.)
ALTER TABLE "findings" ALTER COLUMN "workflowRunId" TYPE BIGINT;
ALTER TABLE "findings" ALTER COLUMN "checkRunId" TYPE BIGINT;
