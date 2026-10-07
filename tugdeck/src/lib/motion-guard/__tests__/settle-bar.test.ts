/**
 * settle-bar.test.ts — the one bar both of its readers consult.
 *
 * These are the clauses the app-test fixture asserts and the verb prints, so
 * a case here is a case both of them read the same way.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SETTLE_BARS,
  GAP_FRAMES_BAR,
  LAND_FRAMES_BAR,
  arrivedIn,
  bandShrinks,
  settleBarsFor,
  settleLegOfDrive,
  settleVerdict,
  settleVerdictOfDrive,
  type SettleBarFrames,
  type SettleBarLand,
  type SettleClause,
} from "../settle-bar";

const cleanRow = (over: Partial<SettleBarFrames> = {}): SettleBarFrames => ({
  motionLongestGapMs: 22,
  motionLongestGapFrames: 1.29,
  offCurvePaneIds: [],
  offCurveTicks: 0,
  motionAtMs: 218,
  motionCommits: [],
  motionDeliveries: [],
  motionForcedLayouts: [{ ms: 2, site: "[bench probe]" }],
  firstPaintDelayMs: 76,
  ...over,
});

const land = (frameMs: number, frameFrames: number): SettleBarLand => ({ frameMs, frameFrames });

const SAME = "p1@0,0+800x600";

function clause(clauses: readonly SettleClause[], name: SettleClause["name"]): SettleClause {
  const c = clauses.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no ${name} clause`);
  return c;
}

const read = (
  frames: SettleBarFrames,
  l: SettleBarLand | null = land(17, 1),
  before = SAME,
  after = SAME,
  options: Parameters<typeof settleVerdict>[1] = {},
) => settleVerdict({ frames, land: l, before, after }, options);

describe("settle bar", () => {
  test("a clean settle passes every clause, with the lead noted", () => {
    const v = read(cleanRow());
    expect(v.clauses.map((c) => c.pass)).toEqual([true, true, true, true]);
    expect(v.leadMs).toBe(76);
  });

  test("a long motion gap is red", () => {
    const g = clause(read(cleanRow({ motionLongestGapFrames: 2.4 })).clauses, "gap");
    expect(g.pass).toBe(false);
  });

  test("a commit that performed work inside the motion is red and an empty one is not", () => {
    expect(clause(read(cleanRow({ motionCommits: [{ performed: 0, site: "root" }] })).clauses, "sealed").pass).toBe(true);
    const s = clause(read(cleanRow({ motionCommits: [{ performed: 12, site: "TugPane" }] })).clauses, "sealed");
    expect(s.pass).toBe(false);
    expect(s.detail).toContain("TugPane");
  });

  test("the bench probe read is carved out and any other forced layout is not", () => {
    expect(clause(read(cleanRow()).clauses, "sealed").pass).toBe(true);
    const s = clause(
      read(cleanRow({ motionForcedLayouts: [{ ms: 3, site: "_placeRunHeight" }] })).clauses,
      "sealed",
    );
    expect(s.pass).toBe(false);
  });

  test("a census the page did not have is not counted rather than green", () => {
    const s = clause(read(cleanRow({ motionCommits: null })).clauses, "sealed");
    expect(s.pass).toBeNull();
    expect(s.detail).toContain("commits not counted");
  });

  test("the swipe's commits are carved out by gesture, and nothing else is", () => {
    const row = cleanRow({ motionCommits: [{ performed: 12, site: "Strip" }] });
    const s = clause(read(row, land(17, 1), SAME, SAME, { gesture: "swipe" }).clauses, "sealed");
    expect(s.pass).toBe(true);
    expect(s.detail).toContain("carved out");
    const forced = cleanRow({
      motionCommits: [{ performed: 12, site: "Strip" }],
      motionForcedLayouts: [{ ms: 3, site: "x" }],
    });
    expect(clause(read(forced, land(17, 1), SAME, SAME, { gesture: "swipe" }).clauses, "sealed").pass).toBe(false);
  });

  test("a long land is red unless the gesture shrinks a frame", () => {
    expect(clause(read(cleanRow(), land(32, 1.9)).clauses, "land").pass).toBe(false);
    const shrunk = clause(read(cleanRow(), land(32, 1.9), SAME, "p1@0,0+800x300").clauses, "land");
    expect(shrunk.pass).toBe(true);
    expect(shrunk.detail).toContain("by ruling");
  });

  test("no land, no frame after the land, and no gate are red rather than passes by absence", () => {
    expect(clause(read(cleanRow(), null).clauses, "land").pass).toBe(false);
    expect(clause(read(cleanRow(), land(-1, 1)).clauses, "land").pass).toBe(false);
    expect(clause(read(cleanRow({ motionAtMs: -1 })).clauses, "sealed").pass).toBe(false);
  });

  test("the two re-budgeted legs carry their own bar", () => {
    expect(settleBarsFor()).toEqual(DEFAULT_SETTLE_BARS);
    expect(settleBarsFor("sidebar-show")).toEqual({ gapFrames: GAP_FRAMES_BAR, landFrames: 2.0 });
    expect(settleBarsFor("fit")).toEqual({ gapFrames: 2.5, landFrames: LAND_FRAMES_BAR });
    expect(settleLegOfDrive("sidebar", { open: true })).toBe("sidebar-show");
    expect(settleLegOfDrive("sidebar", { open: false })).toBeUndefined();
    expect(settleLegOfDrive("fit", {})).toBe("fit");
    expect(settleLegOfDrive("split", {})).toBeUndefined();

    // The show's 1.9-frame land is green on its bar and red on the default.
    const showBars = { bars: settleBarsFor("sidebar-show") };
    expect(clause(read(cleanRow(), land(32, 1.9), SAME, SAME, showBars).clauses, "land").pass).toBe(true);
    expect(clause(read(cleanRow(), land(32, 1.9)).clauses, "land").pass).toBe(false);
    // Resize-to-fit's 2.2-frame gap likewise.
    const row = cleanRow({ motionLongestGapFrames: 2.2 });
    const fit = clause(read(row, land(17, 1), SAME, SAME, { bars: settleBarsFor("fit") }).clauses, "gap");
    expect(fit.pass).toBe(true);
    expect(fit.detail).toContain("against 2.5");
    expect(clause(read(row).clauses, "gap").pass).toBe(false);
  });

  test("bandShrinks reads a frame that got smaller on either axis", () => {
    expect(bandShrinks("p1@0,0+800x600", "p1@0,0+800x300")).toBe(true);
    expect(bandShrinks("p1@0,0+800x600", "p1@0,0+400x600")).toBe(true);
    expect(bandShrinks("p1@0,0+800x300", "p1@0,0+800x600")).toBe(false);
    // A frame that arrived or left is not a shrink.
    expect(bandShrinks("p1@0,0+800x600", "p2@0,0+10x10")).toBe(false);
  });

  test("arrivedIn reads the panes standing after that were not standing before", () => {
    expect(arrivedIn("p1@0,0+800x600", "p1@0,0+600x600 rail@600,0+200x600")).toEqual(["rail"]);
    expect(arrivedIn("p1@0,0+800x600 rail@600,0+200x600", "p1@0,0+800x600")).toEqual([]);
    expect(arrivedIn("p1@0,0+800x600", "p1@0,0+400x600")).toEqual([]);
  });

  test("a show's off-curve ticks on the arriving pane are exempt, and nobody else's", () => {
    const after = "p1@0,0+600x600 rail@600,0+200x600";
    const exempt = clause(read(cleanRow({ offCurvePaneIds: ["rail"], offCurveTicks: 24 }), land(17, 1), SAME, after).clauses, "off-curve");
    expect(exempt.pass).toBe(true);
    expect(exempt.detail).toContain("rail exempt");
    const standing = clause(
      read(cleanRow({ offCurvePaneIds: ["rail", "p1"], offCurveTicks: 24 }), land(17, 1), SAME, after).clauses,
      "off-curve",
    );
    expect(standing.pass).toBe(false);
    expect(standing.detail).toContain("on p1;");
  });

  test("a gesture with no arrivals exempts nobody", () => {
    const c = clause(
      read(
        cleanRow({ offCurvePaneIds: ["rail"], offCurveTicks: 24 }),
        land(17, 1),
        "p1@0,0+800x600 rail@800,0+200x600",
        "p1@0,0+600x600 rail@600,0+200x600",
      ).clauses,
      "off-curve",
    );
    expect(c.pass).toBe(false);
    expect(c.detail).not.toContain("exempt");
  });

  test("the verb's verdict reads the drive's last rows against the drive's leg, and null with no row", () => {
    expect(settleVerdictOfDrive({ frames: [], lands: [], before: SAME, after: SAME })).toBeNull();
    const engine = {
      frames: [cleanRow({ motionLongestGapFrames: 9 }), cleanRow({ motionLongestGapFrames: 2.2 })],
      lands: [land(17, 1)],
      before: SAME,
      after: SAME,
    };
    const fit = settleVerdictOfDrive(engine, "fit", {});
    expect(fit === null ? null : clause(fit.clauses, "gap").pass).toBe(true);
    const split = settleVerdictOfDrive(engine, "split", {});
    expect(split === null ? null : clause(split.clauses, "gap").pass).toBe(false);
  });
});
