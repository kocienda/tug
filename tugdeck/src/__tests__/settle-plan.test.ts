/**
 * The settle's plan, as data in and a plan out.
 *
 * The per-gesture settle app-tests read the settle off a running deck: a
 * gesture that moves nothing arms nothing, a slide raises no resize episode,
 * a hand-lifted strip launches from the gesture, and the beats run back to
 * back — shrink, move, grow — with no hole at a seam (`at0566`) and a prepare
 * beat only where a fold, an arrival or a settling width owes one. Each of
 * those is a decision `settle-plan.ts` makes from data, so each is read here
 * from data, in milliseconds.
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 */

import { describe, expect, test } from "bun:test";

import {
  BEAT_RECIPE,
  armPath,
  arrangementSignature,
  holdCapMs,
  launchedBeats,
  planSettleSchedule,
  readArmChange,
  type ArmPathInputs,
} from "@/components/chrome/settle-plan";
import type { DeckState, TugPaneState } from "@/layout-tree";
import { ARRIVAL_PREPARE_MS, FOLD_PREPARE_MS } from "@/lib/fold-crossing";
import { motionDurationMs } from "@/lib/imposer-motion";
import { BEAT_ORDER, type BeatKind } from "@/lib/pane-flip";

// ---- Decks ----

const RUNS = { rail: null, column: null };

function pane(id: string, extra: Partial<TugPaneState> = {}): TugPaneState {
  return {
    id,
    position: { x: 20, y: 20 },
    size: { width: 400, height: 300 },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: "",
    acceptsFamilies: ["standard"],
    ...extra,
  };
}

function deck(panes: readonly TugPaneState[], extra: Partial<DeckState> = {}): DeckState {
  return {
    cards: panes.flatMap((p) =>
      p.cardIds.map((id) => ({ id, componentId: "probe", title: id, closable: true })),
    ),
    panes,
    activePaneId: panes[0]?.id,
    imposition: { sidebars: {} },
    hasFocus: true,
    ...extra,
  };
}

const sig = (state: DeckState) => arrangementSignature(state, RUNS);
const base = () => deck([pane("a"), pane("b"), pane("c")]);

// ---- What arms a settle ----

describe("arrangementSignature: what a commit is read against", () => {
  test("z-order and activation move nothing: the signature is blind to both", () => {
    const before = base();
    const raised = deck([pane("c"), pane("a"), pane("b")], { activePaneId: "c" });
    expect(sig(raised)).toEqual(sig(before));
  });

  test("a pane's width and its folded flag are terms, in the size half too", () => {
    const wider = deck([pane("a", { size: { width: 500, height: 300 } }), pane("b"), pane("c")]);
    const folded = deck([pane("a", { folded: true }), pane("b"), pane("c")]);
    for (const moved of [wider, folded]) {
      expect(sig(moved).full).not.toBe(sig(base()).full);
      expect(sig(moved).size).not.toBe(sig(base()).size);
    }
  });

  test("a stored height is not a term: a pointer writing it live arms nothing", () => {
    const taller = deck([pane("a", { size: { width: 400, height: 900 } }), pane("b"), pane("c")]);
    expect(sig(taller)).toEqual(sig(base()));
  });

  test("the flow offset is in the full signature only, rounded to the pixel", () => {
    const slid = deck(base().panes, { flowOffset: 120 });
    expect(sig(slid).full).not.toBe(sig(base()).full);
    expect(sig(slid).size).toBe(sig(base()).size);
    expect(sig(slid).sansOffset).toBe(sig(base()).sansOffset);
    const churn = (offset: number) => sig(deck(base().panes, { flowOffset: offset })).full;
    expect(churn(120.2)).toBe(churn(119.8));
  });

  test("a pane's slot is in the full and offset-less signatures, not the size half", () => {
    const slotted = deck([pane("a", { slot: 1 }), pane("b"), pane("c")]);
    expect(sig(slotted).full).not.toBe(sig(base()).full);
    expect(sig(slotted).sansOffset).not.toBe(sig(base()).sansOffset);
    expect(sig(slotted).size).toBe(sig(base()).size);
  });

  test("an arriving pane and a departing pane are no terms of the arrangement", () => {
    const survivors = deck([pane("a"), pane("b")]);
    const arriving = deck([pane("a"), pane("b"), pane("c")], { arriving: { "c": true } });
    const departing = deck([pane("a"), pane("b"), pane("c")], { departing: { "c": true } });
    expect(sig(arriving)).toEqual(sig(survivors));
    expect(sig(departing)).toEqual(sig(survivors));
  });
});

describe("readArmChange: what the commit changed", () => {
  test("an unchanged signature is unchanged", () => {
    expect(readArmChange(sig(base()), sig(base()))).toEqual({ unchanged: true });
  });

  test("a slide along the band is flow-only and no resize", () => {
    const change = readArmChange(sig(base()), sig(deck(base().panes, { flowOffset: 300 })));
    expect(change).toEqual({ unchanged: false, sizeChanged: false, flowOnly: true });
  });

  test("a width change is a resize and not a slide", () => {
    const wider = deck([pane("a", { size: { width: 500, height: 300 } }), pane("b"), pane("c")]);
    expect(readArmChange(sig(base()), sig(wider))).toEqual({
      unchanged: false,
      sizeChanged: true,
      flowOnly: false,
    });
  });

  test("a slot move is neither: the frame travels, its scrollers keep their lines", () => {
    const slotted = deck([pane("a", { slot: 1 }), pane("b"), pane("c")]);
    expect(readArmChange(sig(base()), sig(slotted))).toEqual({
      unchanged: false,
      sizeChanged: false,
      flowOnly: false,
    });
  });
});

// ---- Which path the arm takes ----

const liftedSlide: ArmPathInputs = {
  motionEnabled: true,
  switching: false,
  flowOnly: true,
  handVelocity: 2.5,
  flowOrigin: 0,
  nextFlowOffset: 300,
  tweensRunning: 0,
  firstRectsPending: 0,
  arrivalsPending: 0,
};

describe("armPath: cut, prelaunch, or measure", () => {
  test("a strip a hand let go of launches from the gesture, and measures nothing", () => {
    expect(armPath(liftedSlide)).toEqual({ motion: true, prelaunch: true, measure: false });
  });

  test("reduced motion and a switch epoch animate nothing and measure nothing", () => {
    for (const inputs of [{ ...liftedSlide, motionEnabled: false }, { ...liftedSlide, switching: true }]) {
      expect(armPath(inputs)).toEqual({ motion: false, prelaunch: false, measure: false });
    }
  });

  test("every other slide is set up and goes: it measures", () => {
    const measured = { motion: true, prelaunch: false, measure: true };
    expect(armPath({ ...liftedSlide, handVelocity: null })).toEqual(measured);
    expect(armPath({ ...liftedSlide, flowOnly: false })).toEqual(measured);
    expect(armPath({ ...liftedSlide, nextFlowOffset: 0 })).toEqual(measured);
    expect(armPath({ ...liftedSlide, tweensRunning: 1 })).toEqual(measured);
    expect(armPath({ ...liftedSlide, arrivalsPending: 1 })).toEqual(measured);
  });

  test("an earlier arm's unrendered measurement is never discarded by a prelaunch", () => {
    expect(armPath({ ...liftedSlide, firstRectsPending: 3 }).prelaunch).toBe(false);
  });
});

// ---- What launches, in what order, under what budget ----

const DURATION = 400;
const dur = (kind: BeatKind) => motionDurationMs(BEAT_RECIPE[kind], DURATION);
const beatsOf = (...kinds: BeatKind[]) => [kinds.map((kind) => ({ kind }))];

describe("launchedBeats: a beat no frame has a term in is skipped", () => {
  test("the everyday stack move is one move beat", () => {
    expect(launchedBeats(beatsOf("move"), 0, 0)).toEqual(["move"]);
  });

  test("a resize runs shrink, move, grow, in that order, whichever frame plans them", () => {
    expect(launchedBeats([[{ kind: "grow" }], [{ kind: "move" }, { kind: "shrink" }]], 0, 0)).toEqual([
      "shrink",
      "move",
      "grow",
    ]);
  });

  test("the outer beats launch for an arrival or a departure, which no frame plans", () => {
    expect(launchedBeats(beatsOf("room"), 1, 1)).toEqual(["depart", "room", "arrive"]);
  });
});

describe("planSettleSchedule: back to back, with a prepare only where one is owed", () => {
  const plain = { arrivals: 0, widthSettles: false, opensFoldCrossing: false, durationMs: DURATION };

  test("every beat is scheduled, in BEAT_ORDER", () => {
    const { beats } = planSettleSchedule({ ...plain, launched: ["move"] });
    expect(beats.map((b) => b.kind)).toEqual([...BEAT_ORDER]);
  });

  test("each launched beat begins the moment the one before it ends: no seam", () => {
    const { beats, totalMs, prepareMs } = planSettleSchedule({
      ...plain,
      launched: ["shrink", "move", "grow"],
    });
    const at = (kind: BeatKind) => beats.find((b) => b.kind === kind)!;
    expect(prepareMs).toBe(0);
    expect(at("shrink").delayMs).toBe(0);
    expect(at("move").delayMs).toBe(dur("shrink"));
    expect(at("grow").delayMs).toBe(dur("shrink") + dur("move"));
    expect(totalMs).toBe(dur("shrink") + dur("move") + dur("grow"));
  });

  test("an unlaunched beat runs empty and takes no time", () => {
    const { beats, totalMs } = planSettleSchedule({ ...plain, launched: ["move"] });
    expect(beats.filter((b) => b.launched).map((b) => b.kind)).toEqual(["move"]);
    for (const b of beats) expect(b.delayMs).toBe(b.kind === "grow" || b.kind === "arrive" ? dur("move") : 0);
    expect(totalMs).toBe(dur("move"));
  });

  test("a fold it opens holds every beat off by the fold's prepare; one it adopts does not", () => {
    const opened = planSettleSchedule({ ...plain, launched: ["move"], opensFoldCrossing: true });
    expect(opened.prepareMs).toBe(FOLD_PREPARE_MS);
    expect(opened.beats.find((b) => b.kind === "move")!.delayMs).toBe(FOLD_PREPARE_MS);
    expect(opened.totalMs).toBe(FOLD_PREPARE_MS + dur("move"));
    expect(opened.lateClose).toBe(false);
  });

  test("an arrival or a settling width takes the longer prepare, and closes the gate late", () => {
    for (const owed of [{ arrivals: 1 }, { widthSettles: true }]) {
      const plan = planSettleSchedule({ ...plain, ...owed, launched: ["move"], opensFoldCrossing: true });
      expect(plan.lateClose).toBe(true);
      expect(plan.prepareMs).toBe(ARRIVAL_PREPARE_MS);
    }
    expect(ARRIVAL_PREPARE_MS).toBeGreaterThan(FOLD_PREPARE_MS);
  });
});

describe("holdCapMs: a wedge guard that never fires mid-motion", () => {
  test("twice the window at the deck's timing, floored at a second", () => {
    expect(holdCapMs(800, 1)).toBe(1600);
    expect(holdCapMs(800, 2)).toBe(3200);
    expect(holdCapMs(200, 1)).toBe(1000);
  });
});
