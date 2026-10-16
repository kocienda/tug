/**
 * The beat plan: a body in a carried frame walks from its frame's First rect
 * to its Last, inset to its placeholder, beat by beat; anything the planner
 * cannot carry exactly is refused and keeps the interim hide; and a back
 * pane's moving cut keeps one rectangle per front body at every keyframe.
 *
 * The parity fixture the host's model decodes (`BodyBeatsTests.swift`) is
 * written here, from the planner itself. Regenerate it with
 * `BEAT_PLAN_GOLDEN_UPDATE=1` (or `just golden`).
 *
 * @covers tugdeck/src/lib/body-beat-plan.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  cutWindow,
  frameRectBeats,
  paneCutKeyframes,
  planBodyBeats,
  sweptUnionCut,
  viewportRect,
  wholePoints,
  type BeatPlan,
  type CarriedFrame,
  type FrameBeat,
  type Insets,
  type PlanInput,
  type Rect,
} from "../body-beat-plan";
import type { BodyPlacement, PaneBox } from "../body-placement";

const GOLDEN_PATH = join(import.meta.dir, "fixtures", "beat-plan-parity.json");

/** A spring's samples, with an overshoot, as `motionKeyframes` returns them. */
const SPRING = [0, 0.32, 0.71, 0.93, 1.03, 1.01, 1] as const;
const INSETS: Insets = { top: 36, right: 1, bottom: 1, left: 1 };

function inset(r: Rect, i: Insets = INSETS): Rect {
  return { x: r.x + i.left, y: r.y + i.top, width: r.width - i.left - i.right, height: r.height - i.top - i.bottom };
}

function placed(cardId: string, r: Rect, visible = true): BodyPlacement {
  return { cardId, x: r.x, y: r.y, width: r.width, height: r.height, visible, z: 1 };
}

function moveBeat(dx: number, dy: number, delayMs = 0, durationMs = 300): FrameBeat {
  return { kind: "move", terms: { dx, dy }, delayMs, durationMs, progress: SPRING };
}

function input(frames: CarriedFrame[], bodies: Record<string, string[]>, extra: Partial<PlanInput> = {}): PlanInput {
  const placements: BodyPlacement[] = [];
  for (const frame of frames) {
    for (const cardId of bodies[frame.paneId] ?? []) placements.push(placed(cardId, inset(frame.first)));
  }
  return {
    frames,
    placement: { radius: 8, bodies: placements },
    insets: new Map(Object.values(bodies).flat().map((id) => [id, INSETS])),
    bodiesInFrame: new Map(Object.entries(bodies)),
    stillShown: () => true,
    factor: 1,
    ...extra,
  };
}

// ---- The three fixtures the parity file carries ----

/** The flow strip's slide: one frame, move only, the frame's First − Last = dx. */
function flowSlide(): PlanInput {
  const first = { x: 420, y: 60, width: 400, height: 520 };
  const dx = 300;
  return input([{ paneId: "p1", first, last: { ...first, x: first.x - dx }, beats: [moveBeat(dx, 0)] }], { p1: ["c1"] });
}

/** A stack move: two frames trade places vertically, each carrying its body. */
function stackMove(): PlanInput {
  const top = { x: 40, y: 40, width: 500, height: 300 };
  const bottom = { x: 40, y: 360, width: 500, height: 300 };
  return input(
    [
      { paneId: "a", first: top, last: bottom, beats: [moveBeat(0, top.y - bottom.y)] },
      { paneId: "b", first: bottom, last: top, beats: [moveBeat(0, bottom.y - top.y)] },
    ],
    { a: ["ca"], b: ["cb"] },
  );
}

/** A frame that shrinks then moves: its body's box changes size. */
function sizeChange(allowCrossing: boolean): PlanInput {
  const first = { x: 40, y: 40, width: 600, height: 400 };
  const last = { x: 340, y: 40, width: 300, height: 400 };
  return input(
    [
      {
        paneId: "s",
        first,
        last,
        beats: [
          { kind: "shrink", terms: { dx: 0, dy: 0, width: [600, 300] }, delayMs: 40, durationMs: 200, progress: SPRING },
          { kind: "move", terms: { dx: -300, dy: 0 }, delayMs: 240, durationMs: 300, progress: SPRING },
        ],
      },
    ],
    { s: ["cs"] },
    { allowCrossing },
  );
}

describe("wholePoints", () => {
  test("grows a fractional rect outward to whole points", () => {
    // Zoom 0.9's placeholder in a four-up flow: the view a body is posted
    // at must hold its page's whole-point layout viewport exactly.
    expect(wholePoints({ x: 12.3, y: 40.6, width: 605.7, height: 959.99 })).toEqual({
      x: 12,
      y: 40,
      width: 606,
      height: 961,
    });
  });

  test("leaves a whole rect, and one a rounding error off it, as it is", () => {
    expect(wholePoints({ x: 10, y: 20, width: 300, height: 400 })).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    expect(wholePoints({ x: 9.9999, y: 20.0001, width: 300.0002, height: 399.9999 })).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 400,
    });
  });
});

describe("planBodyBeats", () => {
  test("a rail carried to the other edge leaves at its own insets and lands at its mirrored ones", () => {
    const rail: Insets = { top: 36, right: 1, bottom: 0, left: 0 };
    const mirrored: Insets = { top: 36, right: 0, bottom: 0, left: 1 };
    const first = { x: 1115, y: 0, width: 545, height: 1051 };
    const dx = 1115;
    const i = input(
      [{ paneId: "rail", first, last: { ...first, x: 0 }, beats: [moveBeat(dx, 0)] }],
      { rail: ["ov"] },
      { insets: new Map([["ov", rail]]), landingInsets: new Map([["ov", mirrored]]) },
    );
    const placement = i.placement!;
    const { plan, refused } = planBodyBeats({ ...i, placement: { ...placement, bodies: [placed("ov", inset(first, rail))] } });
    expect(refused).toEqual([]);
    expect(plan[0].beats[0].from).toEqual(inset(first, rail));
    expect(plan[0].landing).toEqual(inset({ ...first, x: 0 }, mirrored));
    expect(plan[0].crossing).toBeUndefined();
  });

  test("a flow slide walks the body from First to Last, inset", () => {
    const i = flowSlide();
    const { plan, refused } = planBodyBeats(i);
    expect(refused).toEqual([]);
    expect(plan).toHaveLength(1);
    const [body] = plan;
    const frame = i.frames[0];
    expect(body.beats).toHaveLength(1);
    expect(body.beats[0].from).toEqual(inset(frame.first));
    expect(body.beats[0].to).toEqual(inset(frame.last));
    expect(body.landing).toEqual(inset(frame.last));
    expect(body.beats[0].progress).toEqual(SPRING);
    expect(body.crossing).toBeUndefined();
  });

  test("at page zoom 1.25 the layout-px rects and terms are carried in viewport px", () => {
    const factor = 1.25;
    const firstLayout = { x: 336, y: 48, width: 320, height: 416 };
    const dx = 240;
    const first = viewportRect(firstLayout, factor);
    const last = viewportRect({ ...firstLayout, x: firstLayout.x - dx }, factor);
    expect(first).toEqual({ x: 420, y: 60, width: 400, height: 520 });
    const i = input([{ paneId: "p", first, last, beats: [moveBeat(dx, 0)] }], { p: ["c"] }, { factor });
    const { plan, refused } = planBodyBeats(i);
    expect(refused).toEqual([]);
    expect(plan[0].landing).toEqual(inset({ x: 120, y: 60, width: 400, height: 520 }));
  });

  test("a body whose posted rect is not inside its frame's First rect is refused", () => {
    const i = flowSlide();
    const stale = { ...i, placement: { radius: 8, bodies: [placed("c1", { x: 900, y: 60, width: 398, height: 483 })] } };
    const out = planBodyBeats(stale);
    expect(out.plan).toEqual([]);
    expect(out.refused).toEqual(["c1"]);
  });

  test("a body not placed visible, or hidden since, is refused", () => {
    const i = flowSlide();
    const hiddenPlaced = { ...i, placement: { radius: 8, bodies: [placed("c1", inset(i.frames[0].first), false)] } };
    expect(planBodyBeats(hiddenPlaced).refused).toEqual(["c1"]);
    const hiddenSince = { ...i, stillShown: () => false };
    const out = planBodyBeats(hiddenSince);
    expect(out.refused).toEqual(["c1"]);
    expect(out.reasons.c1).toContain("hidden since");
  });

  test("shrink then move carries the running rect across both beats", () => {
    const { plan, refused } = planBodyBeats(sizeChange(true));
    expect(refused).toEqual([]);
    const [body] = plan;
    expect(body.beats.map((b) => b.kind)).toEqual(["shrink", "move"]);
    expect(body.beats[0].from).toEqual(inset({ x: 40, y: 40, width: 600, height: 400 }));
    expect(body.beats[0].to).toEqual(inset({ x: 40, y: 40, width: 300, height: 400 }));
    expect(body.beats[1].from).toEqual(body.beats[0].to);
    expect(body.beats[1].to).toEqual(inset({ x: 340, y: 40, width: 300, height: 400 }));
    expect(body.crossing).toEqual({ width: 298, height: 363 });
  });

  test("a size change is refused without allowCrossing", () => {
    const out = planBodyBeats(sizeChange(false));
    expect(out.plan).toEqual([]);
    expect(out.refused).toEqual(["cs"]);
    expect(out.reasons.cs).toContain("changes size");
  });

  test("a frame whose walk misses its Last rect by more than half a pixel refuses its bodies", () => {
    const i = flowSlide();
    const frame = i.frames[0];
    const off = { ...i, frames: [{ ...frame, last: { ...frame.last, width: frame.last.width + 0.6 } }] };
    const out = planBodyBeats(off);
    expect(out.plan).toEqual([]);
    expect(out.refused).toEqual(["c1"]);
    const near = { ...i, frames: [{ ...frame, last: { ...frame.last, width: frame.last.width + 0.4 } }] };
    expect(planBodyBeats(near).refused).toEqual([]);
  });

  test("every body of a refused frame is refused; a frame holding no body plans nothing", () => {
    const i = stackMove();
    const broken = { ...i, frames: [{ ...i.frames[0], beats: [] }, i.frames[1]] };
    const out = planBodyBeats(broken);
    expect(out.refused).toEqual(["ca"]);
    expect(out.plan.map((b) => b.cardId)).toEqual(["cb"]);
    const empty = planBodyBeats({ ...i, bodiesInFrame: new Map() });
    expect(empty).toEqual({ plan: [], refused: [], reasons: {} });
  });
});

describe("paneCutKeyframes", () => {
  const pane: PaneBox = { x: 0, y: 0, width: 800, height: 600, layoutWidth: 800, z: 0 };
  const beat = { delayMs: 0, durationMs: 300, progress: SPRING };

  function commands(clipPath: string): string {
    return clipPath.replace(/-?[\d.]+/g, "");
  }

  test("one keyframe per sample, each with the same commands, a front leaving the pane kept at no area", () => {
    const { plan } = planBodyBeats(flowSlide());
    const front = plan[0];
    const frames = paneCutKeyframes({ box: pane }, [front, { x: 700, y: 582, width: 50, height: 15 }], beat);
    expect(Array.isArray(frames)).toBe(true);
    const list = frames as { offset: number; clipPath: string }[];
    expect(list.map((f) => f.offset)).toEqual(SPRING.map((_, i) => i / (SPRING.length - 1)));
    const shape = commands(list[0].clipPath);
    for (const f of list) expect(commands(f.clipPath)).toBe(shape);
    expect(shape.match(/M/g)).toHaveLength(3);
    // The body ends at x = 121 (Last 120 + inset 1); it starts at 421, inside.
    expect(list[0].clipPath).toContain("M421 96H");
  });

  test("a front that clears the pane at a sample is clamped to zero area, not dropped", () => {
    const right: PaneBox = { x: 600, y: 0, width: 300, height: 600, layoutWidth: 300, z: 0 };
    const { plan } = planBodyBeats(flowSlide());
    const list = paneCutKeyframes({ box: right }, [plan[0]], beat) as { clipPath: string }[];
    const last = list[list.length - 1].clipPath;
    expect(last.match(/M/g)).toHaveLength(2);
    expect(last).toContain("M0 96H0V");
  });

  test("two fronts overlapping inside the pane fall back to the union", () => {
    const { plan } = planBodyBeats(stackMove());
    expect(paneCutKeyframes({ box: pane }, plan, beat)).toBe("union");
  });

  test("no front meeting the pane at any sample needs no cut", () => {
    const far: PaneBox = { x: 2000, y: 0, width: 300, height: 300, layoutWidth: 300, z: 0 };
    const { plan } = planBodyBeats(flowSlide());
    expect(paneCutKeyframes({ box: far }, plan, beat)).toBeNull();
  });

  test("a pane moving under a front body that stands still wears a cut that moves the other way in its own px", () => {
    const frame = flowSlide().frames[0];
    const own = frameRectBeats(frame, 1);
    expect(own).not.toBeNull();
    const box: PaneBox = { ...frame.first, layoutWidth: frame.first.width, z: 0 };
    const still = { x: 500, y: 100, width: 100, height: 100 };
    const window = cutWindow(own!, 16.67)!;
    const list = paneCutKeyframes({ box, beats: own! }, [still], window) as { clipPath: string }[];
    expect(Array.isArray(list)).toBe(true);
    // At First the hole is 80 px into the pane; at Last, 300 px further in.
    expect(list[0].clipPath).toContain("M80 40H180V140H80Z");
    expect(list[list.length - 1].clipPath).toContain("M380 40H400V140H380Z");
  });

  test("a pane that changes size under a still front maps the hole through its scale at each sample", () => {
    const frame = sizeChange(true).frames[0];
    const own = frameRectBeats(frame, 1);
    expect(own).not.toBeNull();
    // Measured at First (600 layout px wide); carried at its Last layout box, 300 wide.
    const box: PaneBox = { ...frame.first, layoutWidth: frame.first.width, z: 0 };
    const still = { x: 400, y: 100, width: 100, height: 100 };
    const window = cutWindow(own!, 16.67)!;
    const list = paneCutKeyframes({ box, beats: own! }, [still], window) as { clipPath: string }[];
    expect(Array.isArray(list)).toBe(true);
    // At First the 300-px box is scaled ×2 across 600 viewport px: the hole
    // at viewport x 400–500 is layout x 180–230. At Last it is unscaled at x 340.
    expect(list[0].clipPath).toContain("M180 60H230V160H180Z");
    expect(list[list.length - 1].clipPath).toContain("M60 60H160V160H60Z");
  });

  test("a reach widens each hole to every rect the front takes a reach either side of its sample", () => {
    const { plan } = planBodyBeats(flowSlide());
    const exact = paneCutKeyframes({ box: pane }, [plan[0]], beat) as { clipPath: string }[];
    const reached = paneCutKeyframes({ box: pane }, [plan[0]], beat, 50) as { clipPath: string }[];
    expect(reached).toHaveLength(exact.length);
    // The hole is the subpath after the outer ring: `ZM<x1> <y1>H<x2>`.
    const hole = (clip: string): number[] => {
      const m = /ZM(-?[\d.]+) -?[\d.]+H(-?[\d.]+)/.exec(clip)!;
      return [Number(m[1]), Number(m[2])];
    };
    // Mid-slide the body moves left, so the reached hole starts further left and ends further right.
    const [x1, x2] = hole(exact[2].clipPath);
    const [r1, r2] = hole(reached[2].clipPath);
    expect(r1).toBeLessThan(x1);
    expect(r2).toBeGreaterThan(x2);
    // The commands are the same as without a reach.
    expect(reached[2].clipPath.replace(/-?[\d.]+/g, "")).toBe(exact[2].clipPath.replace(/-?[\d.]+/g, ""));
  });

  test("a frame's own walk is its visual rects, uninset", () => {
    const frame = flowSlide().frames[0];
    const own = frameRectBeats(frame, 1)!;
    expect(own.map((b) => [b.from, b.to])).toEqual([[frame.first, frame.last]]);
    // A Last whose size no beat makes is a walk that misses it.
    const missed = { ...frame, last: { ...frame.last, width: frame.last.width + 10 } };
    expect(frameRectBeats(missed, 1)).toBeNull();
  });

  test("the cut keys to the beat that moves the geometry, or spans beats on different windows a period apart", () => {
    const { plan } = planBodyBeats(sizeChange(true));
    const [shrink, move] = plan[0].beats;
    const one = cutWindow([move], 16);
    expect(one).toEqual({ delayMs: move.delayMs, durationMs: move.durationMs, progress: move.progress });
    const span = cutWindow([shrink, move], 20)!;
    expect(span.delayMs).toBe(40);
    expect(span.durationMs).toBe(500);
    expect(span.progress).toHaveLength(26);
    const fade = { ...move, kind: "arrive" as const, from: move.to, to: move.to };
    expect(cutWindow([fade], 16)).toBeNull();
  });

  test("the swept union is the box of each front's First and Last, in the pane's px", () => {
    const cut = sweptUnionCut({ ...pane, width: 1000, layoutWidth: 800 }, [
      { first: { x: 100, y: 100, width: 100, height: 100 }, last: { x: 300, y: 100, width: 100, height: 100 } },
    ]);
    expect(cut).toBe('path(evenodd, "M-100000 -100000H100000V100000H-100000ZM80 80H320V160H80Z")');
  });
});

describe("beat-plan-parity.json", () => {
  test("the checked-in fixture is what the planner writes", () => {
    const cases: { name: string; refused: string[]; plan: BeatPlan }[] = [
      ["flow-slide", flowSlide()],
      ["stack-move", stackMove()],
      ["size-change-refused", sizeChange(false)],
      ["size-change-crossing", sizeChange(true)],
    ].map(([name, i], index) => {
      const out = planBodyBeats(i as PlanInput);
      return { name: name as string, refused: out.refused, plan: { planId: index + 1, startWallMs: 1_760_000_000_000 + index * 1000, bodies: out.plan } };
    });
    const serialized = `${JSON.stringify(cases, null, 2)}\n`;
    if (process.env.BEAT_PLAN_GOLDEN_UPDATE === "1") writeFileSync(GOLDEN_PATH, serialized);
    expect(serialized, "the planner's plans moved: review the diff, then regenerate with BEAT_PLAN_GOLDEN_UPDATE=1").toBe(
      readFileSync(GOLDEN_PATH, "utf8"),
    );
  });
});
