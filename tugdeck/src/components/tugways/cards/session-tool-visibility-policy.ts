/**
 * session-tool-visibility-policy.ts — the single editable source of truth
 * for how Claude Code tool names render (or do not render) in the
 * Dev transcript.
 *
 * # The three buckets
 *
 * Every Claude Code tool name falls into exactly one of three
 * classifications. Two are *explicit* in this file; one is *implicit*
 * in `session-assistant-renderer-dispatch.ts`:
 *
 *  1. **bespoke** — *implicit*. A tool has a bespoke wrapper iff it is
 *     registered in `TOOL_BLOCK_REGISTRY` via `registerToolBlock`
 *     (e.g. `BashToolBlock`, `ReadToolBlock`, `EditToolBlock`). These
 *     names MUST NOT appear in `TOOL_VISIBILITY_POLICY` — that would
 *     be a double-classification. The governance test pins this.
 *
 *  2. **hidden** — *explicit* (this file). The tool's per-call events
 *     paint zero ink in the transcript. The dispatch derives a
 *     `HIDDEN_TOOL_NAMES` set from `hiddenToolNames()` and intercepts
 *     these names in `resolveToolBlock` *before* the registry lookup,
 *     returning the shared `NullToolBlock` factory. `detectToolCallDrift`
 *     also short-circuits these names so a hidden tool never raises
 *     an `unknown_tool` caution. Use this bucket for control-channel
 *     machinery the user doesn't need to see (`ToolSearch`,
 *     `ScheduleWakeup`, `EnterPlanMode` / `ExitPlanMode`,
 *     `PushNotification`). `TaskCreate` / `TaskUpdate` were
 *     historically hidden here under the original [D100] decision,
 *     but [#step-24-3-5] introduced the `TaskInlineToolBlock`
 *     second-surface marker — both names are now bespoke (registered
 *     via the dispatch's `BESPOKE_REGISTRATIONS`), and the policy
 *     no longer claims them.
 *
 *  3. **default-intent** — *explicit* (this file). The tool currently
 *     renders through `DefaultToolBlock` (the JsonTree fallback) and
 *     does not raise an `unknown_tool` caution, but a bespoke wrapper
 *     is planned and named. The dispatch derives
 *     `AUDIT_CONFIRMED_DEFAULT_TOOLS` from `defaultIntentToolNames()`
 *     so the drift detector treats these names as "known, JSON-tree
 *     is fine for now." Every entry's `rationale` MUST cite the
 *     follow-on step (`#step-...`) — the governance test enforces
 *     that, so a default-intent entry is always an *explicit TODO*,
 *     never a forever-bucket.
 *
 * # Why this file exists
 *
 * Before this file, the dispatch carried a flat `AUDIT_CONFIRMED_DEFAULT_TOOLS`
 * set that overloaded two policies onto one container: low-volume tools
 * whose JSON-tree default rendering is genuinely fine, AND control
 * tools that should ideally be silenced. Mixing the two made the
 * intent of any given entry unreadable — and made adding a new "hide
 * this" tool require touching the dispatch internals. This file
 * separates the two and gives each entry an audit trail (rationale +
 * `reviewedAt`) so the bucket choice can be defended on review.
 *
 * # Editing this file
 *
 * Moving a tool between buckets is a one-line change:
 *  - Add or move an entry in `TOOL_VISIBILITY_POLICY`.
 *  - Update its `rationale` to reflect the new bucket.
 *  - Bump `reviewedAt` to commit day.
 *  - Run `bun test session-tool-visibility-policy.test.ts` — the governance
 *    test enforces the invariants below.
 *
 * Promoting a tool to bespoke means:
 *  - Add a `registerToolBlock("<name>", MyToolBlock)` call in the
 *    dispatch.
 *  - REMOVE the tool's entry from `TOOL_VISIBILITY_POLICY` (it would
 *    fail the no-double-classification test otherwise).
 *
 * # Invariants (enforced by `session-tool-visibility-policy.test.ts`)
 *
 *  - (a) Every entry's `name` is lowercase; `visibility` is in the
 *    enum; `rationale` is non-empty; `reviewedAt` is `YYYY-MM-DD`.
 *  - (b) No entry's `name` is also in `TOOL_BLOCK_REGISTRY` after
 *    module load (bespoke and policy-classified are mutually
 *    exclusive).
 *  - (c) Every `default-intent` entry's `rationale` contains
 *    `"Awaiting"` and `"#step-"` (explicit ownership of the planned
 *    bespoke wrapper).
 *  - (d) Every name in `V2_1_148_CANONICAL_TOOL_NAMES` (hardcoded in
 *    the test) is covered by either `TOOL_BLOCK_REGISTRY` or this
 *    policy — so a new tool added to a future Claude Code release
 *    fails CI until it is explicitly classified.
 *
 * # Scope — MCP is intentionally excluded
 *
 * The `mcp__*` namespace is a variable, user-installed surface. Per the
 * project policy in `dash/session-assistant-rendering.md` (the MCP
 * non-goal in Open Questions, the deferred-stub Step 24.3.5), MCP
 * tools are **not** classified here. `mcp__*` names continue to route
 * through `DefaultToolBlock` and produce `unknown_tool` cautions; the
 * caution count is the deferral's signal. Do not add an `mcp__*`
 * pattern entry to this file without first reopening the MCP decision.
 *
 * @module components/tugways/cards/session-tool-visibility-policy
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The two *explicit* visibility classifications. Bespoke is implicit
 * (registry presence is the signal) and intentionally not part of this
 * enum — adding it would invite double-classification bugs.
 */
export type ToolVisibility = "hidden" | "default-intent";

/**
 * One row of the policy table. The shape is deliberately small so the
 * table reads as a single editable block; the audit trail (`rationale`
 * + `reviewedAt`) is what makes a bucket choice defensible on review.
 */
export interface ToolVisibilityEntry {
  /**
   * Canonical lowercased tool name (matches the dispatch's
   * `lowercased canonical name` convention — aliases like `task →
   * agent` resolve to the canonical *before* this file is consulted,
   * so a hidden or default-intent entry covers all aliases of its
   * canonical name).
   */
  readonly name: string;
  /** Which bucket this name lives in. */
  readonly visibility: ToolVisibility;
  /**
   * One sentence explaining the bucket choice. For `default-intent`
   * entries the governance test requires this string contain both
   * `"Awaiting"` and a `#step-` substring naming the follow-on
   * roadmap step (forces explicit ownership).
   */
  readonly rationale: string;
  /**
   * ISO-date (`YYYY-MM-DD`) when this entry was last reviewed. Bump
   * whenever the rationale changes or the bucket choice is
   * reconfirmed. A long-stale `reviewedAt` on a `default-intent`
   * entry is the visual signal that the planned bespoke wrapper has
   * been deferred indefinitely; flag for re-triage.
   */
  readonly reviewedAt: string;
}

// ---------------------------------------------------------------------------
// The policy table
// ---------------------------------------------------------------------------

/**
 * The complete classification table. The order within each bucket is
 * alphabetical for searchability; the `hidden` block leads because it
 * is the most-load-bearing UX policy decision (these tools paint zero
 * ink). Cross-references to [D100] / [D101] are deliberate — those
 * decisions cite this file as the surface and changing one without
 * the other is the kind of mistake the audit trail is meant to catch.
 */
export const TOOL_VISIBILITY_POLICY: ReadonlyArray<ToolVisibilityEntry> = [
  // ==============================
  // hidden — zero transcript ink
  // ==============================
  {
    name: "enterplanmode",
    visibility: "hidden",
    rationale:
      "Plan-mode transition is a session-state change — a chrome banner is the right surface, not a transcript row. Banner is a future follow-up; for now the transition is silent.",
    reviewedAt: "2026-05-24",
  },
  {
    name: "exitplanmode",
    visibility: "hidden",
    rationale:
      "Symmetric counterpart of enterplanmode — same banner-not-transcript reading.",
    reviewedAt: "2026-05-24",
  },
  {
    name: "pushnotification",
    visibility: "hidden",
    rationale:
      "The notification itself (system bell / banner) is the user-visible surface. The tool call is plumbing.",
    reviewedAt: "2026-05-24",
  },
  {
    name: "schedulewakeup",
    visibility: "hidden",
    rationale:
      "Internal pacing for `/loop`-style autonomous flows; the wakeup itself is the user-visible event, not the scheduling call.",
    reviewedAt: "2026-05-24",
  },
  {
    name: "toolsearch",
    visibility: "hidden",
    rationale:
      "Schema-loading machinery — the assistant looking up a deferred tool's contract. Internal, user-irrelevant.",
    reviewedAt: "2026-05-24",
  },

  // ==============================
  // default-intent — known tool, JsonTree fallback for now,
  // bespoke wrapper planned (every entry must cite a follow-on step)
  // ==============================
  // (none — every previously default-intent tool has been promoted
  // to bespoke. New default-intent entries follow the same pattern:
  // a one-line `rationale` citing the planned `#step-...` and a
  // `reviewedAt` commit date.)
];

// ---------------------------------------------------------------------------
// Accessors — consumed by the dispatch at module load
// ---------------------------------------------------------------------------

/**
 * Lowercased canonical names of every `hidden` tool. The dispatch
 * builds a `HIDDEN_TOOL_NAMES` set from this and short-circuits
 * `resolveToolBlock` to return `NullToolBlock` for any name it
 * contains. Memoised by the module-static reduce below — the policy
 * table is `const` so the result never changes within a process.
 */
export function hiddenToolNames(): ReadonlySet<string> {
  return HIDDEN_TOOL_NAMES;
}

/**
 * Lowercased canonical names of every `default-intent` tool. The
 * dispatch builds its `AUDIT_CONFIRMED_DEFAULT_TOOLS` set from this —
 * a name in this set routes to `DefaultToolBlock` (the JsonTree
 * fallback) but does *not* raise an `unknown_tool` caution. Memoised
 * below for the same reason as `hiddenToolNames`.
 */
export function defaultIntentToolNames(): ReadonlySet<string> {
  return DEFAULT_INTENT_TOOL_NAMES;
}

// Pre-compute the two name sets once at module load — the policy
// table is `const`, so freezing the derived sets here means callers
// (including the dispatch's module-load wiring) get `Object.is`-stable
// references across every call. The sets are not exported directly
// because the accessor functions are the contract.
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_VISIBILITY_POLICY.filter((entry) => entry.visibility === "hidden").map(
    (entry) => entry.name,
  ),
);

const DEFAULT_INTENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_VISIBILITY_POLICY.filter(
    (entry) => entry.visibility === "default-intent",
  ).map((entry) => entry.name),
);
