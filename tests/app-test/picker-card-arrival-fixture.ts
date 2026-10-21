/**
 * picker-card-arrival-fixture.ts — the deck shapes, the frame census and the
 * trace readings the at0571-picker-card-arrival-* files share.
 *
 * A Session card's arrival into a split column is TWO motions — the column
 * re-dividing to seat the newcomer (`room`) and the newcomer's own entrance
 * (`arrive`) — and the height it arrives at was measured before the commit.
 * The claims are read over the frames the imposer itself marks, against the
 * beat it names on each one (`data-imposer-beat` on the canvas). The scratch
 * project behind the picker is seeded per file through
 * `seedArrivalPickerSessions` / `removeArrivalPickerSessions`, so its
 * Sessions list stands at its cap.
 *
 * Two pages are read. The deck — pane frames, the imposer's beat marks, the
 * departing targets, the held numbers and the deck trace — is the shell's. The
 * picker is the arriving Session card's own sheet, in that card's body: the
 * fixture's decks hold no other Session card, so `kindBody(app, "session")` is
 * the picker's page.
 *
 * @module tests/app-test/picker-card-arrival-fixture
 */

import { expect } from "bun:test";

import { launchTugApp, note, type App, type BodyApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { testTmpDir } from "./_harness/test-cleanup";
import { PIXEL_TOL } from "./_harness/tolerances";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import {
  describePickerFit,
  pickerFit,
  pickerFitProblems,
  pickerListScrolls,
  pickerPanelNaturalHeight,
  pointPickerAt,
  removePickerSessions,
  seedPickerSessions,
  type PickerSessionsFixture,
} from "./picker-sessions-fixture";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

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
export const SHEET_PANEL_TO_MEMBER_PX = 64;

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
export const BID_DRIFT_PX = 1;

/**
 * A project whose Sessions list stands at its 14.5rem cap, so the picker the
 * arriving card raises is the one a real project presents rather than the
 * one-row picker of a fresh instance.
 */
let fixture: PickerSessionsFixture | null = null;

export function seedArrivalPickerSessions(): void {
  if (!SHOULD_RUN) return;
  fixture = seedPickerSessions("at0571");
}

export function removeArrivalPickerSessions(): void {
  removePickerSessions(fixture);
  fixture = null;
  for (const path of tugbanks.splice(0)) rmTempTugbank(path);
}

/** The tugbanks {@link launchArrivalApp} made, removed with the fixture. */
const tugbanks: string[] = [];

/**
 * Launch with `default-project-path` pointed at an empty directory, so the
 * arriving card's picker opens on one empty group.
 *
 * Left unseeded, a debug build opens the picker on the source tree, and
 * whatever sessions this machine holds there are rows in it — rows that move
 * between the bid `addCard` measures off-screen and the live panel the claim
 * is compared against, so the comparison would be this machine's rather than
 * the app's.
 */
export async function launchArrivalApp(testName: string): Promise<App> {
  const tugbankPath = mkTempTugbank();
  tugbanks.push(tugbankPath);
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.app",
    "default-project-path",
    "string",
    testTmpDir("at0571-quiet-project-"),
  );
  return launchTugApp({ testName, env: { TUGBANK_PATH: tugbankPath } });
}

/** The seeded panes. Everything else on the canvas arrived at run time. */
export const SEEDED_PANES = ["p1", "p3"] as const;
/** The member that makes the room: slot 0's sitting `hello` card. */
export const SITTER = "p1";

export const PICKER_FORM = ".session-card-picker-form";
export const DEPARTING = "[data-settle-departing]";
export const SHEET_PANEL = '[data-slot="tug-sheet"].tug-sheet-content';

/**
 * The tier a folded `hello` pane stands at: the card registers no folded
 * policy, so the folded form is the shared tier every such card folds to
 * (`FOLDED_CARD_HEIGHT_PX` in `card-registry.ts`). Copied for the reason every
 * other constant here is, and a copy that drifts fails the roomy test rather
 * than passing quietly.
 */
export const SITTER_FOLDED_TIER_PX = 145;

/**
 * How long each sampler runs. The arrival at the default tune is a shrink beat
 * and an arrive beat, each 0.6× the 400ms nominal, and the sampler runs well
 * past the pair so the rest frames and the sheet's own enter are in the record.
 */
export const CENSUS_MS = 1_600;
/** The whole choreography's window, with room for the last beat to land. */
export const AFTER_LAND_MS = 1_800;

export const wait = (ms: number): Promise<void> =>
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
export function deckShape() {
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
export function openDeckShape() {
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

export interface Sample {
  t: number;
  /** Whether the canvas carried the settle mark on this frame. */
  settling: boolean;
  /** The beat the imposer named on this frame, `""` outside a beat. */
  beat: string;
  /** Every live frame's height, keyed by pane id. */
  heights: Record<string, number>;
  /**
   * Every live frame's opacity as the reader sees it, keyed by pane id: its
   * computed opacity, or "0" while it is `visibility: hidden` — an arriving
   * frame held hidden until its reveal, whose opacity is still 1.
   */
  opacity: Record<string, string>;
  /** Every live frame's INLINE opacity — a hold, or `""`. */
  inlineOpacity: Record<string, string>;
  /**
   * Per pane id, whether its card's body was on screen on this frame: the
   * shell's last placement posts it shown (`lastPosted`), which it does only
   * once the body has painted. The host shows a body only once it
   * reports ready, and an unbound Session card is ready once its picker has
   * mounted and gone quiet ([B16] of the bodies-migration brief). So a frame
   * that is visible with its body not yet shown is a frame whose reader sees
   * the bare pane surface where the picker belongs.
   */
  bodyShown: Record<string, boolean>;
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
  /** How many departing targets the settle was carrying. */
  ghosts: number;
  /** Each departing target: its mark, where it stood, and its opacity. */
  departing: Array<{ key: string; top: number; height: number; opacity: number }>;
}

// Kept local: every file's `census` samples its own gesture's readings, so the
// name is shared and the function is not.
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
 *
 * The sampler runs in the shell, where the frames are. `gesturePage` is the
 * page the gesture is evaluated in: the shell for a deck action, the Session
 * card's body for a press on its picker (`cancelPicker`).
 *
 * The picker is in the arriving card's body, which does not exist when the
 * sampler is armed and keeps its own frame clock, so it is not read here.
 * What the shell reads on each of ITS frames is whether that body is on
 * screen at all ({@link Sample.bodyShown}).
 */
export async function census(
  app: App,
  gesture: string,
  gesturePage: App | BodyApp = app,
): Promise<Sample[]> {
  // card-dom: shell
  await app.evalJS<null>(
    `(function () {
      window.__at0571 = [];
      var t0 = performance.now();
      var posted = function (cardId) {
        var p = window.tugdeck.diag.getBodyPlacement();
        var last = p && p.lastPosted;
        if (!last) return false;
        for (var b = 0; b < last.bodies.length; b += 1) if (last.bodies[b].cardId === cardId) return last.bodies[b].visible === true;
        return false;
      };
      var tick = function () {
        var canvas = document.querySelector("[data-imposer-settling]");
        var sample = {
          t: performance.now() - t0,
          settling: canvas !== null,
          beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
          heights: {},
          opacity: {},
          inlineOpacity: {},
          bodyShown: {},
          ghosts: document.querySelectorAll(${JSON.stringify(DEPARTING)}).length,
        };
        var state = window.tugdeck.diag.getDeckState();
        var bids = state.openingBids || {};
        var claims = state.sheetReservations || {};
        sample.held = {};
        for (var key in claims) sample.held[key] = claims[key];
        for (var key in bids) sample.held[key] = bids[key];
        var targets = document.querySelectorAll(${JSON.stringify(DEPARTING)});
        sample.departing = [];
        for (var g = 0; g < targets.length; g += 1) {
          var tr = targets[g].getBoundingClientRect();
          sample.departing.push({
            key: targets[g].getAttribute("data-settle-departing"),
            top: tr.top,
            height: tr.height,
            opacity: Number(getComputedStyle(targets[g]).opacity),
          });
        }
        var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
        for (var i = 0; i < frames.length; i += 1) {
          var el = frames[i];
          var id = el.getAttribute("data-pane-id");
          sample.heights[id] = el.getBoundingClientRect().height;
          var cs = getComputedStyle(el);
          sample.opacity[id] = cs.visibility === "hidden" ? "0" : cs.opacity;
          sample.inlineOpacity[id] = el.style.opacity;
          var ph = el.querySelector("[data-body-placeholder][data-card-id]");
          sample.bodyShown[id] = ph !== null && posted(ph.getAttribute("data-card-id"));
        }
        window.__at0571.push(sample);
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await gesturePage.evalJS<null>(`(${gesture}, null)`);
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
export async function traceMark(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      window.__deckTrace.enable(true);
      return window.__deckTrace.mark();
    })()`,
  );
}

/** The kinds this file reads back, counted over the events since `mark`. */
export async function traceSince(
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
export function beatFrames(samples: Sample[], beat: string): Sample[] {
  return samples.filter((s) => s.beat === beat);
}

/** The beats the settle ran, in the order they were first seen. */
export function beatOrder(samples: Sample[]): string[] {
  const seen: string[] = [];
  for (const s of samples) {
    if (s.beat !== "" && seen[seen.length - 1] !== s.beat) seen.push(s.beat);
  }
  return seen;
}

/** The pane ids the sampler saw that the fixture did not seed. */
export function arrivedPanes(samples: Sample[]): string[] {
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
export function spread(samples: Sample[], pick: (s: Sample) => number): number {
  const values = samples.map(pick).filter((v) => v > 0);
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

/** The largest frame-to-frame height change any frame took across `samples`. */
export function worstHeightStep(samples: Sample[]): { pane: string; step: number } {
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

/**
 * Whether a picker is up in any page: the shell's document, or the body of
 * any Session card the host holds ready. A card that closed takes its body,
 * and so its picker, with it.
 */
export async function pickerUp(app: App): Promise<boolean> {
  const script = `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`;
  // card-dom: shell — the shell half of "any page"; the bodies follow.
  if (await app.evalJS<boolean>(script)) return true;
  for (const b of await app.bodies()) {
    if (b.cardId === null || b.componentId !== "session" || b.state !== "ready") continue;
    if (await app.body(b.cardId).evalJS<boolean>(script)) return true;
  }
  return false;
}

/** The canvas's marks and the residue every frame carries, at rest. */
export async function atRest(app: App): Promise<{
  settling: boolean;
  beat: string | null;
  inlineOpacities: string[];
  ghosts: number;
  picker: boolean;
}> {
  const deck = await app.evalJS<{
    settling: boolean;
    beat: string | null;
    inlineOpacities: string[];
    ghosts: number;
  }>(
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
        ghosts: document.querySelectorAll(${JSON.stringify(DEPARTING)}).length,
      };
    })()`,
  );
  return { ...deck, picker: await pickerUp(app) };
}

export interface Rect {
  top: number;
  bottom: number;
  height: number;
}

/** Every named pane's live frame, in viewport coordinates. */
export async function paneRects(
  app: App,
  paneIds: readonly string[],
): Promise<Record<string, Rect>> {
  // card-dom: shell
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
export async function arrivedPaneId(app: App): Promise<string | null> {
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

/** The weights `slot`'s column holds, or `null` when it holds none. */
export async function columnShares(
  app: App,
  slot: number,
): Promise<Record<string, number> | null> {
  return app.evalJS<Record<string, number> | null>(
    `(((window.tugdeck.diag.getDeckState().imposition.columns || {})[${slot}] || {}).shares || null)`,
  );
}

/** Whether a pane reads as folded in the deck's own record. */
export async function isFolded(app: App, paneId: string): Promise<boolean> {
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
export async function heldFor(app: App, paneId: string): Promise<number> {
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
 * and assert the picker fits the frame it arrived in ([B07]).
 *
 * With the list at its cap the picker claims more than a member of a split
 * column in the harness window can hold, so the card stands under its claim
 * and the picker lays out for that: the header, the filter, the trash row
 * and the actions all wholly inside the frame, and — whenever the panel
 * stands shorter than its natural height — the Sessions list the element
 * that gave way. Read in the card's own page, against the frame that page
 * draws.
 */
export async function assertFitAtListCap(app: App, label: string): Promise<void> {
  if (fixture === null) throw new Error("the picker sessions fixture was not seeded");
  const page = kindBody(app, "session");
  await pointPickerAt(page, fixture);
  await wait(AFTER_LAND_MS);
  const natural = await pickerPanelNaturalHeight(page);
  const fit = await pickerFit(page);
  note(label, `panel natural ${natural ?? -1}px with the list at its cap; ${describePickerFit(fit)}`);
  expect(fit, `${label}: the picker's parts are all on screen`).not.toBeNull();
  if (fit === null) return;
  expect(
    pickerFitProblems(fit, PIXEL_TOL),
    `${label}: the header, filter, trash row and actions all stand inside the frame`,
  ).toEqual([]);
  if (fit.panelWants - fit.panelHas > PIXEL_TOL) {
    expect(
      pickerListScrolls(fit, PIXEL_TOL),
      `${label}: the panel stands short of its natural height, so the Sessions list gave way`,
    ).toBe(true);
  }
}

// Kept local: every file's `seed` builds its own deck and waits on its own
// readiness, so the name is shared and the function is not.
/** Seed the deck, wait for both frames, and let the imposer settle. */
export async function seed(app: App): Promise<void> {
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
export const addSessionCard = `window.__tug.dispatchControlAction("show-card", { component: "session" })`;

/** Fold or unfold a card through the registry-routed setter, as `at0553` does. */
export const setCardFolded = (cardId: string, folded: boolean): string =>
  `window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(cardId)}, folded: ${folded} })`;

/** Press the picker's Cancel, which closes the host card ([D02] cascade). */
export const cancelPicker = `(function () {
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
