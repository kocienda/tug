/**
 * Pure-logic telemetry helpers — derived views on `TurnEntry` /
 * `CodeSessionState` that the per-turn surface and chrome consume.
 *
 * The reducer captures discrete per-turn signals (timestamps,
 * accumulators, cost snapshots). This module turns those signals into
 * the shapes consumers actually want — per-turn context size, session
 * totals, live in-flight clocks — without any time source, DOM, or
 * React. The lone external coupling is `Date.now()`-style numbers
 * passed in as `now` parameters by the call site.
 *
 * Conformance:
 *   - No DOM, no React, no module-mutable state.
 *   - No `Date.now()` reads inside this module — callers supply `now`
 *     for the `liveTurn*` family so the helpers stay deterministic and
 *     trivially testable.
 *   - No imports from the reducer (the reducer imports from here, not
 *     the other way around) — avoids a circular dependency.
 *
 * @module lib/code-session-store/telemetry
 */

import { deriveContextWindows } from "./end-state";
import type { CodeSessionState } from "./reducer";
import type {
  CodeSessionSnapshot,
  CostSnapshot,
  LiveMessageUsage,
  TurnCost,
  TurnEndReason,
  TurnEntry,
} from "./types";

/**
 * The model's view of "context tokens consumed at the boundary of this
 * turn." Sum of the input + cache-read + cache-creation token counts.
 * Output tokens are NOT part of context — they're the model's response,
 * not its input.
 *
 * Used by the window-utilization gauge (numerator) against the model's
 * static context-window max (denominator).
 */
export function perTurnContextSize(turn: TurnEntry): number {
  return (
    turn.cost.inputTokens +
    turn.cost.cacheReadInputTokens +
    turn.cost.cacheCreationInputTokens
  );
}

/**
 * Build a turn's `TurnCost` from the `cost_update` snapshots taken at
 * the turn's boundaries (`before` = the snapshot at submit, `after` =
 * the snapshot at completion).
 *
 * The four token fields are the turn's LAST tool-loop iteration's
 * `usage`. tugcode emits `cost_update.usage` from the turn's most
 * recent `message_delta` — the final API call of the tool loop —
 * whose `input + cache_read + cache_creation + output` IS the
 * resident context window after the turn. They are read straight off
 * `after.usage` with no turn-over-turn subtraction.
 *
 * What is explicitly NOT stored: `result.usage`. `result.usage` is
 * the SUM of `usage` across every API call of the turn, so a turn
 * that makes K tool calls re-reads the (cached) context K times and
 * `result.usage` over-counts by ~K times. Storing that would make
 * `turnWindowTokens` scale with tool-call count instead of context
 * size. tugcode's `cost_update` carries the last iteration instead;
 * this helper just freezes it.
 *
 * `totalCostUsd` IS cumulative-per-session, so it alone is
 * differenced: `after.totalCostUsd - before.totalCostUsd`, clamped to
 * non-negative. (`total_cost_usd` and `num_turns` accumulate across
 * the session; `usage` is a per-turn snapshot — the asymmetry is the
 * whole point of this function.)
 *
 *   - `after === null`: no `cost_update` fired for this turn -> all zeros.
 *   - `before === null`: first turn -> the cost term is `after.totalCostUsd`.
 *
 * The token fields (`input_tokens`, `output_tokens`,
 * `cache_creation_input_tokens`, `cache_read_input_tokens`) are read
 * by {@link readUsage}; the same names also appear in
 * `modelUsage[<model>]`, which this helper does not read (a future
 * per-model breakdown would).
 */
export function extractTurnCost(
  before: CostSnapshot | null,
  after: CostSnapshot | null,
): TurnCost {
  if (after === null) {
    return ZERO_TURN_COST;
  }
  const usage = readUsage(after.usage);
  const beforeCostUsd = before === null ? 0 : before.totalCostUsd;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    totalCostUsd: clampNonNegative(after.totalCostUsd - beforeCostUsd),
  };
}

// ---------------------------------------------------------------------------
// Per-area popover summaries — count / total / average shapes consumed
// by the Dev status-row popovers (`Time`, `Tokens`) per plan
// `#step-20-4-7-a`. Built on top of {@link deriveSessionTotals} so the
// session-wide sums are computed once; the popover-specific helpers
// add the popover surface's specific shape (count + average for the
// per-area summary footer).
// ---------------------------------------------------------------------------
//
// Why two purpose-named helpers instead of one generic surface: each
// popover has its own footer copy and its own units (ms vs tokens),
// and the renderers downstream want a typed shape they can destructure
// without manually re-computing averages. The two helpers stay tiny
// because they delegate the actual summation to `deriveSessionTotals`.

/**
 * Per-turn timing summary for the `Time` status-area popover.
 *
 *   - `count`: number of committed turns in `transcript[]`.
 *   - `totalActiveMs`: sum of `TurnEntry.activeMs` across the transcript.
 *   - `avgActiveMs`: arithmetic mean, rounded to the nearest ms; `0`
 *     when `count === 0` (avoids a NaN footer for fresh sessions).
 *
 * Active-time is the "machine doing work" measure the indicator's
 * green-axis paint represents — wall-clock minus pause time. The
 * popover surfaces this same measure across the committed transcript
 * so the user sees the per-turn breakdown that matches the headline
 * cell value.
 */
export interface TurnTimingSummary {
  count: number;
  totalActiveMs: number;
  avgActiveMs: number;
}

/**
 * Compute the `Time` popover's summary block from the committed
 * transcript. In-flight turns are NOT included by design — the popover's
 * row log shows committed turns only; live in-flight time is surfaced
 * separately in the popover footer by the renderer (via
 * {@link deriveInflightActiveMs}). See plan `#step-20-4-7-a`.
 */
export function computeTimeSummary(
  transcript: ReadonlyArray<TurnEntry>,
): TurnTimingSummary {
  const totals = deriveSessionTotals(transcript);
  return {
    count: totals.turnCount,
    totalActiveMs: totals.totalActiveMs,
    avgActiveMs:
      totals.turnCount === 0
        ? 0
        : Math.round(totals.totalActiveMs / totals.turnCount),
  };
}

/**
 * Categorical tone for {@link computeRichContextBreakdown} segments.
 * Structurally compatible with `TugArcGaugeSegmentTone` (the gauge
 * primitive's segments-mode tone enum) — the popover hands a
 * breakdown's `segments` array straight to `TugArcGauge` in segments
 * mode without mapping or casting.
 *
 * The vocabulary: the five static `/context`-style categories
 * (`system_prompt` / `system_tools` / `custom_agents` / `memory_files`
 * / `skills`), the feed-derived `messages` slice, the conditional
 * reserved `autocompact_buffer`, and the auto-synthesized `remainder`.
 * `mcp_tools` is intentionally absent — Tug treats MCP as out of scope.
 *
 * Declared locally here rather than imported from the components
 * layer so the library boundary stays one-way: `lib` doesn't depend
 * on `components`.
 */
export type ContextBreakdownTone =
  | "system_prompt"
  | "system_tools"
  | "custom_agents"
  | "memory_files"
  | "skills"
  | "messages"
  | "autocompact_buffer"
  | "remainder";

/**
 * One segment in a context-window categorical breakdown. Mirrors the
 * shape `TugArcGauge`'s segments mode consumes ({@link ContextBreakdownTone}
 * matches its tone union exactly), so the popover renderer can pass
 * the array through without translation.
 */
export interface ContextBreakdownSegment {
  /** Stable identity for the segment across renders. */
  id: string;
  /** Categorical tone — paired with the matching `--tugx-arc-gauge-segment-<tone>-color` slot. */
  tone: ContextBreakdownTone;
  /** Token count for this category (clamped to ≥ 0). */
  value: number;
  /** Human-readable label for the legend. */
  label: string;
}

/**
 * Output shape of {@link computeRichContextBreakdown}: the segments
 * that paint the categorical arc + the headline `totalUsed` count +
 * the `contextMax` cap so the popover footer can render `used / max`.
 */
export interface ContextBreakdown {
  segments: ReadonlyArray<ContextBreakdownSegment>;
  /**
   * Resident context occupied = `bootstrap + messages` = the model's
   * `window` — feed-exact, and identical to the `CONTEXT` cell. The
   * reserved `autocompact_buffer` slice is NOT counted here (it is
   * reserved headroom, not occupied content).
   */
  totalUsed: number;
  /** The model's context-window cap as passed in (clamped to non-negative). */
  contextMax: number;
}

/**
 * Input for {@link computeRichContextBreakdown}.
 */
export interface RichContextBreakdownInput {
  /**
   * tugcode's static-category estimate (the `context_breakdown` wire
   * frame, projected onto `snap.lastContextBreakdown`). `null` until
   * the first frame lands — the popover then has nothing to paint.
   */
  staticBreakdown: ContextBreakdownSnapshotInput | null;
  /**
   * Feed-exact bootstrap `window(0)` — `snap.sessionInitTokens`.
   * `null` before turn 1's first streaming frame; the helper then
   * falls back to the raw static-estimate total.
   */
  sessionInitTokens: number | null;
  /**
   * Resident context window — `window(latest)` (committed) or the
   * live in-flight window. `null` with no turns and nothing in
   * flight; the helper then reports `messages = 0`.
   */
  windowTokens: number | null;
  /** Context-window cap (the `used / max` denominator). */
  contextMax: number;
}

/**
 * Shape this helper reads out of the snapshot's
 * {@link CodeSessionSnapshot.lastContextBreakdown} field. Declared as
 * a structural type so the caller can pass either the snapshot's
 * field directly or any other source carrying the same shape
 * (test fixtures, supervisor-side prefetch, etc.).
 */
export interface ContextBreakdownSnapshotInput {
  contextMax: number;
  categories: ReadonlyArray<{
    id: ContextBreakdownTone;
    label: string;
    tokens: number;
  }>;
}

/** The five session-stable category ids the wire frame carries. */
const STATIC_BREAKDOWN_IDS: ReadonlySet<string> = new Set([
  "system_prompt",
  "system_tools",
  "custom_agents",
  "memory_files",
  "skills",
]);

/**
 * Assemble the `/context`-style breakdown for the Context popover.
 *
 * The breakdown is feed-anchored: its TOTAL and its `messages` slice
 * are exact; only the split among the five static categories is an
 * estimate.
 *
 *   - The five static categories (`system_prompt` … `skills`) come
 *     from tugcode's local tokenizer (`staticBreakdown`). They are
 *     SCALED so they sum exactly to the bootstrap — the last category
 *     absorbs the integer-rounding residual.
 *   - The bootstrap is the feed-exact `sessionInitTokens` once
 *     captured; before turn 1 it is the raw static-estimate total
 *     (the only figure available — see the session-open requirement).
 *   - `messages = window - bootstrap`, feed-exact (equals `Σ perTurn`).
 *   - `autocompact_buffer`, when the frame carries it, is reserved
 *     headroom — a segment, but NOT part of `totalUsed`.
 *   - `remainder` fills the arc out to `contextMax`.
 *
 * `totalUsed = bootstrap + messages = window` — identical to the
 * `CONTEXT` cell, by construction. Returns `null` when no
 * `context_breakdown` frame has landed (popover empty state).
 *
 * Pure: no DOM, no React, no time source.
 */
export function computeRichContextBreakdown(
  input: RichContextBreakdownInput,
): ContextBreakdown | null {
  const { staticBreakdown, sessionInitTokens, windowTokens, contextMax } =
    input;
  if (staticBreakdown === null) {
    // No durable `context_breakdown_latest` row (fresh target / pure offline
    // replay, [P05]): the fine-grained static categories (system prompt,
    // tools, memory, skills) and the reserved `autocompact_buffer` are NOT
    // reconstructable — they come only from tugcode's live tokenizer frame.
    // But the usage-derived occupancy IS reconstructable from the replayed
    // per-turn cost: the session baseline (`window(0)` = `sessionInit`, the
    // lumped startup context) and the messages (`window − baseline`). Build
    // that coarse breakdown so the /context popover is populated on ANY
    // target rather than empty. `null` only when there is genuinely no usage
    // yet (the popover then stays empty, honestly).
    if (windowTokens === null || windowTokens <= 0) {
      return null;
    }
    const safeMax = Math.max(0, contextMax);
    const baseline = Math.max(0, Math.min(sessionInitTokens ?? 0, windowTokens));
    const messages = Math.max(0, windowTokens - baseline);
    const reconstructed: ContextBreakdownSegment[] = [];
    if (baseline > 0) {
      // Lumped under the system-prompt tone — the baseline is dominated by the
      // system prompt + tools; without the static frame it can't be split.
      reconstructed.push({
        id: "session_context",
        tone: "system_prompt",
        value: baseline,
        label: "Session context",
      });
    }
    reconstructed.push({
      id: "messages",
      tone: "messages",
      value: messages,
      label: "Messages",
    });
    reconstructed.push({
      id: "remainder",
      tone: "remainder",
      value: Math.max(0, safeMax - windowTokens),
      label: "Unused",
    });
    return {
      segments: reconstructed,
      totalUsed: windowTokens,
      contextMax: safeMax,
    };
  }
  const safeContextMax = Math.max(0, contextMax);

  // Partition the wire frame: the five static categories vs the
  // conditional, reserved `autocompact_buffer`. A stray `messages`
  // category (older tugcode) is ignored — `messages` is feed-derived.
  const staticCats: Array<{
    id: ContextBreakdownTone;
    label: string;
    tokens: number;
  }> = [];
  let autocompact: { label: string; tokens: number } | null = null;
  for (const c of staticBreakdown.categories) {
    if (c.id === "autocompact_buffer") {
      autocompact = { label: c.label, tokens: Math.max(0, c.tokens) };
      continue;
    }
    if (!STATIC_BREAKDOWN_IDS.has(c.id)) {
      continue;
    }
    staticCats.push({
      id: c.id,
      label: c.label,
      tokens: Math.max(0, c.tokens),
    });
  }
  const rawStaticTotal = staticCats.reduce((acc, c) => acc + c.tokens, 0);

  // Bootstrap: feed-exact `sessionInit` once captured; before turn 1
  // the raw static-estimate total (the only figure available).
  const bootstrap = sessionInitTokens ?? rawStaticTotal;
  // `messages` is feed-exact: window − bootstrap. 0 before any turn.
  const messages = Math.max(0, (windowTokens ?? bootstrap) - bootstrap);

  // Scale the static split so it sums EXACTLY to the bootstrap; the
  // last category absorbs the integer-rounding residual.
  const scale = rawStaticTotal > 0 ? bootstrap / rawStaticTotal : 0;
  const segments: ContextBreakdownSegment[] = [];
  let scaledRunning = 0;
  staticCats.forEach((c, i) => {
    const value =
      i === staticCats.length - 1
        ? Math.max(0, bootstrap - scaledRunning)
        : Math.round(c.tokens * scale);
    scaledRunning += value;
    segments.push({ id: c.id, tone: c.id, value, label: c.label });
  });

  segments.push({
    id: "messages",
    tone: "messages",
    value: messages,
    label: "Messages",
  });

  let reservedBuffer = 0;
  if (autocompact !== null) {
    reservedBuffer = autocompact.tokens;
    segments.push({
      id: "autocompact_buffer",
      tone: "autocompact_buffer",
      value: reservedBuffer,
      label: autocompact.label,
    });
  }

  const totalUsed = bootstrap + messages;
  const remainder = Math.max(0, safeContextMax - totalUsed - reservedBuffer);
  segments.push({
    id: "remainder",
    tone: "remainder",
    value: remainder,
    label: "Unused",
  });

  return { segments, totalUsed, contextMax: safeContextMax };
}

/**
 * The conversation-to-base ratio below which `/compact` frees little — the
 * threshold behind the minimal-effect hint ([P08]). At 0.25, a conversation
 * under a quarter of the base (e.g. base ≈ 38K, conversation ≈ 4K) reads as
 * "small effect"; a conversation ≳ a third of the base does not.
 */
export const COMPACTION_LOW_EFFORT_RATIO = 0.25;

/**
 * Whether the conversation is much smaller than the fixed base — the predicate
 * behind the `/compact` minimal-effect hint ([P08]). `/compact` summarizes only
 * the conversation (`window(latest) − sessionInit`); when that is a small
 * fraction of the base (`sessionInit`), compaction frees little and the hint
 * says so. NEVER gates the command — only tints its slash-popup description.
 *
 * Reads the honest window via {@link deriveContextWindows} (with the
 * post-compaction overrides, so a just-compacted session doesn't itself trip
 * the hint on a stale peak). Returns false when there is no base yet
 * (`sessionInit` null/≤0), no turns, or the conversation is empty/negative —
 * the hint needs a real base+conversation to be honest.
 *
 * Pure: no DOM, no React, no time source.
 */
export function isCompactionLowEffect(
  transcript: ReadonlyArray<TurnEntry>,
  sessionInitTokens: number | null,
): boolean {
  if (sessionInitTokens === null || sessionInitTokens <= 0) return false;
  const steps = deriveContextWindows(
    transcript.map((t) => t.cost),
    sessionInitTokens,
    transcript.map((t) => t.compactionPostTotal ?? null),
  );
  if (steps.length === 0) return false;
  const window = steps[steps.length - 1]!.window;
  const conversation = window - sessionInitTokens;
  if (conversation <= 0) return false;
  return conversation < sessionInitTokens * COMPACTION_LOW_EFFORT_RATIO;
}

/**
 * Session-level totals derived by summing per-turn fields across the
 * committed transcript. Pure folds — no time source, no live in-flight
 * accounting.
 */
export interface SessionTotals {
  totalWallClockMs: number;
  totalAwaitingApprovalMs: number;
  totalTransportDowntimeMs: number;
  totalActiveMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  turnCount: number;
}

export function deriveSessionTotals(
  transcript: ReadonlyArray<TurnEntry>,
): SessionTotals {
  let totalWallClockMs = 0;
  let totalAwaitingApprovalMs = 0;
  let totalTransportDowntimeMs = 0;
  let totalActiveMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCostUsd = 0;
  for (const t of transcript) {
    totalWallClockMs += t.wallClockMs;
    totalAwaitingApprovalMs += t.awaitingApprovalMs;
    totalTransportDowntimeMs += t.transportDowntimeMs;
    totalActiveMs += t.activeMs;
    totalInputTokens += t.cost.inputTokens;
    totalOutputTokens += t.cost.outputTokens;
    totalCacheReadTokens += t.cost.cacheReadInputTokens;
    totalCacheCreationTokens += t.cost.cacheCreationInputTokens;
    totalCostUsd += t.cost.totalCostUsd;
  }
  return {
    totalWallClockMs,
    totalAwaitingApprovalMs,
    totalTransportDowntimeMs,
    totalActiveMs,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalCostUsd,
    turnCount: transcript.length,
  };
}

/**
 * Live wall-clock duration of the in-flight turn (`now -
 * pendingTurn.submitAt`). Returns `0` when no turn is in flight.
 */
export function liveTurnWallClockMs(
  state: CodeSessionState,
  now: number,
): number {
  if (state.pendingTurn === null) {
    return 0;
  }
  return Math.max(0, now - state.pendingTurn.submitAt);
}

/**
 * Live awaiting-approval duration — the committed accumulator plus the
 * live in-progress interval when `awaitingApprovalSince !== null`.
 */
export function liveTurnAwaitingApprovalMs(
  state: CodeSessionState,
  now: number,
): number {
  const accumulated = state.awaitingApprovalAccumulatedMs;
  if (state.awaitingApprovalSince === null) {
    return accumulated;
  }
  return accumulated + Math.max(0, now - state.awaitingApprovalSince);
}

/**
 * Live transport-downtime duration — the committed accumulator plus the
 * live in-progress interval when `transportNonOnlineSince !== null`
 * (covers both `transportState === "offline"` and `"restoring"`).
 */
export function liveTurnTransportDowntimeMs(
  state: CodeSessionState,
  now: number,
): number {
  const accumulated = state.transportDowntimeAccumulatedMs;
  if (state.transportNonOnlineSince === null) {
    return accumulated;
  }
  return accumulated + Math.max(0, now - state.transportNonOnlineSince);
}

/**
 * Live machine-doing-work duration — `live wall − live awaiting − live
 * downtime`, clamped ≥ 0. The headline "assistant response time" for
 * an in-flight turn.
 *
 * Note: this helper SUBTRACTS the two scalar accumulators, so it
 * over-subtracts whenever the two pause axes overlap (e.g. transport
 * goes restoring during an awaiting-approval dialog). The
 * snapshot-projection helper {@link deriveInflightActiveMs} uses the
 * union of per-axis intervals across all three yellow axes (adding
 * interrupt-in-flight) and is the recommended derivation for the
 * gallery's live `Time` cell. `liveTurnActiveMs` is preserved for
 * backwards-compatibility and for the per-turn-summary surfaces that
 * already accept the over-subtraction.
 */
export function liveTurnActiveMs(
  state: CodeSessionState,
  now: number,
): number {
  const wall = liveTurnWallClockMs(state, now);
  const awaiting = liveTurnAwaitingApprovalMs(state, now);
  const downtime = liveTurnTransportDowntimeMs(state, now);
  return Math.max(0, wall - awaiting - downtime);
}

// ---------------------------------------------------------------------------
// Overlap-correct live in-flight active derivation
// ---------------------------------------------------------------------------

/**
 * One pause segment as understood by {@link unionPauseMs}: a tuple
 * whose second element is either the close timestamp (closed
 * segment) or `null` (the segment is still open and treated as
 * ending at the window's end).
 */
export type PauseSegment = readonly [number, number | null];

/**
 * Compute the duration of the UNION of pause segments from any number
 * of axes, clipped to `[windowStart, windowEnd]`. Currently-open
 * segments (`[start, null]`) are treated as having `end = windowEnd`.
 *
 * The naive sum of per-axis durations over-counts whenever segments
 * overlap (an awaiting-approval dialog while transport is restoring
 * contributes twice if you sum them, swallowing real Claude-active
 * time in the live-clock derivation). The union counts each
 * overlapping millisecond exactly once.
 *
 * Algorithm: sort-and-sweep. Each segment is first normalized
 * (open → `windowEnd`, then clipped to `[windowStart, windowEnd]`),
 * skipping any segment that's empty after clipping. The sweep merges
 * adjacent or overlapping intervals as it walks the sorted list,
 * summing each merged region's length.
 *
 * Time-complexity is O(n log n) in the total number of segments,
 * dominated by the sort. For a single in-flight turn the total is
 * typically < 10 (one awaiting-approval dialog, one transport blip,
 * one interrupt-in-flight = three segments), so the constant factor
 * is what matters; the algorithm is the smallest correct one rather
 * than the most performant possible.
 *
 * Returns `0` when `windowEnd <= windowStart` (degenerate window) or
 * when no segment falls inside the window.
 */
export function unionPauseMs(
  segments: ReadonlyArray<PauseSegment>,
  windowStart: number,
  windowEnd: number,
): number {
  if (windowEnd <= windowStart) {
    return 0;
  }
  const clipped: Array<[number, number]> = [];
  for (const [rawStart, rawEnd] of segments) {
    const end = rawEnd ?? windowEnd;
    const start = Math.max(windowStart, rawStart);
    const cappedEnd = Math.min(windowEnd, end);
    if (cappedEnd <= start) {
      continue;
    }
    clipped.push([start, cappedEnd]);
  }
  if (clipped.length === 0) {
    return 0;
  }
  clipped.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let mergeStart = clipped[0][0];
  let mergeEnd = clipped[0][1];
  for (let i = 1; i < clipped.length; i++) {
    const [start, end] = clipped[i];
    if (start <= mergeEnd) {
      if (end > mergeEnd) {
        mergeEnd = end;
      }
    } else {
      total += mergeEnd - mergeStart;
      mergeStart = start;
      mergeEnd = end;
    }
  }
  total += mergeEnd - mergeStart;
  return total;
}

/**
 * Compose the live in-flight active duration from snapshot fields and
 * the current wall-clock. Returns `null` when no turn is in flight
 * (`inflightUserMessage === null`).
 *
 *   liveActiveMs = max(
 *     0,
 *     (nowMs - submitAt) - unionPauseMs(allYellowSegments, submitAt, nowMs)
 *   )
 *
 * Yellow segments = union across all three axes (awaiting-approval +
 * transport-downtime + interrupt-in-flight). The same yellow
 * conditions that flip the `TugStateIndicator` to caution are exactly
 * what open each axis's segment; the live clock pauses while any
 * axis is open and resumes when the union of axes becomes empty —
 * no separate "is the indicator yellow" check is required. Overlapping
 * pauses contribute only once. See {@link unionPauseMs} for the
 * algorithm and {@link PauseSegment} for the input shape.
 */
/**
 * Renderer convenience over {@link deriveInflightActiveMs}. Returns
 * the live in-flight active duration while a turn is in flight, and
 * falls back to a caller-supplied post-commit value (typically the
 * just-committed `TurnEntry.activeMs`, or `0` for a never-submitted
 * card) when no turn is in flight. Never returns `null` — the
 * fallback covers every post-commit / idle / errored path the
 * underlying derivation reports as not-applicable.
 *
 *   - In-flight: ticks up at the granularity of the caller's `tickAt`
 *     (see `useLifecycleTick` for the 1 Hz heartbeat that drives the
 *     gallery + production renderers).
 *   - Pauses when any yellow axis is open — the same overlap-correct
 *     union {@link deriveInflightActiveMs} computes.
 *   - Freezes at turn-complete: the snapshot's `inflightUserMessage`
 *     becomes `null`, the underlying derivation returns `null`, and
 *     this helper returns the committed `activeMs` (the caller's
 *     fallback).
 *   - Resets at the next submit: a fresh `inflightUserMessage` makes
 *     the derivation re-engage from the new `submitAt`.
 *
 * Pure: no time source, no DOM, no React. Callers pass `tickAt`.
 */
export function deriveTimeCellMs(
  snap: CodeSessionSnapshot,
  tickAt: number,
  postCommitFallbackMs: number,
): number {
  const live = deriveInflightActiveMs(snap, tickAt);
  return live ?? postCommitFallbackMs;
}

/**
 * The narrow job slice {@link deriveJobExtendedActiveMs} consumes —
 * status + end stamp of a background job launched by the turn whose
 * clock is being extended. The caller filters the ledger down to the
 * jobs owned by that turn's tool calls.
 */
export interface JobTimeSlice {
  status: string;
  endedAtMs: number | null;
}

/**
 * Extend a committed turn's TIME readout across its background work.
 *
 * A turn that launches a background agent commits while the agent is
 * still running — but from the user's seat the *request* is still in
 * progress, so the TIME cell must keep counting rather than freeze at
 * the launching turn's `activeMs`. This composes the post-commit
 * figure:
 *
 *   - a job launched by the turn is still `running` →
 *     `activeMs + (nowMs − turnEndedAt)` — the clock keeps climbing.
 *   - every such job is terminal → `activeMs + (latestJobEnd −
 *     turnEndedAt)` — the clock freezes at the request's true total,
 *     never snapping back to the bare turn figure.
 *   - the turn launched no background work → `activeMs` unchanged
 *     (today's behavior).
 *
 * Pure: the caller supplies `nowMs` (the 1 Hz tick) and the
 * already-filtered job slices; negative spans clamp to zero so clock
 * skew between `endedAt` and job stamps can't run the readout
 * backwards.
 */
export function deriveJobExtendedActiveMs(args: {
  turnActiveMs: number;
  turnEndedAt: number;
  jobs: ReadonlyArray<JobTimeSlice>;
  nowMs: number;
}): number {
  const { turnActiveMs, turnEndedAt, jobs, nowMs } = args;
  if (jobs.length === 0) return turnActiveMs;
  const running = jobs.some((j) => j.status === "running");
  if (running) {
    return turnActiveMs + Math.max(0, nowMs - turnEndedAt);
  }
  let latestEnd = 0;
  for (const j of jobs) {
    if (j.endedAtMs !== null && j.endedAtMs > latestEnd) latestEnd = j.endedAtMs;
  }
  return turnActiveMs + Math.max(0, latestEnd - turnEndedAt);
}

export function deriveInflightActiveMs(
  snap: CodeSessionSnapshot,
  nowMs: number,
): number | null {
  if (snap.activeTurn === null) {
    return null;
  }
  const submitAt = snap.activeTurn.submitAt;
  if (nowMs <= submitAt) {
    return 0;
  }
  const wall = nowMs - submitAt;
  const segments: PauseSegment[] = [];
  for (const interval of snap.awaitingApprovalIntervals) {
    segments.push(interval);
  }
  if (snap.awaitingApprovalSegmentStartedAt !== null) {
    segments.push([snap.awaitingApprovalSegmentStartedAt, null]);
  }
  for (const interval of snap.transportDowntimeIntervals) {
    segments.push(interval);
  }
  if (snap.transportDowntimeSegmentStartedAt !== null) {
    segments.push([snap.transportDowntimeSegmentStartedAt, null]);
  }
  for (const interval of snap.interruptInFlightIntervals) {
    segments.push(interval);
  }
  if (snap.interruptInFlightSegmentStartedAt !== null) {
    segments.push([snap.interruptInFlightSegmentStartedAt, null]);
  }
  const pause = unionPauseMs(segments, submitAt, nowMs);
  return Math.max(0, wall - pause);
}

// ---------------------------------------------------------------------------
// Per-turn telemetry block — the persistable shape
// ---------------------------------------------------------------------------

/**
 * The persistable per-turn telemetry block — exactly the subset of
 * `TurnEntry` fields that need to survive HMR / Reload / app relaunch
 * via the sqlite SessionLedger (see plan `#step-20-3-3` /
 * `#step-20-3-4`). Two sources can populate it:
 *
 *  - **Live path** — the reducer at `handleTurnComplete` computes
 *    every field from in-memory clock anchors + cost snapshots via
 *    {@link deriveTurnTelemetry}.
 *  - **Replay path** — the supervisor reads previously-persisted
 *    rows from the SessionLedger and inlines this exact shape on
 *    the replayed `turn_complete` wire event. The reducer takes
 *    the inlined payload as-is via {@link mergeTurnTelemetry}.
 *
 * The shape is byte-identical across the two sources by construction;
 * `mergeTurnTelemetry` just decides which source wins (inline if
 * present, else the live derivation). One reducer code path, two
 * data sources, single source of truth for the COMPUTATION (the
 * reducer's clock + cost machinery — see `deriveTurnTelemetry`).
 */
export interface TurnTelemetry {
  cost: TurnCost;
  wallClockMs: number;
  awaitingApprovalMs: number;
  transportDowntimeMs: number;
  activeMs: number;
  ttftMs: number | null;
  ttftcMs: number | null;
  reconnectCount: number;
  maxStreamGapMs: number;
  /**
   * `window(0)` — the session's resident context before any turn.
   * Session-level, not per-turn: every turn's telemetry carries the
   * same value (the reducer captures it once, at the first telemetry
   * iteration). Persisted here, on a channel that already round-trips,
   * so a resumed session restores `sessionInitTokens` from the first
   * replayed `turn_complete` rather than needing a separate ledger
   * row. `null` for a turn whose session never observed a first
   * iteration (and for telemetry rows persisted before this field
   * existed).
   */
  sessionInitTokens: number | null;
  /**
   * The turn's terminal classification — `complete` / `interrupted` /
   * `error` / `transport_lost`.
   *
   * Carried on the persisted block (not derivable from telemetry
   * state) so a resumed session recovers the original outcome instead
   * of re-deriving it. The live re-derivation reads `turn_complete`'s
   * `result` plus the reducer-runtime `interruptInFlight` flag — but
   * `interruptInFlight` never runs on the replay path, so a turn the
   * wire recorded as `result: "error"` because the user pressed Stop
   * (CASE B) would replay as `error` rather than `interrupted`.
   * Persisting the reason here closes that gap (`buildTurnEntry`
   * prefers this value over the re-derivation).
   *
   * Optional: absent on the live-derived block (`deriveTurnTelemetry`
   * does not classify — the reason is decided by `handleTurnComplete`)
   * and on telemetry rows persisted before this field existed.
   * `buildTurnEntry` falls back to the freshly-derived reason when it
   * is absent.
   */
  turnEndReason?: TurnEndReason;
}

/**
 * Whether a committed turn carries REAL multi-clock timing, rather than the
 * zero-placeholder a turn restored without a durable `turn_telemetry` row
 * gets. Per-turn TIME (wall / active / ttft) is NOT in the session JSONL — it
 * is reconstructed only from the durable side-table that tugcast overlays
 * ([P03]), which is empty on a fresh target / pure offline replay ([P05]). On
 * that path `wallClockMs` / `activeMs` come through as `0` and `ttftMs` as
 * `null`. A genuine turn always elapses wall-clock > 0, so all-zero-and-null
 * IS the "no durable timing" signal: the TIME surfaces must then render an
 * explicit `—`, never a fabricated `0:00`. Structural input so both
 * `TurnTelemetry` and `TurnEntry` (which inlines these fields) qualify.
 */
export function turnHasTiming(t: {
  wallClockMs: number;
  activeMs: number;
  ttftMs: number | null;
}): boolean {
  return t.wallClockMs > 0 || t.activeMs > 0 || t.ttftMs !== null;
}

/**
 * Derive the per-turn telemetry block from reducer state at the
 * moment a turn ends. Lifts the computation out of
 * `buildTurnEntry` so it has a pinning surface and so the same
 * shape is what the persistence layer round-trips.
 *
 * `submitAt` and `endedAt` are the same wall-clock millisecond
 * timestamps `buildTurnEntry` derives — passed in so this helper
 * stays pure and the timestamps the reducer chose are the
 * timestamps the telemetry block reports.
 */
export function deriveTurnTelemetry(
  state: CodeSessionState,
  submitAt: number,
  endedAt: number,
): TurnTelemetry {
  const wallClockMs = Math.max(0, endedAt - submitAt);
  const awaitingApprovalMs =
    state.awaitingApprovalSince === null
      ? state.awaitingApprovalAccumulatedMs
      : state.awaitingApprovalAccumulatedMs +
        Math.max(0, endedAt - state.awaitingApprovalSince);
  const transportDowntimeMs =
    state.transportNonOnlineSince === null
      ? state.transportDowntimeAccumulatedMs
      : state.transportDowntimeAccumulatedMs +
        Math.max(0, endedAt - state.transportNonOnlineSince);
  const activeMs = Math.max(
    0,
    wallClockMs - awaitingApprovalMs - transportDowntimeMs,
  );
  const ttftMs =
    state.firstAssistantDeltaAt === null
      ? null
      : Math.max(0, state.firstAssistantDeltaAt - submitAt);
  const ttftcMs =
    state.firstToolUseAt === null
      ? null
      : Math.max(0, state.firstToolUseAt - submitAt);
  const cost = extractTurnCost(state.costAtSubmit, state.lastCost);
  return {
    cost,
    wallClockMs,
    awaitingApprovalMs,
    transportDowntimeMs,
    activeMs,
    ttftMs,
    ttftcMs,
    reconnectCount: state.transportReconnectCount,
    maxStreamGapMs: state.maxStreamGapMs,
    sessionInitTokens: state.sessionInitTokens,
  };
}

/**
 * Pick the authoritative per-turn telemetry block.
 *
 *  - `inline !== undefined` → replay path. The supervisor read this
 *    block from the SessionLedger and attached it to the replayed
 *    `turn_complete` event. Use it verbatim — the values were
 *    computed by the live reducer during the original turn and
 *    persisted at the same `handleTurnComplete` callsite that's
 *    consulting this function now.
 *  - `inline === undefined` → live path. The wire didn't carry a
 *    telemetry payload; the reducer's just-derived block is the
 *    authoritative one and the live path also schedules an effect
 *    to persist it for the next reload.
 *
 * Trivial by construction — the entire merge is `inline ?? derived`.
 * Exists as a named helper so the contract is grep-able, the call
 * site reads as intent, and the test surface has a single function
 * to pin.
 */
export function mergeTurnTelemetry(
  inline: TurnTelemetry | undefined,
  derived: TurnTelemetry,
): TurnTelemetry {
  return inline ?? derived;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ZERO_TURN_COST: TurnCost = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
});

const ZERO_USAGE: LiveMessageUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

function numericField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Read the four token-count fields from a `cost_update.usage` /
 * `streaming_usage.usage` payload, tolerating both snake_case (the
 * wire shape) and camelCase variants. Anthropic emits snake_case; the
 * tolerance defends against any future adapter that pre-normalizes.
 */
export function readUsage(usage: unknown): LiveMessageUsage {
  if (usage === null || typeof usage !== "object") {
    return ZERO_USAGE;
  }
  const r = usage as Record<string, unknown>;
  return {
    inputTokens: numericField(r, "input_tokens") || numericField(r, "inputTokens"),
    outputTokens: numericField(r, "output_tokens") || numericField(r, "outputTokens"),
    cacheCreationInputTokens:
      numericField(r, "cache_creation_input_tokens") ||
      numericField(r, "cacheCreationInputTokens"),
    cacheReadInputTokens:
      numericField(r, "cache_read_input_tokens") || numericField(r, "cacheReadInputTokens"),
  };
}

function clampNonNegative(n: number): number {
  return n > 0 ? n : 0;
}
