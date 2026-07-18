// Unit tests for the pure trigger logic — the checkbox-transition detection
// (security-relevant: only [ ]→[x] fires) and the fix-eligibility gate.
// Run: pnpm --filter @cyclops/worker build && node --test apps/worker/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffNewlyChecked,
  FIX_CHECKBOX_RE,
  APPLY_CHECKBOX_RE,
} from "../dist/lib/github-outputs.js";
import { isAgentFixEligible } from "../dist/lib/github-autofix.js";

const ID = "2b865369-49e1-44b7-8261-529a083b895c";
const fixBox = (state, id = ID, level = "all-in") =>
  `- [${state}] 🤖 Let Cyclops fix this <!-- cyclops-fix:${id}:${level} -->`;
const applyBox = (state, sid = ID) =>
  `- [${state}] ✅ Apply this fix <!-- cyclops-apply:${sid} -->`;

test("fix checkbox: [ ]→[x] fires with [id, level]", () => {
  const out = diffNewlyChecked(fixBox(" "), fixBox("x"), FIX_CHECKBOX_RE);
  assert.deepEqual(out, [[ID, "all-in"]]);
});

test("fix checkbox: already [x] in both → does NOT fire", () => {
  assert.deepEqual(diffNewlyChecked(fixBox("x"), fixBox("x"), FIX_CHECKBOX_RE), []);
});

test("fix checkbox: [x]→[ ] (unticked) → does NOT fire", () => {
  assert.deepEqual(diffNewlyChecked(fixBox("x"), fixBox(" "), FIX_CHECKBOX_RE), []);
});

test("fix checkbox: captures each level", () => {
  for (const level of ["safe", "all-in", "suggest"]) {
    const out = diffNewlyChecked(fixBox(" ", ID, level), fixBox("x", ID, level), FIX_CHECKBOX_RE);
    assert.deepEqual(out, [[ID, level]]);
  }
});

test("fix checkbox: only the newly-checked box among several fires", () => {
  const a = "aaaaaaaa-1111-2222-3333-444444444444";
  const b = "bbbbbbbb-5555-6666-7777-888888888888";
  const old = `${fixBox("x", a)}\n${fixBox(" ", b)}`;
  const now = `${fixBox("x", a)}\n${fixBox("x", b)}`;
  assert.deepEqual(diffNewlyChecked(old, now, FIX_CHECKBOX_RE), [[b, "all-in"]]);
});

test("fix regex ignores a checkbox without our marker", () => {
  const out = diffNewlyChecked("- [ ] some other task", "- [x] some other task", FIX_CHECKBOX_RE);
  assert.deepEqual(out, []);
});

test("apply checkbox: [ ]→[x] fires with sessionId (extra empty)", () => {
  assert.deepEqual(diffNewlyChecked(applyBox(" "), applyBox("x"), APPLY_CHECKBOX_RE), [[ID, ""]]);
});

test("shared /g regex is reset between calls (no lastIndex bleed)", () => {
  // call twice to prove lastIndex reset inside diffNewlyChecked
  diffNewlyChecked(fixBox(" "), fixBox("x"), FIX_CHECKBOX_RE);
  assert.deepEqual(diffNewlyChecked(fixBox(" "), fixBox("x"), FIX_CHECKBOX_RE), [[ID, "all-in"]]);
});

// --- eligibility gate --------------------------------------------------------
const cfg = { confidenceThreshold: 0.85 };
const finding = (detectorType, confidence) => ({ detectorType, confidence });

test("eligible: code detector at/above threshold", () => {
  assert.equal(isAgentFixEligible(finding("FlakyTest", 0.95), cfg), true);
  assert.equal(isAgentFixEligible(finding("lint", 0.85), cfg), true);
  assert.equal(isAgentFixEligible(finding("TestFailure", 0.9), cfg), true);
});

test("ineligible: confidence below threshold", () => {
  assert.equal(isAgentFixEligible(finding("lint", 0.5), cfg), false);
});

test("ineligible: null/absent confidence", () => {
  assert.equal(isAgentFixEligible(finding("lint", null), cfg), false);
});

test("ineligible: non-code detector even at high confidence", () => {
  assert.equal(isAgentFixEligible(finding("missingEnv", 0.99), cfg), false);
  assert.equal(isAgentFixEligible(finding("expiredSecret", 0.99), cfg), false);
});
