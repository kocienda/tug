/**
 * The body land's record, read over a stepped clock: when its tail closes,
 * what it says of a crossing that never solved, and which events are the
 * land's and which the motion's.
 */

import { describe, expect, test } from "bun:test";

import { createBodyLand, periodOf, type BodyLandRow } from "../body-land";
import type { LandEvent } from "../../lib/land-frame-record";

/** A page whose clock and frames advance by hand. */
function page(options: { enabled?: boolean; scrollWrites?: LandEvent[]; episodeEnds?: LandEvent[] } = {}) {
  let t = 0;
  const frames: (() => void)[] = [];
  const rows: BodyLandRow[] = [];
  const land = createBodyLand({
    cardId: () => "card-a",
    enabled: () => options.enabled ?? true,
    now: () => t,
    wallNow: () => 1_000_000 + t,
    raf: (cb) => frames.push(cb),
    cancelRaf: () => {
      frames.length = 0;
    },
    recorder: {
      arm() {},
      disarm() {},
      take: () => ({
        commits: [],
        forcedReads: [],
        deliveries: [],
        episodeEnds: options.episodeEnds ?? [],
        scrollWrites: options.scrollWrites ?? [],
      }),
    },
    record: (row) => rows.push(row),
  });
  return {
    land,
    rows,
    at(ms: number) {
      t = ms;
    },
    /** Run the pending frame callback at `ms`. */
    frame(ms: number) {
      t = ms;
      const cb = frames.shift();
      cb?.();
    },
    pending: () => frames.length,
  };
}

describe("createBodyLand", () => {
  test("the tail closes two ticks after the land, and not before", () => {
    const p = page();
    p.at(0);
    p.land.begin();
    p.frame(16.7);
    p.frame(33.3);
    p.at(40);
    p.land.land();
    p.frame(50);
    expect(p.rows).toEqual([]);
    p.frame(66.7);
    expect(p.rows.length).toBe(1);
    expect(p.pending()).toBe(0);
    const row = p.rows[0];
    expect(row.cardId).toBe("card-a");
    expect(row.landWallMs).toBe(1_000_040);
    expect(row.gapsMs.map((g) => Math.round(g * 10) / 10)).toEqual([16.7, 16.7]);
    expect(Math.round(row.framePeriodMs * 10) / 10).toBe(16.6);
  });

  test("solveMs is null when the page never said it was solved", () => {
    const p = page();
    p.land.begin();
    p.frame(16.7);
    p.at(20);
    p.land.land();
    p.frame(33.3);
    p.frame(50);
    expect(p.rows[0].solveMs).toBeNull();
    expect(p.rows[0].foldLanded).toBeNull();
    expect(p.rows[0].snapshotMs).toBeNull();
    expect(p.rows[0].resizeMissed).toBeNull();
  });

  test("a solved crossing carries its solve, and the motion is read from it", () => {
    const p = page({
      scrollWrites: [
        { t: 10, ms: 0.1, site: "the solve's restore" },
        { t: 30, ms: 0.1, site: "mid-motion" },
      ],
    });
    p.land.begin();
    p.frame(16.7);
    p.at(20);
    p.land.markSolved({ foldLanded: true, resizeMissed: false, snapshotMs: 12 });
    p.frame(33.3);
    p.at(40);
    p.land.land();
    p.frame(50);
    p.frame(66.7);
    const row = p.rows[0];
    expect(row.solveMs).toBe(20);
    expect(row.foldLanded).toBe(true);
    expect(row.snapshotMs).toBe(12);
    expect(row.resizeMissed).toBe(false);
    expect(row.motionScrollWrites.map((e) => e.site)).toEqual(["mid-motion"]);
  });

  test("an episode ended in the land's task is the land's", () => {
    const p = page({ episodeEnds: [{ t: 40.1, ms: 0, site: "episode ×1" }] });
    p.land.begin();
    p.frame(16.7);
    p.frame(33.3);
    p.at(40);
    p.land.land();
    p.frame(50);
    p.frame(66.7);
    expect(p.rows[0].episodeEnds.map((e) => e.site)).toEqual(["episode ×1"]);
  });

  test("a page nobody is measuring arms nothing and records nothing", () => {
    const p = page({ enabled: false });
    p.land.begin();
    expect(p.pending()).toBe(0);
    p.land.land();
    expect(p.rows).toEqual([]);
  });
});

describe("periodOf", () => {
  test("the median gap, and the fallback with too few ticks", () => {
    expect(periodOf([0, 8.3, 16.7, 25, 60])).toBeCloseTo(8.4, 1);
    expect(periodOf([5])).toBeCloseTo(16.67, 1);
  });
});
