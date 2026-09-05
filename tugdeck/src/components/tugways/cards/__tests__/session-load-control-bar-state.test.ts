/**
 * session-load-control-bar-state — pure state-machine tests for the Z0 load
 * control bar ([recency P09]).
 */

import { describe, expect, test } from "bun:test";

import {
  countClaudeTurns,
  deriveControlBarState,
  deriveLoadStatus,
} from "../session-load-control-bar-state";
import { restoreBarValueMax } from "../session-load-control-bar";

describe("restoreBarValueMax — turns committed of turns requested", () => {
  test("streaming: fills toward the requested window, clamped", () => {
    // Mid-load: 7 of 25 turns committed so far.
    expect(restoreBarValueMax(7, 25, true)).toEqual({ value: 7, max: 25 });
    // A burst can't overshoot the requested max.
    expect(restoreBarValueMax(30, 25, true)).toEqual({ value: 25, max: 25 });
  });

  test("landed: settles to the turns actually committed (short session)", () => {
    // A 3-turn session requested 25 → settles to "3 of 3", not "25 of 25".
    expect(restoreBarValueMax(3, 25, false)).toEqual({ value: 3, max: 3 });
  });

  test("landed: a full window reports the requested count", () => {
    expect(restoreBarValueMax(25, 25, false)).toEqual({ value: 25, max: 25 });
  });

  test("landed: never below 1 (an empty load still shows a unit bar)", () => {
    expect(restoreBarValueMax(0, 25, false)).toEqual({ value: 1, max: 1 });
  });
});

describe("deriveControlBarState", () => {
  test("loadingDisplay → loading", () => {
    expect(deriveControlBarState({ loadingDisplay: true })).toEqual({
      kind: "loading",
    });
  });

  test("not loading → metadata (the resting content)", () => {
    expect(deriveControlBarState({ loadingDisplay: false })).toEqual({
      kind: "metadata",
    });
  });
});

describe("deriveLoadStatus — metadata row turns math", () => {
  test("windowed slice with older turns remaining", () => {
    // 3 displayed of a 40-turn session; oldest loaded turn is index 37.
    expect(
      deriveLoadStatus({
        claudeTurnsDisplayed: 3,
        firstLoadedTurnIndex: 37,
        totalTurns: 40,
        step: 25,
      }),
    ).toEqual({ displayed: 3, total: 40, hasOlder: true, loadStep: 25 });
  });

  test("load step clamps to the older count when fewer than the page", () => {
    expect(
      deriveLoadStatus({
        claudeTurnsDisplayed: 35,
        firstLoadedTurnIndex: 5,
        totalTurns: 40,
        step: 25,
      }),
    ).toEqual({ displayed: 35, total: 40, hasOlder: true, loadStep: 5 });
  });

  test("full (non-windowed) load: displayed == total, all loaded", () => {
    // No window: firstLoadedTurnIndex / totalTurns null → derive from length.
    expect(
      deriveLoadStatus({
        claudeTurnsDisplayed: 12,
        firstLoadedTurnIndex: null,
        totalTurns: null,
        step: 25,
      }),
    ).toEqual({ displayed: 12, total: 12, hasOlder: false, loadStep: 0 });
  });

  test("windowed but whole session fits: all loaded", () => {
    expect(
      deriveLoadStatus({
        claudeTurnsDisplayed: 40,
        firstLoadedTurnIndex: 0,
        totalTurns: 40,
        step: 25,
      }),
    ).toEqual({ displayed: 40, total: 40, hasOlder: false, loadStep: 0 });
  });
});

describe("deriveLoadStatus — a lineage replay's several segments", () => {
  // A rotated card replays every segment of its line into one transcript, so
  // `claudeTurnsDisplayed` counts turns from several files and `totalTurns`
  // arrives summed over exactly the segments that replay walked. The two are
  // then two readings of one decision, and the fraction cannot exceed one —
  // which is what "18 of 4 · all loaded" was.
  test("three whole segments, nothing windowed: 18 of 18, all loaded", () => {
    // 1 + 13 + 4 turns across the line, every one of them replayed.
    expect(
      deriveLoadStatus({
        claudeTurnsDisplayed: 18,
        firstLoadedTurnIndex: 0,
        totalTurns: 18,
        step: 25,
      }),
    ).toEqual({ displayed: 18, total: 18, hasOlder: false, loadStep: 0 });
  });

  test("whole ancestors under a windowed tip: 39 of 54, the step clamped to the tip's 15", () => {
    // Ancestors replay whole (24 turns); the 30-turn tip is windowed to its
    // last 15, so `firstLoadedTurnIndex` is 15 — a **tip** coordinate, which
    // is exactly what a load-previous can fetch. Reading it in line
    // coordinates to "match" the 54 would page the wrong turns.
    expect(
      deriveLoadStatus({
        claudeTurnsDisplayed: 39,
        firstLoadedTurnIndex: 15,
        totalTurns: 54,
        step: 25,
      }),
    ).toEqual({ displayed: 39, total: 54, hasOlder: true, loadStep: 15 });
  });
});

describe("countClaudeTurns — shell rows are not conversation turns", () => {
  test("shell-origin rows are excluded; every other origin counts", () => {
    const transcript = [
      { origin: "user" },
      { origin: "shell" },
      { origin: "assistant" },
      { origin: "shell" },
      { origin: "wake" },
      {},
    ];
    expect(countClaudeTurns(transcript)).toBe(4);
  });

  test("a shell-heavy session reads X of Y honestly", () => {
    // The shape that read "83 of 68": 68 Claude turns interleaved with 15
    // shell rows, against an engine count of 68.
    const transcript = [
      ...Array.from({ length: 68 }, () => ({ origin: "user" })),
      ...Array.from({ length: 15 }, () => ({ origin: "shell" })),
    ];
    expect(
      deriveLoadStatus({
        claudeTurnsDisplayed: countClaudeTurns(transcript),
        firstLoadedTurnIndex: 0,
        totalTurns: 68,
        step: 25,
      }),
    ).toEqual({ displayed: 68, total: 68, hasOlder: false, loadStep: 0 });
  });
});
