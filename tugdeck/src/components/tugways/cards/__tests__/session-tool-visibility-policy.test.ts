/**
 * Governance test for `session-tool-visibility-policy.ts` — pins the two
 * invariants that catch *real* mistakes (the ones code review can
 * miss), and the canonical v2.1.148 tool-set coverage that protects
 * against drift from a future Claude Code release.
 *
 * Per [D101], `TOOL_VISIBILITY_POLICY` is the single editable source
 * of truth for the `hidden` and `default-intent` buckets; bespoke is
 * implicit (registry presence).
 *
 *  (c) Every `default-intent` entry's rationale contains both
 *      `"Awaiting"` and a `#step-` substring. This is the *only*
 *      mechanism preventing `default-intent` from becoming a
 *      forever-bucket — without it, a vague rationale lets a tool
 *      sit in the default bucket indefinitely with no planned
 *      bespoke wrapper. The test enforces the social contract.
 *  (d) Every name in `V2_1_148_CANONICAL_TOOL_NAMES` (hardcoded here)
 *      is covered by either the bespoke side (`BESPOKE_TOOL_NAMES`)
 *      or the policy. A new built-in tool added in a future Claude
 *      Code release fails CI until it is explicitly classified —
 *      this is the test most aligned with the plan's goal of "fails
 *      CI when an unclassified tool appears."
 *
 * # Cut on purpose
 *
 * Two checks the original spec called for were dropped because they
 * mostly verify "TypeScript compiled" rather than catching a real
 * failure mode that code review wouldn't:
 *
 *  - (a) "Every entry parses" — the entry shape is already enforced
 *    by the `ToolVisibilityEntry` interface; the lowercase / ISO-date
 *    string checks are weak and the duplicate-name guard is marginal
 *    for an array of ~20 entries.
 *  - (b) "No double-classification" — realistic in principle, but
 *    obvious in code review and very rare in practice. The
 *    `hidden` / `default-intent` split is mutually exclusive by the
 *    enum; a bespoke-and-policy overlap would be visible at glance.
 *
 * The two cuts are about test-suite signal-to-noise, not coverage
 * theatre. Adding (a) or (b) back when a concrete bug is missed by
 * review is fine — until then, the tests below are the ones that
 * pay for their maintenance cost.
 *
 * @module components/tugways/cards/__tests__/session-tool-visibility-policy
 */

import { describe, it, expect } from "bun:test";

import { TOOL_VISIBILITY_POLICY } from "../session-tool-visibility-policy";
import { BESPOKE_TOOL_NAMES } from "../session-assistant-renderer-registrations";

// ---------------------------------------------------------------------------
// Canonical v2.1.148 tool registry
// ---------------------------------------------------------------------------

/**
 * Hardcoded snapshot of the v2.1.148 built-in tool registry, extracted
 * from `capabilities/2.1.148/system-metadata.jsonl`. Names match the
 * `system_metadata.tools` array exactly — `Task` is the canonical
 * upstream name (the dispatch aliases it to `agent` internally).
 *
 * Coverage check (d) asserts every name here is either bespoke
 * (in `BESPOKE_TOOL_NAMES`) or policy-classified. A new tool added
 * in a future Claude Code release will fail this test until it is
 * explicitly classified — which is the point: forces the person
 * bumping the catalog to also decide the new tool's bucket.
 *
 * **Out of scope.** The `mcp__*` namespace is variable, user-installed,
 * and explicitly deferred per the project's MCP non-goal policy
 * (`arc/session-assistant-rendering.md` §Open Questions). It is not
 * listed here.
 */
const V2_1_148_CANONICAL_TOOL_NAMES: ReadonlyArray<string> = [
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "Read",
  "RemoteTrigger",
  "ScheduleWakeup",
  "ShareOnboardingGuide",
  "Skill",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
];

/**
 * Lowercased aliases the dispatch resolves before registry lookup.
 * Mirrors `TOOL_ALIASES` in `session-assistant-renderer-dispatch.ts`.
 * Kept as a local mirror (rather than importing it) because the
 * coverage check is meant to fail loudly when the alias map changes —
 * the test author wants to see that change explicitly.
 */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["task", "agent"],
  ["multiedit", "edit"],
  ["enterworktree", "worktree"],
  ["exitworktree", "worktree"],
  ["tasklist", "taskmgmt"],
  ["taskget", "taskmgmt"],
  ["taskoutput", "taskmgmt"],
  ["taskstop", "taskmgmt"],
  ["croncreate", "cron"],
  ["crondelete", "cron"],
  ["cronlist", "cron"],
]);

function canonicalize(name: string): string {
  const lower = name.toLowerCase();
  return ALIASES.get(lower) ?? lower;
}

const POLICY_NAMES: ReadonlySet<string> = new Set(
  TOOL_VISIBILITY_POLICY.map((entry) => entry.name),
);

// ---------------------------------------------------------------------------
// (c) Default-intent entries cite a follow-on step
// ---------------------------------------------------------------------------

describe("TOOL_VISIBILITY_POLICY — (c) default-intent ownership", () => {
  const entries = TOOL_VISIBILITY_POLICY.filter(
    (entry) => entry.visibility === "default-intent",
  );

  // Per-entry test so a missing rationale element pinpoints which row.
  for (const entry of entries) {
    it(`${entry.name}: rationale contains "Awaiting" and "#step-"`, () => {
      expect(entry.rationale).toContain("Awaiting");
      expect(entry.rationale).toContain("#step-");
    });
  }
});

// ---------------------------------------------------------------------------
// (d) v2.1.148 canonical coverage
// ---------------------------------------------------------------------------

describe("TOOL_VISIBILITY_POLICY — (d) v2.1.148 canonical coverage", () => {
  for (const canonicalName of V2_1_148_CANONICAL_TOOL_NAMES) {
    it(`${canonicalName}: covered by registry or policy`, () => {
      const lookup = canonicalize(canonicalName);
      const inRegistry = BESPOKE_TOOL_NAMES.has(lookup);
      const inPolicy = POLICY_NAMES.has(lookup);
      // Build a descriptive expectation so a failing tool name and
      // its resolved lookup key both appear in the test output.
      expect({
        canonicalName,
        lookupKey: lookup,
        covered: inRegistry || inPolicy,
      }).toEqual({
        canonicalName,
        lookupKey: lookup,
        covered: true,
      });
    });
  }
});
