/**
 * The card plan: a whole card in a carried frame walks from its frame's
 * First rect to its Last, as the view the placer posts it at (the frame
 * outset by the apron, grown to whole points), beat by beat; a card the
 * planner cannot carry exactly is refused and left where it stands.
 *
 * The parity fixture the host's model decodes (`BodyBeatsTests.swift`) is
 * written here, from the planner itself. Regenerate it with
 * `CARD_PLAN_GOLDEN_UPDATE=1` (or `just golden`).
 *
 * @covers tugdeck/src/lib/card-plan.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BodyPlacement } from "../card-placement";
import {
  installCardPlanRunner,
  planCards,
  runCardPlan,
  viewOf,
  viewportRect,
  wholePoints,
  type CardPlan,
  type CardPlanInput,
  type CarriedFrame,
  type FrameBeat,
  type Rect,
} from "../card-plan";
import { CARD_APRON_PX } from "../chrome-placement";

const GOLDEN_PATH = join(import.meta.dir, "fixtures", "card-plan-parity.json");

/** A spring's samples, with an overshoot, as `motionKeyframes` returns them. */
const SPRING = [0, 0.32, 0.71, 0.93, 1.03, 1.01, 1] as const;
const APRON = { top: CARD_APRON_PX, right: CARD_APRON_PX, bottom: CARD_APRON_PX, left: CARD_APRON_PX };

/** The view a frame at `r` is posted as. */
function view(r: Rect): Rect {
  return viewOf(r, CARD_APRON_PX);
}

function placed(cardId: string, r: Rect, visible = true): BodyPlacement {
  return { cardId, x: r.x, y: r.y, width: r.width, height: r.height, visible, z: 1, shell: [], insets: APRON };
}

function moveBeat(dx: number, dy: number, delayMs = 0, durationMs = 300): FrameBeat {
  return { kind: "move", terms: { dx, dy }, delayMs, durationMs, progress: SPRING };
}

function input(frames: CarriedFrame[], cards: Record<string, string[]>, extra: Partial<CardPlanInput> = {}): CardPlanInput {
  const placements: BodyPlacement[] = [];
  for (const frame of frames) {
    for (const cardId of cards[frame.paneId] ?? []) placements.push(placed(cardId, view(frame.first)));
  }
  return {
    frames,
    placement: { bodies: placements },
    cardsInFrame: new Map(Object.entries(cards)),
    stillShown: () => true,
    factor: 1,
    apron: CARD_APRON_PX,
    ...extra,
  };
}

// ---- The fixtures the parity file carries ----

/** The flow strip's slide: one frame, move only, the frame's First − Last = dx. */
function flowSlide(): CardPlanInput {
  const first = { x: 420, y: 60, width: 400, height: 520 };
  const dx = 300;
  return input([{ paneId: "p1", first, last: { ...first, x: first.x - dx }, beats: [moveBeat(dx, 0)] }], { p1: ["c1"] });
}

/** A stack move: two frames trade places vertically, each carrying its card. */
function stackMove(): CardPlanInput {
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

/** A frame that shrinks then moves: its card's box changes size, and it is carried as a crossing. */
function sizeChange(): CardPlanInput {
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
  );
}

/** The same frame, its card posted somewhere its First rect is not: a stale placement, refused. */
function stalePlacement(): CardPlanInput {
  const i = sizeChange();
  const elsewhere = { x: 700, y: 40, width: 620, height: 420 };
  return { ...i, placement: { bodies: [placed("cs", elsewhere)] } };
}

/** A card arriving in a band: posted where it lands and never shown, it rides the frame's rise and fade in. */
function arrival(arriving = true): CardPlanInput {
  const last = { x: 40, y: 360, width: 500, height: 300 };
  const rise = 6;
  const first = { ...last, y: last.y + rise };
  const i = input(
    [{ paneId: "n", first, last, beats: [{ kind: "arrive", terms: { dx: 0, dy: rise }, delayMs: 200, durationMs: 180, progress: [0, 0.4, 0.8, 1] }] }],
    { n: ["cn"] },
    arriving ? { arriving: new Set(["cn"]) } : {},
  );
  return { ...i, placement: { bodies: [placed("cn", view(last), false)] } };
}

describe("wholePoints", () => {
  test("grows a fractional rect outward to whole points", () => {
    // Zoom 0.9's stand-in in a four-up flow: the view a card is posted at
    // must hold its page's whole-point layout viewport exactly.
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

describe("viewportRect", () => {
  test("scales all four components by the factor and adds no origin term", () => {
    expect(viewportRect({ x: 400, y: 40, width: 400, height: 520 }, 1.25)).toEqual({ x: 500, y: 50, width: 500, height: 650 });
  });
});

describe("viewOf", () => {
  test("is the frame outset by the apron and grown to whole points, the rect the placer posts", () => {
    expect(view({ x: 420, y: 60, width: 400, height: 520 })).toEqual({ x: 410, y: 50, width: 420, height: 540 });
    expect(view({ x: 12.3, y: 40.6, width: 605.7, height: 959.99 })).toEqual({ x: 2, y: 30, width: 626, height: 981 });
  });
});

describe("planCards", () => {
  test("an arriving card, never shown, rides its frame's rise and fade in and is marked to be shown with them", () => {
    const i = arrival();
    const { cards, refused } = planCards(i);
    expect(refused).toEqual([]);
    expect(cards).toHaveLength(1);
    const [c] = cards;
    expect(c.arrives).toBe(true);
    expect(c.beats.map((b) => b.kind)).toEqual(["arrive"]);
    expect(c.beats[0].opacity).toEqual([0, 1]);
    expect(c.beats[0].from.y - c.beats[0].to.y).toBe(6);
    expect(c.landing).toEqual(view(i.frames[0].last));
    expect(c.crossing).toBeUndefined();
  });

  test("the same card, not arriving, is refused for never having been shown", () => {
    const { cards, refused, reasons } = planCards(arrival(false));
    expect(cards).toEqual([]);
    expect(refused).toEqual(["cn"]);
    expect(reasons.cn).toBe("not placed visible");
  });

  test("a flow slide walks the card's whole view from First to Last", () => {
    const i = flowSlide();
    const { cards, refused } = planCards(i);
    expect(refused).toEqual([]);
    expect(cards).toHaveLength(1);
    const [c] = cards;
    expect(c.beats).toHaveLength(1);
    expect(c.beats[0].from).toEqual({ x: 410, y: 50, width: 420, height: 540 });
    expect(c.beats[0].to).toEqual({ x: 110, y: 50, width: 420, height: 540 });
    expect(c.landing).toEqual(c.beats[0].to);
    expect(c.beats[0].progress).toEqual(SPRING);
    expect(c.crossing).toBeUndefined();
    expect(c.arrives).toBeUndefined();
  });

  test("at page zoom 1.25 the layout-px rects and terms are carried in viewport px", () => {
    const factor = 1.25;
    const firstLayout = { x: 400, y: 40, width: 400, height: 520 };
    const first = viewportRect(firstLayout, factor);
    const last = { ...first, x: first.x - 300 * factor };
    const i = input([{ paneId: "p1", first, last, beats: [moveBeat(300, 0)] }], { p1: ["c1"] }, { factor });
    const { cards, refused } = planCards(i);
    expect(refused).toEqual([]);
    expect(cards[0].beats[0].from).toEqual(view(first));
    expect(cards[0].beats[0].to).toEqual(view(last));
  });

  test("a card whose posted view is not where its frame's First rect puts it is refused", () => {
    const out = planCards(stalePlacement());
    expect(out.cards).toEqual([]);
    expect(out.refused).toEqual(["cs"]);
    expect(out.reasons.cs).toContain("not where its frame's First rect stands");
  });

  test("a view a point off its frame — the whole-point growth of two readings — is still the frame's", () => {
    const i = flowSlide();
    const v = view(i.frames[0].first);
    const nudged = { ...i, placement: { bodies: [placed("c1", { ...v, x: v.x - 0.5, width: v.width + 0.5 })] } };
    expect(planCards(nudged).refused).toEqual([]);
  });

  test("a card not placed visible, or hidden since, is refused", () => {
    const i = flowSlide();
    const hiddenPlaced = { ...i, placement: { bodies: [placed("c1", view(i.frames[0].first), false)] } };
    expect(planCards(hiddenPlaced).refused).toEqual(["c1"]);
    const hiddenSince = { ...i, stillShown: () => false };
    const out = planCards(hiddenSince);
    expect(out.refused).toEqual(["c1"]);
    expect(out.reasons.c1).toBe("hidden since the placement");
  });

  test("shrink then move carries the running rect across both beats, and a size change is a crossing", () => {
    const { cards, refused } = planCards(sizeChange());
    expect(refused).toEqual([]);
    const [c] = cards;
    expect(c.beats.map((b) => b.kind)).toEqual(["shrink", "move"]);
    expect(c.beats[0].from).toEqual({ x: 30, y: 30, width: 620, height: 420 });
    expect(c.beats[0].to).toEqual({ x: 30, y: 30, width: 320, height: 420 });
    expect(c.beats[1].from).toEqual(c.beats[0].to);
    expect(c.beats[1].to).toEqual({ x: 330, y: 30, width: 320, height: 420 });
    expect(c.landing).toEqual(c.beats[1].to);
    expect(c.crossing).toEqual({ width: 320, height: 420 });
  });

  test("a plan solves exactly when one of its planned cards carries a crossing", () => {
    expect(planCards(sizeChange()).solves).toBe(true);
    expect(planCards(flowSlide()).solves).toBe(false);
    expect(planCards(stackMove()).solves).toBe(false);
    expect(planCards(arrival()).solves).toBe(false);
    // A refused card's crossing is no card's: nothing planned, nothing solves.
    expect(planCards(stalePlacement()).solves).toBe(false);
  });

  test("a split's revealed member, a zero-length beat from the stacked rect to its tile, is a crossing", () => {
    const run = { x: 40, y: 40, width: 500, height: 620 };
    const tile = { x: 40, y: 360, width: 500, height: 300 };
    const beat: FrameBeat = {
      kind: "move",
      terms: { dx: run.x - tile.x, dy: run.y - tile.y, width: [run.width, tile.width], height: [run.height, tile.height] },
      delayMs: 0,
      durationMs: 0,
      progress: [0, 1],
    };
    const out = planCards(input([{ paneId: "r", first: run, last: tile, beats: [beat] }], { r: ["cr"] }));
    expect(out.refused).toEqual([]);
    const [c] = out.cards;
    expect(c.beats).toHaveLength(1);
    expect(c.beats[0].durationMs).toBe(0);
    expect(c.beats[0].from).toEqual(view(run));
    expect(c.landing).toEqual(view(tile));
    expect(c.crossing).toEqual({ width: view(tile).width, height: view(tile).height });
    expect(out.solves).toBe(true);
  });

  test("a stack's retiring member, held at its tile and landing at the full run at the span's end, is a crossing", () => {
    const tile = { x: 40, y: 360, width: 500, height: 300 };
    const run = { x: 40, y: 40, width: 500, height: 620 };
    const spanMs = 420;
    const beats: FrameBeat[] = [
      { kind: "move", terms: { dx: 0, dy: 0 }, delayMs: 0, durationMs: spanMs, progress: [0, 1] },
      {
        kind: "move",
        terms: { dx: tile.x - run.x, dy: tile.y - run.y, width: [tile.width, run.width], height: [tile.height, run.height] },
        delayMs: spanMs,
        durationMs: 0,
        progress: [0, 1],
      },
    ];
    const out = planCards(input([{ paneId: "h", first: tile, last: run, beats }], { h: ["ch"] }));
    expect(out.refused).toEqual([]);
    const [c] = out.cards;
    expect(c.beats[0].from).toEqual(view(tile));
    expect(c.beats[0].to).toEqual(view(tile));
    expect(c.beats[1].delayMs).toBe(spanMs);
    expect(c.beats[1].to).toEqual(view(run));
    expect(c.landing).toEqual(view(run));
    expect(c.crossing).toEqual({ width: view(run).width, height: view(run).height });
    expect(out.solves).toBe(true);
  });

  test("a frame whose walk misses its Last rect by more than half a pixel refuses its cards", () => {
    const first = { x: 40, y: 40, width: 500, height: 300 };
    const off = input([{ paneId: "p", first, last: { ...first, width: 480 }, beats: [moveBeat(0, 0)] }], { p: ["c"] });
    const out = planCards(off);
    expect(out.refused).toEqual(["c"]);
    expect(out.reasons.c).toContain("not the frame's Last");
    const near = input([{ paneId: "p", first, last: { ...first, x: first.x + 0.4 }, beats: [moveBeat(0, 0)] }], { p: ["c"] });
    expect(planCards(near).refused).toEqual([]);
  });

  test("every card of a refused frame is refused; a frame holding no card plans nothing", () => {
    const first = { x: 40, y: 40, width: 500, height: 300 };
    const none = input([{ paneId: "p", first, last: first, beats: [] }], { p: ["a", "b"] });
    const out = planCards(none);
    expect(out.cards).toEqual([]);
    expect(out.refused).toEqual(["a", "b"]);
    expect(out.reasons.a).toBe("the frame carries no beat");
    const empty = planCards(input([{ paneId: "p", first, last: first, beats: [moveBeat(0, 0)] }], {}));
    expect(empty).toEqual({ cards: [], solves: false, refused: [], reasons: {} });
  });
});

describe("runCardPlan", () => {
  test("says what the installed runner posted, and null with none installed", () => {
    const input = { frames: [], startTime: 0, factor: 1 };
    installCardPlanRunner(null);
    expect(runCardPlan(input)).toBeNull();
    installCardPlanRunner(() => ({ planId: 4, solves: true }));
    expect(runCardPlan(input)).toEqual({ planId: 4, solves: true });
    installCardPlanRunner(() => null);
    expect(runCardPlan(input)).toBeNull();
    installCardPlanRunner(null);
  });
});

describe("card-plan-parity.json", () => {
  test("the checked-in fixture is what the planner writes", () => {
    const cases: { name: string; refused: string[]; plan: CardPlan }[] = [
      ["flow-slide", flowSlide()],
      ["stack-move", stackMove()],
      ["stale-placement", stalePlacement()],
      ["size-change", sizeChange()],
      ["arrival", arrival()],
    ].map(([name, i], index) => {
      const out = planCards(i as CardPlanInput);
      return { name: name as string, refused: out.refused, plan: { planId: index + 1, startWallMs: 1_760_000_000_000 + index * 1000, solves: out.solves, cards: out.cards } };
    });
    const serialized = `${JSON.stringify(cases, null, 2)}\n`;
    if (process.env.CARD_PLAN_GOLDEN_UPDATE === "1") writeFileSync(GOLDEN_PATH, serialized);
    expect(serialized, "the planner's plans moved: review the diff, then regenerate with CARD_PLAN_GOLDEN_UPDATE=1").toBe(
      readFileSync(GOLDEN_PATH, "utf8"),
    );
  });
});
