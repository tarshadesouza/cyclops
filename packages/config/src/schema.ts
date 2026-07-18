import { z } from "zod";

// ---------------------------------------------------------------------------
// Phase 7 autofix policy (nested). Supersedes the Phase 6 flat
// `autofix: boolean` + `autofixMode: locked|autofix`.
//
//   autofix:
//     mode: off | suggest | agent        (default: suggest — safest, nothing auto-writes)
//     agent:                             (only meaningful when mode: agent)
//       permission: safe | all-in
//       maxIterations: <int>             (CyclOps OUTER re-dispatch cap per session)
//       model: <string>                  (agent model — main cost/quality lever)
//     dryRun: <bool>                     (true → fixes land on a throwaway ref only)
//     rateLimit: <int>                   (max fix sessions / hour / repo)
//
// Level → button:
//   suggest        → "Apply fix"          (agent runs ONE pass, posts a diff; Apply lands it)
//   agent + safe   → "Agent fix (safe)"   (loop on a new cyclops/fix/* branch, open green PR)
//   agent + all-in → "Agent fix (all-in)" (loop directly on the PR's own branch)
// ---------------------------------------------------------------------------
export const AutofixAgentSchema = z
  .object({
    permission: z.enum(["safe", "all-in"]).default("safe"),
    maxIterations: z.number().int().min(1).max(10).default(3),
    model: z.string().default("claude-sonnet-5"),
  })
  .default({});

export const AutofixSchema = z
  .object({
    mode: z.enum(["off", "suggest", "agent"]).default("suggest"),
    agent: AutofixAgentSchema,
    dryRun: z.boolean().default(false),
    rateLimit: z.number().int().min(1).max(20).default(3),
  })
  .default({});

// ---------------------------------------------------------------------------
// migrateLegacyAutofix — accept the Phase 6 flat shape and rewrite it into the
// nested Phase 7 shape BEFORE validation, so old `.cyclops.yml` files keep
// working (the loader still falls back to defaults on any hard mismatch).
//
//   autofix: false                        → { mode: "off" }
//   autofixMode: "locked"                 → { mode: "agent", agent.permission: "safe" }
//   autofixMode: "autofix"                → { mode: "agent", agent.permission: "all-in" }
//   autofixRateLimit: <n>                 → { rateLimit: <n> }
//
// Only fires when the legacy keys are present and `autofix` is NOT already the
// new object shape — a Phase 7 config passes through untouched.
// ---------------------------------------------------------------------------
function migrateLegacyAutofix(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const obj = { ...(input as Record<string, unknown>) };

  const hasLegacyBool = typeof obj["autofix"] === "boolean";
  const hasLegacyMode = "autofixMode" in obj;
  const hasLegacyRate = "autofixRateLimit" in obj;
  // Already Phase 7 (autofix is an object, or nothing legacy present) → untouched.
  if (!hasLegacyBool && !hasLegacyMode && !hasLegacyRate) return obj;

  const legacyBool = obj["autofix"];
  const legacyMode = obj["autofixMode"];
  const legacyRate = obj["autofixRateLimit"];

  const migrated: Record<string, unknown> = {};
  if (legacyBool === false) {
    migrated["mode"] = "off";
  } else if (legacyMode === "locked" || legacyMode === "autofix") {
    migrated["mode"] = "agent";
    migrated["agent"] = { permission: legacyMode === "autofix" ? "all-in" : "safe" };
  }
  if (typeof legacyRate === "number") migrated["rateLimit"] = legacyRate;

  // Drop the legacy keys, install the migrated nested object.
  delete obj["autofix"];
  delete obj["autofixMode"];
  delete obj["autofixRateLimit"];
  obj["autofix"] = migrated;
  return obj;
}

export const CyclopsConfigSchema = z.preprocess(
  migrateLegacyAutofix,
  z
    .object({
      detectors: z
        .object({
          lint: z.boolean().default(true),
          flakyTest: z.boolean().default(true),
          build: z.boolean().default(true),
          testFailure: z.boolean().default(true),
          missingEnv: z.boolean().default(true),
          expiredSecret: z.boolean().default(true),
        })
        .default({}),
      confidenceThreshold: z.number().min(0).max(1).default(0.85),
      autofix: AutofixSchema,
      notifications: z
        .object({
          slack: z
            .object({
              enabled: z.boolean().default(true),
              channel: z.string().optional(),
              webhookUrl: z.string().url().optional(),
            })
            .default({}),
        })
        .default({}),
      githubIssues: z.boolean().default(true),
      checkRuns: z.boolean().default(true),
      prComments: z.boolean().default(true),
    })
    .transform((cfg) => ({
      ...cfg,
      // ---------------------------------------------------------------------
      // Back-compat derived fields. The Phase 6 suggestedFix path still reads
      // these; keep them consistent with the nested policy so both paths agree
      // until that path is fully removed.
      //   autofixMode:      all-in → "autofix", else "locked"
      //   autofixRateLimit: mirrors autofix.rateLimit
      //   autofixEnabled:   convenience — mode !== "off"
      // ---------------------------------------------------------------------
      autofixMode: (cfg.autofix.agent.permission === "all-in"
        ? "autofix"
        : "locked") as "locked" | "autofix",
      autofixRateLimit: cfg.autofix.rateLimit,
      autofixEnabled: cfg.autofix.mode !== "off",
    }))
);

export type CyclopsConfig = z.infer<typeof CyclopsConfigSchema>;
