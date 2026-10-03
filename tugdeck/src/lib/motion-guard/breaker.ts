/**
 * The motion switch — one attribute that stills every long-running loop.
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
 * carries `data-breathing` and its component logic is untouched: the switch is
 * a CSS answer to a CSS contract, and React never hears about it ([L06]).
 *
 * ## It is a hand switch, and it used to be a circuit breaker
 *
 * Until 2026-09-28 this module also ACTED. It subscribed to the render-cost
 * probe and set the attribute itself when three consecutive samples read over
 * the per-frame cost budget, or when three read over the at-rest updates
 * budget with nothing in flight and no gesture running; it recovered on three
 * clean samples and latched after three trips in one page lifetime.
 *
 * On the release deck it fired three times in one afternoon on the reading it
 * was least entitled to act on. Frames cost 1–3 ms against a 16 ms budget;
 * what tripped was 11–20 main-thread stalls a second against a budget of 10,
 * while a live turn's six pulsing dots were breathing and its feed batches
 * were landing — read as "rest" because the in-flight source saw no session
 * in a mid-turn phase. The user's animations went away, silently, and the
 * latch kept them away until a reload. A guard that can do that to the person
 * it is guarding is the wrong trade at any threshold, and no calibration of
 * the budgets fixes a policy that lets a stylesheet decide.
 *
 * So the readings stay and the authority goes. The probe still samples while
 * motion is running; every sample still carries its cost, its at-rest count
 * and whether anything was in flight; and the two budgets are still published
 * beside them as the calibrated reference (`render-cost-probe.ts` carries
 * both tables), because the person who can act on an over-budget deck is the
 * one reading `tugtool deck motion probe`. Nothing in the product turns the
 * user's motion off on its own. This switch is thrown by hand — `tugtool deck
 * motion demote on|off`, `window.__tugMotion.demote()` — and by nothing else.
 *
 * ## Throwing it back re-arms what it stood down
 *
 * Clearing the attribute is not the whole of `demote(false)`. A loop the deck
 * paused through the Web Animations API is not resumed by a stylesheet letting
 * go, because the API outranks it. `space-layer-loops.ts` resumes a loop it
 * paused once its layer is shown whether or not the demotion stands, so the
 * demotion alone strands nothing; but a resume that module declined — a
 * component's own `animation-play-state: paused` holding the loop — waits for
 * the next pass. So the off edge tells its subscribers ({@link
 * MotionBreaker.onResume}), and the canvas runs the same loop pass a
 * workspace switch runs. A refusal re-arms; it does not just return ([L32]).
 *
 * @module lib/motion-guard/breaker
 */

import {
  RENDER_COST_BUDGET_MS,
  REST_UPDATES_BUDGET_PER_S,
} from "./render-cost-probe";

/** The root attribute `tug.css` resolves `--tug-loop-iterations: 0` from. */
export const DEMOTED_ATTRIBUTE = "data-tug-motion-demoted";

/**
 * The phases in which the deck legitimately lays out every frame.
 *
 * `idle`, `awaiting_approval` and `errored` are deliberately absent: a session
 * waiting on the user moves a breathing dot and nothing else. The probe
 * records the answer on every sample so a reader of the ring can tell a
 * reading taken on a busy deck from one taken on a still one.
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

export interface MotionBreaker {
  /**
   * The calibrated per-frame render-cost reference, in milliseconds. Nothing
   * acts on it; a reading over it is a fact for the probe's reader.
   */
  readonly budgetMs: number;
  /** The calibrated at-rest reference, in updates per second. Same standing. */
  readonly restBudgetPerSecond: number;
  /** Whether the root is demoting right now. */
  readonly demoted: boolean;
  /** Set or clear the demotion by hand. The only writer of the attribute. */
  demote(on: boolean): void;
  /** Back to how the page started: un-demoted. */
  reset(): void;
  /**
   * Be told when a demotion is cleared — the edge from demoted to not, and
   * nothing else. Returns the release ([L27]).
   */
  onResume(listener: () => void): () => void;
}

/** The slice of `<html>` the switch reads and writes. */
export interface DemoteRoot {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

class MotionBreakerImpl implements MotionBreaker {
  private readonly resumeListeners = new Set<() => void>();

  constructor(private readonly rootOf: () => DemoteRoot | null) {}

  get budgetMs(): number {
    return RENDER_COST_BUDGET_MS;
  }

  get restBudgetPerSecond(): number {
    return REST_UPDATES_BUDGET_PER_S;
  }

  get demoted(): boolean {
    return this.rootOf()?.hasAttribute(DEMOTED_ATTRIBUTE) ?? false;
  }

  demote(on: boolean): void {
    const root = this.rootOf();
    if (root === null) return;
    if (on) {
      root.setAttribute(DEMOTED_ATTRIBUTE, "");
      return;
    }
    if (!root.hasAttribute(DEMOTED_ATTRIBUTE)) return;
    root.removeAttribute(DEMOTED_ATTRIBUTE);
    for (const listener of [...this.resumeListeners]) listener();
  }

  reset(): void {
    this.demote(false);
  }

  onResume(listener: () => void): () => void {
    this.resumeListeners.add(listener);
    return () => {
      this.resumeListeners.delete(listener);
    };
  }
}

/** A switch over `rootOf()`; the deck's is {@link motionBreaker}. */
export function createMotionBreaker(
  rootOf: () => DemoteRoot | null,
): MotionBreaker {
  return new MotionBreakerImpl(rootOf);
}

export const motionBreaker: MotionBreaker = createMotionBreaker(() =>
  typeof document === "undefined" ? null : document.documentElement,
);
