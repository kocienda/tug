/**
 * The body land — what a card page's own land frame cost, and what ran in it.
 *
 * The shell's `settle-land` row reads the shell's land. Since every card is
 * its own web view, the card's land runs in the card's process: the host's
 * track ends, it resizes the page or tells it `land`, the page ends its
 * resize episode, and the restore, the pin and the re-measure are paid here,
 * where the shell's record cannot see. This is that record for a card page,
 * one `body-land` deck-trace row per crossing, read by the same pure
 * classification the shell's land uses (`lib/land-frame-record.ts`).
 *
 * The record arms at `bodyCrossing begin` and pumps frame callbacks until two
 * ticks past `land` — the same two-tick tail the shell's land takes, for the
 * same reason: the first tick after the land runs ahead of the layout and
 * deliveries the hand-back dirtied, and the second closes the frame that paid.
 * The ticks before the land also give the page's display period, which a body
 * page has no settle record to read it from.
 *
 * The solve is stamped by {@link BodyLand.markSolved} when the page reports
 * itself laid out at its end size; what ran between it and the land is the
 * motion's, carried beside the land as `motionCommits` and
 * `motionScrollWrites`. A crossing that never solved reads the motion from
 * the begin, and says so with a null `solveMs`.
 *
 * It is a BENCH RECORD, like the shell's: it arms only while the `body-land`
 * kind is enabled (the record switch, or a test that asks), so a page nobody
 * is measuring pumps no frame callback.
 *
 * @module body/body-land
 */

import {
  classifyLand,
  classifyMotionEvents,
  landOpensAt,
  type LandCommit,
  type LandEvent,
  type LandInput,
} from "../lib/land-frame-record";

/** How many ticks one crossing keeps; a crossing nobody lands stops here. */
export const BODY_LAND_TICK_CAP = 600;

/** The display period a page with too few ticks to read one assumes. */
const FALLBACK_PERIOD_MS = 1000 / 60;

/** The `body-land` row, as the deck trace carries it. */
export interface BodyLandRow {
  readonly cardId: string;
  /** The plan that carried the card; `null` when the host did not say. */
  readonly planId: number | null;
  /** Begin to the page's solved report; `null` when it never solved. */
  readonly solveMs: number | null;
  /** How long the host's cover snapshot took; `null` when there was none. */
  readonly snapshotMs: number | null;
  /** Whether the folded form had landed at the solve; `null` when not folding. */
  readonly foldLanded: boolean | null;
  /** The host's resize never reached the solve, which ran on its fallback; `null` with no solve. */
  readonly resizeMissed: boolean | null;
  /** `Date.now()` at the land, so a reader on another clock can find the row. */
  readonly landWallMs: number;
  readonly frameMs: number;
  readonly frameFrames: number;
  readonly gapsMs: readonly number[];
  readonly framePeriodMs: number;
  /** The land's commits; `null` with no commit census in the page. */
  readonly commits: readonly LandCommit[] | null;
  readonly forcedLayouts: readonly LandEvent[];
  /** The land's observer deliveries; `null` with no delivery wrapper. */
  readonly deliveries: readonly LandEvent[] | null;
  readonly episodeEnds: readonly LandEvent[];
  readonly scrollWrites: readonly LandEvent[];
  /** What committed between the solve (or the begin) and the land. */
  readonly motionCommits: readonly LandCommit[] | null;
  readonly motionScrollWrites: readonly LandEvent[];
}

/** What the record reads the page through, so the arithmetic runs as data. */
export interface BodyLandDeps {
  readonly cardId: () => string;
  /** Whether the `body-land` kind is armed now. */
  readonly enabled: () => boolean;
  readonly now: () => number;
  readonly wallNow: () => number;
  readonly raf: (cb: () => void) => number;
  readonly cancelRaf: (id: number) => void;
  readonly recorder: {
    arm(): void;
    disarm(): void;
    take(from: number): Pick<LandInput, "commits" | "forcedReads" | "deliveries" | "episodeEnds" | "scrollWrites">;
  };
  readonly record: (row: BodyLandRow) => void;
}

/** What the page knows of its solve when it reports it. */
export interface BodySolveFacts {
  /** Whether the card host wore its folded form at the solve; `null` when not folding. */
  readonly foldLanded: boolean | null;
  /** The solve ran on its fallback: the host's resize never came. */
  readonly resizeMissed: boolean;
  /** How long the host's cover snapshot took, when the page was told. */
  readonly snapshotMs?: number | null;
}

/** One page's land record. */
export interface BodyLand {
  /** The host told the page its crossing. A begin over an unlanded one starts again. */
  begin(): void;
  /** The page is laid out at its end size. */
  markSolved(facts: BodySolveFacts): void;
  /** The host's track ended; the tail reads two more ticks and records. */
  land(): void;
}

/** The median gap between ticks; the fallback period with fewer than two. */
export function periodOf(ticks: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < ticks.length; i++) gaps.push(ticks[i] - ticks[i - 1]);
  if (gaps.length === 0) return FALLBACK_PERIOD_MS;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

export function createBodyLand(deps: BodyLandDeps): BodyLand {
  let armed = false;
  let beginAt = 0;
  let solveAt: number | null = null;
  let foldLanded: boolean | null = null;
  let resizeMissed: boolean | null = null;
  let snapshotMs: number | null = null;
  let landAt: number | null = null;
  let landWallMs = 0;
  let afterLand = 0;
  let ticks: number[] = [];
  let raf: number | null = null;

  const stop = (): void => {
    if (raf !== null) deps.cancelRaf(raf);
    raf = null;
    armed = false;
    deps.recorder.disarm();
  };

  const finish = (): void => {
    const at = landAt ?? deps.now();
    // The period from the ticks before the land: the land's own gaps are
    // the ones being measured, and would read a slow land as a slow display.
    const period = periodOf(ticks.filter((t) => t < at));
    const reading = classifyLand({
      ticks,
      landAt: at,
      gestureAt: beginAt,
      framePeriodMs: period,
      ...deps.recorder.take(ticks[0] ?? beginAt),
    });
    const motionFrom = solveAt ?? beginAt;
    const motion = classifyMotionEvents(deps.recorder.take(motionFrom), motionFrom, landOpensAt(ticks, at));
    const row: BodyLandRow = {
      cardId: deps.cardId(),
      planId: null,
      solveMs: solveAt === null ? null : solveAt - beginAt,
      snapshotMs,
      foldLanded,
      resizeMissed,
      landWallMs,
      frameMs: reading.frameMs,
      frameFrames: reading.frameFrames,
      gapsMs: reading.gapsMs,
      framePeriodMs: period,
      commits: reading.commits,
      forcedLayouts: reading.forcedLayouts,
      deliveries: reading.deliveries,
      episodeEnds: reading.episodeEnds,
      scrollWrites: reading.scrollWrites,
      motionCommits: motion.commits,
      motionScrollWrites: motion.scrollWrites,
    };
    stop();
    deps.record(row);
  };

  const tick = (): void => {
    raf = null;
    if (!armed) return;
    ticks.push(deps.now());
    if (landAt !== null) afterLand += 1;
    if (afterLand >= 2 || ticks.length >= BODY_LAND_TICK_CAP) {
      finish();
      return;
    }
    raf = deps.raf(tick);
  };

  return {
    begin() {
      if (armed) stop();
      if (!deps.enabled()) return;
      armed = true;
      beginAt = deps.now();
      solveAt = null;
      foldLanded = null;
      resizeMissed = null;
      snapshotMs = null;
      landAt = null;
      afterLand = 0;
      ticks = [];
      deps.recorder.arm();
      raf = deps.raf(tick);
    },
    markSolved(facts) {
      if (!armed || solveAt !== null) return;
      solveAt = deps.now();
      foldLanded = facts.foldLanded;
      resizeMissed = facts.resizeMissed;
      snapshotMs = facts.snapshotMs ?? null;
    },
    land() {
      if (!armed || landAt !== null) return;
      landAt = deps.now();
      landWallMs = deps.wallNow();
    },
  };
}
