/**
 * The Beat's pure core: which properties a beat's keyframes move, the
 * transform/opacity contract a beat is planned against, and the row it writes
 * at its landing.
 *
 * `planBeat` itself writes poses and creates effects, which is the live deck's
 * to show; the settle app-tests read its rows there. What is tested here is
 * everything the beat decides before and after it touches the DOM.
 */

import { describe, expect, test } from "bun:test";
import {
  beatAnimatedProperties,
  beatRow,
  undeclaredBeatProperties,
} from "@/components/tugways/tug-animator";

describe("beatAnimatedProperties", () => {
  test("reads every property across a keyframe list, leaving out timing keys", () => {
    expect(
      beatAnimatedProperties([
        { transform: "translate(10px, 0px)", offset: 0, easing: "linear" },
        { transform: "none", opacity: 1, composite: "replace" },
      ]),
    ).toEqual(["opacity", "transform"]);
  });

  test("reads property-indexed keyframes", () => {
    expect(
      beatAnimatedProperties({ height: ["100px", "200px"], offset: [0, 1] }),
    ).toEqual(["height"]);
  });
});

describe("undeclaredBeatProperties", () => {
  test("transform and opacity need no declaration", () => {
    expect(
      undeclaredBeatProperties(
        [{ transform: "scale(0.5)", opacity: 0 }, { transform: "none", opacity: 1 }],
        [],
      ),
    ).toEqual([]);
  });

  test("a layout property the beat did not declare is refused", () => {
    expect(
      undeclaredBeatProperties([{ height: "600px" }, { height: "1041px" }], []),
    ).toEqual(["height"]);
  });

  test("a declared breach passes, and only the one declared", () => {
    const keyframes = [
      { height: "600px", width: "400px", transform: "none" },
      { height: "1041px", width: "675px", transform: "none" },
    ];
    expect(undeclaredBeatProperties(keyframes, ["height", "width"])).toEqual([]);
    expect(undeclaredBeatProperties(keyframes, ["height"])).toEqual(["width"]);
  });

  test("a property no beat can declare is refused whatever is declared", () => {
    expect(
      undeclaredBeatProperties([{ left: "0px" }, { left: "10px" }], ["height", "width"]),
    ).toEqual(["left"]);
  });
});

describe("beatRow", () => {
  const base = {
    recipe: "move",
    targets: 3,
    durationMs: 399.6,
    declares: [] as const,
  };

  test("the start delay is planning to the earliest effect's clock", () => {
    const row = beatRow({
      ...base,
      plannedAt: 1000,
      startTimes: [1017.4, 1016.6, 1017.4],
      allFinished: true,
    });
    expect(row).toEqual({
      recipe: "move",
      targets: 3,
      durationMs: 400,
      startDelayMs: 17,
      declares: [],
      landing: "finished",
    });
  });

  test("a beat whose clocks never started reports -1, and lands cut", () => {
    const row = beatRow({
      ...base,
      plannedAt: 1000,
      startTimes: [null, null, null],
      allFinished: false,
    });
    expect(row.startDelayMs).toBe(-1);
    expect(row.landing).toBe("cut");
  });

  test("an effect cancelled before its first frame is left out of the delay", () => {
    expect(
      beatRow({ ...base, plannedAt: 500, startTimes: [null, 533], allFinished: false })
        .startDelayMs,
    ).toBe(33);
  });

  test("an unresolved timeline gives no delay rather than a wrong one", () => {
    expect(
      beatRow({ ...base, plannedAt: null, startTimes: [17], allFinished: true })
        .startDelayMs,
    ).toBe(-1);
  });

  test("a declared breach is carried on the row", () => {
    expect(
      beatRow({
        ...base,
        recipe: "grow",
        declares: ["height"],
        plannedAt: 0,
        startTimes: [16],
        allFinished: true,
      }).declares,
    ).toEqual(["height"]);
  });

  test("a beat with no targets still writes its row", () => {
    expect(
      beatRow({ ...base, targets: 0, plannedAt: 0, startTimes: [], allFinished: true }),
    ).toMatchObject({ targets: 0, startDelayMs: -1 });
  });
});
