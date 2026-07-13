---
phase: 02-detector-pipeline-and-ai-analysis
plan: "04"
subsystem: encryption
tags: [aes-256-gcm, byok, node-crypto, fastify, pino-redact, setup-endpoint]

# Dependency graph
requires:
  - phase: 02-01
    provides: encryptedApiKey String? column on Installation model (Prisma schema)
provides:
  - "encryptApiKey/decryptApiKey in @ciintel/core — AES-256-GCM, node:crypto only, shared by api + worker"
  - "POST /setup/:installationId in apps/api — validates sk-ant- key, authenticates via CYCLOPS_SETUP_SECRET, stores encrypted key"
  - "pino redact config in apps/api — x-setup-token header + apiKey + encryptedApiKey never hit logs"
affects:
  - 02-detector-pipeline-and-ai-analysis (worker plans that call decryptApiKey to retrieve BYOK key for createAnthropicForInstallation)
  - any future admin tooling that stores or rotates Anthropic keys

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AES-256-GCM single-column encoding: base64(iv[12] + authTag[16] + ciphertext)"
    - "timingSafeEqual with length-mismatch guard — prevents timing oracle on CYCLOPS_SETUP_SECRET comparison"
    - "pino redact paths: req.headers[x-setup-token], apiKey, encryptedApiKey, *.apiKey, *.encryptedApiKey"
    - "Prisma P2025 code catch for installation-not-found → 404"

key-files:
  created:
    - packages/core/src/crypto.ts
    - apps/api/src/routes/setup.ts
  modified:
    - packages/core/src/index.ts
    - apps/api/src/index.ts

# Execution metadata
decisions:
  - "[02-04]: Encryption lives in @ciintel/core (not apps/worker) so both apps/api (encrypt) and apps/worker (decrypt) share one implementation"
  - "[02-04]: timingSafeEqual length-mismatch guard — tokenHeader.length === setupSecret.length check before compare to prevent panic"

metrics:
  duration: "1m 59s"
  completed: "2026-07-13"
---

# Phase 2 Plan 4: BYOK Setup Endpoint & AES-256-GCM Encryption Summary

**One-liner:** AES-256-GCM encrypt/decrypt in @ciintel/core (node:crypto only) + POST /setup/:installationId in apps/api with shared-secret auth and pino key redaction.

## What Was Built

### Task 1 — AES-256-GCM utilities in @ciintel/core (commit: 1f705d4)

Created `packages/core/src/crypto.ts` implementing:
- `encryptApiKey(plaintext)` — generates 12-byte random IV, AES-256-GCM cipher, concatenates `iv[12] + authTag[16] + ciphertext` and encodes as base64
- `decryptApiKey(encoded)` — decodes base64, slices iv/authTag/ciphertext, verifies auth tag, returns plaintext
- `getEncryptionKey()` — reads `CYCLOPS_ENCRYPTION_KEY` hex env var, validates 32-byte length (64 hex chars)
- node:crypto ONLY — no external crypto libraries; core stays I/O-free

Exported both functions from `packages/core/src/index.ts` via `./crypto.js`.

### Task 2 — POST /setup/:installationId + log redaction (commit: b9f9a19)

Created `apps/api/src/routes/setup.ts`:
- Reads `CYCLOPS_SETUP_SECRET` at plugin registration; throws if missing (fail-fast)
- `POST /setup/:installationId` handler:
  - Auth: reads `x-setup-token` header, guards length mismatch, uses `timingSafeEqual` → 401 on failure
  - Validates `installationId` is a positive integer → 400 on failure
  - Validates `apiKey` body field starts with `sk-ant-` → 400 on failure
  - Calls `encryptApiKey(apiKey)` from `@ciintel/core`
  - Calls `db.installation.update({ where: { id }, data: { encryptedApiKey } })`
  - Catches Prisma P2025 (record not found) → 404
  - Logs only `{ installationId }` on success — key material never logged
  - Returns `{ ok: true }` on success

Updated `apps/api/src/index.ts`:
- Added pino redact config: `x-setup-token` header, `apiKey`, `encryptedApiKey`, `*.apiKey`, `*.encryptedApiKey` → `[REDACTED]`
- Registered `setupRoutes` after existing route registrations

## Verification Results

- `pnpm --filter @ciintel/core build` — exit 0
- `pnpm --filter @ciintel/api build` — exit 0
- `grep aes-256-gcm packages/core/src/crypto.ts` — PASS
- `grep /setup/:installationId apps/api/src/routes/setup.ts` — PASS
- `grep redact apps/api/src/index.ts` — PASS
- `grep encryptApiKey apps/api/src/routes/setup.ts` — PASS
- `grep x-setup-token apps/api/src/routes/setup.ts` — PASS

## Deviations from Plan

None — plan executed exactly as written.

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Encryption in @ciintel/core (not apps/worker) | Both apps/api (encrypt on store) and apps/worker (decrypt on use) share one implementation; no duplication |
| timingSafeEqual length-mismatch guard | `timingSafeEqual` throws if buffers differ in length; guard prevents RangeError and ensures clean 401 response |

## Next Phase Readiness

This plan satisfies the BYOK prerequisite for the worker plans (02-05, 02-06):
- `decryptApiKey` is now available from `@ciintel/core` for the AI analysis worker to retrieve the per-installation Anthropic key
- `createAnthropicForInstallation` in `@ciintel/ai` (02-03) can now receive the decrypted key at job execution time

**Pending env vars for deployment:**
- `CYCLOPS_ENCRYPTION_KEY` — 64-hex-char (32-byte) AES key; generate with `openssl rand -hex 32`
- `CYCLOPS_SETUP_SECRET` — shared secret for the setup endpoint; generate with `openssl rand -hex 32`
