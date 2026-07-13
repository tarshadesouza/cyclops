-- 0002_rls: Enable Row-Level Security on tenant tables

ALTER TABLE "installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION current_installation_id() RETURNS INTEGER AS $$
  SELECT NULLIF(current_setting('app.current_installation_id', true), '')::INTEGER;
$$ LANGUAGE SQL STABLE;

CREATE POLICY "installations_tenant_isolation" ON "installations"
  USING (id = current_installation_id());

CREATE POLICY "webhook_deliveries_tenant_isolation" ON "webhook_deliveries"
  USING ("installationId" = current_installation_id());

CREATE POLICY "installations_service_bypass" ON "installations"
  TO "postgres"
  USING (true);

CREATE POLICY "webhook_deliveries_service_bypass" ON "webhook_deliveries"
  TO "postgres"
  USING (true);
