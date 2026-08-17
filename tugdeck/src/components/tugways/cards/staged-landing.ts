/**
 * staged-landing — the parked landing callback, under a deadline ([L31]).
 *
 * A landing press dismisses the Changes shade first and fires on the shade's
 * `sheetDidHide`, so the transcript receipt lands on a clean beat after the
 * panel is gone rather than on top of it. That ordering is worth keeping; what
 * is not is the way it used to be held. The callback sat in a ref waiting for a
 * hide that nothing guarantees — the hide rides an effect keyed on whether any
 * landing mode is active, and any state where that expression fails to flip
 * strands the user's landing with no error, no timeout, and no trace.
 *
 * So the park carries a deadline. `sheetDidHide` disarms it and runs the
 * landing on the usual beat; if that beat never comes, the watchdog runs the
 * landing anyway and reports the fault. Running it late honors the gesture —
 * the landing controllers re-check their gate before anything reaches the wire,
 * so a stale press cannot land something newly refusable — and the alternative
 * is asking the user to press a button that already worked.
 *
 * Exactly-once is a null-swap on the parked callback: both beats call the same
 * `run`, and whichever arrives second finds nothing to do.
 */

/** The beat the shade's exit animation is given before the landing fires. */
const POST_HIDE_DELAY_MS = 150;

/**
 * How long a parked landing waits for `sheetDidHide` before firing on its own.
 * Long enough to lose the race to the real hide in every ordinary case, short
 * enough that a wedged shade costs the user a perceptible pause rather than the
 * landing.
 */
const WATCHDOG_MS = 1000;

export interface StagedLanding {
  /** Park a landing to run on the next hide, or on the deadline. */
  stage: (runLand: () => void) => void;
  /** The shade finished hiding — disarm the deadline and run what is parked. */
  sheetDidHide: () => void;
  /** Release both timers and drop any parked callback ([L27]). */
  dispose: () => void;
}

export interface StagedLandingDeps {
  /** Called when the deadline fired because the hide never did. */
  onFault: () => void;
  /** Injected by the tests; the browser's timers otherwise. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export function createStagedLanding(deps: StagedLandingDeps): StagedLanding {
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => window.clearTimeout(id));

  let parked: (() => void) | null = null;
  let watchdog: number | null = null;
  let delay: number | null = null;

  const disarm = (): void => {
    if (watchdog !== null) {
      clearTimer(watchdog);
      watchdog = null;
    }
  };

  /** Take the parked callback if there is one — the exactly-once swap. */
  const take = (): (() => void) | null => {
    const run = parked;
    parked = null;
    return run;
  };

  return {
    stage: (runLand: () => void): void => {
      disarm();
      parked = runLand;
      watchdog = setTimer(() => {
        watchdog = null;
        const run = take();
        if (run === null) return;
        deps.onFault();
        run();
      }, WATCHDOG_MS);
    },

    sheetDidHide: (): void => {
      const run = take();
      if (run === null) return;
      disarm();
      delay = setTimer(() => {
        delay = null;
        run();
      }, POST_HIDE_DELAY_MS);
    },

    dispose: (): void => {
      disarm();
      if (delay !== null) {
        clearTimer(delay);
        delay = null;
      }
      parked = null;
    },
  };
}
