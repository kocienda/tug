/**
 * tolerances.ts — the house tolerances and timing budgets, named once.
 *
 * A tolerance is how far two readings may differ and still mean the same
 * thing, and each one here says what it tolerates. A test whose tolerance is
 * one of these imports it by name. A test whose tolerance is a different
 * number keeps its own constant, with a comment, because a different tolerance
 * is a decision and the table must not flatten it.
 *
 * Import by name from `./_harness/tolerances`; `_harness/index.ts` re-exports
 * only `QUIESCE_DRAIN_DEADLINE_MS`, which tests read through it.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Geometry read off the deck in px — a frame's edge, a pin, a width — agrees
 * within a pixel and a half. Layout rounds to device pixels, so two readings
 * of one edge can differ by a pixel without disagreeing; a real disagreement
 * is larger than that.
 */
export const PIXEL_TOL = 1.5;

/**
 * Half a pixel, for a reading that should come out exact but passes through
 * fractional layout on the way: anything a whole pixel off is real.
 */
export const SUBPIXEL_TOL = 0.5;

/**
 * Scroll positions agree within 8 px. A restored, anchored or pinned scroll
 * lands within the rounding of line boxes and scroll snapping; a real miss is
 * a line or more.
 */
export const SCROLL_TOL_PX = 8;

/**
 * A card put back where it stood — after a workspace switch, a move, a
 * remount — lands within 2 px of the spot it left.
 */
export const RESTORE_TOL_PX = 2;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Settle after the big state transitions — launch handshake,
 * `seedDeckState`, `bindSession` — before the harness lets ANY further
 * driving happen. A person cannot act on an app that is still painting its
 * first frame; a test must not either (keys posted into the launch window
 * land nowhere and beep). Override with `TUGAPP_STATE_SETTLE_MS`.
 */
export const STATE_SETTLE_MS = (() => {
  const raw = Number(process.env.TUGAPP_STATE_SETTLE_MS ?? "500");
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
})();

/**
 * How long a pid-mode launch may take to read `document.hasFocus()` true in
 * the shell. The host has the app believe it is active and its window
 * really key; WebKit recomputes the page's active state from that on its
 * own, within about two seconds of the window becoming key (measured
 * 2026-10-21, with no event posted between). Five seconds is that with
 * room for a loaded machine; a launch that never flips is a launch whose
 * key window or active bit is missing, and `launchTugApp` fails it with
 * `windowState` as the next read.
 */
export const PID_FOCUS_SETTLE_TIMEOUT_MS = 5000;

/**
 * The `tug-quiesce` teardown deadline: how long the harness gives a whole
 * Tug.app teardown before it escalates to SIGKILL. Mirror of
 * `tugcore::quiesce::TEARDOWN_DEADLINE_MS` (the source of truth; its
 * `quiesce_constants_are_mirrored` test fails the Rust build if this
 * drifts). It sits above the app's own 4 s process-group drain deadline,
 * which in turn sits above each service's 2 s self-enforced flush budget
 * — so in a healthy teardown nothing here ever fires.
 */
export const QUIESCE_TEARDOWN_DEADLINE_MS = 8000;

/**
 * The shutdown supervisor's process-group drain deadline, as tests assert it in
 * `quiesce-report.json`. Mirror of `tugcore::quiesce::DRAIN_DEADLINE_MS`,
 * pinned by the same build-failing Rust mirror test.
 */
export const QUIESCE_DRAIN_DEADLINE_MS = 4000;
