# Phase 4: Public SDK - Research

**Researched:** 2026-07-14
**Domain:** npm package publishing, dual ESM/CJS TypeScript libraries, public interface design
**Confidence:** HIGH (codebase read directly; tooling verified via official docs)

---

## Summary

Phase 4 publishes `@cyclops/core` as the public SDK. Three distinct problems must be solved in sequence: (1) the SDK's public type surface (`IDetector`, `DetectorContext`) does not exist yet and must be created; (2) the current tsc-only build produces ESM only and must be replaced with tsup for dual ESM/CJS output; (3) validation tooling (`publint`, `@arethetypeswrong/cli`) and a publish workflow must be wired into CI.

A fourth problem requires a judgment call before code work begins: `encryptApiKey`/`decryptApiKey` currently live in `packages/core` and are exported from the SDK entry point. These functions have no place in a public detector-author SDK — they are internal server utilities. They must be removed from the public surface before publish.

**Primary recommendation:** Create `IDetector` + `DetectorContext` in `packages/core`; move crypto out of the SDK entry point; replace tsc build with tsup; add CI validation; add npm publish workflow with OIDC provenance.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| tsup | ^8.x | Bundles TS to dual ESM/CJS with `.d.cts` | Industry standard for library dual-format output; esbuild-powered, handles `dts` generation automatically |
| publint | ^0.x | Validates `package.json` exports map | Catches export map shape errors before publish; runs in <1s |
| @arethetypeswrong/cli | ^0.x | Validates TypeScript resolution across module modes | Catches "masquerading as CJS" and type resolution failures that publint misses |
| @changesets/cli | ^2.x | Semver versioning + changelog for monorepos | Standard for pnpm monorepos; enforces major bump policy on `IDetector` changes |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @changesets/action | ^1.x | GitHub Action to open version PRs | In CI only; automates the Version Packages PR on merge |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| tsup | tsc only | tsc cannot emit `.cjs` + `.d.cts`; dual format requires bundler |
| tsup | tsdown | tsdown is newer and less ecosystem-tested; tsup is proven |
| changesets | np / release-it | changesets is pnpm-workspace-aware; others require manual coordination |

### Installation

```bash
pnpm add -D tsup publint @arethetypeswrong/cli --filter @cyclops/core
pnpm add -D @changesets/cli @changesets/action -w
```

---

## Architecture Patterns

### Recommended Project Structure (packages/core)

```
packages/core/
├── src/
│   ├── index.ts          # public SDK entry — IDetector, DetectorContext, DetectorResult
│   ├── types.ts          # all exported types
│   └── crypto.ts         # MOVE OUT — not SDK surface (see Pitfall 1)
├── dist/                 # tsup output (gitignored)
│   ├── index.js          # ESM runtime
│   ├── index.cjs         # CJS runtime
│   ├── index.d.ts        # ESM types
│   └── index.d.cts       # CJS types (critical for @arethetypeswrong pass)
├── tsup.config.ts
├── package.json
└── tsconfig.json
```

### Pattern 1: IDetector Interface Design

**What:** A synchronous interface mapping `DetectorContext` → `DetectorResult`. The interface must be callable as a pure function so third-party implementors need zero I/O imports.

**When to use:** Any third-party engineer building a custom detector.

```typescript
// packages/core/src/types.ts
export interface IDetector {
  detect(context: DetectorContext): DetectorResult;
}

export type DetectorContext = {
  logExcerpt: string;
  workflowYaml: string;
  jobName: string;
  checkRunHistory?: Array<{ conclusion: string | null }>;
};

// DetectorResult already exists in packages/core/src/index.ts:
// export type DetectorResult = {
//   detectorType: DetectorType;
//   matched: boolean;
//   violations: Violation[];
//   rawExcerpt: string;
// };
```

**Key design note:** `DetectorContext` is a rename/promotion of `DetectorInput` from `packages/detectors/src/types.ts`. The detectors package already re-exports `DetectorType`/`DetectorResult`/`Violation` from `@cyclops/core`; after this change it will also import `DetectorContext` from core and alias or drop its local `DetectorInput`.

### Pattern 2: tsup Dual ESM/CJS Configuration

**What:** tsup replaces tsc as the build tool for `packages/core` only. Other packages (detectors, db, queue, etc.) keep tsc because they are not published to npm.

```typescript
// packages/core/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,       // generates index.d.ts AND index.d.cts automatically
  clean: true,
  sourcemap: true,
  target: 'node22',
});
```

### Pattern 3: package.json exports map

The `types` condition MUST be first within each condition block — publint errors on `EXPORTS_TYPES_SHOULD_BE_FIRST` otherwise. The `main` field is required for older tooling that ignores `exports`.

```json
{
  "name": "@cyclops/core",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "publint": "publint",
    "attw": "attw --pack"
  }
}
```

### Pattern 4: tsconfig for packages/core when using tsup

tsup uses esbuild, not tsc, for transpilation. The existing `tsconfig.json` is still needed for `composite: true` project references and for the `tsc --build --noEmit` type check in CI. Only the build script changes.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

Set `noEmit: true` in packages/core tsconfig so that `tsc --build` across the monorepo does not conflict with tsup's dist output. tsup owns dist; tsc only type-checks.

### Anti-Patterns to Avoid

- **Using `"default"` condition without a `"require"` condition:** CJS consumers get the ESM bundle, which breaks in older Node.
- **Putting `types` after `default` in exports:** publint `EXPORTS_TYPES_SHOULD_BE_FIRST` error.
- **`"type": "module"` with `.js` CJS output:** The `.cjs` extension is mandatory when `"type": "module"` is set.
- **Bundling `node:crypto` or other Node builtins:** tsup does not bundle builtins by default; confirm with `external: ['node:crypto']` if needed.
- **Removing `composite: true` from packages/core tsconfig:** Other packages reference it via project references.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Dual ESM/CJS output | Custom tsc scripts | tsup `format: ['esm','cjs']` | Handles `.d.cts` generation, clean, sourcemaps automatically |
| Export map validation | Manual testing | publint | Knows all 10+ known failure modes |
| Type resolution validation | Manual CJS/ESM import testing | @arethetypeswrong/cli | Tests node10/node16/bundler resolution modes automatically |
| Monorepo semver | Manual version bumps | @changesets/cli | Tracks which packages changed, prevents accidental major bumps |
| npm publish auth | Long-lived NPM_TOKEN | OIDC trusted publishing | NPM_TOKEN classic tokens deprecated December 2025 |

**Key insight:** The entire class of "works on my machine, broken on npm" bugs for dual ESM/CJS packages is caught by `publint` + `attw --pack` in under 5 seconds. Never publish without both.

---

## Common Pitfalls

### Pitfall 1: crypto.ts in the public SDK entry point

**What goes wrong:** `encryptApiKey`/`decryptApiKey` are currently exported from `packages/core/src/index.ts` and will therefore appear in the published `@cyclops/core` SDK. Third-party detector authors who `import { IDetector } from '@cyclops/core'` will also receive these internal encryption functions. They require `CYCLOPS_ENCRYPTION_KEY` env var to be set, which has no meaning outside the Cyclops server.

**Why it happens:** `packages/core` was originally the shared-types-and-utils package for the monorepo, not a public SDK.

**How to avoid:** Before adding IDetector/DetectorContext, remove `encryptApiKey`/`decryptApiKey` from `packages/core/src/index.ts`. The two consumers (`apps/api/src/routes/setup.ts` and `apps/worker/src/workers/ai-analysis.ts`) should either inline `crypto.ts` or import from a new non-published internal package (e.g., `packages/server-utils`). The simplest approach: copy `crypto.ts` into each app that uses it, or create `packages/internal` (private: true, never published).

**Warning signs:** Running `attw --pack` locally before removing crypto shows it in the public API surface.

### Pitfall 2: Missing `.d.cts` breaks @arethetypeswrong

**What goes wrong:** If tsup is configured with `dts: true` but only one format, or if the exports map points `require.types` at `.d.ts` instead of `.d.cts`, `attw` reports "masquerading as CJS" — the package's CJS entry has ESM-flavored types.

**Why it happens:** With `"type": "module"`, a `.d.ts` file is treated as ESM types by TypeScript. CJS consumers in `moduleResolution: node16/nodenext` see the wrong types.

**How to avoid:** tsup automatically generates `.d.cts` when `format: ['esm', 'cjs']` and `dts: true` are both set. Verify `dist/index.d.cts` exists after build. The exports map must point `require.types` to `./dist/index.d.cts`, not `./dist/index.d.ts`.

### Pitfall 3: `composite: true` + tsup dist conflict

**What goes wrong:** `tsc --build` (used by dependent packages via project references) tries to emit into `dist/`. If tsup already emitted there with a different file layout, type-check passes locally but CI sees stale/wrong `.d.ts` files.

**Why it happens:** Project references need tsconfig `outDir` to match where `.d.ts` files live. tsup's `outDir` is also `dist/`.

**How to avoid:** Add `"noEmit": true` to `packages/core/tsconfig.json`. This makes `tsc --build` from root only type-check core, not emit. tsup owns all emission. Downstream packages (detectors) reference core for types, and since tsup produces `dist/index.d.ts`, the reference is satisfied at runtime after `pnpm build`.

**Warning sign:** `tsc --build --noEmit` passes but `tsc --build` (with emit) produces inconsistent `dist/` contents.

### Pitfall 4: `DetectorInput` → `DetectorContext` rename breaks packages/detectors

**What goes wrong:** `DetectorInput` is defined in `packages/detectors/src/types.ts` and used by all six detector functions and `runAllDetectors`. Moving or renaming it requires updating all six detector files.

**Why it happens:** `DetectorInput` was the detectors-internal name; `DetectorContext` is the public SDK name.

**How to avoid:** Two clean options: (a) Add `DetectorContext` to `packages/core` as the canonical type, then make `DetectorInput` in `packages/detectors` a re-export alias (`export type DetectorInput = DetectorContext`); or (b) rename in place across all detector files (6 files, mechanical change). Option (a) is safer as a single-step change with no logic edits.

### Pitfall 5: npm OIDC trusted publishing requires exact repository.url

**What goes wrong:** The publish workflow fails with "not authorized" even with `id-token: write` permission if `repository.url` in `packages/core/package.json` does not exactly match the GitHub repository URL.

**How to avoid:** Set `"repository": { "type": "git", "url": "https://github.com/ORG/REPO" }` in packages/core/package.json before configuring trusted publishing on npm. The URL must be the canonical HTTPS form.

---

## Code Examples

### CI Validation Step (runs before every publish)

```yaml
# .github/workflows/publish.yml — validation job
- name: Build
  run: pnpm build --filter @cyclops/core

- name: publint
  run: pnpm --filter @cyclops/core exec publint

- name: Are the types wrong?
  run: pnpm --filter @cyclops/core exec attw --pack
```

### Changesets Publish Workflow Skeleton

```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write   # required for npm OIDC provenance
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org  # REQUIRED — triggers .npmrc write
      - run: pnpm install --frozen-lockfile
      - run: pnpm build --filter @cyclops/core
      - run: pnpm --filter @cyclops/core exec publint
      - run: pnpm --filter @cyclops/core exec attw --pack
      - uses: changesets/action@v1
        with:
          publish: pnpm changeset publish
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
          # No NPM_TOKEN needed with OIDC trusted publishing
```

### IDetector Usage Example (for SDK documentation / verification test)

```typescript
// Verifies SDK-02 and success criteria 1+2
import { IDetector, DetectorContext, DetectorResult } from '@cyclops/core';

class MyLintDetector implements IDetector {
  detect(context: DetectorContext): DetectorResult {
    const matched = context.logExcerpt.includes('ESLint');
    return {
      detectorType: 'Lint',
      matched,
      violations: matched ? [{ message: 'lint failure found' }] : [],
      rawExcerpt: context.logExcerpt,
    };
  }
}
```

---

## Current State of packages/core

| Item | Status |
|------|--------|
| `DetectorResult` type | EXISTS — `packages/core/src/index.ts` |
| `DetectorType` type | EXISTS — `packages/core/src/index.ts` |
| `Violation` type | EXISTS — `packages/core/src/index.ts` |
| `IDetector` interface | MISSING — must be created |
| `DetectorContext` type | MISSING — must be created (currently `DetectorInput` in packages/detectors) |
| `encryptApiKey` / `decryptApiKey` | EXISTS but MUST BE REMOVED from SDK entry point |
| tsup build | MISSING — currently tsc only |
| dual ESM/CJS output | MISSING — currently ESM only |
| `.d.cts` file | MISSING |
| `"require"` exports condition | MISSING |
| `"main"` field (CJS fallback) | MISSING |
| `"files": ["dist"]` | MISSING — would publish entire package dir |
| publint | MISSING |
| @arethetypeswrong/cli | MISSING |
| CI publish workflow | MISSING — only build/type-check CI exists |
| version | `0.0.0` — needs bump to `1.0.0` for initial SDK publish |

---

## IDetector / DetectorContext / DetectorResult Location

**Today:**
- `DetectorResult`, `DetectorType`, `Violation` → `packages/core/src/index.ts` (correct)
- `IDetector` → does not exist anywhere
- `DetectorContext` → does not exist; closest equivalent is `DetectorInput` in `packages/detectors/src/types.ts`

**After Phase 4:**
- `IDetector`, `DetectorContext`, `DetectorResult`, `DetectorType`, `Violation` → all in `packages/core/src/index.ts`
- `packages/detectors` imports `DetectorContext` from `@cyclops/core` and aliases `DetectorInput = DetectorContext` (or renames in all 6 files)
- `encryptApiKey`/`decryptApiKey` → moved out of core into consuming apps or `packages/internal`

**No circular dependency risk:** `packages/detectors` already depends on `packages/core`. Moving `DetectorInput` upstream to core does not create a cycle.

---

## tsup Configuration

See Architecture Patterns → Pattern 2 and Pattern 3 above for the full config.

**Critical outputs tsup must produce:**

| File | Format | Required by |
|------|--------|-------------|
| `dist/index.js` | ESM | `"import"` condition |
| `dist/index.cjs` | CJS | `"require"` condition |
| `dist/index.d.ts` | ESM types | `"import".types` condition |
| `dist/index.d.cts` | CJS types | `"require".types` condition |

tsup generates all four automatically with:
```bash
tsup src/index.ts --format esm,cjs --dts --clean
```

The `--dts` flag generates both `.d.ts` and `.d.cts` when both formats are requested. This is tsup's documented behavior (HIGH confidence — verified against tsup docs).

**Turbo integration:** Update `turbo.json` outputs to include `"dist/**"` (already present). The `build` script in packages/core changes from `tsc -p tsconfig.json` to `tsup`.

---

## publint + @arethetypeswrong

**publint** checks the `package.json` metadata and export map shape:
- `FILE_DOES_NOT_EXIST`: every path in `exports` must exist in `dist/`
- `EXPORTS_TYPES_SHOULD_BE_FIRST`: `types` key must come before `default` in each condition
- `FILE_INVALID_FORMAT`: `.js` with `"type": "module"` must be ESM; `.cjs` must be CJS
- `EXPORTS_TYPES_INVALID_FORMAT`: `.d.ts` in a `require` condition of a `"type": "module"` package is wrong

**@arethetypeswrong/cli** (attw) checks TypeScript consumer resolution:
- "masquerading as CJS": `.d.cts` missing for `require` condition
- "resolution failed": consumer in `moduleResolution: node16` cannot find types
- "incorrect module type": runtime file is CJS but types declare ESM exports

**How to run:**
```bash
# From packages/core after build:
npx publint           # validates package.json exports map
npx attw --pack       # packs the tarball, validates type resolution in all modes
```

**Passing both means:** Any Node.js 22 consumer using ESM (`import`) or CJS (`require`), and any TypeScript consumer using `node10`, `node16`, `nodenext`, or `bundler` moduleResolution will get correct types and runtime behavior.

---

## CI Pipeline for npm Publish

**Current CI** (`.github/workflows/ci.yml`): runs on push/PR to main; does `pnpm install`, `pnpm build`, `tsc --build --noEmit`. No publish step.

**Required additions:**

1. **New workflow file** `publish.yml` triggered on push to main (or on tag `v*.*.*`).
2. **Permissions:** `id-token: write` (OIDC provenance), `contents: write` (changesets creates tags), `pull-requests: write` (changesets opens Version Packages PR).
3. **setup-node `registry-url`** must be set to `https://registry.npmjs.org` — this is what triggers setup-node to write the `.npmrc` authentication file on the runner. Without it, publish fails silently.
4. **NPM trusted publishing**: Configure on npmjs.com under the package settings (link your GitHub repo + org/repo). No `NPM_TOKEN` secret needed. Set `NPM_CONFIG_PROVENANCE=true` as env var.
5. **publint + attw run before `changeset publish`** — if either fails, publish is blocked.
6. **changesets/action** handles the version PR lifecycle; when the Version Packages PR is merged, it auto-publishes.

**npm access:** `@cyclops/core` must be published with `--access public` (scoped packages default to private). Add to `packages/core/package.json`:
```json
"publishConfig": {
  "access": "public"
}
```

---

## Recommended Plan Breakdown

| Plan ID | One-line description |
|---------|----------------------|
| 04-01 | Package rename `@ciintel/*` → `@cyclops/*` across all package.json names, workspace imports, and tsconfig paths (already decided) |
| 04-02 | Add `IDetector` interface and `DetectorContext` type to `packages/core`; remove `encryptApiKey`/`decryptApiKey` from core's public entry (move to `packages/internal` or inline into consuming apps) |
| 04-03 | Replace tsc-only build in `packages/core` with tsup; produce dual ESM/CJS output with `.d.cts`; update `package.json` exports map, `"main"`, `"files"`, `"publishConfig"` |
| 04-04 | Add `publint` and `@arethetypeswrong/cli` as devDependencies in core; wire both into the existing `ci.yml` as a `validate-sdk` job gated on build success |
| 04-05 | Initialize changesets (`pnpm changeset init`); cut first changeset for `1.0.0`; add `publish.yml` GitHub Actions workflow with OIDC provenance; publish `@cyclops/core@1.0.0` |

---

## Risks / Pitfalls

1. **crypto.ts removal scope creep:** `apps/api` and `apps/worker` both import `encryptApiKey`/`decryptApiKey` from `@ciintel/core`. Moving crypto out of core requires updating two apps. The rename in 04-01 must happen before 04-02, or the import paths will be inconsistent during the transition.

2. **`composite: true` + tsup `noEmit` requirement:** If `packages/core/tsconfig.json` does not set `noEmit: true`, running `tsc --build` from the monorepo root will emit `.js` files into `dist/` that conflict with tsup's `.cjs` output. This produces a broken dist that passes type-check but breaks runtime. **Set `noEmit: true` in packages/core tsconfig as part of 04-03.**

3. **`DetectorInput` used in 9 call sites in packages/detectors:** All 6 detector source files (`lint.ts`, `build-failure.ts`, `test-failure.ts`, `flaky-test.ts`, `missing-env-var.ts`, `expired-secret.ts`), `log-utils.ts`, `types.ts`, and `index.ts` reference `DetectorInput`. The simplest migration in 04-02: add `export type DetectorInput = DetectorContext` to `packages/detectors/src/types.ts` as an alias — zero file changes needed in the individual detector files. Remove the alias in a later cleanup.

4. **npm scoped package requires org on npmjs.com:** `@cyclops/core` requires the `cyclops` npm organization to exist and the publisher to be a member with publish rights. If publishing under a personal account, use `@username/core` instead. Confirm the npm org exists before wiring up OIDC trusted publishing in 04-05.

5. **`version: 0.0.0` → `1.0.0` is a manual first step:** changesets won't bump to 1.0.0 automatically from 0.0.0. The initial version bump to 1.0.0 must be done manually (edit `package.json` + run `pnpm changeset` to record the major) or via `pnpm changeset version` after adding a major changeset file. Document this in the 04-05 plan.

6. **tsup and `module: nodenext` in tsconfig:** tsup uses esbuild for transpilation, ignoring `module: nodenext`. This means tsup will not enforce `.js` extension in import paths during bundling. The output is correct (ESM + CJS), but the source must still use `.js` extensions in all imports (as enforced by the existing `nodenext` tsconfig) for `tsc --noEmit` to pass.

---

## Sources

### Primary (HIGH confidence)
- Codebase direct read: `packages/core/src/index.ts`, `crypto.ts`, `package.json`, `tsconfig.json`
- Codebase direct read: `packages/detectors/src/types.ts`, `index.ts`, `package.json`
- Codebase direct read: `.github/workflows/ci.yml`, `turbo.json`, `tsconfig.base.json`

### Secondary (MEDIUM confidence)
- [publint rules reference](https://publint.dev/rules) — official tool documentation, rule names verified
- [Dual ESM/CJS with tsup + attw (johnnyreilly.com)](https://johnnyreilly.com/dual-publishing-esm-cjs-modules-with-tsup-and-are-the-types-wrong) — verified package.json exports map pattern
- [npm trusted publishing docs](https://docs.npmjs.com/trusted-publishers/) — OIDC provenance official docs
- [npm trusted publishing GA announcement](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/) — confirmed GA July 31 2025

### Tertiary (LOW confidence)
- WebSearch results on changesets + pnpm monorepo patterns — consistent across multiple sources, not individually verified against changesets official docs

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — tsup/publint/attw are the established tools; no viable alternatives
- Architecture (IDetector design): HIGH — derived directly from codebase inspection + requirements
- tsup config: HIGH — verified against official article with exact package.json; `.d.cts` generation confirmed
- publint/attw failure modes: HIGH — rules page fetched directly
- CI/OIDC: MEDIUM — official docs confirmed GA; exact YAML not verified end-to-end
- changesets initial 1.0.0 workflow: LOW — standard pattern, not verified against changesets docs

**Research date:** 2026-07-14
**Valid until:** 2026-08-14 (tsup/publint stable; npm OIDC GA and stable)
