/**
 * matchers.ts — Trace-assertion matchers for the in-app harness.
 *
 * Exports `toContainOrderedSubset`, which asserts that a sequence of
 * partial entries appears in-order (not necessarily contiguous) inside
 * a trace array. The `DeckTraceEvent` union in `deck-trace.ts` is the
 * shape reference; in practice the matcher is type-agnostic
 * so tests can hand it any event-like array.
 *
 * Semantics:
 *   - "Ordered subset": the entries must appear in the given order,
 *     but additional entries may sit between them.
 *   - "Partial match": each `expected` entry's keys that ARE specified
 *     must equal the corresponding keys on the actual entry; keys NOT
 *     specified are wildcards. Nested objects match recursively using
 *     the same partial rule; arrays use deep-equal on each element.
 *
 * The matcher is dual-shaped:
 *   - {@link toContainOrderedSubset} — pure predicate returning
 *     `{ pass, message }`. This is what the unit tests call.
 *   - {@link registerSubsetMatcher} — registers the matcher via
 *     `expect.extend` so tests can write
 *     `expect(trace).toContainOrderedSubset([...])`. Call this once at
 *     module load inside any test file that wants the fluent form.
 *
 * The pure-predicate shape exists precisely so the unit tests stay
 * tsc-checkable without dragging `expect.extend`'s type gymnastics
 * into every test file.
 */

import { expect } from "bun:test";

/**
 * A result shape compatible with both the bun:test `expect.extend`
 * contract and our own predicate-style assertions. `pass` is the
 * boolean outcome; `message` is a thunk producing a human-readable
 * explanation on failure.
 */
export interface MatcherResult {
  pass: boolean;
  message: () => string;
}

/**
 * A partially-specified entry. Every key in the expected object must
 * appear (with a matching value) in the actual entry. Extra keys on
 * the actual entry are allowed. Values are compared via
 * {@link partialMatchValue} (objects recurse, arrays deep-equal,
 * primitives strict-equal).
 *
 * Kept as `Record<string, unknown>` rather than `Partial<DeckTraceEvent>`
 * so callers can match on shapes that intentionally omit the union's
 * required fields (e.g. matching an `{ kind: "fr-flip" }` skeleton
 * without providing `from`/`to`/`trigger`).
 */
export type ExpectedEntry = Record<string, unknown>;

// ---------------------------------------------------------------------------
// DeckTraceEvent shape mirror (see `tugdeck/src/deck-trace.ts`)
// ---------------------------------------------------------------------------

/**
 * Discriminated-union mirror of `tugdeck/src/deck-trace.ts` →
 * `DeckTraceEvent`'s kind-specific payload. Fields stamped by the
 * trace module (`timestamp`, `seq`, `loc`, `store`) are declared
 * optional so this type matches both wire events (all four stamps
 * populated) and test fixtures (none populated).
 *
 * Keep every variant in sync with `DeckTraceEvent` in
 * `tugdeck/src/deck-trace.ts`. The drift test pins that coupling at
 * compile time; any new kind added there forces an update here
 * *and* a new branch in {@link summarizeEvent}.
 */
export type DeckTraceEventShape = {
  timestamp?: number;
  seq?: number;
  loc?: string;
  store?: unknown;
} & (
  | {
      kind: "fr-flip";
      from: string | null;
      to: string | null;
      trigger: string;
    }
  | {
      kind: "destination-flip";
      cardId: string;
      from: boolean;
      to: boolean;
    }
  | {
      kind: "card-host-mount";
      cardId: string;
      hostStackId: string;
    }
  | {
      kind: "card-host-unmount";
      cardId: string;
      hostStackId: string;
    }
  | {
      kind: "focus-call";
      site: string;
      cardId: string;
      targetSelector: string;
      activeBefore: string;
      activeAfter: string;
      hidden: boolean;
    }
  | {
      kind: "focusin";
      el: string;
      relatedTarget: string | null;
    }
  | {
      kind: "focusout";
      el: string;
      relatedTarget: string | null;
    }
  | {
      kind: "save-callback";
      cardId: string;
      source: string;
    }
  | {
      kind: "selection-restore";
      cardId: string;
      via: string;
    }
  | {
      kind: "commit-tick";
      count: number;
    }
  | {
      kind: "engine-ready";
      cardId: string;
      engine: string;
    }
  | {
      kind: "engine-activation-dispatched";
      cardId: string;
      engine: string;
      dispatchedFrom: string;
    }
  | {
      kind: "cold-boot-restore-snapshot";
      cardId: string;
      hasContent: boolean;
      engineSelection: { start: number; end: number } | null;
    }
  | {
      kind: "engine-restore-applied";
      cardId: string;
      engine: string;
      selectionApplied: { start: number; end: number } | null;
      domSelectionAfter: { start: number; end: number } | null;
    }
  | {
      kind: "focus-measurement";
      phase: string;
      site: string;
      cardId: string | null;
      activeElement: string;
    }
  | {
      kind: "engine-paint-mirror-active";
      cardId: string;
      caller: string;
    }
  | {
      kind: "engine-paint-mirror-inactive";
      cardId: string;
    }
  | {
      kind: "macrotask-focus-claim";
      cardId: string;
      delegate: string;
    }
  | {
      kind: "caret-responder-divergence";
      editorResponderId: string;
      firstResponderId: string | null;
    }
  | {
      kind: "kbf-caret-divergence";
      editorResponderId: string | null;
    }
  | {
      kind: "return-promise-collision";
      count: number;
      wearers: string;
    }
  | {
      kind: "follow-bottom";
      following: boolean;
      source: string;
    }
  | {
      kind: "scroll-displacement";
      from: number;
      to: number;
      scrollHeight: number;
      clientHeight: number;
      following: boolean;
      evicting: boolean;
    }
  | {
      kind: "extent-rebase";
      from: number;
      to: number;
      scrollTop: number;
      clientHeight: number;
      clamped: boolean;
      following: boolean;
    }
  | {
      kind: "store-notify";
      caller: string;
      version: number;
      /** How the commit declared it wants to land ([B01], [B02]). */
      landing: "cross" | "cut";
    }
  | {
      kind: "settle-arm";
      signature: string;
      panes: number;
      armed: boolean;
      /** How the commit that provoked this arm declared it wanted to land. */
      landing: "cross" | "cut";
      /** What this arm did about it ([B06]). */
      outcome: "carried" | "unarmed" | "declined" | "unchanged";
    }
  | {
      kind: "settle-retarget";
      paneId: string;
      mode: "snap" | "matched";
    }
  | {
      kind: "session-lifecycle";
      event: string;
      fields: Record<string, unknown>;
    }
);

/**
 * Set of every `kind` handled by {@link summarizeEvent}. Exported so
 * `tugdeck/src/__tests__/trace-summarize-drift.test.ts` can pin it
 * against the real `DeckTraceEvent` union at compile time — a new
 * kind added to tugdeck without a matching branch here fails that
 * test's tsc pass with an actionable error.
 */
export const HARNESS_KNOWN_TRACE_KINDS = [
  "fr-flip",
  "destination-flip",
  "card-host-mount",
  "card-host-unmount",
  "focus-call",
  "focusin",
  "focusout",
  "save-callback",
  "selection-restore",
  "commit-tick",
  "engine-ready",
  "engine-activation-dispatched",
  "cold-boot-restore-snapshot",
  "engine-restore-applied",
  "focus-measurement",
  "engine-paint-mirror-active",
  "engine-paint-mirror-inactive",
  "macrotask-focus-claim",
  "caret-responder-divergence",
  "kbf-caret-divergence",
  "return-promise-collision",
  "follow-bottom",
  "scroll-displacement",
  "extent-rebase",
  "store-notify",
  "settle-arm",
  "settle-retarget",
  "session-lifecycle",
] as const;
export type HarnessKnownTraceKind = (typeof HARNESS_KNOWN_TRACE_KINDS)[number];

/**
 * Strict deep-equal for values. Used for array elements and for
 * nested objects when the expected side's key list spans the entire
 * value shape (i.e. the caller passed an "exact-match" expectation
 * for that nested level).
 *
 * For the top-level partial-match semantics use
 * {@link partialMatchValue}.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Compare a single expected value against the corresponding actual
 * value using the matcher's partial-match rules.
 *
 *   - Primitives (including `null`/`undefined`) strict-equal.
 *   - Arrays deep-equal (arrays are treated as opaque values at nested
 *     levels — the top-level "ordered subset" semantics apply only to
 *     the outer trace array, not to nested sequences).
 *   - Plain objects recurse with the same partial-match rule: every
 *     key in `expected` must be present and match in `actual`; extra
 *     keys on `actual` are ignored.
 */
function partialMatchValue(expected: unknown, actual: unknown): boolean {
  if (expected === undefined) {
    // An explicit `undefined` in the expected entry means "the actual
    // must also be undefined" — matches the user's intent if they
    // literally typed `undefined`. Missing keys are handled at the
    // object level (see `partialMatchEntry`).
    return actual === undefined;
  }
  if (expected === null) return actual === null;
  if (typeof expected !== "object") return Object.is(expected, actual);
  if (Array.isArray(expected)) return deepEqual(expected, actual);
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  for (const key of Object.keys(expected as object)) {
    const ok = partialMatchValue(
      (expected as Record<string, unknown>)[key],
      (actual as Record<string, unknown>)[key],
    );
    if (!ok) return false;
  }
  return true;
}

/**
 * Check a single expected entry against a single actual entry using
 * the partial-match rule. Every key in `expected` must be present
 * and match in `actual`; unspecified keys are wildcards.
 */
function partialMatchEntry(
  expected: ExpectedEntry,
  actual: unknown,
): boolean {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  for (const key of Object.keys(expected)) {
    const ok = partialMatchValue(
      expected[key],
      (actual as Record<string, unknown>)[key],
    );
    if (!ok) return false;
  }
  return true;
}

/**
 * Pretty-print a value for the failure message. We keep this cheap
 * and deterministic — `JSON.stringify` with a 2-space indent is plenty
 * for the shallow shapes we deal with, and it won't throw on the
 * serializable DeckTraceEvent union.
 */
function prettify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Render a single value compactly for the one-line summary used in
 * order-violation annotations. Primitives become their literal form,
 * strings stay unquoted, objects/arrays fall back to JSON.
 */
function summarizeValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Format a scalar field value for inclusion in a summarizeEvent
 * label. Maps `undefined` → `?` (partial expected-entry sentinel)
 * and `null` → `∅` (explicit-null marker, distinct from unset);
 * everything else stringifies. Lets the same summarizer serve
 * both real trace events (all fields populated) AND partially-
 * specified expected entries passed through the ordered-subset
 * matcher's annotation path — a matcher-level concern surfacing
 * here because both shapes share the `kind`-keyed union mirror.
 */
function fmt(v: unknown): string {
  if (v === undefined) return "?";
  if (v === null) return "∅";
  return String(v);
}

/**
 * One-line summary of a fully-typed {@link DeckTraceEventShape}.
 * Label grammar per Step 0e: kind-specific short forms
 * (`fr-flip A→B trigger=…`, `destination-flip B:false→true`,
 * `focus-call C site=… target=… active=…→…`, etc.) chosen to make
 * the sequence scannable in 10 seconds without opening the full
 * JSON dump.
 *
 * The `default` branch triggers a compile-time `never` check: every
 * kind in the mirrored {@link DeckTraceEventShape} union must have a
 * case here, and adding a new kind to that union fails tsc until a
 * matching branch lands. The companion drift test in
 * `tugdeck/src/__tests__/trace-summarize-drift.test.ts` pins the
 * mirror against tugdeck's real `DeckTraceEvent` union so any drift
 * between the two is caught at the tugdeck tsc boundary too.
 *
 * Missing fields on partial expected entries render via {@link fmt}
 * as `?` (undefined) or `∅` (explicit null), never as the literal
 * string "undefined".
 */
export function summarizeEvent(e: DeckTraceEventShape): string {
  switch (e.kind) {
    case "fr-flip":
      return `fr-flip ${fmt(e.from)}→${fmt(e.to)} trigger=${fmt(e.trigger)}`;
    case "destination-flip":
      return `destination-flip ${fmt(e.cardId)}:${fmt(e.from)}→${fmt(e.to)}`;
    case "card-host-mount":
      return `card-host-mount ${fmt(e.cardId)} stack=${fmt(e.hostStackId)}`;
    case "card-host-unmount":
      return `card-host-unmount ${fmt(e.cardId)} stack=${fmt(e.hostStackId)}`;
    case "focus-call": {
      const parts = [
        `focus-call ${fmt(e.cardId)}`,
        `site=${fmt(e.site)}`,
        `target=${fmt(e.targetSelector)}`,
        `active=${e.activeBefore || "∅"}→${e.activeAfter || "∅"}`,
      ];
      if (e.hidden === true) parts.push("hidden=true");
      return parts.join(" ");
    }
    case "focusin":
      return e.relatedTarget !== null && e.relatedTarget !== undefined
        ? `focusin el=${fmt(e.el)} from=${e.relatedTarget}`
        : `focusin el=${fmt(e.el)}`;
    case "focusout":
      return e.relatedTarget !== null && e.relatedTarget !== undefined
        ? `focusout el=${fmt(e.el)} to=${e.relatedTarget}`
        : `focusout el=${fmt(e.el)}`;
    case "save-callback":
      return `save-callback ${fmt(e.cardId)} src=${fmt(e.source)}`;
    case "selection-restore":
      return `selection-restore ${fmt(e.cardId)} via=${fmt(e.via)}`;
    case "commit-tick":
      return `commit-tick count=${fmt(e.count)}`;
    case "engine-ready":
      return `engine-ready ${fmt(e.cardId)} engine=${fmt(e.engine)}`;
    case "engine-activation-dispatched":
      return `engine-activation-dispatched ${fmt(e.cardId)} engine=${fmt(e.engine)} from=${fmt(e.dispatchedFrom)}`;
    case "cold-boot-restore-snapshot": {
      const sel =
        e.engineSelection !== null
          ? `${e.engineSelection.start}..${e.engineSelection.end}`
          : "null";
      return `cold-boot-restore-snapshot ${fmt(e.cardId)} hasContent=${fmt(e.hasContent)} sel=${sel}`;
    }
    case "engine-restore-applied": {
      const applied =
        e.selectionApplied !== null
          ? `${e.selectionApplied.start}..${e.selectionApplied.end}`
          : "null";
      const dom =
        e.domSelectionAfter !== null
          ? `${e.domSelectionAfter.start}..${e.domSelectionAfter.end}`
          : "null";
      return `engine-restore-applied ${fmt(e.cardId)} engine=${fmt(e.engine)} applied=${applied} dom=${dom}`;
    }
    case "focus-measurement":
      return `focus-measurement ${fmt(e.cardId)} phase=${fmt(e.phase)} site=${fmt(e.site)} active=${e.activeElement || "∅"}`;
    case "engine-paint-mirror-active":
      return `engine-paint-mirror-active ${fmt(e.cardId)} caller=${fmt(e.caller)}`;
    case "engine-paint-mirror-inactive":
      return `engine-paint-mirror-inactive ${fmt(e.cardId)}`;
    case "macrotask-focus-claim":
      return `macrotask-focus-claim ${fmt(e.cardId)} delegate=${fmt(e.delegate)}`;
    case "caret-responder-divergence":
      return `caret-responder-divergence editor=${fmt(e.editorResponderId)} firstResponder=${fmt(e.firstResponderId)}`;
    case "kbf-caret-divergence":
      return `kbf-caret-divergence editor=${fmt(e.editorResponderId)}`;
    case "return-promise-collision":
      return `return-promise-collision count=${e.count} wearers=${fmt(e.wearers)}`;
    case "follow-bottom":
      return `follow-bottom ${e.following ? "engage" : "disengage"} source=${fmt(e.source)}`;
    case "scroll-displacement":
      return `scroll-displacement ${e.from}→${e.to} (${e.to - e.from >= 0 ? "+" : ""}${e.to - e.from}) h=${e.scrollHeight}/${e.clientHeight} following=${e.following} evicting=${e.evicting}`;
    case "extent-rebase":
      return `extent-rebase ${e.from}→${e.to} (${e.to - e.from}) top=${e.scrollTop} client=${e.clientHeight} clamped=${e.clamped} following=${e.following}`;
    case "store-notify":
      return `store-notify caller=${fmt(e.caller)} v=${e.version} landing=${e.landing}`;
    case "settle-arm":
      return `settle-arm ${e.outcome} landing=${e.landing} panes=${e.panes} sig=${fmt(e.signature)}`;
    case "settle-retarget":
      return `settle-retarget ${e.mode} pane=${fmt(e.paneId)}`;
    case "session-lifecycle":
      return `session-lifecycle ${fmt(e.event)} ${Object.entries(e.fields)
        .map(([k, v]) => `${k}=${fmt(v)}`)
        .join(" ")}`;
    default: {
      // Exhaustiveness pin: if a new kind is added to DeckTraceEventShape,
      // the assignment below fails because `e` is no longer `never`.
      const _exhaustive: never = e;
      void _exhaustive;
      return "<unknown>";
    }
  }
}

/**
 * Type guard for an entry whose `kind` matches one of the variants
 * {@link summarizeEvent} handles. Lets {@link summarizeEntry} route
 * known shapes through the typed summarizer without an `as` cast.
 */
function isKnownTraceEvent(entry: unknown): entry is DeckTraceEventShape {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const kind = (entry as Record<string, unknown>).kind;
  return (
    typeof kind === "string" &&
    (HARNESS_KNOWN_TRACE_KINDS as readonly string[]).includes(kind)
  );
}

/**
 * Render an expected entry or trace event as a terse one-line string.
 * Trace events with a known `kind` are routed through
 * {@link summarizeEvent} for the kind-specific short form; unknown
 * shapes (including partially-specified expected entries) fall back
 * to the generic `kind key1=value1 key2=value2` rendering.
 *
 * Fields stamped by the trace module itself (`timestamp`, `seq`,
 * `loc`, `store`) are omitted — they are context, not signal, for
 * the subset-matcher's diagnosis.
 */
function summarizeEntry(entry: unknown): string {
  if (isKnownTraceEvent(entry)) {
    return summarizeEvent(entry);
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return String(entry);
  }
  const obj = entry as Record<string, unknown>;
  const kind = typeof obj.kind === "string" ? obj.kind : "?";
  const skip = new Set(["kind", "timestamp", "seq", "loc", "store"]);
  const pairs = Object.keys(obj)
    .filter((k) => !skip.has(k))
    .map((k) => `${k}=${summarizeValue(obj[k])}`);
  return pairs.length > 0 ? `${kind} ${pairs.join(" ")}` : kind;
}

/**
 * Render the numbered one-line summary of the full `actual` trace
 * that {@link toContainOrderedSubset} prepends above its JSON dump
 * on failure. Each row carries at most three markers:
 *   - `← matched #N`        — this actual entry satisfied expected #N.
 *   - `← expected #i (wrong order)`
 *                          — would have matched the failing expected
 *                            but lies BEFORE an earlier match (order
 *                            violation from Step 0b).
 *   - `← cursor stopped here`
 *                          — the matcher's scan cursor for the failing
 *                            expected sat at this index.
 *
 * The footer spells out how many actual rows were scanned without a
 * match for the failing expected so the reader can tell at a glance
 * whether the trace is short a needed event or the wrong shape.
 */
function formatActualSummary(
  actual: readonly unknown[],
  matchedIndices: readonly number[],
  earlierMatches: readonly number[],
  cursor: number,
  missingExpectedIndex: number,
  want: ExpectedEntry,
): string {
  if (actual.length === 0) {
    return `actual trace summary: trace is empty (0 entries).`;
  }
  const indexWidth = String(actual.length - 1).length;
  const matchedByIndex = new Map<number, number>();
  matchedIndices.forEach((idx, pos) => matchedByIndex.set(idx, pos));
  const earlierSet = new Set(earlierMatches);
  const header =
    `actual trace summary ` +
    `(matched ${matchedIndices.length}/${matchedIndices.length + 1} ` +
    `before failing on expected #${missingExpectedIndex}):`;
  const lines: string[] = [header];
  for (let i = 0; i < actual.length; i++) {
    const idx = String(i).padStart(indexWidth, " ");
    const label = summarizeEntry(actual[i]);
    const markers: string[] = [];
    const matchedPos = matchedByIndex.get(i);
    if (matchedPos !== undefined) {
      markers.push(`← matched #${matchedPos}`);
    }
    if (earlierSet.has(i)) {
      markers.push(`← expected #${missingExpectedIndex} (wrong order)`);
    }
    if (i === cursor && cursor < actual.length) {
      markers.push(`← cursor stopped here`);
    }
    const suffix = markers.length > 0 ? `   ${markers.join("  ")}` : "";
    lines.push(`  [${idx}] ${label}${suffix}`);
  }
  const gap = actual.length - cursor;
  const footer =
    cursor >= actual.length
      ? `cursor ran past the end of the trace without matching expected #${missingExpectedIndex} (${summarizeEntry(want)}).`
      : `expected #${missingExpectedIndex} (${summarizeEntry(want)}) not found in actual[${cursor}..${actual.length}); scanned ${gap} entries.`;
  lines.push(footer);
  return lines.join("\n");
}

/**
 * Assert that `expected` appears as an ordered subset of `actual`:
 * every `expected[i]` must partial-match some `actual[j]`, with the
 * chosen j values strictly increasing. Extra actual entries between
 * matches are fine.
 *
 * Returns a `{ pass, message }` pair compatible with both our direct
 * test usage and the `expect.extend` registration.
 *
 * The search is greedy from the left: at each expected index we scan
 * forward in `actual` from the last-matched position + 1. This
 * matches human intuition ("find the next entry that fits") and
 * avoids pathological backtracking on trace shapes that do not
 * branch.
 */
export function toContainOrderedSubset(
  actual: readonly unknown[] | null | undefined,
  expected: readonly ExpectedEntry[],
): MatcherResult {
  if (!Array.isArray(actual)) {
    return {
      pass: false,
      message: () =>
        `expected an array of trace entries, received ${prettify(actual)}`,
    };
  }
  if (expected.length === 0) {
    return {
      pass: true,
      message: () => "expected an empty subset; trivially matches any trace",
    };
  }

  let cursor = 0;
  const matchedIndices: number[] = [];
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    let found = -1;
    for (let j = cursor; j < actual.length; j++) {
      if (partialMatchEntry(want, actual[j])) {
        found = j;
        break;
      }
    }
    if (found === -1) {
      // Scan the earlier section of `actual` for matches. If the
      // failed entry exists BEFORE the cursor, the failure is an
      // order violation, not a genuine absence — emit an
      // annotation at the top of the message that spells it out so
      // callers don't have to eyeball the JSON to reach the same
      // conclusion.
      const earlierMatches: number[] = [];
      for (let k = 0; k < cursor; k++) {
        if (partialMatchEntry(want, actual[k])) {
          earlierMatches.push(k);
        }
      }
      const matchedTail = matchedIndices.length
        ? ` (matched indices so far: [${matchedIndices.join(", ")}])`
        : "";
      // Split the base message into a preamble and the JSON dump so
      // the one-line summary (Step 0e) can sit BETWEEN them — the
      // reader scans the summary first, drops into the JSON only
      // when a field that summarizeEvent elides is in question.
      const baseHeader =
        `expected trace to contain entry #${i} as an ordered subset${matchedTail}:\n` +
        `looking for:\n${prettify(want)}\n` +
        `after actual index ${cursor - 1}; trace length = ${actual.length}.`;
      const fullTraceDump = `full trace:\n${prettify(actual)}`;
      let annotation = "";
      if (earlierMatches.length > 0 && matchedIndices.length > 0) {
        const priorIdx = matchedIndices[matchedIndices.length - 1]!;
        const earliestEarlier = earlierMatches[0]!;
        const idxList = earlierMatches.length === 1
          ? `actual[${earliestEarlier}]`
          : `actual[${earlierMatches.join(", ")}]`;
        annotation =
          `Order violation in ordered subset match:\n` +
          `  Expected #${i} (${summarizeEntry(want)}) matches ${idxList},\n` +
          `  BEFORE the prior match for expected #${i - 1} ` +
          `(${summarizeEntry(expected[i - 1])}) at actual[${priorIdx}].\n\n`;
      }
      const summaryBlock = formatActualSummary(
        actual,
        matchedIndices,
        earlierMatches,
        cursor,
        i,
        want,
      );
      return {
        pass: false,
        message: () =>
          `${annotation}${baseHeader}\n\n${summaryBlock}\n\n${fullTraceDump}`,
      };
    }
    matchedIndices.push(found);
    cursor = found + 1;
  }

  return {
    pass: true,
    message: () =>
      `expected trace NOT to contain ordered subset, but it did at indices [${matchedIndices.join(", ")}]`,
  };
}

/**
 * Register `toContainOrderedSubset` with bun:test's `expect`. Calling
 * this once per test file that uses the fluent form is safe;
 * `expect.extend` is idempotent with respect to redefining the same
 * matcher name.
 *
 * Tests that prefer the pure predicate form can ignore this function
 * and call {@link toContainOrderedSubset} directly.
 */
export function registerSubsetMatcher(): void {
  expect.extend({
    toContainOrderedSubset(
      received: unknown,
      expected: readonly ExpectedEntry[],
    ): MatcherResult {
      // Narrow the first argument: the matcher only makes sense on
      // array-like inputs. We forward to the pure predicate so the
      // behavior is identical to the direct-call shape.
      return toContainOrderedSubset(
        received as readonly unknown[] | null | undefined,
        expected,
      );
    },
  });
}

/**
 * Augment `bun:test`'s matcher type list so tests importing this
 * module (plus calling {@link registerSubsetMatcher}) get typed
 * `.toContainOrderedSubset(...)` calls on `expect(trace)`.
 */
declare module "bun:test" {
  interface Matchers<T> {
    toContainOrderedSubset(expected: readonly ExpectedEntry[]): T;
  }
  interface AsymmetricMatchers {
    toContainOrderedSubset(expected: readonly ExpectedEntry[]): unknown;
  }
}
