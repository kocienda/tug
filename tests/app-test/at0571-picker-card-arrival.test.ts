/**
 * at0571-picker-card-arrival.test.ts — a Session card's arrival is TWO
 * motions, and the height it arrives at was known before the commit.
 *
 * ## What this gates
 *
 * Opening a Session card into a split column used to be one commit's worth of
 * everything at once: the neighbour shrank, the new frame slid and faded in
 * over the same window, and the picker's sheet came up on a clock that had
 * been guessed at rather than measured — a card still travelling when its
 * sheet began to rise, and a sheet clamped against a frame whose height was
 * changing under it. What the reader saw was hitching, and a picker that
 * arrived at the wrong size in the wrong place.
 *
 * Then it was three: a shrink, an arrive, and a sheet that waited on
 * `cardDidArrive`. Three is one too many. An arrival is one thing happening —
 * the column re-dividing to seat a newcomer — and the newcomer is not a second
 * event that follows it. So the arrangement change and the newcomer's entrance
 * are FUSED into a single `room` beat, the card's own entrance rides the
 * second, and the picker rides the frame rather than waiting behind a beat it
 * cannot see ([P07], [P08]).
 *
 * The height the card arrives at is MEASURED, and measured BEFORE the commit
 * that appends the pane ([P02]). The card type declares an opening form; the
 * deck renders that form off-screen at the width the pane is about to stand
 * at, reads the panel's natural height, and writes the member floor it derives
 * from it as the opening bid inside the same commit. Nothing in this file
 * names a declared height any more, because there is no longer one to name:
 * the number this test reads off the live store is a number the app measured
 * seconds earlier, and the assertion is that the picker the user then sees
 * reports exactly it ([P04]).
 *
 * The claims are read over the frames the imposer itself marks, against the
 * beat it names on each one (`data-imposer-beat` on the canvas), which is what
 * `runBeat` writes the attribute for. Nothing here depends on a wall-clock
 * window:
 *
 *   1. **The arrival is exactly `room` then `arrive`, and nothing else.** No
 *      `shrink`, no `move`, no `grow`, no `depart`. Two motions is the
 *      contract, and a census naming a third is the contract broken.
 *   2. **The picker is on the frame from the first frame the reader can see
 *      it.** On the arriving frame's first sample whose computed opacity is
 *      above 0, the picker's panel is already in the document, and it is there
 *      on every sample after. This is the exact reverse of what this file used
 *      to assert: the picker waited for the beats to end, which is what made
 *      the arrival three motions instead of two.
 *   3. **Nothing re-targets the settle once it is launched.** Exactly one
 *      armed `settle-arm` is recorded across the whole gesture. A second one
 *      is a number that arrived late — the defect the pre-commit measure
 *      exists to remove — and the trace is where it would show.
 *   4. **The bid was measured, and the picker agrees with it.** The opening
 *      bid keyed by the new pane is present, the newcomer stands at least
 *      there, and the bid equals the live panel's own natural height put
 *      through the same chrome arithmetic the deck used. No
 *      `opening-bid-mismatch` row is recorded, which is the app's own
 *      statement that the first live report and the bid were the same number.
 *   5. **Nothing is left behind.** At rest no frame carries an inline
 *      `opacity`, the canvas carries neither `data-imposer-settling` nor
 *      `data-imposer-beat`, and no exit ghost is in the document. An opacity
 *      hold left on a settled frame is a card the reader cannot see.
 *
 * The second test is the departure, which is the same design read backwards
 * and is also two motions: `depart`, then `room`. The ghost that stands where
 * the card was is a BLANK TILE carrying nothing, which is what a departure
 * has been since the clone planted inside it was retired — a copy of a card
 * leaves behind everything about the card that is not DOM.
 *
 * The sitting member is a `hello` card rather than a second Session card for
 * `at0569`'s reason: an unbound Session card raises its picker the moment it
 * activates, and a fixture with two of them has two pickers up and two claims
 * against one run.
 *
 * The third test is the ROOMY column — the case from the screenshot, and the
 * one no app-test has ever driven. The sitter folds first, so the column has
 * hundreds of pixels the sitter's tier does not claim, and then the same
 * production arrival runs. The newcomer takes that room instead of standing at
 * the height it bid with a dead band beneath it, the folded sitter does not
 * move at all, and the column's last member reaches the run's own bottom.
 * "No band beneath it" is read against the frame in slot 1, which is a single
 * member spanning the same run — a reading that cannot be satisfied by the two
 * heights the claim is about.
 *
 * Every one of those three drives a Session card into a split column, and a
 * split column is not a landing place: a new card goes to one only when
 * nothing else will take it. So their fixture SEALS slot 1 — it holds the
 * focused card in a split of its own — and the arrival they read is the
 * fallback, the bottom of the nearest split. The fourth test is the ordinary
 * deck: the same split, with an empty slot beside it, and the card opens in
 * the empty slot, picker and all.
 *
 * `@covers` names the planner that partitions a settle's terms into beats, the
 * lifecycle channel the card's activation runs through, the settle-end notice
 * the clamp measures from, and the allocator that divides the column — the
 * arrival's own weight is derived there ({@link arrivalSharesOf}), and the
 * roomy claim below is a claim about what that division does.
 *
 * Two modules this file is unmistakably about are deliberately NOT named, for
 * the same reason and by the same precedent. `deck-canvas.tsx`, which plans
 * and launches every beat asserted here, stands at its recorded fan-out of 21,
 * one past the selection budget; so does `session-card.tsx`, where the picker
 * is raised. Recorded debt may be paid down but never refinanced, so naming
 * either would be refused outright on the commit that did it — which is
 * exactly the call `at0563` made about the same two modules, and `at0569`
 * about the second. What stands in their place are the seams each reaches this
 * choreography through: `pane-flip.ts` owns the beat order and the partition
 * the canvas launches, and `card-lifecycle.ts` owns the channel the picker's
 * presentation rides. An edit that changes which beats run, or when a card is
 * said to have activated, selects this file through one of those.
 *
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/card-lifecycle.ts
 * @covers tugdeck/src/lib/settle-notice.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/opening-placement.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { IMPOSITION_GAP_PX } from "../../tugdeck/src/lib/layout-imposer";
import {
  pickerPanelNaturalHeight,
  pointPickerAt,
  removePickerSessions,
  seedPickerSessions,
  type PickerSessionsFixture,
} from "./picker-sessions-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/**
 * What the deck adds between a sheet's panel and the member under it —
 * `memberFloorForSheetPanel`'s sum, copied for the reason `at0569` carries the
 * same copy: `--jsx` is off here, so nothing under `components/` can be
 * imported, and `lib/sheet-reservation.ts` reaches the card registry through
 * the `@` alias this file does not resolve.
 *
 * 37 (the pane's title bar and the 1px its sheet clip drops below it) + 32
 * (`SHEET_CANVAS_GAP`) − 5 (`IMPOSITION_GAP_PX`, the gap already under a
 * column's last member). This is the ONLY number in this file, and it is a
 * shape rather than a height: it is what turns the panel the app measured into
 * the member floor the app bid, so claim 4 can put the two on the same footing
 * without either of them being written down anywhere.
 */
const SHEET_PANEL_TO_MEMBER_PX = 64;

/**
 * How far the bid may sit from a fresh reading of the live panel.
 *
 * The two use the identical formula over the identical component, so this is
 * not a tolerance on the arithmetic — it is a tolerance on WHEN: the bid was
 * read off an off-screen render taken before the commit, and this reading is
 * taken off the live panel after it. Sub-pixel layout rounding is the whole of
 * what may differ, and the alternatives a wrong bid would be — a constant, the
 * frame, the stack floor — are tens or hundreds of pixels away.
 */
const BID_DRIFT_PX = 1;

/**
 * A project whose Sessions list stands at its 14.5rem cap, so the picker the
 * arriving card raises is the one a real project presents rather than the
 * one-row picker of a fresh instance.
 */
let fixture: PickerSessionsFixture | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  fixture = seedPickerSessions("at0571");
});

afterAll(() => {
  removePickerSessions(fixture);
});

/** The seeded panes. Everything else on the canvas arrived at run time. */
const SEEDED_PANES = ["p1", "p3"] as const;
/** The member that makes the room: slot 0's sitting `hello` card. */
const SITTER = "p1";

const PICKER_FORM = ".session-card-picker-form";
const EXIT_GHOST = ".tug-pane-exit-ghost";
const SHEET_PANEL = '[data-slot="tug-sheet"].tug-sheet-content';

/**
 * The tier a folded `hello` pane stands at: the card registers no folded
 * policy, so the folded form falls back to its `sizePolicy.min.height`
 * (`hello-world-card.tsx`). Copied for the reason every other constant here
 * is, and a copy that drifts fails the roomy test rather than passing quietly.
 */
const SITTER_FOLDED_TIER_PX = 150;

/**
 * How long each sampler runs. The arrival at the default tune is a shrink beat
 * and an arrive beat, each 0.6× the 400ms nominal, and the sampler runs well
 * past the pair so the rest frames and the sheet's own enter are in the record.
 */
const CENSUS_MS = 1_600;
/** The whole choreography's window, with room for the last beat to land. */
const AFTER_LAND_MS = 1_800;
/** Geometry tolerance: sub-pixel layout rounding, never a real disagreement. */
const EPSILON = 1.5;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * A two-up whose slot 0 holds one `hello` card in a SPLIT column, and whose
 * slot 1 is SEALED: it holds the focused card, in a split column of its own.
 *
 * Slot 0 is split with a single member on purpose: splitting a slot that holds
 * one card is a legal committed state, and it is what makes the card added
 * below join as a second MEMBER rather than as a second card on a stack. A
 * stacked arrival moves nothing and would make every claim here vacuous.
 *
 * A split column is not a landing place, so a new card goes to one only when
 * nothing else will take it — and this fixture is that deck. The new card is
 * ranked from the focused card, whose own slot it never covers, and the one
 * slot left is the split at slot 0; slot 1 being split as well means no
 * anchor could find anything better. What the three tests below drive is the
 * fallback: the bottom of the nearest split.
 *
 * No `openingBids` here, and that is the point of this fixture against
 * `at0569`'s: the pin under test is the one `addCard` writes.
 */
function deckShape() {
  const pane = (id: string, cardId: string, slot: number) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 600, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "hello", title: "Card A", closable: true },
      { id: "C", componentId: "hello", title: "Card C", closable: true },
    ],
    panes: [pane("p1", "A", 0), pane("p3", "C", 1)],
    activePaneId: "p3",
    imposition: {
      kind: "two-up",
      sidebars: {},
      columns: {
        0: { mode: "split", order: ["p1"] },
        1: { mode: "split", order: ["p3"] },
      },
    },
    hasFocus: true,
  };
}

/**
 * The same sitter's split column, with an EMPTY slot 1 beside it and the other
 * card moved out to slot 2 — the deck a new card should never open into a
 * split on. Focus stays on the sitter, so the arrival is ranked from slot 0.
 */
function openDeckShape() {
  const shape = deckShape();
  return {
    ...shape,
    panes: [shape.panes[0], { ...shape.panes[1], slot: 2 }],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p1"] } },
    },
  };
}

interface Sample {
  t: number;
  /** Whether the canvas carried the settle mark on this frame. */
  settling: boolean;
  /** The beat the imposer named on this frame, `""` outside a beat. */
  beat: string;
  /** Every live frame's height, keyed by pane id. */
  heights: Record<string, number>;
  /** Every live frame's COMPUTED opacity, keyed by pane id. */
  opacity: Record<string, string>;
  /** Every live frame's INLINE opacity — a hold, or `""`. */
  inlineOpacity: Record<string, string>;
  /** Whether the picker's panel was in the document. */
  picker: boolean;
  /** How many session rows the picker's list showed on this frame. */
  rows: number;
  /**
   * The number the deck HELD for each member on this frame: its opening bid
   * while one stands, else its sheet reservation.
   *
   * One number rather than the bid alone, because a bid does not survive
   * being agreed with: the first live report that matches it hands the number
   * over to the member's sheet reservation and clears the bid in the same
   * commit ([B02]) — and the picker now mounts inside the arrival's own task,
   * so that handoff lands before the first frame this sampler sees. What the
   * settle divides against is the held number, whichever record carries it.
   */
  held: Record<string, number>;
  /** How many exit ghosts stood on the canvas. */
  ghosts: number;
  /** How many nodes stood INSIDE the ghosts. A departure is a blank tile. */
  ghostCarried: number;
}

/**
 * Arm a per-frame sampler, run one gesture, and hand back what it saw.
 *
 * Installed BEFORE the gesture and reading on `requestAnimationFrame`, so the
 * first sample is the pre-motion geometry and every frame of the motion is in
 * the record. Frames are collected by walking `.tug-pane[data-pane-id]` rather
 * than by naming ids, because the frame under test is the one that did not
 * exist when the sampler was written: its pane id is a fresh UUID.
 *
 * Opacity is read twice on purpose. The COMPUTED value is what the reader sees
 * and is what claim 1 is about; the INLINE value is where the hold actually
 * lives, and claim 5's residue check is about that one.
 */
async function census(app: App, gesture: string): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0571 = [];
      var t0 = performance.now();
      var tick = function () {
        var canvas = document.querySelector("[data-imposer-settling]");
        var sample = {
          t: performance.now() - t0,
          settling: canvas !== null,
          beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
          heights: {},
          opacity: {},
          inlineOpacity: {},
          picker: document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null,
          ghosts: document.querySelectorAll(${JSON.stringify(EXIT_GHOST)}).length,
        };
        var state = window.tugdeck.diag.getDeckState();
        var bids = state.openingBids || {};
        var claims = state.sheetReservations || {};
        sample.held = {};
        for (var key in claims) sample.held[key] = claims[key];
        for (var key in bids) sample.held[key] = bids[key];
        sample.rows = document.querySelectorAll('[data-testid="session-card-picker-session-resume"]').length;
        var tiles = document.querySelectorAll(${JSON.stringify(EXIT_GHOST)});
        sample.ghostCarried = 0;
        for (var g = 0; g < tiles.length; g += 1) {
          sample.ghostCarried += tiles[g].childNodes.length;
        }
        var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
        for (var i = 0; i < frames.length; i += 1) {
          var el = frames[i];
          var id = el.getAttribute("data-pane-id");
          sample.heights[id] = el.getBoundingClientRect().height;
          sample.opacity[id] = getComputedStyle(el).opacity;
          sample.inlineOpacity[id] = el.style.opacity;
        }
        window.__at0571.push(sample);
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(`(${gesture}, null)`);
  await wait(CENSUS_MS + 300);
  return app.evalJS<Sample[]>(`window.__at0571`);
}

/**
 * Turn the deck's own trace on and take a mark, so `traceSince` below can read
 * exactly the events one gesture produced.
 *
 * `settle-arm` records only while the trace is enabled; `opening-bid-mismatch`
 * is an always-recorded kind and would be there either way. Enabling costs the
 * canvas a record per arm, which is nothing beside the rAF sampler already
 * running over the same window.
 */
async function traceMark(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      window.__deckTrace.enable(true);
      return window.__deckTrace.mark();
    })()`,
  );
}

/** The kinds this file reads back, counted over the events since `mark`. */
async function traceSince(
  app: App,
  mark: number,
): Promise<{
  armedArms: number;
  arms: number;
  reservationNotifies: number;
  mismatches: { memberId: string; bid: number; report: number }[];
}> {
  return app.evalJS(
    `(function () {
      var events = window.__deckTrace.since(${mark});
      var arms = 0;
      var armedArms = 0;
      var reservationNotifies = 0;
      var mismatches = [];
      for (var i = 0; i < events.length; i += 1) {
        var e = events[i];
        if (e.kind === "settle-arm") {
          arms += 1;
          if (e.armed === true) armedArms += 1;
        } else if (e.kind === "store-notify" && e.caller === "setSheetReservation") {
          reservationNotifies += 1;
        } else if (e.kind === "opening-bid-mismatch") {
          mismatches.push({ memberId: e.memberId, bid: e.bid, report: e.report });
        }
      }
      return { arms: arms, armedArms: armedArms, reservationNotifies: reservationNotifies, mismatches: mismatches };
    })()`,
  );
}

/** The samples the imposer named a given beat on. */
function beatFrames(samples: Sample[], beat: string): Sample[] {
  return samples.filter((s) => s.beat === beat);
}

/** The beats the settle ran, in the order they were first seen. */
function beatOrder(samples: Sample[]): string[] {
  const seen: string[] = [];
  for (const s of samples) {
    if (s.beat !== "" && seen[seen.length - 1] !== s.beat) seen.push(s.beat);
  }
  return seen;
}

/** The pane ids the sampler saw that the fixture did not seed. */
function arrivedPanes(samples: Sample[]): string[] {
  const ids = new Set<string>();
  for (const s of samples) {
    for (const id of Object.keys(s.heights)) {
      if (!SEEDED_PANES.includes(id as (typeof SEEDED_PANES)[number])) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** The extent a picked series covered across the samples it was seen in. */
function spread(samples: Sample[], pick: (s: Sample) => number): number {
  const values = samples.map(pick).filter((v) => v > 0);
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

/** The largest frame-to-frame height change any frame took across `samples`. */
function worstHeightStep(samples: Sample[]): { pane: string; step: number } {
  let worst = { pane: "", step: 0 };
  for (let i = 1; i < samples.length; i += 1) {
    const before = samples[i - 1].heights;
    const after = samples[i].heights;
    for (const pane of Object.keys(after)) {
      if (before[pane] === undefined) continue;
      const step = Math.abs(after[pane] - before[pane]);
      if (step > worst.step) worst = { pane, step };
    }
  }
  return worst;
}

/** The canvas's marks and the residue every frame carries, at rest. */
async function atRest(app: App): Promise<{
  settling: boolean;
  beat: string | null;
  inlineOpacities: string[];
  ghosts: number;
  picker: boolean;
}> {
  return app.evalJS(
    `(function () {
      var canvas = document.querySelector("[data-imposer-settling]");
      var withBeat = document.querySelector("[data-imposer-beat]");
      var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
      var inline = [];
      for (var i = 0; i < frames.length; i += 1) {
        if (frames[i].style.opacity !== "") inline.push(frames[i].style.opacity);
      }
      return {
        settling: canvas !== null,
        beat: withBeat === null ? null : withBeat.getAttribute("data-imposer-beat"),
        inlineOpacities: inline,
        ghosts: document.querySelectorAll(${JSON.stringify(EXIT_GHOST)}).length,
        picker: document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null,
      };
    })()`,
  );
}

interface Rect {
  top: number;
  bottom: number;
  height: number;
}

/** Every named pane's live frame, in viewport coordinates. */
async function paneRects(
  app: App,
  paneIds: readonly string[],
): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      ${JSON.stringify(paneIds)}.forEach(function (id) {
        var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
        if (el === null) return;
        var r = el.getBoundingClientRect();
        out[id] = { top: r.top, bottom: r.bottom, height: r.height };
      });
      return out;
    })()`,
  );
}

/**
 * The pane id on the canvas the fixture did not seed — the arrival, read from
 * the document rather than from the sampler, for the tests that add a card
 * without taking a census.
 */
async function arrivedPaneId(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var seeded = ${JSON.stringify(SEEDED_PANES)};
      var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
      for (var i = 0; i < frames.length; i += 1) {
        var id = frames[i].getAttribute("data-pane-id");
        if (seeded.indexOf(id) === -1) return id;
      }
      return null;
    })()`,
  );
}

/**
 * Whether the picker's panel is capped short inside pane `paneId`, and how far
 * its bottom edge sits inside that pane's frame.
 *
 * `at0569`'s two readings, in its own words: `overflow` is the panel capped
 * against the canvas, and `bottomSlack` is the panel hanging past the FRAME,
 * which the clip's `overflow: hidden` would cut without touching
 * `scrollHeight`. A card that took the room has to hold the picker whole, and
 * this is the half of that claim the roomy case can make.
 */
async function panelFit(
  app: App,
  paneId: string,
): Promise<{ overflow: number; bottomSlack: number } | null> {
  return app.evalJS<{ overflow: number; bottomSlack: number } | null>(
    `(function () {
      var pane = document.querySelector('.tug-pane[data-pane-id="' + ${JSON.stringify(paneId)} + '"]');
      if (pane === null) return null;
      var el = pane.querySelector(${JSON.stringify(SHEET_PANEL)});
      if (el === null) return null;
      return {
        overflow: el.scrollHeight - el.clientHeight,
        bottomSlack:
          pane.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom,
      };
    })()`,
  );
}

/** The weights `slot`'s column holds, or `null` when it holds none. */
async function columnShares(
  app: App,
  slot: number,
): Promise<Record<string, number> | null> {
  return app.evalJS<Record<string, number> | null>(
    `(((window.tugdeck.diag.getDeckState().imposition.columns || {})[${slot}] || {}).shares || null)`,
  );
}

/** Whether a pane reads as folded in the deck's own record. */
async function isFolded(app: App, paneId: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `window.__tug.getPaneRecord(${JSON.stringify(paneId)}).folded === true`,
  );
}

/**
 * The number the deck holds for `paneId` — its opening bid while the bid still
 * stands, and its sheet reservation once the first live report has superseded
 * it.
 *
 * They are the same number by the first-report rule ([P04]), so which of the
 * two records it is sitting in is a matter of how far the handoff has got, and
 * no assertion here should depend on that.
 */
async function heldFor(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var s = window.tugdeck.diag.getDeckState();
      var bid = (s.openingBids || {})[${JSON.stringify(paneId)}];
      if (typeof bid === "number") return bid;
      var claim = (s.sheetReservations || {})[${JSON.stringify(paneId)}];
      return typeof claim === "number" ? claim : -1;
    })()`,
  );
}

/**
 * Point the open picker at the seeded project, let the list reach its cap,
 * and print the panel's natural height as it then stands.
 */
async function measureAtListCap(app: App, label: string): Promise<void> {
  if (fixture === null) throw new Error("the picker sessions fixture was not seeded");
  await pointPickerAt(app, fixture);
  await wait(AFTER_LAND_MS);
  const natural = await pickerPanelNaturalHeight(app);
  note(label, `panel natural ${natural ?? -1}px with the list at its cap`);
}

/** Seed the deck, wait for both frames, and let the imposer settle. */
async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
  await app.waitForCondition<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/**
 * Add a Session card the way the app does: the `show-card` control action,
 * which is what a menu item dispatches and which routes to `addCard`.
 *
 * The deck ranks its slot from the focused card: on the sealed fixture that
 * leaves the split at slot 0, and on the open one the empty slot beside it.
 */
const addSessionCard = `window.__tug.dispatchControlAction("show-card", { component: "session" })`;

/** Fold or unfold a card through the registry-routed setter, as `at0553` does. */
const setCardFolded = (cardId: string, folded: boolean): string =>
  `window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(cardId)}, folded: ${folded} })`;

/** Press the picker's Cancel, which closes the host card ([D02] cascade). */
const cancelPicker = `(function () {
  var form = document.querySelector(${JSON.stringify(PICKER_FORM)});
  if (form === null) return null;
  var buttons = form.querySelectorAll(".tug-sheet-actions button");
  for (var i = 0; i < buttons.length; i += 1) {
    if ((buttons[i].textContent || "").trim() === "Cancel") {
      buttons[i].click();
      return null;
    }
  }
  return null;
})()`;

describe.skipIf(!SHOULD_RUN)("AT0571: the divided arrival", () => {
  test(
    "the column makes room and the card rides in on the picker it already measured",
    async () => {
      const app = await launchTugApp({ testName: "at0571-arrival" });
      try {
        await seed(app);
        const runBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="${SITTER}"]').getBoundingClientRect().height`,
        );

        const mark = await traceMark(app);
        const samples = await census(app, addSessionCard);
        const arrived = arrivedPanes(samples);
        note("arrival", `panes arrived: ${JSON.stringify(arrived)}`);
        expect(arrived.length, "exactly one frame arrived").toBe(1);
        const newcomer = arrived[0];

        const order = beatOrder(samples);
        const room = beatFrames(samples, "room");
        const arrive = beatFrames(samples, "arrive");
        note(
          "arrival beats",
          `order=${JSON.stringify(order)} room=${room.length}f arrive=${arrive.length}f run before=${runBefore.toFixed(2)}`,
        );

        // ── 1. TWO MOTIONS. The arrangement change and the newcomer's
        //    entrance are one beat and its successor, and there is no third.
        //    Asserted as the whole census rather than as a presence check, so
        //    a shrink or a move creeping back in fails here rather than
        //    passing under an assertion that only looked for what it wanted
        //    ([P08]). ──
        expect(order, "the arrival is exactly room then arrive").toEqual([
          "room",
          "arrive",
        ]);
        expect(
          room.length,
          "the room beat must be sampled mid-motion",
        ).toBeGreaterThan(3);
        expect(
          arrive.length,
          "the arrive beat must be sampled mid-motion",
        ).toBeGreaterThan(3);

        // 4, next, because 1 to 3 are only claims if there was a real arrival
        // to read them over. The sitter's own height is the motion, and the
        // bid is the number the app measured before it committed.
        const sitterTravel = spread(room, (s) => s.heights[SITTER] ?? 0);
        // Both resting heights are read from the LAST sample rather than from
        // the extreme of the room beat. The beat's last sampled frame is a
        // pixel or so short of where the spring finally lands, and reading the
        // minimum there would build that overshoot into the arithmetic — which
        // is what turned an exact claim into a tolerance on the first run of
        // this file.
        const last = samples[samples.length - 1];
        const sitterRest = last.heights[SITTER] ?? -1;
        const newcomerRest = last.heights[newcomer] ?? -1;
        // The bid the card was REVEALED on, which is the LAST one the deck
        // held while the pane was hidden — not the first the sampler caught.
        // A hidden pane's sheet reports more than once as its list settles
        // (446 then 444, on this fixture), and the reveal spends the most
        // recent report by construction, so the first is a superseded number
        // and the claim below would be asked against a floor the allocator
        // never saw. The first live report hands the bid over and clears it,
        // so the last sample carrying one is the number the reveal used.
        const bidSamples = samples
          .map((s) => s.held[newcomer])
          .filter((v): v is number => typeof v === "number");
        const bid = bidSamples[bidSamples.length - 1] ?? -1;
        note(
          "arrival extent",
          `sitter travel=${sitterTravel.toFixed(2)} run before=${runBefore.toFixed(2)} at rest sitter=${sitterRest.toFixed(2)} newcomer=${newcomerRest.toFixed(2)} held=${bid.toFixed(2)} on ${bidSamples.length} sample(s)`,
        );
        expect(
          bid,
          "addCard measured the opening form and the deck holds the number, on the production path",
        ).toBeGreaterThan(0);
        // The bid is a FLOOR, so the newcomer stands at least there — this
        // fixture's column has nothing spare to lift it past, but the claim is
        // written the way the allocator reads the number rather than the way
        // this run happens to land ([P02]).
        expect(
          newcomerRest,
          "the arriving card stands at least at the height the app bid for it",
        ).toBeGreaterThanOrEqual(bid - EPSILON);
        // And the sitter holds every pixel the newcomer did not take: the two
        // members and the gap between them are the run the sitter held alone.
        expect(
          sitterRest + IMPOSITION_GAP_PX + newcomerRest,
          "the sitter holds every pixel the newcomer did not take",
        ).toBeCloseTo(runBefore, 0);
        expect(
          sitterTravel,
          "and it travelled the whole extent to get there",
        ).toBeGreaterThan(bid * 0.8);

        // ── 2. The picker RIDES THE FRAME. The reverse of what this file
        //    used to assert: on the first sample the arriving frame is visible
        //    at all, the picker is already in the document, and it is there on
        //    every sample after ([P07]). A picker that waited for the beats
        //    would be absent on the first visible sample and would make the
        //    arrival three motions again. ──
        const visible = samples.filter((s) => {
          const o = s.opacity[newcomer];
          return o !== undefined && Number.parseFloat(o) > 0;
        });
        const firstVisible = visible[0];
        const visibleWithoutPicker = visible.filter((s) => !s.picker);
        note(
          "picker",
          `first visible at t=${(firstVisible?.t ?? -1).toFixed(0)}ms beat=${firstVisible?.beat || "none"} picker=${firstVisible?.picker ?? false}; ${visible.length} visible sample(s), ${visibleWithoutPicker.length} without the picker`,
        );
        expect(
          visible.length,
          "the arriving frame becomes visible during the census",
        ).toBeGreaterThan(0);
        expect(
          visibleWithoutPicker.length,
          "the picker is on the frame from the first sample the reader can see it",
        ).toBe(0);

        // ── 3. Nothing re-targeted the settle. One armed arm for the whole
        //    gesture: a second one is a number that landed after the commit
        //    and re-aimed a settle already in flight, which is precisely what
        //    measuring before the commit removes ([P02], [B06]).
        //    4, continued: and the app itself says the first live report and
        //    the bid were the same number, because the guard that would have
        //    recorded a disagreement recorded nothing ([P04], [Spec S04]). ──
        const trace = await traceSince(app, mark);
        note(
          "arrival trace",
          `${trace.armedArms} armed of ${trace.arms} arm(s); mismatches=${JSON.stringify(trace.mismatches)}`,
        );
        expect(
          trace.armedArms,
          "the arrival is one armed settle, and nothing re-targeted it",
        ).toBe(1);
        expect(
          trace.mismatches,
          "no opening-bid mismatch — the first live report was the bid",
        ).toEqual([]);

        // 5. Nothing is left behind.
        await wait(AFTER_LAND_MS);
        const rest = await atRest(app);
        note("arrival at rest", JSON.stringify(rest));
        expect(rest.settling, "the settle mark is off the canvas").toBe(false);
        expect(rest.beat, "and so is the beat attribute").toBeNull();
        expect(
          rest.inlineOpacities,
          "no frame keeps an inline opacity hold",
        ).toEqual([]);
        expect(rest.ghosts, "and no exit ghost stands").toBe(0);
        expect(rest.picker, "the picker is up at rest").toBe(true);

        // ── 4, finished. The bid the app wrote before the commit, against a
        //    fresh reading of the panel the user is now looking at, put
        //    through the same chrome arithmetic the deck used. This is the
        //    arc's whole claim in one comparison, and neither side of it is a
        //    number anybody wrote down. ──
        const liveNatural = await pickerPanelNaturalHeight(app);
        const held = await heldFor(app, newcomer);
        note(
          "bid vs first report",
          `bid=${bid.toFixed(1)} held=${held.toFixed(1)} live panel natural=${(liveNatural ?? -1).toFixed(1)} → member floor ${((liveNatural ?? -1) + SHEET_PANEL_TO_MEMBER_PX).toFixed(1)}`,
        );
        expect(liveNatural, "the picker's panel is on screen").not.toBeNull();
        expect(
          Math.abs(bid - ((liveNatural ?? -1) + SHEET_PANEL_TO_MEMBER_PX)),
          "the bid is the panel the user sees, through the deck's own arithmetic",
        ).toBeLessThanOrEqual(BID_DRIFT_PX);
        // And the handoff carried the same number across: the bid is gone and
        // the member's own claim stands at it, which is what a first report
        // AGREEING with a bid does ([B02]).
        expect(
          Math.abs(held - bid),
          "the number the deck holds for the member is still the number it bid",
        ).toBeLessThanOrEqual(BID_DRIFT_PX);

        // The picker over a project with more sessions than the list's cap
        // holds — the case a real project presents. It comes LAST, because
        // filling the list changes the panel and so the claim above is only
        // readable before it ([P05]: a genuinely-changed picker is an honest
        // update, not a defect).
        await measureAtListCap(app, "arrival picker");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "cancelling the picker takes the card away, and its ghost is a blank tile",
    async () => {
      const app = await launchTugApp({ testName: "at0571-departure" });
      try {
        await seed(app);
        await app.evalJS<null>(`(${addSessionCard}, null)`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);
        await measureAtListCap(app, "departure picker");

        // The height the leaving card stands at, read before it goes: the
        // survivor's travel is measured against it below, and once the card
        // is gone there is nothing left to read it off.
        const leaving = await arrivedPaneId(app);
        expect(leaving, "the card to cancel is on the canvas").not.toBeNull();
        const leavingHeight = (
          await paneRects(app, [leaving ?? ""])
        )[leaving ?? ""].height;

        const samples = await census(app, cancelPicker);
        const order = beatOrder(samples);
        const depart = beatFrames(samples, "depart");
        const room = beatFrames(samples, "room");
        note(
          "departure beats",
          `order=${JSON.stringify(order)} depart=${depart.length}f room=${room.length}f leaving=${leavingHeight.toFixed(1)}`,
        );

        // ── TWO MOTIONS, read backwards. The ghost fades on its own beat,
        //    then the column re-divides in one — there is no separate grow,
        //    because the survivor taking the room back IS the arrangement
        //    change ([P08]). ──
        expect(order, "the departure is exactly depart then room").toEqual([
          "depart",
          "room",
        ]);
        expect(
          depart.length,
          "the depart beat must be sampled mid-motion",
        ).toBeGreaterThan(3);
        expect(
          room.length,
          "the room beat must be sampled mid-motion",
        ).toBeGreaterThan(3);

        // The survivor holds still for the whole of the ghost's fade — the
        // departure's half of "one kind of thing at a time".
        const departStep = worstHeightStep(depart);
        note(
          "departure hold",
          `worst height step during depart: ${departStep.step.toFixed(2)}px on ${departStep.pane || "nothing"}`,
        );
        expect(
          departStep.step,
          "no frame changes size during the depart beat",
        ).toBeLessThan(EPSILON);

        // ── The ghost stands where the card was, and it is a BLANK TILE. The
        //    clone that used to be planted in it is retired: a copy of a card
        //    leaves behind everything about the card that is not DOM, and the
        //    set of such things has no end to enumerate. What survives is the
        //    claim that a departure is marked at all. ──
        const withGhost = samples.filter((s) => s.ghosts > 0);
        note(
          "ghost tile",
          `${withGhost.length} sample(s) with a ghost, ${withGhost.filter((s) => s.ghostCarried > 0).length} carrying anything inside`,
        );
        expect(
          withGhost.length,
          "a ghost stands where the card was",
        ).toBeGreaterThan(0);
        expect(
          withGhost.filter((s) => s.ghostCarried > 0).length,
          "and it is a blank tile — a departure carries nothing inside it",
        ).toBe(0);

        // The ghost is the depart beat's whole subject, so it is gone by the
        // time the survivor takes the room back.
        const ghostsDuringRoom = room.filter((s) => s.ghosts > 0);
        note(
          "ghost",
          `standing on ${depart.filter((s) => s.ghosts > 0).length} depart sample(s), ${ghostsDuringRoom.length} room sample(s)`,
        );
        expect(
          ghostsDuringRoom.length,
          "the ghost is gone before the room beat starts",
        ).toBe(0);

        // And the survivor really did grow back over the whole run.
        const growTravel = spread(room, (s) => s.heights[SITTER] ?? 0);
        note("departure extent", `survivor travel=${growTravel.toFixed(2)}`);
        expect(
          growTravel,
          "the survivor grows back over the room the card left",
        ).toBeGreaterThan(leavingHeight * 0.8);


        await wait(AFTER_LAND_MS);
        const rest = await atRest(app);
        note("departure at rest", JSON.stringify(rest));
        expect(rest.settling, "the settle mark is off the canvas").toBe(false);
        expect(rest.beat, "and so is the beat attribute").toBeNull();
        expect(
          rest.inlineOpacities,
          "no frame keeps an inline opacity hold",
        ).toEqual([]);
        expect(rest.ghosts, "and no exit ghost stands").toBe(0);
        expect(rest.picker, "the picker went with its card").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a newcomer onto a ROOMY split column takes the room, and leaves no band beneath it",
    async () => {
      const app = await launchTugApp({ testName: "at0571-roomy-column" });
      try {
        await seed(app);
        // The sitter folds first, which is what makes the column roomy: a
        // folded member pins at its tier and asks for no share of the run
        // ([P05]), so once it has somebody to divide with, everything below
        // its 150px is room nothing has claimed. This is the screenshot's
        // arrangement, and until the one-rule change the arrival stood at its
        // declared height with that room left empty beneath it ([F01]).
        await app.evalJS<null>(`(${setCardFolded("A", true)}, null)`);
        await wait(AFTER_LAND_MS);
        expect(await isFolded(app, SITTER), "the sitter folded").toBe(true);

        const before = await paneRects(app, [SITTER, "p3"]);
        // The run is read off SLOT 1's frame — one member spanning the same
        // vertical run — so nothing below is checked against the numbers it is
        // about.
        const run = before.p3.height;
        note(
          "roomy column",
          `sitter folded at ${before[SITTER].height.toFixed(1)} of run ${run.toFixed(1)}`,
        );
        expect(
          Math.abs(before[SITTER].height - run),
          "alone in its column the folded sitter is still the whole run — there is nothing yet to divide with",
        ).toBeLessThanOrEqual(EPSILON);

        await app.evalJS<null>(`(${addSessionCard}, null)`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);

        const newcomer = await arrivedPaneId(app);
        expect(newcomer, "the card arrived").not.toBeNull();
        const after = await paneRects(app, [SITTER, "p3", newcomer ?? ""]);
        const arrival = after[newcomer ?? ""];
        const shares = await columnShares(app, 0);
        const bid = await heldFor(app, newcomer ?? "");
        note(
          "roomy arrival",
          `sitter=${after[SITTER].height.toFixed(1)} newcomer=${arrival.height.toFixed(1)} bid=${bid.toFixed(1)} of run ${run.toFixed(1)}; band beneath=${(after.p3.bottom - arrival.bottom).toFixed(1)}; shares=${JSON.stringify(shares)}`,
        );

        // ── The room is worth having: what the folded tier leaves is
        //    hundreds of pixels more than the app bid for the newcomer, which
        //    is what makes this the roomy case rather than a tight one. The
        //    comparison is against the LIVE bid — the number this run
        //    measured — because there is no declared height left to compare
        //    against, and that is the arc. ──
        expect(
          bid,
          "the newcomer arrived carrying a measured bid",
        ).toBeGreaterThan(0);
        expect(
          run - IMPOSITION_GAP_PX - SITTER_FOLDED_TIER_PX,
          "and the room the folded sitter leaves is well past what the newcomer bid",
        ).toBeGreaterThan(bid + EPSILON);

        // ── It took the ROOM, not its bid. Read the strong way round: above
        //    the height it bid, which the ceiling this arc removed could never
        //    have allowed. ──
        expect(
          arrival.height,
          "the newcomer stands above the height it bid — the bid is a floor, not a ceiling",
        ).toBeGreaterThan(bid + EPSILON);
        expect(
          Math.abs(
            arrival.height - (run - IMPOSITION_GAP_PX - SITTER_FOLDED_TIER_PX),
          ),
          "and it stands at everything the folded sitter's tier did not claim",
        ).toBeLessThanOrEqual(EPSILON);

        // ── And the sitter claims its TIER and nothing more. It came down
        //    from the whole run, which is the fold taking effect rather than
        //    a yield: what a folded member is worth is its tier as soon as it
        //    has anyone to divide with, and every pixel past it went to the
        //    newcomer instead of standing as a band ([B05]). ──
        expect(
          Math.abs(after[SITTER].height - SITTER_FOLDED_TIER_PX),
          "the folded sitter stands at its tier and claims no more",
        ).toBeLessThanOrEqual(EPSILON);

        // ── NO BAND BENEATH IT. The column's last member reaches the run's
        //    own bottom, read against slot 1's frame. This is the dead band
        //    from the screenshot, asserted away. ──
        expect(
          Math.abs(after.p3.bottom - arrival.bottom),
          "the column's last member reaches the bottom of the run",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          Math.abs(after.p3.top - after[SITTER].top),
          "and its first member stands at the top of it",
        ).toBeLessThanOrEqual(EPSILON);

        // ── The arrival's own weight is in the record, so the next
        //    re-division agrees with what the eye saw rather than handing the
        //    newcomer the unnamed default's fraction ([B05], [F08]). ──
        expect(
          shares?.[newcomer ?? ""],
          "the arrival wrote its weight into the column's division",
        ).toBeGreaterThan(1);

        // ── And the other half of the claim: the card that took the room
        //    holds the picker whole, with the list at its cap. ──
        await measureAtListCap(app, "roomy picker");
        const fit = await panelFit(app, newcomer ?? "");
        note("roomy fit", JSON.stringify(fit));
        expect(fit, "the picker's panel is on screen").not.toBeNull();
        expect(
          fit?.overflow ?? 999,
          "the panel stands at its natural height rather than capped short",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          fit?.bottomSlack ?? -1,
          "and its bottom edge sits inside the frame that took the room",
        ).toBeGreaterThanOrEqual(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with an empty slot beside the split, the card opens there instead",
    async () => {
      const app = await launchTugApp({ testName: "at0571-open-slot" });
      try {
        await app.seedDeckState({ state: openDeckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        await app.evalJS<null>(`(${addSessionCard}, null)`);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getDeckState().cards.some(function (c) {
            return c.componentId === "session";
          })`,
          { timeoutMs: 8_000 },
        );
        const placed = await app.evalJS<{ paneId: string; slot: number | null }>(
          `(function () {
            var state = window.tugdeck.diag.getDeckState();
            var card = state.cards.filter(function (c) {
              return c.componentId === "session";
            })[0];
            var pane = state.panes.filter(function (p) {
              return p.cardIds.indexOf(card.id) !== -1;
            })[0];
            return { paneId: pane.id, slot: pane.slot === undefined ? null : pane.slot };
          })()`,
        );
        note("open slot", JSON.stringify(placed));
        expect(
          placed.slot,
          "the empty slot beside the focused card's split, never the split itself",
        ).toBe(1);

        // It still rides in on its picker: the arrival is the same one, only
        // somewhere better.
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="${placed.paneId}"] ${PICKER_FORM}') !== null`,
          { timeoutMs: 8_000 },
        );

        // The split column was not joined: its one member is still its only one.
        expect(
          await app.evalJS<number>(
            `window.tugdeck.diag.getDeckState().panes.filter(function (p) {
              return p.slot === 0;
            }).length`,
          ),
          "the split at slot 0 took no newcomer",
        ).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
