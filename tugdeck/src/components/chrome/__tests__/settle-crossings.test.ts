/**
 * settle-crossings.test.ts — the crossing record's bookkeeping: which marks
 * each exit ends, by which door, under which id.
 *
 * The doors are fakes that keep the marks in a map, since `bun test` has no
 * DOM to write them on. What the real doors do to a frame is gated in the
 * app, by `at0689-retarget-ends-crossings.test.ts` and
 * `at0698-settle-drop-mid-flight.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { SettleCrossings, type CrossingDoors } from "../settle-crossings";

interface Marks {
  fold: number | null;
  still: number | null;
}

function fakeDoors() {
  const marks = new Map<HTMLElement, Marks>();
  const ended: string[] = [];
  const of = (frame: HTMLElement): Marks => {
    let m = marks.get(frame);
    if (m === undefined) {
      m = { fold: null, still: null };
      marks.set(frame, m);
    }
    return m;
  };
  // The real doors' rules: a fold's end takes the still mark with it, and an
  // id that does not match the standing mark ends nothing.
  const doors: CrossingDoors = {
    endFold(frame, id) {
      const m = of(frame);
      if (m.fold === null || (id !== undefined && m.fold !== id)) return;
      m.fold = null;
      m.still = null;
      ended.push("fold");
    },
    endStill(frame, id) {
      const m = of(frame);
      if (m.still === null || (id !== undefined && m.still !== id)) return;
      m.still = null;
      ended.push("still");
    },
    foldStanding: (frame) => of(frame).fold !== null,
  };
  const mark = (frame: HTMLElement, fold: number | null, still: number | null) => {
    marks.set(frame, { fold, still });
  };
  return { doors, of, mark, ended };
}

const frame = (): HTMLElement => ({}) as HTMLElement;

describe("SettleCrossings", () => {
  test("a frame arm held and no Last pass carried is ended when the pass closes", () => {
    const { doors, of, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    mark(a, null, 1);
    crossings.hold(a, "still");
    crossings.closePass();
    expect(of(a)).toEqual({ fold: null, still: null });
    expect(crossings.size).toEqual({ handed: 0, live: 0 });
  });

  test("a carried frame stays held, and its completion ends it by id", () => {
    const { doors, of, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    mark(a, null, 1);
    crossings.hold(a, "still");
    mark(a, null, 2);
    crossings.carry(a, { fold: null, still: 2 });
    crossings.closePass();
    expect(of(a).still).toBe(2);
    crossings.end(a, { fold: null, still: 2 });
    expect(of(a).still).toBeNull();
    expect(crossings.size).toEqual({ handed: 0, live: 0 });
  });

  test("a late completion under a stale id does not end the replacement's crossing", () => {
    const { doors, of, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    mark(a, 3, 3);
    crossings.carry(a, { fold: 3, still: 3 });
    crossings.retake(a);
    mark(a, 4, 4);
    crossings.carry(a, { fold: 4, still: 4 });
    crossings.end(a, { fold: 3, still: 3 });
    expect(of(a)).toEqual({ fold: 4, still: 4 });
    expect(crossings.size.live).toBe(1);
  });

  test("a retaken frame the next pass does not carry loses both marks", () => {
    const { doors, of, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    mark(a, 5, 5);
    crossings.carry(a, { fold: 5, still: 5 });
    crossings.retake(a);
    crossings.closePass();
    expect(of(a)).toEqual({ fold: null, still: null });
  });

  test("a retaken still crossing with no fold is ended by the still door", () => {
    const { doors, of, mark, ended } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    mark(a, null, 6);
    crossings.retake(a);
    crossings.closePass();
    expect(of(a).still).toBeNull();
    expect(ended).toEqual(["still"]);
  });

  test("an arm hold not predicted again is ended by the next arm, by its own door", () => {
    const { doors, of, mark, ended } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    const b = frame();
    mark(a, 7, 7);
    mark(b, null, 8);
    crossings.hold(a, "fold");
    crossings.hold(b, "still");
    const finish = crossings.beginArm();
    crossings.hold(b, "still");
    finish();
    expect(of(a)).toEqual({ fold: null, still: null });
    expect(of(b).still).toBe(8);
    expect(ended).toEqual(["fold"]);
  });

  test("a stale arm hold on a retaken frame keeps the retake's claim", () => {
    const { doors, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    mark(a, null, 9);
    crossings.retake(a);
    crossings.hold(a, "still");
    crossings.beginArm()();
    expect(crossings.size.handed).toBe(1);
  });

  test("a frame carried by its still alone yields a standing fold before it is marked", () => {
    const { doors, of, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    mark(a, 10, 10);
    crossings.retake(a);
    expect(crossings.yieldFold(a)).toBe(true);
    expect(of(a)).toEqual({ fold: null, still: null });
    mark(a, null, 11);
    crossings.carry(a, { fold: null, still: 11 });
    crossings.closePass();
    expect(of(a)).toEqual({ fold: null, still: 11 });
    expect(crossings.yieldFold(a)).toBe(false);
  });

  test("the sweep and the unmount end every handed and live mark, unguarded", () => {
    const { doors, of, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const live = frame();
    const handed = frame();
    mark(live, 12, 12);
    mark(handed, null, 13);
    crossings.carry(live, { fold: 12, still: 12 });
    crossings.hold(handed, "still");
    crossings.endAll();
    expect(of(live)).toEqual({ fold: null, still: null });
    expect(of(handed)).toEqual({ fold: null, still: null });
    expect(crossings.size).toEqual({ handed: 0, live: 0 });
  });

  test("the early returns end handed marks and leave a running settle's own", () => {
    const { doors, of, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const running = frame();
    const handed = frame();
    mark(running, null, 14);
    mark(handed, null, 15);
    crossings.carry(running, { fold: null, still: 14 });
    crossings.hold(handed, "still");
    crossings.closePass();
    expect(of(running).still).toBe(14);
    expect(of(handed).still).toBeNull();
  });

  test("a pointer gesture's take ends every mark and forgets the frame", () => {
    const { doors, of, mark } = fakeDoors();
    const crossings = new SettleCrossings(doors);
    const a = frame();
    mark(a, 16, 16);
    crossings.carry(a, { fold: 16, still: 16 });
    crossings.release(a);
    expect(of(a)).toEqual({ fold: null, still: null });
    expect(crossings.size).toEqual({ handed: 0, live: 0 });
  });
});
