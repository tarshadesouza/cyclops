---
phase: 01-github-app-foundation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - pnpm-workspace.yaml
  - turbo.json
  - tsconfig.base.json
  - package.json
  - .npmrc
  - apps/api/package.json
  - apps/api/tsconfig.json
  - apps/worker/package.json
  - apps/worker/tsconfig.json
  - packages/core/package.json
  - packages/core/tsconfig.json
  - packages/core/src/index.ts
  - packages/db/package.json
  - packages/db/tsconfig.json
  - packages/github/package.json
  - packages/github/tsconfig.json
  - packages/queue/package.json
  - packages/queue/tsconfig.json
  - .gitignore
  - .github/workflows/ci.yml
autonomous: true

must_haves:
  truths:
    - "pnpm install succeeds from the repo root with no errors"
    - "turbo build runs without error (no actual source to compile yet, but task graph resolves)"
    - "All 6 packages appear in pnpm list --recursive"
    - "TypeScript strict mode is inherited by all packages via tsconfig.base.json"
    - "Each package's tsconfig extends tsconfig.base.json with nodenext moduleResolution and es2025 target"
  artifacts:
    - path: "pnpm-workspace.yaml"
      provides: "Workspace package glob"
    - path: "turbo.json"
      provides: "Turborepo task pipeline (tasks key, not pipeline)"
    - path: "tsconfig.base.json"
      provides: "Shared TypeScript config base"
    - path: "apps/api/package.json"
      provides: "@ciintel/api package manifest"
    - path: "apps/worker/package.json"
      provides: "@ciintel/worker package manifest"
    - path: "packages/core/package.json"
      provides: "@ciintel/core package manifest"
    - path: "packages/db/package.json"
      provides: "@ciintel/db package manifest"
    - path: "packages/github/package.json"
      provides: "@ciintel/github package manifest"
    - path: "packages/queue/package.json"
      provides: "@ciintel/queue package manifest"
  key_links:
    - from: "apps/api/tsconfig.json"
      to: "tsconfig.base.json"
      via: "extends"
      pattern: "extends.*tsconfig.base"
    - from: "apps/worker/tsconfig.json"
      to: "tsconfig.base.json"
      via: "extends"
      pattern: "extends.*tsconfig.base"
    - from: "turbo.json"
      to: "package.json scripts"
      via: "tasks.build pipeline"
      pattern: "\"tasks\""
---

<objective>
Bootstrap the complete pnpm + Turborepo 2 monorepo skeleton with all 6 packages/apps scaffolded, strict TypeScript config in place, and a GitHub Actions CI workflow.

Purpose: Every subsequent plan depends on this scaffold existing. Plans 02 and 03 run in parallel immediately after this plan completes. Getting the workspace, build graph, and TypeScript config right here prevents every downstream executor from fighting tooling issues.

Output: A working monorepo root where `pnpm install` and `turbo build` both succeed, with correct package names, dependency declarations, and TypeScript inheritance.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/tsouza/Projects/ciintel/.planning/PROJECT.md
@/Users/tsouza/Projects/ciintel/.planning/ROADMAP.md
@/Users/tsouza/Projects/ciintel/.planning/STATE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Root workspace config — pnpm-workspace, turbo.json, root tsconfig, root package.json</name>
  <files>
    pnpm-workspace.yaml
    turbo.json
    tsconfig.base.json
    package.json
    .npmrc
    .gitignore
  </files>
  <action>
Initialize the repo root with the following files. The repo root is /Users/tsouza/Projects/ciintel.

**pnpm-workspace.yaml:**
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

**turbo.json** (Turborepo 2 — use `tasks` key, NOT `pipeline`):
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "lint": {}
  }
}
```

**tsconfig.base.json** (TypeScript 7 hard requirements — nodenext, es2025, no baseUrl):
```json
{
  "compilerOptions": {
    "target": "es2025",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "incremental": true
  }
}
```

**package.json** (root — private, workspace manager, dev tooling only):
```json
{
  "name": "ciintel",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "clean": "turbo run clean && find . -name node_modules -type d -prune -exec rm -rf '{}' +"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.8.0"
  }
}
```

**.npmrc:**
```
shamefully-hoist=false
strict-peer-dependencies=false
```

**.gitignore:**
```
node_modules/
dist/
.turbo/
*.tsbuildinfo
.env
.env.local
.env.*.local
prisma/migrations/dev.db
*.log
.DS_Store
```
  </action>
  <verify>
From /Users/tsouza/Projects/ciintel: `cat pnpm-workspace.yaml` shows apps/* and packages/*. `cat turbo.json` has "tasks" key (not "pipeline"). `cat tsconfig.base.json` has "moduleResolution": "nodenext" and "target": "es2025".
  </verify>
  <done>Root config files exist with correct Turborepo 2 schema, TypeScript 7-compatible base config, and pnpm workspace declarations.</done>
</task>

<task type="auto">
  <name>Task 2: All 6 package/app scaffolds with package.json, tsconfig.json, and stub index files</name>
  <files>
    apps/api/package.json
    apps/api/tsconfig.json
    apps/api/src/index.ts
    apps/worker/package.json
    apps/worker/tsconfig.json
    apps/worker/src/index.ts
    packages/core/package.json
    packages/core/tsconfig.json
    packages/core/src/index.ts
    packages/db/package.json
    packages/db/tsconfig.json
    packages/db/src/index.ts
    packages/github/package.json
    packages/github/tsconfig.json
    packages/github/src/index.ts
    packages/queue/package.json
    packages/queue/tsconfig.json
    packages/queue/src/index.ts
  </files>
  <action>
Create the directory tree and files below. Every tsconfig.json extends the root tsconfig.base.json with a relative path. All relative imports within each package must use .js extensions (TypeScript nodenext requirement). Stub index files export a placeholder comment so `tsc --noEmit` passes.

**apps/api/package.json:**
```json
{
  "name": "@ciintel/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@ciintel/core": "workspace:*",
    "@ciintel/db": "workspace:*",
    "@ciintel/github": "workspace:*",
    "@ciintel/queue": "workspace:*",
    "fastify": "^5.10.0",
    "fastify-raw-body": "^5.0.0",
    "ioredis": "^5.11.1",
    "pino": "^9.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

**apps/api/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

**apps/api/src/index.ts:**
```typescript
// @ciintel/api — Fastify webhook receiver (implemented in Plan 04)
export {};
```

**apps/worker/package.json:**
```json
{
  "name": "@ciintel/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@ciintel/core": "workspace:*",
    "@ciintel/db": "workspace:*",
    "@ciintel/github": "workspace:*",
    "@ciintel/queue": "workspace:*",
    "bullmq": "^5.79.3",
    "ioredis": "^5.11.1",
    "pino": "^9.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

**apps/worker/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

**apps/worker/src/index.ts:**
```typescript
// @ciintel/worker — BullMQ worker process (implemented in Plan 05)
export {};
```

**packages/core/package.json:**
```json
{
  "name": "@ciintel/core",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist .turbo"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "@types/node": "^22.0.0"
  }
}
```

**packages/core/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

**packages/core/src/index.ts:**
```typescript
// @ciintel/core — shared types, I/O-free (no external dependencies allowed)
// Implemented progressively as other packages define their contracts.

export type InstallationId = number;

export type TenantContext = {
  installationId: InstallationId;
};
```

**packages/db/package.json:**
```json
{
  "name": "@ciintel/db",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "db:generate": "prisma generate --config prisma.config.ts",
    "db:migrate": "prisma migrate deploy --config prisma.config.ts",
    "db:migrate:dev": "prisma migrate dev --config prisma.config.ts",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@ciintel/core": "workspace:*",
    "@prisma/adapter-pg": "^7.8.0",
    "pg": "^8.13.0",
    "prisma": "^7.8.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0"
  }
}
```

**packages/db/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*", "prisma.config.ts"]
}
```

**packages/db/src/index.ts:**
```typescript
// @ciintel/db — Prisma client, tenant extension, RLS (implemented in Plan 02)
export {};
```

**packages/github/package.json:**
```json
{
  "name": "@ciintel/github",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@ciintel/core": "workspace:*",
    "@octokit/app": "^16.1.2",
    "@octokit/auth-app": "^8.2.0",
    "@octokit/webhooks": "^14.2.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "@types/node": "^22.0.0"
  }
}
```

**packages/github/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

**packages/github/src/index.ts:**
```typescript
// @ciintel/github — Octokit App singleton, factory functions (implemented in Plan 03)
export {};
```

**packages/queue/package.json:**
```json
{
  "name": "@ciintel/queue",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@ciintel/core": "workspace:*",
    "bullmq": "^5.79.3",
    "ioredis": "^5.11.1",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "@types/node": "^22.0.0"
  }
}
```

**packages/queue/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

**packages/queue/src/index.ts:**
```typescript
// @ciintel/queue — queue definitions, job types, FlowProducer (implemented in Plan 03)
export {};
```
  </action>
  <verify>
Run from /Users/tsouza/Projects/ciintel:
1. `pnpm install` — exits 0, no unresolved peer dependency errors
2. `pnpm list --recursive --depth 0` — shows all 6 packages (@ciintel/api, @ciintel/worker, @ciintel/core, @ciintel/db, @ciintel/github, @ciintel/queue)
3. `pnpm --filter @ciintel/core exec tsc --noEmit` — exits 0
  </verify>
  <done>All 6 packages exist with correct package names, workspace cross-dependencies, TypeScript configs extending the base, and stub source files that compile cleanly.</done>
</task>

<task type="auto">
  <name>Task 3: GitHub Actions CI workflow</name>
  <files>
    .github/workflows/ci.yml
  </files>
  <action>
Create .github/workflows/ci.yml. This workflow runs on push to main and on all pull requests. It installs dependencies with pnpm, runs turbo build, and runs turbo lint. Keep it minimal — no test step yet since no tests exist in Phase 1.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Type check
        run: pnpm exec tsc --build --noEmit
```
  </action>
  <verify>
`cat /Users/tsouza/Projects/ciintel/.github/workflows/ci.yml` exists and contains `pnpm/action-setup@v4` and `pnpm install --frozen-lockfile`.
  </verify>
  <done>GitHub Actions CI workflow exists and will run on push/PR to main.</done>
</task>

</tasks>

<verification>
From /Users/tsouza/Projects/ciintel:
1. `pnpm install` — exits 0
2. `pnpm list --recursive --depth 0` — shows 6 packages
3. `cat turbo.json | grep tasks` — returns "tasks" key (not "pipeline")
4. `cat tsconfig.base.json | grep moduleResolution` — returns "nodenext"
5. `cat tsconfig.base.json | grep target` — returns "es2025"
6. Each package tsconfig `extends` points to `../../tsconfig.base.json`
</verification>

<success_criteria>
- pnpm install succeeds with no errors
- All 6 packages listed in pnpm workspace
- turbo.json uses tasks key (Turborepo 2 schema)
- tsconfig.base.json has moduleResolution: nodenext and target: es2025
- All package tsconfigs extend tsconfig.base.json
- .github/workflows/ci.yml exists
- No TypeScript compilation errors on stub source files
</success_criteria>

<output>
After completion, create `/Users/tsouza/Projects/ciintel/.planning/phases/01-github-app-foundation/01-01-SUMMARY.md` with:
- frontmatter: phase, plan, subsystem: monorepo, affects: [all], tech-stack.added: [pnpm@9, turbo@2, typescript@5.8]
- What was built
- Key files created
- Any decisions made
</output>
