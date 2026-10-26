/**
 * _scene.test.ts — a scene's timeline runs on schedule, and its crop is the
 * arithmetic every driver used to do by hand.
 *
 * The timeline is run over a fake clock, so the test reads what the
 * scheduler asked for and never the machine's own time. The crop cases are
 * rects recorded off a one-up Session card at 760×1000 in a 1200×1100
 * window, with the status bar where the card's body puts it.
 */

import { describe, expect, test } from "bun:test";

import { cropAround, cropRect, runTimeline, timelineSpan, type TimelineClock, type TimelineEntry } from "./_scene";

/** A clock that only moves when something sleeps on it, or when a test moves it. */
function fakeClock(): TimelineClock & { t: number; sleeps: number[] } {
  const clock = {
    t: 0,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

describe("a scene's timeline", () => {
  test("spans to its last entry, and an empty one spans nothing", () => {
    expect(timelineSpan([])).toBe(0);
    expect(timelineSpan([{ at: 500, kind: "mark", name: "a" }, { at: 9_400, kind: "act", act: async () => {} }, { at: 1_000, kind: "mark", name: "b" }])).toBe(9_400);
  });

  test("fires each entry at its time, in order, marks included", async () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const entries: TimelineEntry[] = [
      { at: 1_000, kind: "act", act: async () => { fired.push(`act@${clock.t}`); } },
      { at: 1_000, kind: "mark", name: "loop-start" },
      { at: 2_500, kind: "act", act: async () => { fired.push(`act@${clock.t}`); } },
      { at: 0, kind: "mark", name: "open" },
      { at: 4_000, kind: "mark", name: "loop-end" },
    ];
    await runTimeline(entries, clock, async (name) => { fired.push(`${name}@${clock.t}`); });
    expect(fired).toEqual(["open@0", "act@1000", "loop-start@1000", "act@2500", "loop-end@4000"]);
    expect(clock.sleeps).toEqual([1_000, 1_500, 1_500]);
  });

  test("schedules from the clock at the call, not from zero", async () => {
    const clock = fakeClock();
    clock.t = 7_000;
    const at: number[] = [];
    await runTimeline([{ at: 300, kind: "act", act: async () => { at.push(clock.t); } }], clock, async () => {});
    expect(at).toEqual([7_300]);
  });

  test("an act that overruns pushes the next entry, which fires at once", async () => {
    const clock = fakeClock();
    const fired: string[] = [];
    await runTimeline(
      [
        { at: 100, kind: "act", act: async () => { clock.t += 900; fired.push(`slow@${clock.t}`); } },
        { at: 500, kind: "mark", name: "pushed" },
        { at: 2_000, kind: "mark", name: "on-time" },
      ],
      clock,
      async (name) => { fired.push(`${name}@${clock.t}`); },
    );
    expect(fired).toEqual(["slow@1000", "pushed@1000", "on-time@2000"]);
    expect(clock.sleeps).toEqual([100, 1_000]);
  });
});

/** A one-up Session card at 760×1000 in a 1200×1100 window. */
const CONTENT = { width: 1200, height: 1100 };
const CARD = { x: 40, y: 40, width: 760, height: 1000 };
/** The status bar's rect in content points, as `elementRect` answers it: the card's view plus the bar's rect in the body. */
const STATUS_BAR = { x: 40, y: 40 + 802.5, width: 760, height: 28 };

describe("a scene's crop", () => {
  test("around a card is the card padded, kept inside the content", () => {
    expect(cropAround([CARD], 12, CONTENT)).toEqual({ x: 28, y: 28, width: 784, height: 1024 });
    expect(cropAround([CARD], 60, CONTENT)).toEqual({ x: 0, y: 0, width: 860, height: 1100 });
    expect(cropAround([{ x: 10.4, y: 10.6, width: 100.2, height: 50.9 }], 0, CONTENT)).toEqual({ x: 10, y: 10, width: 101, height: 52 });
  });

  test("ending at the status bar stops at the bar's bottom edge, as the drivers computed it", () => {
    const byHand = cropAround([{ x: CARD.x, y: CARD.y, width: CARD.width, height: STATUS_BAR.y + STATUS_BAR.height - CARD.y }], 12, CONTENT);
    expect(cropRect([CARD], { end: STATUS_BAR }, 12, CONTENT)).toEqual(byHand);
    expect(byHand).toEqual({ x: 28, y: 28, width: 784, height: 855 });
  });

  test("starting at a block starts at the block's top edge, as the drivers computed it", () => {
    const first = { x: 64, y: 40 + 210.25, width: 712, height: 36 };
    const top = first.y - 20;
    const byHand = cropAround([{ x: CARD.x, y: top, width: CARD.width, height: STATUS_BAR.y + STATUS_BAR.height - top }], 12, CONTENT);
    expect(cropRect([CARD], { start: { ...first, y: top }, end: STATUS_BAR }, 12, CONTENT)).toEqual(byHand);
    expect(byHand).toEqual({ x: 28, y: 218, width: 784, height: 665 });
  });

  test("with no end is the cards' own union", () => {
    const second = { x: 820, y: 40, width: 340, height: 1000 };
    expect(cropRect([CARD, second], {}, 24, CONTENT)).toEqual(cropAround([CARD, second], 24, CONTENT));
    expect(cropRect([CARD, second], {}, 24, CONTENT)).toEqual({ x: 16, y: 16, width: 1168, height: 1048 });
  });

  test("an end below a card leaves that card's own bottom", () => {
    const short = { x: 40, y: 40, width: 760, height: 300 };
    expect(cropRect([short], { end: STATUS_BAR }, 0, CONTENT)).toEqual({ x: 40, y: 40, width: 760, height: 300 });
  });

  test("refuses no cards and an end above the start", () => {
    expect(() => cropRect([], {}, 0, CONTENT)).toThrow("at least one card");
    expect(() => cropRect([CARD], { end: { x: 40, y: 10, width: 760, height: 20 } }, 0, CONTENT)).toThrow("above its start");
    expect(() => cropRect([CARD], { start: { x: 40, y: 900, width: 760, height: 20 }, end: STATUS_BAR }, 0, CONTENT)).toThrow("above its start");
  });
});
