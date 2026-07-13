---
phase: 02-detector-pipeline-and-ai-analysis
plan: 04
type: execute
wave: 3
depends_on: ["02-01"]
files_modified:
  - packages/core/src/crypto.ts
  - packages/core/src/index.ts
  - apps/api/src/routes/setup.ts
  - apps/api/src/index.ts
autonomous: true

must_haves:
  truths:
    - "An admin can POST an Anthropic API key for an installation and have it stored AES-256-GCM encrypted"
    - "The stored value is base64(iv[12] + authTag[16] + ciphertext) in a single column"
    - "decryptApiKey round-trips the exact plaintext key"
    - "The setup endpoint rejects callers without the correct CYCLOPS_SETUP_SECRET"
    - "The API key and encryptedApiKey never appear in logs"
  artifacts:
    - path: "packages/core/src/crypto.ts"
      provides: "encryptApiKey, decryptApiKey (node:crypto AES-256-GCM only)"
      contains: "aes-256-gcm"
    - path: "apps/api/src/routes/setup.ts"
      provides: "POST /setup/:installationId route"
      contains: "/setup/:installationId"
    - path: "apps/api/src/index.ts"
      provides: "setup route registration + pino redact for the key"
      contains: "redact"
  key_links:
    - from: "apps/api/src/routes/setup.ts"
      to: "packages/core encryptApiKey"
      via: "import { encryptApiKey } from '@ciintel/core'"
      pattern: "encryptApiKey"
    - from: "apps/api/src/routes/setup.ts"
      to: "installations.encryptedApiKey"
      via: "db.installation.update"
      pattern: "encryptedApiKey"
---

<objective>
Provide the BYOK path: AES-256-GCM encryption utilities in @ciintel/core (node:crypto only, shared by api + worker) and a `POST /setup/:installationId` endpoint in apps/api that validates, encrypts, and stores the Anthropic key — with pino redaction so the key never hits logs.

Purpose: Installations must be able to supply their key via curl/CLI (no UI) and have it stored securely. Satisfies the BYOK requirement and constraints 3 (no key in logs) and 8 (node:crypto only).
Output: Shared encrypt/decrypt in core; a working setup route gated by a shared secret.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/phases/02-detector-pipeline-and-ai-analysis/02-RESEARCH.md
@apps/api/src/index.ts
@apps/api/src/routes/webhooks.ts
@apps/api/src/routes/health.ts
</context>

<user_setup>
  - service: cyclops-encryption
    why: "Encrypt BYOK API keys at rest and authenticate the setup endpoint"
    env_vars:
      - name: CYCLOPS_ENCRYPTION_KEY
        source: "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" (64 hex chars), store in Railway env for both apps/api and apps/worker"
      - name: CYCLOPS_SETUP_SECRET
        source: "Admin-chosen shared secret; store in Railway env for apps/api"
    dashboard_config: []
</user_setup>

<tasks>

<task type="auto">
  <name>Task 1: AES-256-GCM utilities in @ciintel/core</name>
  <files>packages/core/src/crypto.ts, packages/core/src/index.ts</files>
  <action>
1. Create `packages/core/src/crypto.ts` per RESEARCH.md lines 651-684:
   - `import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';`
   - Constants: ALGORITHM = 'aes-256-gcm', IV_LENGTH = 12, TAG_LENGTH = 16.
   - `getEncryptionKey()` — read `process.env['CYCLOPS_ENCRYPTION_KEY']`, throw if missing, `Buffer.from(keyHex,'hex')`, throw if length !== 32.
   - `encryptApiKey(plaintext)` — random 12-byte IV, cipher, `Buffer.concat([iv, authTag, encrypted]).toString('base64')`.
   - `decryptApiKey(encoded)` — base64 decode, subarray IV[0:12], authTag[12:28], ciphertext[28:], setAuthTag, return utf-8 plaintext.
   CONSTRAINT 8: node:crypto ONLY — no external crypto libs. CONSTRAINT 7: core stays I/O-free — node:crypto + process.env are pure/config, no Octokit/Redis/Prisma.

2. In `packages/core/src/index.ts`, add `export { encryptApiKey, decryptApiKey } from './crypto.js';`

3. Build @ciintel/core.

DECISION: encryption lives in @ciintel/core (not apps/worker as the research sketch suggested) so both apps/api (encrypt) and apps/worker (decrypt) share one implementation without duplication. This keeps core I/O-free (crypto is pure computation) and DRY.
  </action>
  <verify>
`pnpm --filter @ciintel/core build` exits 0; `grep -q "aes-256-gcm" packages/core/src/crypto.ts`. Round-trip test: `CYCLOPS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") node --input-type=module -e "import('./packages/core/dist/crypto.js').then(m=>{const e=m.encryptApiKey('sk-ant-test');console.log(m.decryptApiKey(e)==='sk-ant-test')})"` prints `true`.
  </verify>
  <done>encryptApiKey/decryptApiKey round-trip correctly using node:crypto AES-256-GCM; exported from @ciintel/core; core has no I/O deps.</done>
</task>

<task type="auto">
  <name>Task 2: POST /setup/:installationId route + registration + log redaction</name>
  <files>apps/api/src/routes/setup.ts, apps/api/src/index.ts</files>
  <action>
1. Create `apps/api/src/routes/setup.ts` — a Fastify plugin `setupRoutes(app)` (mirror the shape of webhooks.ts / health.ts, ESM `.js` imports):
   - Read `const setupSecret = process.env['CYCLOPS_SETUP_SECRET'];` at registration; throw if missing (fail fast like webhookRoutes does for GITHUB_WEBHOOK_SECRET).
   - `app.post('/setup/:installationId', async (request, reply) => {...})`:
     - Auth (chosen scheme — shared secret, RESEARCH.md Open Question 1 option 2): read `x-setup-token` header; if it does not `timingSafeEqual` match setupSecret → 401 `{ error: 'Unauthorized' }`. Use node:crypto timingSafeEqual with equal-length buffers (guard length mismatch → 401).
     - Parse `installationId` from params via parseInt; validate positive integer else 400.
     - Body `{ apiKey }` — validate with zod (`z.object({ apiKey: z.string().min(1) })`); if `!apiKey.startsWith('sk-ant-')` → 400 `{ error: 'Invalid Anthropic API key format' }`.
     - `const encrypted = encryptApiKey(apiKey);` (import from `@ciintel/core`).
     - `const db = getDb();` (import from `@ciintel/db`; base client — installation table update, not tenant-scoped). `await db.installation.update({ where: { id: installationId }, data: { encryptedApiKey: encrypted } });` Catch Prisma "record not found" → 404 `{ error: 'Installation not found' }`.
     - Return 200 `{ ok: true }`.
     - Log only `{ installationId }` on success — NEVER log apiKey or encrypted value.

2. In `apps/api/src/index.ts`:
   - Configure the Fastify logger with redaction so secrets never serialize:
     `logger: { level: ..., redact: { paths: ['req.headers["x-setup-token"]', 'apiKey', 'encryptedApiKey', '*.apiKey', '*.encryptedApiKey'], censor: '[REDACTED]' } }`
   - `await app.register(setupRoutes);` after the existing route registrations.

3. Build apps/api.
  </action>
  <verify>
`pnpm --filter @ciintel/api build` exits 0; `grep -q "/setup/:installationId" apps/api/src/routes/setup.ts`; `grep -q "redact" apps/api/src/index.ts`; `grep -q "encryptApiKey" apps/api/src/routes/setup.ts`; `grep -q "x-setup-token" apps/api/src/routes/setup.ts`. Confirm apiKey is never passed to any `log`/`app.log` call in setup.ts (manual grep: `grep -n "log" apps/api/src/routes/setup.ts` shows no apiKey argument).
  </verify>
  <done>POST /setup/:installationId validates the sk-ant- key, authenticates via CYCLOPS_SETUP_SECRET, stores the encrypted key, and the logger redacts the token/key; route registered in index.ts.</done>
</task>

</tasks>

<verification>
- `pnpm --filter @ciintel/core build && pnpm --filter @ciintel/api build` exit 0
- Encrypt/decrypt round-trips a sk-ant- key
- Setup route rejects wrong/absent x-setup-token with 401
- Logger redact config present; no apiKey logged
</verification>

<success_criteria>
- BYOK key stored AES-256-GCM encrypted (single base64 column) via node:crypto only
- Setup endpoint authenticated by shared secret, validates key format
- Key material never written to logs (pino redact)
</success_criteria>

<output>
After completion, create `.planning/phases/02-detector-pipeline-and-ai-analysis/02-04-SUMMARY.md`
</output>
