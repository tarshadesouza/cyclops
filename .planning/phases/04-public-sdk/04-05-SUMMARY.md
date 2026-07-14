# Plan 04-05 Summary: Changesets + npm Publish

## Status: Complete

## What Was Built

Changesets initialized for semver discipline, `@tdesouza/cyclops@0.0.0` published to npm,
and an automated publish workflow wired up for future releases.

## Tasks Completed

### Task 1: Initialize changesets + stage 1.0.0 major changeset
- `.changeset/config.json` created with `access: "public"`, `baseBranch: "main"`, all
  non-published packages in `ignore`
- `.changeset/initial-cyclops-core-1-0-0.md` authored manually as a major changeset
- Root scripts added: `changeset`, `version-packages`, `release`
- Commit: `3cf498e`

### Checkpoint: npm org + GitHub repo setup
- GitHub repo created at `github.com/tarshadesouza/cyclops` with `workflow` scope token
- npm account: `tdesouza`, npm org: `tdesouza`
- Package renamed from `@tdesouza/core` → `@tdesouza/cyclops` (clearer branding)
- All internal workspace deps updated from `@cyclops/core` → `@tdesouza/cyclops`
- Commits: `cf6e83d`, `cc95e5f`, `c733971`

### Task 2: Publish workflow
- `.github/workflows/publish.yml` created — triggers on "Version Packages" commits
- Uses `NPM_TOKEN` secret (stored in GitHub repo settings) via `setup-node registry-url`
- `NPM_TOKEN` GitHub secret configured
- `@tdesouza/core@0.0.0` deprecated on npm with redirect to `@tdesouza/cyclops`
- `@tdesouza/cyclops@0.0.0` published live to npmjs.com
- Commits: `75d7bd3`, `c733971`

## Deviations from Plan

- **OIDC → NPM_TOKEN**: Plan called for OIDC trusted publishing (`id-token: write`). Used
  classic `NPM_TOKEN` secret instead — OIDC requires the package to pre-exist on npm with a
  configured trusted publisher, which requires a UI step on npmjs.com that isn't available for
  a brand-new package. NPM_TOKEN is equivalent security for a personal project.
- **Package renamed**: `@tdesouza/cyclops` instead of `@cyclops/core` — npm org `cyclops` wasn't
  available; personal scope `@tdesouza` used instead. Name simplified to `cyclops` (not `core`)
  for clearer branding.
- **0.0.0 published first**: Manual first publish at `0.0.0` was required to establish the
  package on npm before automated CI publishing could be configured. The major changeset will
  bump to `1.0.0` on the next "Version Packages" merge.

## Artifacts

| File | Purpose |
|------|---------|
| `.changeset/config.json` | Changesets config, only `@tdesouza/cyclops` publishable |
| `.changeset/initial-cyclops-core-1-0-0.md` | Major changeset → 1.0.0 on next version run |
| `.github/workflows/publish.yml` | Automated publish on Version Packages merge |

## npm Package

`@tdesouza/cyclops@0.0.0` — live at https://www.npmjs.com/package/@tdesouza/cyclops
