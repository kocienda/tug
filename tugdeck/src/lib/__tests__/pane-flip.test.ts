import { describe, expect, test } from "bun:test";

import {
  MAX_FLIP_SCALE_DISTORTION,
  BEAT_ORDER,
  beatLaunchVelocity,
  flipDelta,
  planSettleBeats,
  scaleDistortion,
  springSettleKeyframes,
  type SettleBeat,
} from "@/lib/pane-flip";
import { motionKeyframes } from "@/lib/imposer-motion";

/**
 * The curve the deck's settle actually runs on. This module no longer owns a
 * spring — the choreography is stated once in `lib/imposer-motion.ts` — so the
 * tests below check the MAPPING of a curve onto a frame's terms, against the
 * same curve the canvas passes in.
 */
const CROSSING = motionKeyframes("crossing", { nominalMs: 360 }).progress;
const STOPS = CROSSING.length - 1;

/** A short hand-built curve, for the cases that only care about the shape of
 *  the output list rather than the physics. */
const COARSE = [0, 0.25, 0.6, 0.85, 1];

/** A rect standing in for a measured frame; the origin and the width are read. */
function rect(left: number, top: number, width = 400, height = 600): DOMRectReadOnly {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRectReadOnly;
}

/** The px pair inside a `translate(…)` keyframe value. */
function translation(frame: Keyframe): { x: number; y: number } {
  const match = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
    String(frame.transform),
  );
  if (!match) throw new Error(`not a 2D translate: ${String(frame.transform)}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** The factor inside a `scaleX(…)` keyframe value, or 1 when there is none. */
function scaleX(frame: Keyframe): number {
  const match = /scaleX\(([\d.]+)\)/.exec(String(frame.transform));
  return match === null ? 1 : Number(match[1]);
}

describe("flipDelta", () => {
  test("is the distance from the new position back to the old one", () => {
    expect(flipDelta(rect(100, 50), rect(400, 210))).toEqual({
      dx: -300,
      dy: -160,
      sx: 1,
    });
  });

  test("is nothing at all when a frame did not move or resize", () => {
    expect(flipDelta(rect(240, 96), rect(240, 96))).toEqual({
      dx: 0,
      dy: 0,
      sx: 1,
    });
  });

  test("carries a width change as the scale the frame starts at", () => {
    const before = rect(0, 0, 675, 600);
    const after = rect(0, 0, 1230, 600);
    expect(flipDelta(before, after)).toEqual({
      dx: 0,
      dy: 0,
      sx: 675 / 1230,
    });
  });

  test("does not carry height — a height change is never smeared", () => {
    // The top member of a fresh split: left, top, and width all unchanged, and
    // only the height halved. Its delta is nothing at all; the settle reads
    // the rects' heights directly and drives springSizeKeyframes instead.
    expect(flipDelta(rect(0, 0, 400, 600), rect(0, 0, 400, 300))).toEqual({
      dx: 0,
      dy: 0,
      sx: 1,
    });
  });

  test("reads a frame with no width as unscaled rather than dividing by zero", () => {
    const delta = flipDelta(rect(0, 0, 400, 600), rect(0, 0, 0, 0));
    expect(delta.sx).toBe(1);
  });
});

describe("scaleDistortion", () => {
  test("is symmetric in grow and shrink", () => {
    expect(scaleDistortion(2)).toBeCloseTo(1, 10);
    expect(scaleDistortion(0.5)).toBeCloseTo(1, 10);
    expect(scaleDistortion(1)).toBe(0);
  });

  test("reads a degenerate scale as no distortion at all", () => {
    expect(scaleDistortion(0)).toBe(0);
    expect(scaleDistortion(-1)).toBe(0);
  });

  test("the cap admits the adjacent width-preset step and nothing wider", () => {
    expect(scaleDistortion(675 / 800)).toBeLessThanOrEqual(
      MAX_FLIP_SCALE_DISTORTION,
    );
    expect(scaleDistortion(800 / 1230)).toBeGreaterThan(
      MAX_FLIP_SCALE_DISTORTION,
    );
    expect(scaleDistortion(675 / 1230)).toBeGreaterThan(
      MAX_FLIP_SCALE_DISTORTION,
    );
  });
});

describe("springSettleKeyframes", () => {
  const FRAMES = springSettleKeyframes({ dx: -300, dy: -160 }, CROSSING);

  test("starts at the full inverse delta and ends at no transform", () => {
    expect(translation(FRAMES[0])).toEqual({ x: -300, y: -160 });
    expect(FRAMES[FRAMES.length - 1].transform).toBe("translate(0px, 0px)");
  });

  test("emits one keyframe per stop in the curve it was given", () => {
    expect(FRAMES).toHaveLength(CROSSING.length);
  });

  test("offsets rise strictly from 0 to 1", () => {
    expect(FRAMES[0].offset).toBe(0);
    expect(FRAMES[FRAMES.length - 1].offset).toBe(1);
    for (let i = 1; i < FRAMES.length; i += 1) {
      expect(FRAMES[i].offset as number).toBeGreaterThan(
        FRAMES[i - 1].offset as number,
      );
      expect(FRAMES[i].offset as number).toBeLessThanOrEqual(1);
    }
  });

  test("every keyframe carries only a 2D transform and its offset", () => {
    for (const frame of FRAMES) {
      expect(Object.keys(frame).sort()).toEqual(["offset", "transform"]);
      const value = String(frame.transform);
      expect(value).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\)$/);
      expect(value).not.toMatch(/3d|translateZ|perspective|rotate|scale|matrix/i);
    }
  });

  test("traces the curve it was handed, term by term", () => {
    for (let i = 1; i < STOPS; i += 1) {
      const remaining = 1 - CROSSING[i];
      const { x, y } = translation(FRAMES[i]);
      expect(x).toBeCloseTo(-300 * remaining, 2);
      expect(y).toBeCloseTo(-160 * remaining, 2);
    }
  });

  test("moves monotonically home — the spring never overshoots", () => {
    let previous = Infinity;
    for (const frame of FRAMES) {
      const { x } = translation(frame);
      expect(Math.abs(x)).toBeLessThanOrEqual(previous);
      previous = Math.abs(x);
    }
  });

  test("a curve of any length maps, and a degenerate one still has two ends", () => {
    expect(springSettleKeyframes({ dx: 10, dy: 0 }, COARSE)).toHaveLength(5);
    expect(springSettleKeyframes({ dx: 10, dy: 0 }, [0, 1])).toHaveLength(3);
  });

  test("a frame that only moves is tweened by the transform it always was", () => {
    // The everyday arrangement gestures take no scale and no size term, so
    // their keyframes are byte-identical to what the deck has always animated
    // — and, carrying nothing but transform, stay accelerable.
    for (const frame of springSettleKeyframes({ dx: -300, dy: -160 }, CROSSING)) {
      expect(String(frame.transform)).toMatch(
        /^translate\(-?[\d.]+px, -?[\d.]+px\)$/,
      );
    }
  });

  test("a frame that neither moves nor scales carries no transform at all", () => {
    // A rail member growing in place: its top-left corner is where it always
    // was, so there is nothing to invert and an identity transform would be a
    // term claiming motion that is not happening.
    for (const frame of springSettleKeyframes(
      { dx: 0, dy: 0, height: [300, 640] },
      CROSSING,
    )) {
      expect(Object.keys(frame).sort()).toEqual(["height", "offset"]);
    }
  });

  describe("with a width change", () => {
    const SCALED = springSettleKeyframes({ dx: -40, dy: 0, sx: 675 / 800 }, CROSSING);

    test("starts at the old width's scale and ends at none", () => {
      expect(scaleX(SCALED[0])).toBeCloseTo(675 / 800, 5);
      expect(SCALED[SCALED.length - 1].transform).toBe(
        "translate(0px, 0px) scaleX(1)",
      );
    });

    test("stays a 2D transform, so the effect stays accelerable", () => {
      for (const frame of SCALED) {
        expect(Object.keys(frame).sort()).toEqual(["offset", "transform"]);
        expect(String(frame.transform)).toMatch(
          /^translate\(-?[\d.]+px, -?[\d.]+px\) scaleX\([\d.]+\)$/,
        );
      }
    });

    test("walks the scale up on the same curve the move rides", () => {
      const sx = 675 / 800;
      for (let i = 1; i < STOPS; i += 1) {
        const remaining = 1 - CROSSING[i];
        expect(scaleX(SCALED[i])).toBeCloseTo(1 + (sx - 1) * remaining, 4);
      }
    });
  });
});

describe("springSettleKeyframes, with a real size term", () => {
  const GROWN = springSettleKeyframes({ dx: 0, dy: 0, height: [300, 640] }, CROSSING);

  test("starts at the old size and ends exactly at the new one", () => {
    expect(GROWN[0]).toEqual({ height: "300px", offset: 0 });
    expect(GROWN[GROWN.length - 1]).toEqual({ height: "640px", offset: 1 });
  });

  test("walks the size on the same curve the move rides", () => {
    for (let i = 1; i < STOPS; i += 1) {
      const value = Number(String(GROWN[i].height).replace("px", ""));
      expect(value).toBeCloseTo(300 + 340 * CROSSING[i], 2);
    }
  });

  test("animates width by the same construction", () => {
    const frames = springSettleKeyframes(
      { dx: 0, dy: 0, width: [800, 1230] },
      COARSE,
    );
    expect(frames).toHaveLength(5);
    expect(frames[0]).toEqual({ width: "800px", offset: 0 });
    expect(frames[frames.length - 1]).toEqual({ width: "1230px", offset: 1 });
  });

  test("a two-stop curve still yields a list with two ends", () => {
    expect(
      springSettleKeyframes({ dx: 0, dy: 0, height: [0, 100] }, [0, 1]),
    ).toHaveLength(3);
  });

  /**
   * The reason move and size share one keyframe list.
   *
   * A rail member growing into the whole run from the BOTTOM tile ends up
   * translated by exactly the height it gains: its top edge travels the whole
   * way and its bottom edge must not move by a pixel. Nothing enforces that
   * except the two terms being sampled at the same offsets off the same spring
   * — which is a property of the keyframe list, and is therefore checkable
   * here rather than only in the eye.
   *
   * (The two terms living in separate effects is what let this drift in the
   * running app: the transform ran on the compositor, the height on the main
   * thread, and the "pinned" edge slid by however far they came apart.)
   */
  test("a bottom-anchored grow pins the bottom edge at every keyframe", () => {
    const TOP = 620; // the tile's top, in the run
    const HEIGHT = 300; // the tile's height
    const RUN_TOP = 5; // where the whole run starts
    const dy = TOP - RUN_TOP; // the inverse the FLIP starts at
    const grown = HEIGHT + dy; // the run's full height — same bottom edge
    for (const frame of springSettleKeyframes(
      { dx: 0, dy, height: [HEIGHT, grown] },
      CROSSING,
    )) {
      const { y } = translation(frame);
      const height = Number(String(frame.height).replace("px", ""));
      expect(RUN_TOP + y + height).toBeCloseTo(TOP + HEIGHT, 3);
    }
  });

  test("a top-anchored shrink pins the top edge at every keyframe", () => {
    // The mirror case: the frontmost member is the TOP tile and the rail is
    // being split, so it keeps its top and gives up its bottom.
    for (const frame of springSettleKeyframes(
      { dx: 0, dy: 0, height: [1220, 607] },
      CROSSING,
    )) {
      expect(frame.transform).toBeUndefined();
      expect(Number(String(frame.height).replace("px", ""))).toBeLessThanOrEqual(
        1220,
      );
    }
  });
});

describe("BEAT_ORDER", () => {
  test("is the five kinds, outermost first", () => {
    // The one place the order lives: the canvas folds its chain over this
    // array, so a chain that disagreed with the kinds would have to disagree
    // with this.
    expect(BEAT_ORDER).toEqual([
      "depart",
      "shrink",
      "move",
      "grow",
      "arrive",
    ]);
  });

  test("the middle three are the ones planSettleBeats can emit, in its order", () => {
    // A departure has no Last rect to invert and an arrival no First, so the
    // planner emits neither — the canvas authors the outer two because it is
    // the only thing that knows they happened.
    expect(BEAT_ORDER.slice(1, -1)).toEqual(["shrink", "move", "grow"]);
  });
});

describe("planSettleBeats", () => {
  /** The kinds a plan runs, in the order it runs them. */
  const kinds = (beats: SettleBeat[]) => beats.map((b) => b.kind);
  /** Whether a beat's animated terms carry any translate or smear. */
  const carriesTransform = (b: SettleBeat) =>
    b.terms.dx !== 0 || b.terms.dy !== 0 || (b.terms.sx ?? 1) !== 1;
  /** Whether a beat's animated terms carry a real size. */
  const carriesSize = (b: SettleBeat) =>
    b.terms.width !== undefined || b.terms.height !== undefined;

  test("a frame with no size term plans to one move beat carrying today's terms", () => {
    // The stack move: the settle the whole design is measured against.
    const terms = { dx: -300, dy: -160 };
    const beats = planSettleBeats(terms);
    expect(kinds(beats)).toEqual(["move"]);
    expect(beats[0].held).toEqual({});
    // The keyframe list is the one the canvas cut yesterday, byte for byte.
    expect(springSettleKeyframes(beats[0].terms, CROSSING)).toEqual(
      springSettleKeyframes(terms, CROSSING),
    );
    for (const frame of springSettleKeyframes(beats[0].terms, CROSSING)) {
      expect(frame.width).toBeUndefined();
      expect(frame.height).toBeUndefined();
    }
  });

  test("a smear rides the move beat, not a resize beat", () => {
    // The adjacent width-preset step is under the cap and rides the raster.
    const terms = { dx: 0, dy: 0, sx: 675 / 800 };
    const beats = planSettleBeats(terms);
    expect(kinds(beats)).toEqual(["move"]);
    expect(springSettleKeyframes(beats[0].terms, CROSSING)).toEqual(
      springSettleKeyframes(terms, CROSSING),
    );
  });

  test("a frame that neither moves nor resizes plans to nothing", () => {
    expect(planSettleBeats({ dx: 0, dy: 0 })).toEqual([]);
    // An equal pair is not a size term.
    expect(planSettleBeats({ dx: 0, dy: 0, height: [600, 600] })).toEqual([]);
  });

  test("never emits an outer beat, whatever the terms", () => {
    // [B02] of `briefs/three-beat-settle-brief.md` held: widening `BeatKind`
    // did not widen what the planner partitions. Every shape the canvas can
    // hand it, and not one of them names depart or arrive.
    const shapes = [
      { dx: -300, dy: -160 },
      { dx: 0, dy: 0, sx: 675 / 800 },
      { dx: 0, dy: 0, height: [600, 400] as const },
      { dx: 0, dy: 0, height: [400, 600] as const },
      { dx: -40, dy: 20, width: [800, 675] as const, height: [400, 600] as const },
      { dx: 0, dy: 0 },
    ];
    for (const terms of shapes) {
      for (const beat of planSettleBeats(terms)) {
        expect(beat.kind).not.toBe("depart");
        expect(beat.kind).not.toBe("arrive");
      }
    }
  });

  test("a frame with only a size term plans to no move beat", () => {
    // The sitting member of a split column, when a card arrives beside it.
    const shrinkOnly = planSettleBeats({ dx: 0, dy: 0, height: [1220, 607] });
    expect(kinds(shrinkOnly)).toEqual(["shrink"]);
    expect(shrinkOnly[0].held).toEqual({});
    // The member left behind, when a card departs.
    const growOnly = planSettleBeats({ dx: 0, dy: 0, height: [607, 1220] });
    expect(kinds(growOnly)).toEqual(["grow"]);
    expect(growOnly[0].held).toEqual({});
  });

  test("a shrink-then-move never puts a size term and a translate in one beat", () => {
    // A card crossing from a wide column into a split one: it shrinks where
    // it stands, then travels.
    const terms = { dx: -640, dy: 0, height: [1220, 607] as const };
    const beats = planSettleBeats(terms);
    expect(kinds(beats)).toEqual(["shrink", "move"]);
    for (const beat of beats) {
      expect(carriesTransform(beat) && carriesSize(beat)).toBe(false);
    }
    const [shrink, move] = beats;
    expect(shrink.terms.height).toEqual([1220, 607]);
    // The shrink wears the move's constant translate, so the frame shrinks at
    // First rather than at its committed place.
    expect(shrink.held.transform).toEqual({ dx: -640, dy: 0, sx: 1 });
    expect(shrink.held.height).toBeUndefined();
    // The move carries exactly today's transform-only list; the shrunk
    // height is the committed one, so it holds nothing.
    expect(move.terms).toEqual({ dx: -640, dy: 0, sx: 1 });
    expect(move.held).toEqual({});
    for (const frame of springSettleKeyframes(shrink.terms, CROSSING)) {
      expect(frame.transform).toBeUndefined();
    }
  });

  test("a move-then-grow holds First height through the move", () => {
    // A member growing into a rail's full run from the bottom tile: it
    // travels up first, then grows into the room.
    const terms = { dx: 0, dy: 615, height: [300, 915] as const };
    const beats = planSettleBeats(terms);
    expect(kinds(beats)).toEqual(["move", "grow"]);
    const [move, grow] = beats;
    // The frame's committed layout is already 915px tall; the hold is what
    // keeps it at 300 until the grow beat.
    expect(move.held).toEqual({ height: 300 });
    expect(carriesSize(move)).toBe(false);
    // The grow runs after the move, at the committed place: no transform.
    expect(grow.terms).toEqual({ dx: 0, dy: 0, width: undefined, height: [300, 915] });
    expect(grow.held).toEqual({});
    for (const frame of springSettleKeyframes(grow.terms, CROSSING)) {
      expect(frame.transform).toBeUndefined();
    }
  });

  test("all three beats, in order, with the holds each one needs", () => {
    // Width shrinking by real geometry, height growing, and a travel.
    const beats = planSettleBeats({
      dx: 200,
      dy: -40,
      width: [1230, 675],
      height: [400, 800],
    });
    expect(kinds(beats)).toEqual(["shrink", "move", "grow"]);
    const [shrink, move, grow] = beats;
    expect(shrink.terms.width).toEqual([1230, 675]);
    expect(shrink.terms.height).toBeUndefined();
    expect(shrink.held).toEqual({
      transform: { dx: 200, dy: -40, sx: 1 },
      height: 400,
    });
    expect(move.held).toEqual({ height: 400 });
    expect(grow.terms.height).toEqual([400, 800]);
    expect(grow.terms.width).toBeUndefined();
    expect(grow.held).toEqual({});
    for (const beat of beats) {
      expect(carriesTransform(beat) && carriesSize(beat)).toBe(false);
    }
  });
});

describe("beatLaunchVelocity", () => {
  test("a settle nothing interrupted launches every beat from rest", () => {
    for (const kind of ["shrink", "move", "grow"] as const) {
      expect(beatLaunchVelocity(kind, null)).toBe(0);
    }
  });

  test("an interrupted beat's velocity goes to the beat of the same kind", () => {
    expect(beatLaunchVelocity("move", { kind: "move", velocity: 1.7 })).toBe(1.7);
    expect(beatLaunchVelocity("shrink", { kind: "shrink", velocity: 0.9 })).toBe(
      0.9,
    );
    expect(beatLaunchVelocity("grow", { kind: "grow", velocity: 2.2 })).toBe(2.2);
  });

  test("every other kind launches from rest, whichever beat was interrupted", () => {
    // A shrink interrupted mid-close-up hands nothing to the move that
    // follows it: a width's velocity is not a translate's, and a card that
    // was closing up must not be thrown across the deck at that speed.
    const shrinking = { kind: "shrink", velocity: 1.4 } as const;
    expect(beatLaunchVelocity("move", shrinking)).toBe(0);
    expect(beatLaunchVelocity("grow", shrinking)).toBe(0);
    const moving = { kind: "move", velocity: 1.4 } as const;
    expect(beatLaunchVelocity("shrink", moving)).toBe(0);
    expect(beatLaunchVelocity("grow", moving)).toBe(0);
    const growing = { kind: "grow", velocity: 1.4 } as const;
    expect(beatLaunchVelocity("shrink", growing)).toBe(0);
    expect(beatLaunchVelocity("move", growing)).toBe(0);
  });

  test("a matched launch is a continuation: the curve is ahead of one from rest", () => {
    // The placement's point, read through the recipe it feeds: a move beat
    // handed the interrupted move's velocity is further along early on than
    // the same beat launched from rest.
    const velocity = beatLaunchVelocity("move", { kind: "move", velocity: 2 });
    const atRest = motionKeyframes("crossing", { nominalMs: 360 });
    const carried = motionKeyframes("crossing", {
      nominalMs: 360,
      initialVelocity: velocity,
    });
    const early = Math.floor(atRest.progress.length * 0.2);
    expect(carried.progress[early]).toBeGreaterThan(atRest.progress[early]);
  });
});
