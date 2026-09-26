/**
 * The motion circuit breaker — the deck failing toward stillness.
 *
 * Everything else in this module measures. This is the one piece that acts:
 * when the page's own render-cost reading says the whole-page compositing walk
 * is back in the frame loop, and says it three samples running with nothing in
 * flight to justify it, the breaker stills every long-running loop on the deck
 * ([B07], [P07]).
 *
 * ## What "stills" means, and why it is one CSS variable
 *
 * `demote(true)` sets `data-tug-motion-demoted` on `<html>`, which resolves
 * `--tug-loop-iterations` to `0` ([P06]). Every long-running loop in the deck
 * writes its iteration count as `var(--tug-loop-iterations, infinite)` — the
 * form `scripts/audit-motion.ts` rule 3 enforces — so one attribute stills all
 * of them at once and nothing has to keep a list. An iteration count of zero
 * leaves each element at its base style rather than frozen mid-cycle, which is
 * what a blanket `animation-play-state: paused` would have done to every
 * finite entrance on the page as well.
 *
 * Nothing else changes. Transitions still run, entrances still run, a dot still
 * carries `data-breathing` and its component logic is untouched: the loop
 * simply has no active duration. That is [P09]'s silent demotion — the deck
 * gets quieter and nothing announces itself to the user, because the reader is
 * not the person who can act on it. The `motion-demoted` deck-trace row is.
 *
 * ## Why three samples, and why `inFlight` gates them
 *
 * A streaming transcript legitimately lays out every frame ([D4]); the walk
 * this breaker exists to catch is the one that runs with nothing to show for
 * it ([F02]). So a sample counts toward a trip only if nothing was in flight
 * when it was taken — `awaiting_approval` breathes a dot and moves no DOM,
 * which is exactly the case where an over-budget frame is the loop's fault.
 *
 * And it is three consecutive samples rather than one because a single
 * polluted frame is not a diagnosis (Risk R03). At {@link SAMPLE_INTERVAL_MS}
 * that is nine seconds of a deck paying for a walk it does not need.
 *
 * ## The latch
 *
 * Motion resumes on the registry's next 0→1 edge — the deck goes still, the
 * next thing that moves gets a fair chance. After {@link BREAKER_LATCH_TRIPS}
 * trips in one page lifetime the demotion latches: three fair chances is
 * enough, and a deck that flaps between demoted and not is worse than one that
 * is quietly still. `reset()` and a reload are the two ways back.
 *
 * @module lib/motion-guard/breaker
 */

import { animationCensus } from "@/lib/perf-monitor";
import { deckTrace } from "@/deck-trace";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

import { onMotionEdge } from "./registry";
import {
  renderCostProbe,
  RENDER_COST_BUDGET_MS,
  type RenderCostSample,
} from "./render-cost-probe";

/** How many consecutive over-budget samples trip the breaker. */
export const BREAKER_TRIP_SAMPLES = 3;

/** How many trips in one page lifetime latch the demotion. */
export const BREAKER_LATCH_TRIPS = 3;

/** The root attribute `tug.css` resolves `--tug-loop-iterations: 0` from. */
export const DEMOTED_ATTRIBUTE = "data-tug-motion-demoted";

/**
 * The phases in which the deck legitimately lays out every frame.
 *
 * `idle`, `awaiting_approval` and `errored` are deliberately absent: a session
 * waiting on the user moves a breathing dot and nothing else, so an
 * over-budget frame in that state is the loop's bill and not the turn's.
 */
export const IN_FLIGHT_PHASES: ReadonlySet<string> = new Set([
  "submitting",
  "awaiting_first_token",
  "streaming",
  "tool_work",
  "replaying",
  "waking",
]);

/**
 * Whether no session on the deck is mid-turn.
 *
 * Pure over the phases so the condition is testable without a deck; the walk
 * that collects them is a thin adapter in `index.ts`.
 */
export function nothingInFlight(phases: readonly string[]): boolean {
  return !phases.some((phase) => IN_FLIGHT_PHASES.has(phase));
}

/**
 * Whether the last `needed` samples are all over budget with nothing in
 * flight.
 *
 * Fewer than `needed` samples is never a trip — the probe arms on a rising
 * motion edge and a deck that has only just started moving has said nothing
 * yet. A single in-flight sample anywhere in the tail clears it: the run has
 * to be clean, not merely mostly clean, because the one reading this breaker
 * must never act on is a busy deck doing its job.
 */
export function shouldTrip(
  samples: readonly RenderCostSample[],
  budgetMs: number,
  needed: number = BREAKER_TRIP_SAMPLES,
): boolean {
  if (needed <= 0) return false;
  if (samples.length < needed) return false;
  return samples
    .slice(-needed)
    .every((sample) => sample.inFlight === false && sample.costMs > budgetMs);
}

/** A census summary small enough to ride a trace row. */
function censusSummary(): {
  longRunning: number;
  byName: Record<string, number>;
  violations: string[];
} {
  const census = animationCensus();
  const byName: Record<string, number> = {};
  for (const entry of census.entries) {
    byName[entry.name] = (byName[entry.name] ?? 0) + 1;
  }
  return {
    longRunning: census.longRunning,
    byName,
    violations: census.violations.map(
      (entry) => `${entry.name} on ${entry.target}: ${entry.violations.join("; ")}`,
    ),
  };
}

export interface MotionBreaker {
  /** The budget a sample is over when it exceeds it, in milliseconds. */
  readonly budgetMs: number;
  /** How many times the breaker has tripped this page lifetime. */
  readonly trips: number;
  /** Whether the demotion is latched until `reset()` or a reload. */
  readonly latched: boolean;
  /** Whether the root is demoting right now. */
  readonly demoted: boolean;
  /** Set or clear the demotion by hand. Counts no trip and latches nothing. */
  demote(on: boolean): void;
  /** Move the budget. Takes effect on the next sample. */
  setBudget(ms: number): void;
  /** Back to how the page started: un-demoted, un-latched, budget restored. */
  reset(): void;
  /** Subscribe to the probe and the registry. Idempotent. */
  install(): void;
}

class MotionBreakerImpl implements MotionBreaker {
  #budgetMs = RENDER_COST_BUDGET_MS;
  #trips = 0;
  #latched = false;
  #installed = false;

  get budgetMs(): number {
    return this.#budgetMs;
  }

  get trips(): number {
    return this.#trips;
  }

  get latched(): boolean {
    return this.#latched;
  }

  get demoted(): boolean {
    if (typeof document === "undefined") return false;
    return document.documentElement.hasAttribute(DEMOTED_ATTRIBUTE);
  }

  demote(on: boolean): void {
    if (typeof document === "undefined") return;
    if (on) document.documentElement.setAttribute(DEMOTED_ATTRIBUTE, "");
    else document.documentElement.removeAttribute(DEMOTED_ATTRIBUTE);
  }

  setBudget(ms: number): void {
    this.#budgetMs = ms;
  }

  reset(): void {
    this.#trips = 0;
    this.#latched = false;
    // The budget goes back too. A `setBudget` that survived a reset would
    // leave the deck one sample away from demoting itself again, which is the
    // opposite of what the one verb called `reset` is for.
    this.#budgetMs = RENDER_COST_BUDGET_MS;
    this.demote(false);
  }

  install(): void {
    if (this.#installed) return;
    this.#installed = true;

    renderCostProbe.onSample(() => {
      // Already still: the reading that follows a demotion is about the
      // demoted deck, and re-reading it as a fresh diagnosis would trip the
      // breaker again on its own success.
      if (this.demoted) return;
      if (!shouldTrip(renderCostProbe.samples(), this.#budgetMs)) return;
      this.#trip();
    });

    // The deck went still and something started moving again: a fair chance,
    // unless the breaker has already given out all of them.
    onMotionEdge((holds) => {
      if (holds === 0 || this.#latched) return;
      if (this.demoted) this.demote(false);
    });
  }

  #trip(): void {
    const tail = renderCostProbe
      .samples()
      .slice(-BREAKER_TRIP_SAMPLES)
      .map((sample) => sample.costMs);

    // Read the census BEFORE demoting. `document.getAnimations()` forces a
    // style update, and an iteration count of zero ends the loops — so a
    // census taken after the answer would report `longRunning: 0` and the row
    // would say nothing at all about what the deck was paying for.
    const census = censusSummary();

    this.demote(true);
    this.#trips += 1;
    this.#latched = this.#trips >= BREAKER_LATCH_TRIPS;

    deckTrace.record({
      kind: "motion-demoted",
      costMs: tail,
      budgetMs: this.#budgetMs,
      trips: this.#trips,
      latched: this.#latched,
      census,
    });
    tugDevLogStore.warn("perf", "motion demoted", {
      costMs: tail,
      budgetMs: this.#budgetMs,
      trips: this.#trips,
      latched: this.#latched,
      longRunning: census.longRunning,
    });
  }
}

export const motionBreaker: MotionBreaker = new MotionBreakerImpl();
