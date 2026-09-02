/**
 * sparkline-tape — the tape's policy, with no DOM in it.
 *
 * `TugSparkline` is two things wearing one coat: a policy (when to sample,
 * when to stop, when the epoch rebases, when the tape may go inert) and a
 * surface (a canvas, a WAAPI transform, an `IntersectionObserver`, computed
 * style). This module is the policy half. It owns the tape array, the clock
 * it stamps points with, the deadband that decides what counts as change,
 * the two finishers, dormancy, and the epoch. It reaches the world only
 * through {@link SparklineSurface}, and it reads the clock and the timers
 * only through {@link SparklineTapeOptions} — so a test can drive it with a
 * fake clock and record every call it makes.
 *
 * The rules the tape obeys are the component's rules, unchanged:
 *
 *  1. Values are NEVER revised. A point, once shown, is permanent; the pen
 *     holds the newest value flat to the right edge.
 *  2. New samples write at the right edge and scroll left at a constant rate.
 *  3. THE DATA EVENT IS THE ONLY CLOCK. Every append is downstream of an
 *     `onActivity` call. The only timers are finishers for work an event
 *     started, and each terminates by construction.
 *  4. DORMANCY IS THE NO-EVENT STATE. Once every change has scrolled off,
 *     the tape is inert until the next event.
 *
 * ## Three clocks, and where each one stops
 *
 * | Clock | Owns |
 * |---|---|
 * | `performance.now()` (monotonic) | the tape's own axis: `SparklinePoint.t`, `committedT0`, `lastChangeAt`, `lastEventAt`, the deadband and settle timers |
 * | `document.timeline` (same origin) | the scroll transform's position, via `Animation.startTime` |
 * | `Date.now()` (wall clock) | the activity meters' ABSOLUTE bin indices |
 *
 * The first two share the document's time origin, so `anim.startTime = now`
 * makes the time→x map in `sparkline-geometry.ts` and the transform the same
 * function — which is the whole point of injecting one clock here.
 *
 * The third cannot be unified and is CONVERTED, at exactly one seam:
 * {@link SparklineTape.storeNow}. `RateMeter.series(nowMs)` advances an
 * absolute wall-clock bin index, and that advance is the only thing that
 * zero-fills the bins that have gone by — which is the entire mechanism by
 * which a stalled stream decays to a flat line. Hand it a monotonic value
 * (≈1e5) against a head bin minted from wall clock (≈1e12) and it takes its
 * early return every time: the window stops advancing and the tape holds its
 * last level forever. The failure is silent and reads as a data bug.
 *
 * @module lib/sparkline-tape
 */

import { pruneSparklineTape, type SparklinePoint } from "./sparkline-geometry";

/**
 * Response curve: maps the rate as a fraction of full scale (`x = rate /
 * fullScale`, ≥ 0 and MAY exceed 1) to a display height. The tape clamps the
 * result into `[0, 1]`, so a curve may either reach 1 exactly at `x = 1` (a
 * hard ceiling) or asymptote toward 1 and never clip. `curve(0)` must be 0 so
 * silence reads a flat baseline. The library of curves lives with the
 * component, in `tug-sparkline.tsx`.
 */
export type SparklineCurve = (x: number) => number;

/**
 * How long a datum stays visible, in seconds — the ONE knob for the time span.
 * The scroll speed is derived from it and the width, so a datum enters at the
 * right edge and scrolls off the left exactly this many seconds later.
 */
export const VISIBLE_SECONDS = 15;
/**
 * Settle-burst cadence (ms) — how often the finisher appends while the
 * plotted value is still moving. This is not a standing clock: the burst
 * exists only downstream of a data event and stops itself the moment the
 * value stops changing.
 */
export const SAMPLE_MS = 250;
/** Off-screen seconds kept past the left edge before a point is pruned. */
export const PRUNE_MARGIN_S = 4;
/** Seconds the scroll runs before a seamless time-rebase. */
export const EPOCH_S = 120;
/** One epoch in ms — the span `t0` advances by at a rollover. */
export const EPOCH_MS = EPOCH_S * 1000;
/**
 * Flat-window span (ms) after the last recognized change before the scroll
 * retires — exactly how long a datum takes to scroll fully off, so the tape
 * goes inert only once the screen is provably unchanging edge to edge.
 */
export const DORMANT_AFTER_MS = (VISIBLE_SECONDS + PRUNE_MARGIN_S) * 1000;
/** Window over which the plotted rate is summed (a rolling per-second rate). */
export const RATE_WINDOW_MS = 1_000;
/**
 * Change recognition, in PLOT PIXELS: a sample must move the line at least
 * this far from the value at the last recognized change to count as change at
 * all. Anything smaller cannot be read off a graph this size. Divided by the
 * plot amplitude at use, so the same knob is honest across every geometry.
 */
export const DEADBAND_PX = 2;
/**
 * Consecutive unchanged settle ticks before the burst declares the value
 * settled and stops itself. Necessary but NOT sufficient: the burst must also
 * outlive the rolling window's drain — a clamped or gently-curved plot holds a
 * constant pixel value while the window underneath is still draining, and
 * stopping on stability alone would freeze the tape at that level instead of
 * drawing the decay.
 */
export const SETTLE_TICKS = 2;
/**
 * How long the element must be continuously out of view before the tape stops.
 * Dormancy is an optimisation, and an optimisation that fires on a 16 ms flap
 * costs more than it saves — so the gate waits this long before believing the
 * tape has really left the screen. Re-entry cancels the wait outright.
 *
 * The flapping is real and constant on the rail: rows change height on
 * every pulse beat (a `ResizeObserver` on the sparkline's own parent rewrites
 * the middle-truncated activity run) and the Cards section re-sorts by
 * activity, so a row near the clip edge crosses the intersection boundary
 * repeatedly while nothing about it has actually changed.
 */
export const HIDDEN_PAUSE_DELAY_MS = 500;
/**
 * How long a rebase waits for its surface to say the pixels exist before
 * committing anyway.
 *
 * There are real ways the acknowledgement never arrives: the canvas is
 * re-claimed at a new resolution and the old painter's ack route goes with it;
 * the page-lifetime worker dies, taking every tape's pending rebase; a
 * `dispose` races a `tape` message. Without a bound the tape would sit at its
 * epoch's end forever — and on a wake, where the resume is ordered after the
 * rebase, it would sit PAUSED forever. One paint's worth of stale pixels is
 * strictly better than either.
 */
export const REBASE_ACK_TIMEOUT_MS = 250;
/**
 * Registration slop, in CSS px, that is simply ignored. Below this the scroll
 * and the ink disagree by less than the line they are drawn with.
 */
export const REGISTRATION_OK_PX = 1;
/**
 * The widest divergence a NUDGE may correct — everything at or above it goes
 * through the ack-gated rebase instead.
 *
 * The band has to stay this tiny because a nudge is an UNREPAINTED transform
 * move: it is the one sanctioned exception to the rule that the scroll never
 * moves ahead of its pixels, and it is sanctioned only because a ≤2 px shift of
 * a staircase on a 22 px tape is below what the eye resolves. Widening it would
 * silently reintroduce the exact defect this design removes, just at amplitudes
 * that are harder to catch. Anything the eye could see goes through the ack.
 */
export const REGISTRATION_NUDGE_MAX_PX = 2;

/** Everything the tape needs from the world it is drawn into. */
export interface SparklineSurface {
  /**
   * Post the whole tape for `t0`. `ack` non-null ⇒ the surface must call
   * {@link SparklineTape.onPainted} once those pixels exist — and must do so
   * ASYNCHRONOUSLY, or the rebase would run re-entrantly inside this very
   * call. `clear` false ⇒ draw WITHOUT wiping the canvas: an origin-moving
   * rebase paints its proposal into the proposal's own (disjoint) region and
   * leaves the committed picture — which the still-unmoved transform is
   * showing — intact, so no viewport position ever looks at blank canvas
   * while the acknowledgement is in flight.
   */
  paint(
    points: readonly SparklinePoint[],
    t0: number,
    ack: number | null,
    clear: boolean,
  ): void;
  /**
   * Register the scroll: write the animation's start time. Writing a resolved
   * start time also clears any hold, so this is ALSO the resume verb — there
   * is deliberately no `resume()` that replays from a held position, because
   * the clock runs on while a tape is paused and a hold-relative resume would
   * come back mis-registered by the whole dormant spell. Called with a NEW
   * origin only from the epoch protocol's commit; called with the CURRENT
   * committed origin wherever a stopped scroll re-registers.
   */
  setEpochStart(timelineMs: number): void;
  /** Stop the scroll. Restarting is a {@link setEpochStart} write. */
  pause(): void;
  /**
   * The dominant-channel stamp. `t0` non-null ⇒ also repaint the colours for
   * it; null ⇒ write the attribute only — the canvas refresh is deferred
   * because a rebase is in flight, and the commit flushes it.
   */
  stampChannel(channel: string | null, t0: number | null): void;
  /** Re-read the resolved colours and repaint the current tape for `t0`. */
  refreshColors(t0: number): void;
}

/** The seams a test replaces: the clock, the timers, and the data reads. */
export interface SparklineTapeOptions {
  /** The tape's clock. `Date.now` in production until the clock unification. */
  now: () => number;
  /** Current window oldest→newest; the last element is the still-open bin. */
  getSeries: (nowMs: number) => number[];
  /** Dominant-channel selector, sampled on the same loop as `getSeries`. */
  getColorChannel?: (nowMs: number) => string | null;
  /** Bin width in ms (used to size the rolling-rate window). */
  binMs: number;
  /** Rate (per {@link RATE_WINDOW_MS}) that reaches full height. */
  fullScale: number;
  /** Vertical response curve. */
  curve: SparklineCurve;
  /** Plot pixels between baseline and full scale — the deadband's divisor. */
  amplitude: number;
  /** Scroll rate — also the tape's time→x mapping. */
  pxPerSec: number;
  /** False under `prefers-reduced-motion`: there is no animation to register. */
  motion: boolean;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  /**
   * Every dormancy transition, for the dev panel. Churn on the rail is
   * exactly what {@link HIDDEN_PAUSE_DELAY_MS} exists to stop, and this is how
   * a human sees whether it stopped: scroll hard and watch the log stay quiet.
   * Injected rather than imported so the policy module keeps no dependency on
   * an app singleton, and so a test reads transitions the same way it reads
   * everything else.
   */
  onTransition?: (from: SparklineTapeState, to: SparklineTapeState) => void;
  /**
   * Called at the end of every settle-burst tick, and only while live.
   *
   * The registration self-check hangs off this. Reading the scroll's actual
   * position — and deciding whether it is even safe to look, which turns on
   * `document.visibilityState` — needs the DOM, so WHETHER to check is the
   * component's call. The CADENCE is the tape's, because an idle tape must
   * cost nothing at rest and the settle burst is the only clock that already
   * runs when something is happening.
   */
  onLiveTick?: () => void;
}

/**
 * What {@link SparklineTape.checkRegistration} says about the scroll's actual
 * position. A `nudge` is applied directly to the animation; a `rebase` goes
 * through the ack-gated protocol like any other origin move.
 */
export type SparklineRegistrationVerdict =
  | { kind: "ok" }
  | { kind: "nudge"; startTimeMs: number }
  | { kind: "rebase" };

/** The three states of Spec S02. */
export type SparklineTapeState = "live" | "flat-dormant" | "hidden-paused";

/** What {@link SparklineTape.debugState} reports. Not a production read. */
export interface SparklineTapeDebugState {
  state: SparklineTapeState;
  t0: number;
  points: number;
  /** The newest plotted value — what the pen is holding at the right edge. */
  lastV: number;
}

/**
 * The tape: an append-only array of samples, the epoch origin they are drawn
 * against, and the protocol that decides when to append and when to stop.
 */
export class SparklineTape {
  private readonly surface: SparklineSurface;
  private readonly opts: SparklineTapeOptions;

  /** Append-only while live; pruned at the left, never revised. */
  private readonly tape: SparklinePoint[] = [];
  /**
   * The scroll's origin — the clock value the animation was started from. All
   * epoch boundaries are exact multiples of {@link EPOCH_MS} from here, so
   * `t0` is derived rather than assigned and there is no ad-hoc assignment
   * left to get wrong.
   */
  private epochOrigin = 0;
  /**
   * The ONE `t0` every paint is measured from. It advances only where the
   * epoch protocol moves it, in the same statement that moves the transform —
   * so pixels and motion cannot disagree.
   */
  private committed = 0;
  /**
   * `Date.now() - now()`, captured once at {@link start}. The tape's only
   * wall clock, and the only conversion between its monotonic axis and the
   * activity meters' absolute wall-clock bins.
   */
  private wallOffset = 0;
  /** How many of the most recent bins the rolling rate sums. */
  private readonly rateBins: number;
  /** Change recognition, as a fraction of full scale. */
  private readonly deadband: number;
  /** The drain the settle burst must outlive before it may stop. */
  private readonly drainMs: number;

  /**
   * The three states of Spec S02, held explicitly rather than derived. The two
   * inert ones are NOT the same condition wearing one name:
   *
   *  - `flat-dormant` — every change has scrolled off, so the picture is
   *    provably flat. Reached by the flat-off finisher, and true whether or not
   *    anyone is looking.
   *  - `hidden-paused` — the element is off screen, so the picture is
   *    ARBITRARY. Reached by the visibility gate. Nothing about the tape is
   *    disturbed on the way in; it is a stopped scroll and nothing more.
   *
   * Collapsing them is what made the Cards card judder: a full rebase of a non-flat
   * picture on every scroll-boundary crossing.
   */
  private state: SparklineTapeState = "flat-dormant";
  /**
   * Whether the element is on screen. Orthogonal to {@link state}: a tape can
   * be off screen AND provably flat, in which case `flat-dormant` is the more
   * specific description and the one reported. Both exit the same way.
   */
  private inView = true;
  /**
   * The plotted value at the last recognized change. The reference advances
   * only when the deadband is cleared, so slow drift accumulates against a
   * fixed point and eventually registers instead of ratcheting under the
   * threshold sample after sample.
   */
  private refV = 0;
  private lastChangeAt = 0;
  /**
   * When the last data event arrived. The settle burst must run at least the
   * rolling window's span past this before it may stop: until every bin the
   * last event touched has aged out, the plotted value has a future the pixels
   * have not shown yet.
   */
  private lastEventAt = 0;
  private stampedChannel: string | null = null;

  /** The two finishers. Each terminates on its own; events only reset them. */
  private settleTimer: number | null = null;
  private settledTicks = 0;
  private flatOffTimer: number | null = null;
  /** The out-of-view hysteresis. Re-entry cancels it. */
  private pauseTimer: number | null = null;
  /** True while a `surface.paint` call is on the stack — see `onPainted`. */
  private painting = false;
  /**
   * Whether the scroll is currently stopped. The component creates the
   * animation running and registered, so a born-live tape has nothing to
   * restart; every stop and every restart below goes through
   * {@link stopScroll} / {@link registerScroll} so this cannot drift.
   */
  private scrollStopped = false;

  /**
   * The rebase in flight, if any. `pendingSeq` is the newest sequence issued;
   * an acknowledgement for anything older has been superseded and is dropped.
   * `pending` holds the origin that sequence proposed — it is consumed at the
   * commit, so a late ack for a sequence the watchdog already committed finds
   * nothing to do.
   */
  private pendingSeq = 0;
  private readonly pending = new Map<number, number>();
  private watchdog: number | null = null;
  /** Set when the rebase in flight is a wake: stay running once the origin moves. */
  private resumeAfterRebase = false;
  /**
   * A colour change (channel stamp or theme swap) landed while a rebase was in
   * flight. Repainting colours then would clear the canvas and redraw one
   * origin, blanking the other's viewport — so the refresh waits for the
   * commit, which flushes it against the newly committed origin.
   */
  private colorsStale = false;

  constructor(surface: SparklineSurface, options: SparklineTapeOptions) {
    this.surface = surface;
    this.opts = options;
    this.rateBins = Math.max(1, Math.round(RATE_WINDOW_MS / options.binMs));
    this.deadband = DEADBAND_PX / options.amplitude;
    this.drainMs = RATE_WINDOW_MS + options.binMs;
  }

  /**
   * Mount: build the tape from the caller's binned history, stamp the tint,
   * and decide born-live vs born-inert. `originMs` is the clock reading the
   * caller took for this mount — the same one the scroll's origin is set from.
   */
  start(originMs: number): void {
    this.captureWallOffset();
    this.epochOrigin = originMs;
    this.committed = this.proposedT0(originMs);
    // Stamp the tint once at mount, dormancy-independent: a born-idle tape
    // never runs the sampler, and a fixed-hue row (the Pulse card) must not
    // sit untinted until its first wake. Not an activity signal —
    // `stampedChannel` is pre-set so the first append sees no change.
    if (this.opts.getColorChannel !== undefined) {
      const mountChannel = this.opts.getColorChannel(this.storeNow(originMs));
      this.stampedChannel = mountChannel;
      if (mountChannel !== null) this.surface.stampChannel(mountChannel, this.committed);
    }
    this.rebuildTape(originMs);
    if (this.flatPastWindow(originMs)) {
      // Born inert: paint the static picture once and wait for the clock — an
      // idle session costs nothing from the first frame. A steady gauge level
      // is as inert as a zero rate: its line is flat at the level. The scroll
      // the component just created is running — stop it, or a born-idle tape
      // pays for a compositor animation until its first epoch end.
      this.transition("flat-dormant");
      this.paint();
      this.stopScroll();
    } else {
      this.wakeLive(originMs);
    }
  }

  /**
   * Re-derive the wall-clock offset. Called when the page comes back from
   * hidden, where a sleep/wake or an NTP step may have moved wall clock
   * relative to the monotonic one.
   */
  resyncWallClock(): void {
    this.captureWallOffset();
  }

  /**
   * THE ONE WALL CLOCK. Every store-facing read crosses {@link storeNow};
   * nothing else in this file or in the component reads `Date.now`, and this
   * is the single expression that produces it. See the module header for what
   * breaks if a second one appears — or if this one goes.
   */
  private captureWallOffset(): void {
    this.wallOffset = Date.now() - this.opts.now();
  }

  /**
   * The epoch boundary at or before `now` — exact multiples of
   * {@link EPOCH_MS} from the scroll's own origin. Consulted ONLY by the
   * epoch protocol: a paint that used this instead of {@link committedT0}
   * would draw for an origin the transform has not reached.
   */
  proposedT0(now: number): number {
    return (
      this.epochOrigin + Math.floor((now - this.epochOrigin) / EPOCH_MS) * EPOCH_MS
    );
  }

  /**
   * The data event — the tape's one clock. Dormant: wake, unless the plotted
   * value would not visibly move (a below-deadband gauge event; the store's
   * gate is finer than the plot's). Live: reset the settle burst's quiet
   * count. Off-screen: just remember the activity so re-entry resumes live.
   */
  onActivity(): void {
    const now = this.opts.now();
    this.lastEventAt = now;
    if (!this.inView) {
      this.lastChangeAt = now;
      return;
    }
    if (this.state !== "live") {
      if (Math.abs(this.sampleRate(now) - this.refV) < this.deadband) return;
      this.wakeLive(now);
      return;
    }
    this.startSettle();
  }

  /**
   * RAW intersection from the observer — the out-of-view hysteresis lives
   * here, on the injected timers, so a test can reach it. Re-entry cancels any
   * pending pause. At a zero delay the pause stays synchronous, because a
   * deferred one would be a behaviour change dressed as a refactor.
   */
  setVisible(visible: boolean): void {
    if (visible) {
      this.clearPauseTimer();
      if (this.inView) return;
      this.inView = true;
      this.wakeFromHidden(this.opts.now());
      return;
    }
    if (!this.inView || this.pauseTimer !== null) return;
    if (HIDDEN_PAUSE_DELAY_MS <= 0) {
      this.enterHiddenPause();
      return;
    }
    this.pauseTimer = this.opts.setTimeout(() => {
      this.pauseTimer = null;
      this.enterHiddenPause();
    }, HIDDEN_PAUSE_DELAY_MS);
  }

  /**
   * The scroll reached its epoch's end. A redundant nudge into the same check
   * the tape's own tick runs — NOT the rollover's only path, because a paused
   * animation never finishes and a tape that was hidden across a boundary
   * would otherwise never roll over.
   */
  onEpochFinished(): void {
    this.rollover(this.opts.now());
  }

  /**
   * The surface's acknowledgement that the pixels for a paint carrying `ack`
   * now exist.
   *
   * A surface that acks from inside `paint()` is a programming error, not an
   * edge case: the ack is what moves the scroll origin, so a synchronous one
   * would move it from inside the very paint it is acknowledging. The on-main
   * painter draws synchronously and defers through `queueMicrotask` for
   * exactly this reason, and this assertion is what stops that microtask from
   * being tidied away by someone who cannot see why it is there.
   */
  onPainted(ack: number): void {
    if (this.painting) {
      throw new Error("SparklineSurface acknowledged a paint synchronously");
    }
    // Superseded by a newer rebase, or orphaned by `cancelRebase`.
    if (ack !== this.pendingSeq) return;
    this.clearWatchdog();
    const proposed = this.pending.get(ack);
    // Already committed — the watchdog got here first and this is its ack
    // arriving late. Committing twice would move the origin without a paint.
    if (proposed === undefined) return;
    this.pending.delete(ack);
    // COMMIT AND MOVE ARE ONE OPERATION. The pixels for this origin exist;
    // the transform may now assume them. Do not separate these two lines.
    this.committed = proposed;
    this.scrollStopped = false;
    this.surface.setEpochStart(this.committed);
    // Flush. Ordinary paints held their fire while the rebase was in flight —
    // a clear-paint at either origin would have blanked the other's viewport —
    // so the canvas may be missing points appended since the proposal, and it
    // still carries the retired origin's ink. One clear paint squares it.
    this.paint();
    if (this.colorsStale) {
      this.colorsStale = false;
      this.surface.refreshColors(this.committed);
    }
    if (this.resumeAfterRebase) {
      // A wake stays running: the setEpochStart write above cleared the hold
      // and registered the scroll in the same stroke — only AFTER the origin
      // moved, because resuming first would run the scroll from a stale
      // origin, which is this plan's own defect wearing a different hat.
      this.resumeAfterRebase = false;
      return;
    }
    // Writing a resolved start time also clears the animation's hold, so a
    // dormant tape that rebased — because it woke after a long hidden spell
    // and its origin had gone stale — would quietly start scrolling. Put it
    // back where dormancy left it.
    if (this.state !== "live") this.stopScroll();
  }

  /**
   * Repaint the current tape unchanged — the canvas underneath was replaced.
   * A non-live tape re-parks afterwards: its scroll was paused at some older
   * clock reading, and a fresh committed-origin paint under that stale hold
   * can put the viewport onto empty canvas. Registering the paused position
   * back onto the clock is what keeps a resting flatline visible across a
   * resolution change.
   */
  repaint(): void {
    this.paint();
    this.parkScroll();
  }

  /**
   * The canvas the outstanding rebase was painted on is gone, so its ack will
   * never arrive. Orphan the sequence and disarm the watchdog; the tape
   * re-proposes on its next tick.
   */
  cancelRebase(): void {
    this.clearWatchdog();
    this.pendingSeq += 1;
    this.pending.clear();
    if (!this.resumeAfterRebase) return;
    // The origin never moved, so restarting is a re-registration onto it —
    // leaving the scroll paused would strand the tape with no tick to
    // re-propose from.
    this.resumeAfterRebase = false;
    this.registerScroll();
  }

  /**
   * The colours under the canvas changed (theme swap). Deferred while a rebase
   * is in flight — see {@link colorsStale} — and painted for the committed
   * origin otherwise, which is the origin the pixels on screen were drawn for.
   */
  refreshColors(): void {
    if (this.pending.size > 0) {
      this.colorsStale = true;
      return;
    }
    this.surface.refreshColors(this.committed);
  }

  /** The `t0` every paint uses. Public: the wake divergence log reads it. */
  committedT0(): number {
    return this.committed;
  }

  /**
   * Is the scroll where the clock says it should be?
   *
   * Registration is VERIFIED rather than assumed, because the ways it can slip
   * are not all inside this design: a document timeline that stalls while the
   * window is occluded, a `startTime` write that landed against a different
   * frame, a compositor that dropped the layer. The check is pure — it reads a
   * position and returns a verdict — so the caller can gate it on conditions
   * only the caller knows about, and so its band is testable directly.
   *
   * `animCurrentTimeMs` is the animation's position, or `null` when there is no
   * running animation to read (paused, missing, or otherwise not advancing).
   * A tape that is live and yet has no running scroll is not slightly out of
   * register; it is not registered at all, so that is a rebase, never a nudge.
   */
  checkRegistration(animCurrentTimeMs: number | null): SparklineRegistrationVerdict {
    // Reduced motion has no animation and therefore no registration to keep.
    if (!this.opts.motion) return { kind: "ok" };
    if (animCurrentTimeMs === null) return { kind: "rebase" };
    // Where the scroll should be: the committed origin is the ONE authority,
    // so this is the same number every paint is measured from.
    const expected = this.opts.now() - this.committed;
    const driftPx = ((animCurrentTimeMs - expected) / 1000) * this.opts.pxPerSec;
    const magnitude = Math.abs(driftPx);
    if (magnitude < REGISTRATION_OK_PX) return { kind: "ok" };
    // Correcting registration means writing back the origin the tape already
    // committed — the pixels on screen were drawn for it, so this moves the
    // scroll ONTO its own picture rather than away from it. That is the whole
    // reason an unrepainted write is safe here and nowhere else.
    if (magnitude < REGISTRATION_NUDGE_MAX_PX) {
      return { kind: "nudge", startTimeMs: this.committed };
    }
    return { kind: "rebase" };
  }

  /**
   * The self-check found a divergence too large to nudge. Re-register through
   * the ordinary ack-gated path: repaint for the origin, then move onto it.
   *
   * Forced, because the origin it lands on is usually the one already
   * committed — the picture is right and the SCROLL is wrong, which is the one
   * case an ordinary rebase's "nothing to do" early return would swallow.
   */
  resyncRegistration(): void {
    this.rebase(this.proposedT0(this.opts.now()), true);
  }

  /** Test/debug read-out. Production reads `t0` through {@link committedT0}. */
  debugState(): SparklineTapeDebugState {
    const newest = this.tape.length > 0 ? this.tape[this.tape.length - 1].v : 0;
    return {
      state: this.state,
      t0: this.committed,
      points: this.tape.length,
      lastV: newest,
    };
  }

  /**
   * The single writer for {@link state}. Every transition goes through here so
   * the dev-log view of the tape's churn cannot drift from the tape's actual
   * behaviour — a report emitted at four of the five call sites would be worse
   * than none, because a quiet log would then mean nothing.
   */
  private transition(next: SparklineTapeState): void {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.opts.onTransition?.(from, next);
  }

  /** Release every timer the tape holds. Called from the effect's cleanup. */
  stop(): void {
    this.stopSettle();
    this.stopFlatOff();
    this.clearPauseTimer();
    this.clearWatchdog();
  }

  // ---------------------------------------------------------------- painting

  /**
   * The store reads on the meters' clock. The ONE conversion — see the module
   * header. Both `getSeries` and `getColorChannel` take the same `nowMs`
   * contract, and `getColorChannel`'s argument funds `dominant`'s series read
   * AND its hysteresis stamps, which are compared against state the store
   * writes from wall clock. No current caller reads that argument, which is
   * exactly why it must be right now rather than noticed later.
   */
  private storeNow(now: number): number {
    return now + this.wallOffset;
  }

  /**
   * The ordinary paint: the committed origin, a full clear. HELD while a
   * rebase is in flight — the canvas then carries the committed picture (which
   * the still-unmoved transform is showing) AND the proposal's picture (which
   * the acknowledgement is about to move onto), and a clear-paint at either
   * origin would blank the other's viewport. The tape keeps appending
   * meanwhile; the commit flushes one clear paint that squares everything.
   */
  private paint(): void {
    if (this.pending.size > 0) return;
    const now = this.opts.now();
    pruneSparklineTape(this.tape, now, DORMANT_AFTER_MS);
    this.painting = true;
    try {
      this.surface.paint(this.tape, this.committed, null, true);
    } finally {
      this.painting = false;
    }
  }

  /**
   * The rebase's own paint. When the origin actually moves, it draws WITHOUT
   * clearing: the proposal's ink lands in its own region — origins differ by
   * whole epochs, several viewport-widths apart — and the committed picture
   * stays intact for the transform still in force, so the ack window shows a
   * freeze, never a blank. A FORCED same-origin rebase (the registration
   * self-check re-registering a drifted scroll) clears as usual: same origin,
   * same region, and an overdraw would double the translucent area fill.
   */
  private paintProposal(t0: number, ack: number): void {
    const now = this.opts.now();
    pruneSparklineTape(this.tape, now, DORMANT_AFTER_MS);
    this.painting = true;
    try {
      this.surface.paint(this.tape, t0, ack, t0 === this.committed);
    } finally {
      this.painting = false;
    }
  }

  /** Stop the scroll, and remember that it is stopped. */
  private stopScroll(): void {
    if (!this.opts.motion) return;
    this.scrollStopped = true;
    this.surface.pause();
  }

  /**
   * Restart a stopped scroll by REGISTERING it: write the committed origin
   * back as the start time, which clears the hold and lands the scroll where
   * the clock says — never where the pause left it, because the clock ran on
   * through the whole stopped spell. A scroll that is already running is
   * already registered (the self-check polices drift) and is left alone.
   */
  private registerScroll(): void {
    if (!this.opts.motion || !this.scrollStopped) return;
    this.scrollStopped = false;
    this.surface.setEpochStart(this.committed);
  }

  /**
   * Register a stopped scroll onto the committed origin and keep it stopped.
   * The setEpochStart write moves the paused position onto the clock — over
   * pixels just painted for that same origin, whose held tail covers the
   * quiet stretch — and the pause puts the hold back. Live tapes and
   * reduced-motion tapes have nothing to park.
   */
  private parkScroll(): void {
    if (!this.opts.motion || this.state === "live") return;
    this.registerScroll();
    this.stopScroll();
  }

  /**
   * The current rolling rate: sum of the most recent `rateBins` buckets, taken
   * as a fraction of full scale, shaped by `curve`, then clamped. The clamp is
   * OUTSIDE the curve so a saturating curve can take x > 1 and roll off gently
   * instead of being pre-clipped at full scale.
   */
  private sampleRate(now: number): number {
    const vals = this.opts.getSeries(this.storeNow(now));
    let sum = 0;
    for (let i = Math.max(0, vals.length - this.rateBins); i < vals.length; i++) {
      sum += vals[i];
    }
    return Math.min(1, Math.max(0, this.opts.curve(sum / this.opts.fullScale)));
  }

  /**
   * One append → one permanent point at "now" (the right edge), then a
   * repaint. Every call is downstream of a data event: the wake path and the
   * settle burst are the only callers.
   */
  private appendPoint(now: number): void {
    // With motion off there is no scroll to register against, so the origin
    // re-seeds to the newest sample and the picture stands still. This is the
    // one path that writes `committed` outside the epoch protocol, and it is
    // sound precisely because there is no transform to disagree with.
    if (!this.opts.motion) this.committed = now;
    const v = this.sampleRate(now);
    if (Math.abs(v - this.refV) >= this.deadband) {
      this.refV = v;
      this.lastChangeAt = now;
    }
    this.tape.push({ t: now, v });
    this.paint();
    if (this.opts.getColorChannel === undefined) return;
    const channel = this.opts.getColorChannel(this.storeNow(now));
    if (channel === this.stampedChannel) return;
    // A dominant-channel CHANGE is on-screen change — the tint is about to
    // move, so it holds the scroll alive like any drawn change. A steady
    // return is not: a fixed-hue consumer (the Pulse card rows) is always
    // non-null, and treating that as change would lock those tapes out of
    // dormancy forever.
    this.lastChangeAt = now;
    this.stampedChannel = channel;
    if (this.pending.size > 0) {
      // Mid-rebase the attribute may move now — it is DOM, not canvas — but
      // the colour repaint waits for the commit like every other paint.
      this.colorsStale = true;
      this.surface.stampChannel(channel, null);
      return;
    }
    this.surface.stampChannel(channel, this.committed);
  }

  // ------------------------------------------------------------- the epoch

  /**
   * Roll the epoch over if the clock has crossed a boundary. The trigger is
   * this comparison, evaluated on the tape's own tick — never the animation's
   * `onfinish`, which a paused animation never reaches, so a tape hidden
   * across a boundary would otherwise never roll over at all.
   */
  private rollover(now: number): boolean {
    if (!this.opts.motion) return false;
    return this.rebase(this.proposedT0(now));
  }

  /**
   * THE ONLY PATH THAT MOVES THE SCROLL ORIGIN. The tape is painted for the
   * proposed origin first, and the transform follows only when the surface
   * says those pixels exist. Returns true when a rebase is now in flight.
   *
   * There is no fast path for a flat tape, and adding one would ship the exact
   * defect this exists to prevent. The tempting argument — "a flat tape is a
   * horizontal line, and translating a horizontal line changes nothing" — is
   * false: `drawSparkline` begins its path at `xOf(tape[0].t)`, so everything
   * left of the oldest retained point is EMPTY, and a translated flat line is
   * only pixel-identical where there is actually ink. And the shortcut buys
   * nothing anyway: the stall an ack costs is only perceptible while something
   * is moving, and while something is moving the tape is not flat.
   *
   * The rollover therefore freezes for one round-trip, and that is the
   * accepted trade. The freeze really is a freeze: the proposal is painted
   * WITHOUT clearing (see {@link paintProposal}), so the committed picture the
   * transform is still showing survives the whole ack window, and ordinary
   * paints hold their fire until the commit flushes them ({@link paint}). At
   * the epoch's end the scroll sits at its `fill: forwards` end position over
   * those intact pixels; `svgWidth = width + epochPx + 8` reserves the slack
   * past the boundary.
   */
  private rebase(newT0: number, force = false): boolean {
    // Nothing to do — unless the caller is the registration self-check, which
    // reaches here precisely BECAUSE the scroll has drifted off an origin that
    // has not otherwise changed.
    if (newT0 === this.committed && !force) return false;
    // Already proposed and still in flight. Re-issuing on every tick would
    // supersede the outstanding sequence 4 times a second and re-arm the
    // watchdog with it, so a lost ack would never time out at all.
    if (this.pending.get(this.pendingSeq) === newT0) return true;
    const seq = ++this.pendingSeq;
    this.pending.clear();
    this.pending.set(seq, newT0);
    this.paintProposal(newT0, seq);
    this.clearWatchdog();
    // A lost ack must not freeze — or, on a wake, permanently pause — the tape.
    this.watchdog = this.opts.setTimeout(() => {
      this.watchdog = null;
      // Through the same body the surface would have reached, so the
      // commit-and-move pairing has exactly one implementation.
      this.onPainted(seq);
    }, REBASE_ACK_TIMEOUT_MS);
    return true;
  }

  private clearWatchdog(): void {
    if (this.watchdog === null) return;
    this.opts.clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Rebuild the tape from the caller's real binned history: zero seeds cover
   * the span the bins do not reach (so the chart is FULL edge to edge, never
   * growing in from the right), then each bin becomes the point the live
   * sampler would have written at that moment — same rolling rate, same curve.
   * Used at mount and at every wake, so what is on screen is always derived
   * from data + timestamps, never from scroll continuity.
   */
  private rebuildTape(now: number): void {
    this.tape.length = 0;
    const vals = this.opts.getSeries(this.storeNow(now));
    const binSpan = vals.length * this.opts.binMs;
    for (let dt = DORMANT_AFTER_MS; dt > binSpan; dt -= SAMPLE_MS) {
      this.tape.push({ t: now - dt, v: 0 });
    }
    // Change-scan the real points: the reference starts at the first
    // reconstructed value (a level held through the whole window is not change
    // — the zero-seed step at the window's left edge is a seam of
    // reconstruction, not data) and advances exactly as the live path would
    // have, so `lastChangeAt` lands where the deadband was last genuinely
    // cleared.
    let seeded = false;
    for (let i = 0; i < vals.length; i++) {
      let sum = 0;
      for (let j = Math.max(0, i - this.rateBins + 1); j <= i; j++) sum += vals[j];
      const v = Math.min(1, Math.max(0, this.opts.curve(sum / this.opts.fullScale)));
      const t = now - (vals.length - 1 - i) * this.opts.binMs;
      if (!seeded) {
        this.refV = v;
        seeded = true;
      } else if (Math.abs(v - this.refV) >= this.deadband) {
        this.refV = v;
        this.lastChangeAt = Math.max(this.lastChangeAt, t);
      }
      this.tape.push({ t, v });
    }
  }

  // ------------------------------------------------------------- finishers

  private stopSettle(): void {
    if (this.settleTimer === null) return;
    this.opts.clearInterval(this.settleTimer);
    this.settleTimer = null;
  }

  private stopFlatOff(): void {
    if (this.flatOffTimer === null) return;
    this.opts.clearTimeout(this.flatOffTimer);
    this.flatOffTimer = null;
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer === null) return;
    this.opts.clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  /**
   * Finisher 1 — the settle burst. Keeps appending at {@link SAMPLE_MS} while
   * the plotted value is still moving, and stops itself after
   * {@link SETTLE_TICKS} unchanged ticks. Events reset the quiet count, so
   * continuous activity holds the burst open at exactly the sampler's cadence
   * — and the instant activity stops, it ends.
   */
  private startSettle(): void {
    this.settledTicks = 0;
    if (this.settleTimer !== null) return;
    this.settleTimer = this.opts.setInterval(() => {
      const now = this.opts.now();
      // The tape's tick is where the epoch rolls over.
      this.rollover(now);
      const prev = this.tape.length > 0 ? this.tape[this.tape.length - 1].v : 0;
      this.appendPoint(now);
      // The registration self-check rides here, after the paint that just went
      // out — so what it compares the scroll against is the picture currently
      // on screen. Only while live, which is what makes an idle tape free.
      this.opts.onLiveTick?.();
      const cur = this.tape[this.tape.length - 1].v;
      if (Math.abs(cur - prev) >= this.deadband) {
        this.settledTicks = 0;
        return;
      }
      this.settledTicks += 1;
      // Stop only when the value is stable AND the last event's whole window
      // has drained: a plot clamped at full scale (or riding a gentle curve)
      // holds still while the sum under it is still falling, and a
      // stability-only stop would freeze that level on screen instead of
      // drawing the decay to rest.
      if (this.settledTicks >= SETTLE_TICKS && now - this.lastEventAt >= this.drainMs) {
        this.stopSettle();
      }
    }, SAMPLE_MS);
  }

  /**
   * Finisher 2 — the flat-off timeout. Retires the scroll once the last
   * recognized change has scrolled fully off screen. Scheduled against
   * `lastChangeAt` and re-checked on fire, so changes recognized after
   * scheduling push it out without rescheduling churn on every event.
   */
  private scheduleFlatOff(): void {
    this.stopFlatOff();
    const remaining = this.lastChangeAt + DORMANT_AFTER_MS - this.opts.now();
    if (remaining <= 0) {
      this.enterFlatDormancy();
      return;
    }
    this.flatOffTimer = this.opts.setTimeout(() => {
      this.flatOffTimer = null;
      const now = this.opts.now();
      if (now - this.lastChangeAt >= DORMANT_AFTER_MS) this.enterFlatDormancy();
      else this.scheduleFlatOff();
    }, remaining + 20);
  }

  // -------------------------------------------------------------- dormancy

  /**
   * FLAT DORMANCY: every recognized change has scrolled off, so the picture is
   * provably flat and a scrolling flat line is pixel-identical to a still one.
   * Not a detected condition — just what no-events looks like once the
   * finishers have run out. Idempotent.
   *
   * Nothing is rebased on the way in. The origin only ever moves where the
   * epoch protocol moves it, and the wake path already runs that check — so
   * rebasing here would only add a rebase at the moment the tape stops
   * mattering.
   */
  private enterFlatDormancy(): void {
    if (this.state === "flat-dormant") return;
    const wasLive = this.state === "live";
    this.transition("flat-dormant");
    this.stopSettle();
    this.stopFlatOff();
    if (wasLive) {
      // A live tape earned its flatness: the settle burst only stops once the
      // value has held still AND the last event's whole window has drained, so
      // the pen is already down at the level the data supports and the picture
      // is flat at it. Nothing to redraw — just retire the scroll.
      this.stopScroll();
      return;
    }
    // From a HIDDEN PAUSE it did not. That pause stopped the settle burst
    // wherever it happened to be — mid-decay, or clamped at full scale — and
    // the pen has been frozen there ever since. The picture is indeed flat
    // now; it is flat AT THE FROZEN LEVEL, and the geometry holds that last
    // value out to the canvas edge, so the tape rests as a solid full-width
    // bar at a height the meters stopped supporting seconds ago. Coming to
    // rest is exactly when that stops being a transient and becomes what the
    // instrument says.
    //
    // Only when it actually disagrees, and judged the way every other change
    // on this tape is judged — the deadband, in PLOT PIXELS. A tape that went
    // off screen holding the level the meters still hold is already resting on
    // its data, and rebuilding it would move nothing while putting a paint, an
    // origin write and a pause into the trace for every hidden tape that
    // crosses its deadline. That is most of the Cards card, most of the time.
    const now = this.opts.now();
    const held = this.tape.length > 0 ? this.tape[this.tape.length - 1].v : 0;
    if (Math.abs(this.sampleRate(now) - held) < this.deadband) return;
    this.restOnData(now);
  }

  /**
   * HIDDEN PAUSE: the element is off screen, so the picture is ARBITRARY —
   * mid-staircase, mid-burst, anything. That is the whole difference from flat
   * dormancy, and it is why this path changes NOTHING except stopping: no `t0`
   * move, no repaint, no rebuild. Moving the origin here would translate a
   * picture that is not translation-invariant, which is the Cards card judder.
   *
   * The tape may sit here for longer than an epoch — a collapsed Cards card section,
   * a backgrounded window. That is safe because the rollover trigger is the
   * clock comparison in {@link rollover}, not the animation's `onfinish`: a
   * paused animation never finishes, so a tape hidden across a boundary would
   * otherwise never roll over at all. Resume rebases by however many epochs
   * went by, in one move.
   *
   * The flat-off finisher stays armed. Whether the last change has scrolled off
   * is a fact about the data, not about who is looking, and letting it run is
   * what lets a tape hidden past its deadline settle into the more specific
   * `flat-dormant` — one timeout, which then terminates by construction and
   * leaves the tape holding none.
   */
  private enterHiddenPause(): void {
    this.inView = false;
    // Already inert. `flat-dormant` is the stronger statement about the same
    // stopped scroll, so it stands, and there is no second `pause` to emit.
    if (this.state !== "live") return;
    this.transition("hidden-paused");
    this.stopSettle();
    this.stopScroll();
  }

  /**
   * Resume live: reconstruct from data, restart the scroll, append the point
   * the triggering event just made true, and arm the finishers. Runs
   * synchronously inside the caller's data write, so waking never trails the
   * activity that caused it.
   */
  private wakeLive(now: number): void {
    this.transition("live");
    // A wake counts as an event for the drain clock even when it came from the
    // visibility gate rather than the data channel — the rebuilt window
    // deserves a full settle pass either way.
    this.lastEventAt = now;
    this.rebuildTape(now);
    if (this.opts.motion) {
      // The restart is ordered AFTER the origin moves, so it rides the
      // rebase's acknowledgement when there is one. With no boundary to cross
      // the scroll restarts immediately — as a REGISTRATION, not a replay:
      // writing the committed origin back as the start time clears the hold
      // and lands the scroll where the clock says, not where the pause left
      // it. The clock ran on through dormancy, and a hold-relative resume
      // would come back shifted by that whole quiet spell — the viewport on
      // older ink, or past the ink entirely — until the self-check caught it
      // a tick later and snapped. The jump forward is safe because the paint
      // it lands on holds the pen's value flat to the canvas's edge.
      if (this.rollover(now)) this.resumeAfterRebase = true;
      else this.registerScroll();
    }
    this.appendPoint(now);
    this.startSettle();
    this.scheduleFlatOff();
  }

  /**
   * Back on screen. A tape with nothing recent to show stays inert and simply
   * re-derives its picture; one with recent activity resumes live. Either way
   * the origin moves only through the ack-gated rebase.
   */
  private wakeFromHidden(now: number): void {
    if (this.state === "live") return;
    if (this.flatPastWindow(now)) {
      // Nothing recent to show, so the tape stays inert — but its origin may
      // be many epochs stale after a long spell off screen, and a paint
      // against a stale origin lands the ink entirely off the canvas. Rebase
      // it (ack-gated like any other) and let the rebase's own paint stand.
      //
      // The picture is now known to be flat, so the state settles to the more
      // specific of the two. The scroll stays stopped either way — `onPainted`
      // re-pauses after the origin moves, because writing a resolved start
      // time clears the animation's hold; the no-rollover path parks
      // explicitly, because the fresh paint assumes the clock and the paused
      // scroll was held at some older reading.
      this.transition("flat-dormant");
      this.restOnData(now);
      return;
    }
    this.wakeLive(now);
  }

  /**
   * Come to rest on the DATA, not on wherever the pen was left.
   *
   * Both roads into flat dormancy from a hidden pause end here. The tape is
   * about to stop entirely — no settle burst, no flat-off timer, no scroll —
   * so whatever is on the canvas when this returns is what the tape shows
   * until something wakes it, which may be never. That makes this the one
   * place the picture has to be re-derived rather than inherited.
   *
   * The origin may be many epochs stale after a long spell off screen, and a
   * paint against a stale origin lands the ink entirely off the canvas — so
   * the rebase runs first and, when it moves the origin, its own ack-gated
   * paint is the one that stands. The no-rollover path parks explicitly,
   * because the fresh paint assumes the clock while the paused scroll is still
   * held at some older reading.
   */
  private restOnData(now: number): void {
    this.rebuildTape(now);
    if (this.rollover(now)) return;
    this.paint();
    this.parkScroll();
  }

  private flatPastWindow(now: number): boolean {
    return now - this.lastChangeAt >= DORMANT_AFTER_MS;
  }
}
