/**
 * Pure-logic helpers for the session-card Z1B end-state display.
 *
 * Used by the production Z1B status row (`session-card-z1b.tsx`). The
 * helpers live in this module, not inline in the component, so the
 * mapping from `TurnEndReason` to badge text and tone has one
 * source of truth.
 *
 * The end-state display surfaces three pieces of post-turn
 * information:
 *   - A terminal-state badge (OK / interrupted / errored / lost)
 *   - The turn's active-ms (machine-doing-work time)
 *   - The turn's per-turn token count (the context-window delta)
 *
 * Pure: no DOM, no React, no side effects. Safe to call from
 * `useMemo` / render bodies.
 */

import type { InterruptReason, LiveMessageUsage, TurnEndReason } from "./types";

/**
 * The roles a terminal-state badge can take. Subset of
 * `TugBadgeRole` — the badge component carries more roles than
 * the end-state mapping uses, so this narrower type keeps the
 * helper's contract honest about its output set.
 *
 * `"inherit"` (vs the coloured tones) is the deliberate choice for
 * the `complete` outcome: in a transcript of many committed rows
 * the green "OK" dots otherwise compound into a vertical column
 * that draws the eye away from message content. The actionable
 * outcomes (`interrupted` / `error` / `transport_lost`) keep
 * their coloured tones because attention IS warranted there.
 */
export type EndStateBadgeRole = "inherit" | "caution" | "danger";

export interface EndStateBadge {
  /** Display text rendered inside the badge. */
  text: string;
  /** Tone driving the badge's color treatment. */
  role: EndStateBadgeRole;
}

/**
 * Map a `TurnEndReason` to its end-state badge text + tone:
 *
 * | turnEndReason     | interruptReason | text                 | role     |
 * |-------------------|-----------------|----------------------|----------|
 * | `complete`        | —               | "OK"                 | inherit  |
 * | `interrupted`     | (none)          | "Interrupted"        | caution  |
 * | `interrupted`     | `logout`        | "Stopped — logged out" | caution  |
 * | `interrupted`     | `configure-tug` | "Stopped — Configure Tug" | caution |
 * | `error`           | —               | "Error"              | danger   |
 * | `transport_lost`  | —               | "Lost"               | caution  |
 *
 * `complete` returns `role: "inherit"` so the OK badge paints in
 * the surrounding text colour and blends into the row's rhythm —
 * saving the coloured palettes for outcomes that warrant
 * attention. `transport_lost` is mapped to `caution` (not
 * `danger`) because the wire-loss path is recoverable — a
 * reconnect can deliver the outstanding output; `caution` reads
 * as "look at this" rather than "this failed."  `interrupted` is
 * also `caution` because the user initiated the stop; it isn't a
 * system error.
 *
 * `interruptReason` refines the `interrupted` label: a turn stopped by an
 * app-level flow reads "Stopped — logged out" / "Stopped — Configure Tug" instead
 * of a bare "Interrupted", keeping the same `caution` tone. It
 * is the one helper both the Z1B footer and the telemetry popover call,
 * so both surfaces stay in sync ([D19]).
 */
export function endStateBadgeFor(
  reason: TurnEndReason,
  interruptReason?: InterruptReason,
): EndStateBadge {
  switch (reason) {
    case "complete":
      return { text: "OK", role: "inherit" };
    case "interrupted":
      switch (interruptReason) {
        case "logout":
          return { text: "Stopped — logged out", role: "caution" };
        case "configure-tug":
          return { text: "Stopped — Configure Tug", role: "caution" };
        default:
          return { text: "Interrupted", role: "caution" };
      }
    case "error":
      return { text: "Error", role: "danger" };
    case "transport_lost":
      return { text: "Lost", role: "caution" };
  }
}

/**
 * End-state badge for a settled `$`-route shell exchange. The shell row's
 * Z1B ([D111]) shows the exit status where a Claude turn shows its OK /
 * Error badge — same badge grammar (text + tone), but the exchange's own
 * vocabulary: `exit 0` (blends in, `inherit`), `exit N` (`danger`), or
 * `killed` (a reap / timeout, `caution`). The tone maps 1:1 onto the same
 * `TurnEndReason` the shell turn carries, so the badge icon can reuse the
 * shared end-state glyph set.
 *
 * `exitCode` is `null` for a killed / timed-out exchange; a finite number
 * otherwise. Callers gate on a settled exchange before calling.
 */
export function shellEndStateBadge(exitCode: number | null): EndStateBadge {
  if (exitCode === null) return { text: "killed", role: "caution" };
  if (exitCode === 0) return { text: "exit 0", role: "inherit" };
  return { text: `exit ${exitCode}`, role: "danger" };
}

/**
 * The resident context window after a turn — `window(N)`. Sum of all
 * four token fields of the turn's LAST tool-loop iteration's `usage`:
 * the model's input (`input` + `cache_read` + `cache_creation`) plus
 * its `output`.
 *
 * `TurnCost` carries the last iteration's `usage` (see
 * `extractTurnCost`), NOT the per-iteration sum `result.usage` would
 * give — so this is the model's true context occupancy after the
 * turn. It is NOT a per-turn delta; `perTurnTokens` and
 * `deriveContextWindows` compute that.
 *
 * A zero-usage turn (an interrupted/errored turn with no measurable
 * iteration) returns `0` here — callers that need the resident window
 * use `deriveContextWindows`, which carries the prior window forward
 * across such turns.
 */
export function turnWindowTokens(usage: LiveMessageUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  );
}

/**
 * The signed per-turn token count — how much this turn changed the
 * resident context window:
 *
 *   perTurnTokens(N) = window(N) - prevWindow
 *
 * where `window(N)` is `turnWindowTokens` of this turn's
 * last-iteration `usage` and `prevWindow` is the resident window after
 * the prior turn (the caller resolves it: `sessionInitTokens` for the
 * first turn, the prior turn's window otherwise).
 *
 * Signed, never clamped. A turn that grows the window is positive; a
 * `/compact` that shrinks it is an honest negative. The deltas
 * telescope: `sessionInit + sum of perTurnTokens = window(latest)`,
 * exactly, by construction. No local tokenizer — every term is a feed
 * number.
 *
 * This is the per-turn primitive used for the in-flight turn (whose
 * `usage` is never all-zero once a frame has landed). For a whole
 * committed transcript — including the zero-usage carry-forward — use
 * `deriveContextWindows`, which special-cases a turn whose `usage` is
 * all-zero (this helper would read its `window` as `0` and report
 * `-prevWindow`).
 */
export function perTurnTokens(
  usage: LiveMessageUsage,
  prevWindow: number,
): number {
  return turnWindowTokens(usage) - prevWindow;
}

/** One turn's resident context window and the signed delta into it. */
export interface ContextWindowStep {
  /**
   * `window(N)` — the resident context tokens after this turn. Equals
   * `turnWindowTokens` of the turn's `usage`, EXCEPT a zero-usage turn
   * carries the prior turn's window forward.
   */
  window: number;
  /**
   * `window(N) - window(N-1)`, signed. `0` for a zero-usage turn.
   * This is the figure the `TOKENS` cell and Z1B show.
   */
  perTurn: number;
}

/**
 * Walk a transcript's per-turn `usage` and produce, per turn, the
 * resident context window and the signed per-turn delta into it.
 *
 *   - `window(0)` = `sessionInit` (the bootstrap before any turn).
 *   - `window(N)` = `turnWindowTokens` of turn N's `usage`, EXCEPT a
 *     zero-usage turn (`turnWindowTokens === 0` — an interrupted /
 *     errored turn with no measurable iteration) carries the prior
 *     window forward: `window(N) = window(N-1)`.
 *   - **Compaction-boundary reset ([S03]):** a zero-usage turn whose next
 *     REAL turn has a window *below* the prior window is a `/compact` (or
 *     `/clear`) boundary — the resident context actually fell (the API's
 *     `cache_read` reset). It does NOT carry the stale pre-compact peak
 *     forward; it resets to that post-compact window. A plain interrupt's
 *     next turn keeps ~the same window (the conversation is still resident),
 *     so it carries forward as before.
 *   - `perTurn(N)` = `window(N) - window(N-1)`, signed — `0` for a plain
 *     zero-usage turn, the negative drop at a `/compact` boundary.
 *
 * **Honest post-compaction override ([P01], Spec S02):** `windowOverrides`
 * is a per-turn array aligned to `usages`; when `windowOverrides[i]` is a
 * finite number it IS `window(i)` directly (the zero-usage/reset logic is
 * skipped for that turn), and `perTurn(i) = window(i) - window(i-1)`. A
 * compaction turn commits before any post-compaction `cost_update` exists,
 * so its raw window would carry the stale pre-compaction peak forward; the
 * override supplies the honest resident total (`post_tokens`)
 * so CONTEXT drops in place with no one-turn lag. The next real turn has no
 * override and self-corrects to its exact feed window.
 *
 * Identity: `sessionInit + sum of perTurn = window(latest)` —
 * telescopes exactly, every turn including compactions (the override IS
 * `window(i)`, so the telescoping identity is preserved).
 *
 * Pure: no DOM, no React, no time source. Safe in `useMemo` / render.
 */
export function deriveContextWindows(
  usages: ReadonlyArray<LiveMessageUsage>,
  sessionInit: number,
  windowOverrides?: ReadonlyArray<number | null>,
): ReadonlyArray<ContextWindowStep> {
  const raws = usages.map((u) => turnWindowTokens(u));
  const steps: ContextWindowStep[] = [];
  let prevWindow = sessionInit;
  for (let i = 0; i < raws.length; i++) {
    const override = windowOverrides?.[i];
    let window: number;
    if (typeof override === "number" && Number.isFinite(override)) {
      // Honest post-compaction total: this turn's window is supplied
      // directly (the compaction turn's own usage is stale/absent).
      window = override;
    } else {
      const raw = raws[i]!;
      if (raw !== 0) {
        window = raw;
      } else {
        // Zero-usage turn: carry the prior window forward UNLESS the next real
        // turn is a drop below it — then this is a compaction/clear boundary and
        // the window resets to the post-compact value, never the stale peak.
        const nextReal = nextNonZeroWindow(raws, i + 1);
        window = nextReal !== null && nextReal < prevWindow ? nextReal : prevWindow;
      }
    }
    steps.push({ window, perTurn: window - prevWindow });
    prevWindow = window;
  }
  return steps;
}

/** The next strictly-positive window at or after `from`, else `null`. */
function nextNonZeroWindow(
  raws: ReadonlyArray<number>,
  from: number,
): number | null {
  for (let i = from; i < raws.length; i++) {
    if (raws[i]! !== 0) return raws[i]!;
  }
  return null;
}
