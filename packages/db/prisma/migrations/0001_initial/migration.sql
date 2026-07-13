-- 0001_initial: Create installations and webhook_deliveries tables

CREATE TABLE "installations" (
  "id"           INTEGER       NOT NULL,
  "accountLogin" TEXT          NOT NULL,
  "accountType"  TEXT          NOT NULL,
  "appId"        INTEGER       NOT NULL,
  "targetId"     INTEGER       NOT NULL,
  "targetType"   TEXT          NOT NULL,
  "suspended"    BOOLEAN       NOT NULL DEFAULT false,
  "deletedAt"    TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)  NOT NULL,

  CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_deliveries" (
  "id"             TEXT          NOT NULL,
  "deliveryId"     TEXT          NOT NULL,
  "installationId" INTEGER       NOT NULL,
  "eventName"      TEXT          NOT NULL,
  "action"         TEXT,
  "payload"        JSONB         NOT NULL,
  "enqueuedAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"    TIMESTAMP(3),

  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_deliveries_deliveryId_key" ON "webhook_deliveries"("deliveryId");
CREATE INDEX "webhook_deliveries_installationId_idx" ON "webhook_deliveries"("installationId");
CREATE INDEX "webhook_deliveries_deliveryId_idx" ON "webhook_deliveries"("deliveryId");

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "installations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
