/**
 * `classifyLand` — the land's frame, read off the ticks around it, and the
 * events that belong to it.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyLand,
  classifyMotionEvents,
  landOpensAt,
  type LandInput,
} from "../land-frame-record";

const PERIOD = 1000 / 60;

function input(overrides: Partial<LandInput>): LandInput {
  return {
    ticks: [],
    landAt: 0,
    gestureAt: 0,
    framePeriodMs: PERIOD,
    commits: [],
    forcedReads: [],
    deliveries: [],
    ...overrides,
  };
}

describe("classifyLand", () => {
  test("a land of one frame reads its two gaps at the display's period", () => {
    const r = classifyLand(
      input({ ticks: [100, 116.7, 133.3, 150, 166.7], landAt: 140, gestureAt: 20 }),
    );
    expect(r.gapsMs.map((g) => Math.round(g * 10) / 10)).toEqual([16.7, 16.7]);
    expect(Math.round(r.frameMs * 10) / 10).toBe(16.7);
    expect(Math.round(r.frameFrames * 100) / 100).toBe(1);
    expect(r.landAtMs).toBe(120);
  });

  test("the land's cost shows in the SECOND gap, where its layout is paid", () => {
    // The first tick after the land runs ahead of the layout the hand-back
    // dirtied; the frame that pays for it ends at the second.
    const r = classifyLand(input({ ticks: [100, 116.7, 120, 165], landAt: 118 }));
    expect(r.gapsMs.map((g) => Math.round(g * 10) / 10)).toEqual([3.3, 45]);
    expect(r.frameMs).toBe(45);
  });

  test("events inside the span are the land's, and only those", () => {
    const r = classifyLand(
      input({
        ticks: [100, 116.7, 133.3, 150],
        landAt: 120,
        commits: [
          { t: 110, performed: 5, site: "before" },
          { t: 121, performed: 40, site: "TugPaneImpl" },
          { t: 151, performed: 2, site: "after" },
        ],
        forcedReads: [
          { t: 116.7, ms: 2, site: "at the opening tick" },
          { t: 125, ms: 30, site: "_placeRunHeight" },
        ],
        deliveries: [{ t: 140, ms: 4, site: "div.tug-list-view ×1" }],
      }),
    );
    expect(r.commits?.map((c) => c.site)).toEqual(["TugPaneImpl"]);
    expect(r.forcedLayouts.map((e) => e.site)).toEqual(["_placeRunHeight"]);
    expect(r.deliveries?.map((e) => e.site)).toEqual(["div.tug-list-view ×1"]);
  });

  test("a page that cannot count says null, not zero", () => {
    const r = classifyLand(
      input({ ticks: [100, 120, 140], landAt: 110, commits: null, deliveries: null }),
    );
    expect(r.commits).toBeNull();
    expect(r.deliveries).toBeNull();
    expect(r.forcedLayouts).toEqual([]);
  });

  test("a land no tick followed has no frame to report", () => {
    const r = classifyLand(input({ ticks: [100, 116.7], landAt: 120 }));
    expect(r.frameMs).toBe(-1);
    expect(r.frameFrames).toBe(-1);
    expect(r.gapsMs).toEqual([]);
  });

  test("a land with one tick after reads the one gap it has", () => {
    const r = classifyLand(input({ ticks: [100, 116.7, 140], landAt: 120 }));
    expect(Math.round(r.frameMs * 10) / 10).toBe(23.3);
  });

  test("a land before any tick opens its span at the land itself", () => {
    const r = classifyLand(
      input({
        ticks: [130, 146.7],
        landAt: 120,
        forcedReads: [{ t: 119, ms: 5, site: "before the land" }],
      }),
    );
    expect(r.gapsMs.map((g) => Math.round(g * 10) / 10)).toEqual([10, 16.7]);
    expect(r.forcedLayouts).toEqual([]);
  });

  test("nothing shed late reads two gaps and no shed", () => {
    const r = classifyLand(input({ ticks: [100, 116.7, 133.3, 150], landAt: 110 }));
    expect(r.gapsMs.length).toBe(2);
    expect(r.shedAtMs).toBeNull();
  });

  test("a mark shed after the land reads on to two ticks past the shed", () => {
    // The hand-back's last mark came off two frames after the land, and its
    // cost lands in the frame after that: the record has to reach it.
    const r = classifyLand(
      input({
        ticks: [100, 116.7, 133.3, 150, 190, 206.7, 223.3],
        landAt: 110,
        shedAt: 150.001,
        gestureAt: 10,
        forcedReads: [{ t: 160, ms: 25, site: "the late mark-off" }],
      }),
    );
    expect(r.gapsMs.map((g) => Math.round(g * 10) / 10)).toEqual([16.7, 16.6, 16.7, 40, 16.7]);
    expect(r.frameMs).toBe(40);
    expect(Math.round(r.shedAtMs! * 1000) / 1000).toBe(140.001);
    expect(r.forcedLayouts.map((e) => e.site)).toEqual(["the late mark-off"]);
  });

  test("a shed at or before the land changes nothing", () => {
    const plain = classifyLand(input({ ticks: [100, 116.7, 133.3, 150], landAt: 110 }));
    const early = classifyLand(
      input({ ticks: [100, 116.7, 133.3, 150], landAt: 110, shedAt: 105 }),
    );
    expect(early.gapsMs).toEqual(plain.gapsMs);
  });
});

describe("landOpensAt", () => {
  test("the land opens at the last tick before it", () => {
    expect(landOpensAt([100, 116.7, 133.3, 150], 140)).toBe(133.3);
  });

  test("a land with no tick before it opens at the land", () => {
    expect(landOpensAt([150, 166.7], 140)).toBe(140);
  });
});

describe("classifyMotionEvents", () => {
  test("only what began between the beats' launch and the land is the motion's", () => {
    const r = classifyMotionEvents(
      {
        commits: [
          { t: 90, performed: 900, site: "the set-up's commit" },
          { t: 130, performed: 12, site: "SessionCard" },
          { t: 210, performed: 3, site: "after the land" },
        ],
        forcedReads: [
          { t: 99, ms: 40, site: "_placeRunHeight" },
          { t: 150, ms: 6, site: "pinToBottom" },
        ],
        deliveries: [{ t: 200, ms: 2, site: "div.tug-list-view ×1" }],
      },
      100,
      200,
    );
    expect(r.commits?.map((c) => c.site)).toEqual(["SessionCard"]);
    expect(r.forcedLayouts.map((e) => e.site)).toEqual(["pinToBottom"]);
    expect(r.deliveries?.map((e) => e.site)).toEqual(["div.tug-list-view ×1"]);
  });

  test("the hand-back's flush is the land's, not the motion's", () => {
    // The completion's own forced read lands after the last tick before the
    // land: it is in the `settle-land` row, and reading it here as well
    // would bar one event twice.
    const ticks = [100, 116.7, 133.3, 150];
    const r = classifyMotionEvents(
      {
        commits: [],
        forcedReads: [
          { t: 120, ms: 3, site: "onScrollChanged" },
          { t: 151, ms: 2, site: "endSettleMarks" },
        ],
        deliveries: [],
      },
      100,
      landOpensAt(ticks, 152),
    );
    expect(r.forcedLayouts.map((e) => e.site)).toEqual(["onScrollChanged"]);
  });

  test("a page that cannot count says null, not zero", () => {
    const r = classifyMotionEvents({ commits: null, forcedReads: [], deliveries: null }, 0, 100);
    expect(r.commits).toBeNull();
    expect(r.deliveries).toBeNull();
  });
});
