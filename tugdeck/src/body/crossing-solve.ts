/**
 * The crossing solve — a card page laying itself out at its crossing's size
 * before the motion starts.
 *
 * The host tells the page `bodyCrossing { begin, solve: true }` and holds its
 * container at First. The page opens its resize episode (the pin), says
 * `crossingReady`, and then this sequence runs: wait for the host's resize to
 * land (`window` `resize`, or {@link SOLVE_RESIZE_FALLBACK_MS} when none
 * comes), end the episode so every pinned scroller is restored at the new
 * size, and wait frame by frame until one passes in which no `ResizeObserver`
 * delivery ran and no React commit landed — at least two, so the frame is
 * composited. Then the page is solved, and says so.
 *
 * Two frames alone is not a laid-out page: a list view's rows keep
 * re-measuring for several frames after its frame stops moving, and each
 * re-measure re-lands its anchor. The quiet frame is read from the same
 * delivery wrapper and commit census the land record uses.
 *
 * Everything the sequence touches comes in through {@link CrossingSolveDeps},
 * so it runs as data in a test.
 *
 * @module body/crossing-solve
 */

/** How long the page waits for the host's resize before solving without it. */
export const SOLVE_RESIZE_FALLBACK_MS = 100;

/**
 * How many frames the page waits for a quiet one before saying solved
 * anyway. The host's own guard starts the plan long before this; the cap only
 * keeps a page whose content never settles from pumping frames for ever.
 */
export const SOLVE_QUIET_FRAME_CAP = 60;

export interface CrossingSolveDeps {
  readonly now: () => number;
  readonly raf: (cb: () => void) => number;
  readonly cancelRaf: (id: number) => void;
  readonly setTimer: (cb: () => void, ms: number) => number;
  readonly clearTimer: (id: number) => void;
  /** Listen for the page's next resize; returns the release. */
  readonly onResize: (cb: () => void) => () => void;
  /** End the crossing's resize episode: the restore at the new size. */
  readonly endEpisode: () => void;
  /** Whether no delivery ran and no commit landed since `t`. */
  readonly quietSince: (t: number) => boolean;
  /** The page is laid out; `resizeMissed` when the host's resize never came. */
  readonly solved: (facts: { resizeMissed: boolean; frames: number }) => void;
}

/** Run one solve. Returns its cancel, which runs nothing more and is idempotent. */
export function runCrossingSolve(deps: CrossingSolveDeps): () => void {
  let done = false;
  let timer: number | null = null;
  let raf: number | null = null;
  let releaseResize: (() => void) | null = null;

  const release = (): void => {
    releaseResize?.();
    releaseResize = null;
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    if (raf !== null) deps.cancelRaf(raf);
    raf = null;
  };

  const settle = (resizeMissed: boolean): void => {
    if (done) return;
    releaseResize?.();
    releaseResize = null;
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    deps.endEpisode();
    let frames = 0;
    let lastTick = deps.now();
    const tick = (): void => {
      raf = null;
      if (done) return;
      frames += 1;
      const at = deps.now();
      if ((frames >= 2 && deps.quietSince(lastTick)) || frames >= SOLVE_QUIET_FRAME_CAP) {
        done = true;
        deps.solved({ resizeMissed, frames });
        return;
      }
      lastTick = at;
      raf = deps.raf(tick);
    };
    raf = deps.raf(tick);
  };

  releaseResize = deps.onResize(() => settle(false));
  timer = deps.setTimer(() => settle(true), SOLVE_RESIZE_FALLBACK_MS);

  return () => {
    if (done) return;
    done = true;
    release();
  };
}
