-- AlterTable: per-installation AI provider configuration.
-- provider is "direct" (Anthropic BYOK) or "proxy" (custom Anthropic-compatible gateway).
-- Endpoint, optional identifying header, and model are supplied at runtime.
ALTER TABLE "installations" ADD COLUMN "aiProvider" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "installations" ADD COLUMN "aiBaseUrl" TEXT;
ALTER TABLE "installations" ADD COLUMN "aiHeaderName" TEXT;
ALTER TABLE "installations" ADD COLUMN "aiHeaderValue" TEXT;
ALTER TABLE "installations" ADD COLUMN "aiModel" TEXT;
