/**
 * at0569-sheet-reservation.test.ts — an unbound Session card stands at LEAST
 * at its picker's height with the sessions list at its cap, takes more when its
 * column has more to give, and gives the room back when a session opens.
 *
 * Two mechanisms meet on one card here, and this file is where the meeting is
 * pinned THROUGH THE LIVE APP.
 *
 * A modal surface whose natural height is content-bounded declares that height
 * at its call site, the sheet measures the panel and reports the number out,
 * and the deck derives the host member's floor from it and holds the member
 * there for as long as the sheet is up. That is the RESERVATION, and the
 * DERIVATION is the deck's ([B03]): the sheet knows its panel, and everything
 * between a panel and the member under it — the title bar, the clip's drop,
 * the gap the clamp keeps against the canvas, less the gap the imposition
 * leaves under a column's last member — is arithmetic the card does not know
 * and should not.
 *
 * That is why the claim is no longer 64px short of what the card needs. It
 * used to store the sheet's number unchanged, which made it inert on a Session
 * card — a floor under a member already well above it — and the picker's real
 * height was carried separately, by hand, in a registration's doc-comment. The
 * two are one quantity now, and with the sessions list at its cap the deck's
 * measured claim and the height the card DECLARED are the same number. This
 * file asserts that directly.
 *
 * What sizes the card is the other contributor: the height a Session card
 * DECLARES while it is unbound ([B01]). A Session card with no session behind
 * it is nothing but the picker it exists to raise — no transcript, no composer,
 * and so none of what the 600px floor is for. So the card declares what it is
 * worth unbound — MEASURED, off the picker's own panel, before the commit that
 * appends the pane — and `placeMembers` reads that bid as one more
 * contributor to the member's FLOOR: the largest thing
 * standing on the member wins, and the member keeps its weight. The card
 * stands at the picker's height whenever its share of the run would put it
 * lower, takes the share when the share is higher — which is the second test
 * below, and the whole of what changed — and the sheet going drops the
 * declaration ([B02]) so the stored division comes back either way.
 *
 * ## Why the frames MOVE here, where they used to be asserted not to
 *
 * This file's older claim was that nothing moves at all, which was the honest
 * reading of the reservation alone: a floor under a member already above it is
 * inert. The declaration is a floor, but it is not the STACK floor: it is a
 * number of its own, set by the picker with its sessions list at its cap
 * rather than by anything the 600px floor is for, and this fixture's shares
 * are chosen so the stack floor and the weighted share would each put the card
 * somewhere else — which is what makes the declaration's reading
 * distinguishable from theirs, and is asserted directly below. So the geometry
 * assertions say
 * where the two frames stand rather than that they did not move, and the
 * binding commit's assertion is the one that did not change: after
 * `bindSession` the division is the stored one again.
 *
 * ## The picker this file measures, and why it is not the one a fresh instance shows
 *
 * Every app-test launches on a fresh per-instance `sessions.db`, so the picker
 * a card raises here lists one row — "New session" — and its panel is some
 * 380px tall. The Sessions list is capped at 14.5rem with a 3.5rem floor per
 * row, so on any real project with more than three sessions the list stands
 * at its cap and the panel is about 174px taller than that. A pin measured
 * against the one-row picker fits the one-row picker, and the first real
 * project cut the Choose Session header off above the path field and the
 * action row off below the list, with nothing in this file able to say so —
 * every fit assertion it made was against the picker that fit.
 *
 * So the fit claim that matters is made over a SEEDED project
 * (`picker-sessions-fixture.ts`): five two-line sessions, enough to stand the
 * list at its cap. The Session card is the LOWER member of a split column,
 * which is the case from the screenshot — the sheet's top-anchor clamp caps
 * the panel against the canvas bottom, and the lower member is the one whose
 * frame can be too short for that. With the list at its cap the panel's
 * overflow is within a pixel, the Choose Session header sits wholly below the
 * title bar, and the action row sits wholly above the FRAME's bottom edge. The
 * frame is the edge that matters and the clip is not: `.tug-sheet-clip` is
 * `height: 100vh` on purpose ("it must NOT bound the panel"), so a reading
 * against its bottom is a reading against something a viewport below anything
 * on screen, and could not go negative for any clipping this card can produce.
 * The one-row picker's fit is still read before the list fills, because a
 * panel that fits the cap must also fit less.
 *
 * ## Two fixtures, and what each of them can say
 *
 * The first two tests SEED their deck, including the opening bid, because
 * `addCard` is the only thing that writes one and nothing here calls it —
 * `seedDeckState` is an atomic in-process state replace, so a `DeckState`
 * field passes straight through it. What they are about is the ALLOCATOR's
 * reading of a bid, and what the sheet's own claim does to one. And because a
 * seeded bid is by definition a number nobody measured, they are also where
 * the first-report rule is seen REFUSING: the live report disagrees with the
 * seeded number, the deck records the disagreement instead of quietly
 * re-targeting, and the claim lands later on an honest update ([P04], [P05]).
 *
 * The third test adds its card through the production `show-card` path, so
 * `addCard` measures the card's opening form and bids what it read. That is
 * where the rule is seen AGREEING — the number the deck holds for the member
 * is the panel the user is looking at, at two picker heights far enough apart
 * that no constant could have satisfied both.
 *
 * The card is bound through the harness rather than by driving the picker's
 * Open, because the binding update IS what unmounts the picker on the real path
 * — `session-card.tsx` defers its wire send by the sheet's exit duration for
 * exactly that reason — and a live spawn would put a claude process inside a
 * geometry test.
 *
 * Deliberately NOT declaring `@covers tugdeck/src/components/tugways/cards/session-card.tsx`,
 * though the DECLARATION under test is made at that module's picker call site.
 * Its honest fan-out is already recorded debt at 21, one past the selection
 * budget, and naming it here would make it 22 — which the covers-check refuses
 * outright on the commit that does it. What stands in its place are the two
 * seams the call site reaches the deck through, `lib/sheet-reservation.ts` and
 * `lib/opening-bid.ts`: an edit that changes where the picker's numbers go
 * selects this file, and only an edit that drops a declaration while leaving
 * both modules alone would slip past.
 *
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/lib/sheet-reservation.ts
 * @covers tugdeck/src/lib/opening-bid.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-registration.tsx
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
const TEST_TIMEOUT_MS = 120_000;

/** Geometry tolerance: sub-pixel layout rounding, never a real disagreement. */
const EPSILON = 1.5;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

/**
 * The Session card's own stack floor (`session-card-registration.tsx`). Named
 * here because the pin standing somewhere the floor would not put the card is
 * what separates a pin from a reservation, and that is asserted rather than
 * assumed.
 */
const SESSION_FLOOR_PX = 600;

/**
 * How far the deck's claim may sit from a fresh reading of the panel.
 *
 * The two use the IDENTICAL formula — `scrollHeight` plus borders plus margins
 * — so this is not a tolerance on the arithmetic. It is a tolerance on WHEN:
 * the sheet reports on change and re-measures from a `ResizeObserver` on the
 * panel's own box, and a late content reflow that changes `scrollHeight`
 * without changing that box does not re-fire it. So the standing claim can be
 * a pixel or two behind a reading taken afterwards.
 *
 * What the assertion is for survives it whole: the alternatives a wrong number
 * would be — the card's floor, the frame's height, nothing at all — are tens or
 * hundreds of pixels away, not two.
 */
const REPORTER_DRIFT = 3;

/**
 * How far a MEASURED bid may sit from a fresh reading of the panel it was
 * measured off.
 *
 * Tighter than {@link REPORTER_DRIFT} on purpose, and the tightness is the
 * claim: the bid and the live report come from the identical component through
 * the identical formula, taken a second apart with nothing between them but
 * the commit that appended the pane. Sub-pixel layout rounding is the whole of
 * what may differ. A looser bar here would let a bid that was merely CLOSE
 * pass, and close is what a constant is.
 */
const MEASURED_BID_DRIFT = 1;

/**
 * What the deck adds between a sheet's panel and the member under it —
 * `memberFloorForSheetPanel`'s sum, copied for the reason every other constant
 * in this header is: `--jsx` is off here, so nothing under `components/` can be
 * imported, and `lib/sheet-reservation.ts` reaches the card registry through
 * the `@` alias this file does not resolve.
 *
 * 37 (the pane's title bar and the 1px its sheet clip drops below it) + 32
 * (`SHEET_CANVAS_GAP`) − 5 (`IMPOSITION_GAP_PX`, the gap already under a
 * column's last member). A copy that drifts fails the assertions below rather
 * than passing quietly.
 */
const SHEET_PANEL_TO_MEMBER_PX = 64;

/**
 * The opening bid this fixture SEEDS. It is no longer a copy of anything in
 * the app, because there is nothing left to copy: the declared unbound height
 * is gone, and `addCard` measures the card's opening form and bids what it
 * reads. This file seeds its deck rather than adding to it, so the number
 * below is one this fixture chose — large enough to clear both the stack floor
 * and the share the hand gives the member, which is what makes a reading here
 * distinguishable from either.
 *
 * And it is deliberately a number no picker will ever report. A seeded bid is
 * a number nobody measured, so the first live report disagrees with it — and
 * the first-report rule refusing that report, with a row in the trace naming
 * both numbers, is what this file asserts below ([P04], [Spec S04]).
 */
const SEEDED_OPENING_BID_PX = 618;

/**
 * A project whose Sessions list stands at its 14.5rem cap. The picker a fresh
 * instance opens lists one row, and a height measured against that picker is
 * wrong on every real project; the fixture is what makes the panel's height
 * here the height the pin has to hold.
 */
let fixture: PickerSessionsFixture | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  fixture = seedPickerSessions("at0569");
});

afterAll(() => {
  removePickerSessions(fixture);
});

const PICKER_FORM = ".session-card-picker-form";
const SHEET_PANEL = '[data-slot="tug-sheet"].tug-sheet-content';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Rect {
  top: number;
  bottom: number;
  height: number;
}

/**
 * A two-up whose slot 0 is SPLIT between a plain card and a Session card, with
 * the shares the caller names.
 *
 * The upper member is a `hello` card rather than a second Session card for one
 * reason: an unbound Session card raises its picker the moment it activates,
 * and a fixture with two of them has two pickers up and two claims against one
 * run — which is a case the brief left open rather than the one under test.
 *
 * `openingBids` is SEEDED because this fixture seeds rather than adds:
 * `addCard` is the only thing that writes a pin, and nothing here calls it. See
 * the header for what that does and does not leave proven. The field is the
 * OPENING BID a card arrives carrying ([B02]): a floor for the arrival window,
 * cleared by a claim at least as high as it and by the sheet going.
 */
function deckShape(shares: Record<string, number>) {
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
      { id: "B", componentId: "session", title: "Session", closable: true },
      { id: "C", componentId: "hello", title: "Card C", closable: true },
    ],
    panes: [
      pane("p1", "A", 0),
      pane("p2", "B", 0),
      pane("p3", "C", 1),
    ],
    activePaneId: "p1",
    imposition: {
      kind: "two-up",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p1", "p2"], shares } },
    },
    openingBids: { p2: SEEDED_OPENING_BID_PX },
    hasFocus: true,
  };
}

/** Every named pane's live frame, in viewport coordinates. */
async function rects(app: App, paneIds: string[]): Promise<Record<string, Rect>> {
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
 * The panel's natural height as the SHEET computes it — `scrollHeight` plus its
 * borders and its own margins — the overflow of that natural height against the
 * room the panel actually has, and how far the panel's own bottom edge sits
 * INSIDE the pane frame around it.
 *
 * The first two are the contract the reservation rests on: `scrollHeight` is
 * what the panel wants whether or not a cap is biting, which is what makes the
 * number stable against the room it wins, and an overflow above a pixel is the
 * panel capped short.
 *
 * `bottomSlack` is here for the PIN, and the two readings catch different
 * failures. The panel is capped against the CANVAS rather than against the pane
 * ([`clampSheetToCanvas`]), so a frame too short to hold it clips the panel with
 * the clip's own `overflow: hidden` and leaves `scrollHeight` untouched —
 * invisible to the overflow reading, and exactly the failure a height constant
 * one pixel too small produces. Negative slack is the panel hanging past the
 * frame's bottom edge.
 */
async function panelMeasure(app: App): Promise<{
  natural: number;
  overflow: number;
  bottomSlack: number;
} | null> {
  return app.evalJS<{
    natural: number;
    overflow: number;
    bottomSlack: number;
  } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(SHEET_PANEL)});
      if (el === null) return null;
      var cs = getComputedStyle(el);
      var px = function (v) { return parseFloat(v) || 0; };
      var frame = el.closest('.tug-pane');
      return {
        natural:
          el.scrollHeight +
          px(cs.borderTopWidth) +
          px(cs.borderBottomWidth) +
          px(cs.marginTop) +
          px(cs.marginBottom),
        overflow: el.scrollHeight - el.clientHeight,
        bottomSlack:
          frame === null
            ? -1
            : frame.getBoundingClientRect().bottom -
              el.getBoundingClientRect().bottom,
      };
    })()`,
  );
}

/** The reservations the live store holds, keyed by member. */
async function reservations(app: App): Promise<Record<string, number> | null> {
  return app.evalJS<Record<string, number> | null>(
    `(window.tugdeck.diag.getDeckState().sheetReservations || null)`,
  );
}

/**
 * Every `opening-bid-mismatch` the deck has recorded this run.
 *
 * The kind is always-recorded — it does not wait on `enable(true)` — because a
 * first live report disagreeing with the bid is the one thing the deck wants
 * on the record whether or not anybody armed the trace ([Spec S04]).
 */
async function bidMismatches(
  app: App,
): Promise<{ memberId: string; bid: number; report: number }[]> {
  return app.evalJS(
    `(function () {
      var out = [];
      var events = window.__deckTrace.since(0);
      for (var i = 0; i < events.length; i += 1) {
        var e = events[i];
        if (e.kind === "opening-bid-mismatch") {
          out.push({ memberId: e.memberId, bid: e.bid, report: e.report });
        }
      }
      return out;
    })()`,
  );
}

/** The opening bids the live store holds, keyed by member. */
async function pins(app: App): Promise<Record<string, number> | null> {
  return app.evalJS<Record<string, number> | null>(
    `(window.tugdeck.diag.getDeckState().openingBids || null)`,
  );
}

/** The run slot 0's column divides, as the two frames report it. */
function runOf(frames: Record<string, Rect>): number {
  return frames.p1.height + IMPOSITION_GAP_PX + frames.p2.height;
}

/**
 * How much run is left BENEATH the column's last member, read against slot
 * 1's frame — one member spanning the same vertical run, so the reading is
 * independent of the two heights the claims are about. {@link runOf} sums
 * those two and could never see a band; this is what can.
 *
 * A band is the failure from the screenshot: both members held at ceilings
 * with no weight, their heights adding up to less than the run, and the
 * surplus left as dead pixels under the lower card ([F01]).
 */
function bandBeneath(frames: Record<string, Rect>): number {
  return frames.p3.bottom - frames.p2.bottom;
}

/**
 * The picker's edges against the chrome around it, read inside pane `p2`: how
 * far the Choose Session header's top sits below the title bar's bottom, and
 * how far the action row's bottom sits above the PANE FRAME's bottom. Either
 * negative is the sheet cut off at that end — the screenshot's failure, read
 * at the two edges it showed.
 *
 * The two edges are not symmetric, and reading them both against the clip
 * would get one of them wrong. The clip's TOP is a real edge: it sits at
 * `chrome-height + 1px` with `overflow: hidden`, so a panel riding up under
 * the title bar is genuinely cut there. Its BOTTOM is not an edge at all —
 * `.tug-sheet-clip` is `height: 100vh` deliberately ("it must NOT bound the
 * panel"; `tug-sheet.css`), because the panel is capped in JS against the
 * measured canvas instead. So the bottom reading is against the frame the
 * panel has to fit inside, which is the same box `panelMeasure`'s
 * `bottomSlack` reads and the one a height constant a pixel too small
 * overruns.
 */
async function pickerEdges(app: App): Promise<{
  headerBelowTitleBar: number;
  actionsAbovePaneBottom: number;
} | null> {
  return app.evalJS<{
    headerBelowTitleBar: number;
    actionsAbovePaneBottom: number;
  } | null>(
    `(function () {
      var pane = document.querySelector('.tug-pane[data-pane-id="p2"]');
      if (pane === null) return null;
      var bar = pane.querySelector('[data-testid="tug-pane-title-bar"]');
      var header = pane.querySelector('.tug-sheet-header');
      var actions = pane.querySelector('.tug-sheet-actions');
      if (bar === null || header === null || actions === null) return null;
      return {
        headerBelowTitleBar:
          header.getBoundingClientRect().top - bar.getBoundingClientRect().bottom,
        actionsAbovePaneBottom:
          pane.getBoundingClientRect().bottom - actions.getBoundingClientRect().bottom,
      };
    })()`,
  );
}

/**
 * Point the open picker at the seeded project, let the list reach its cap,
 * and assert the panel fits the pinned card whole.
 *
 * Filling the list is a genuine change to the picker, so the report it
 * provokes is an ordinary one rather than a first one ([P05]) — which is why
 * this is where the claim lands on a fixture whose bid was seeded rather than
 * measured. The number it prints is the panel the deck derived that claim
 * from.
 */
async function assertFitAtListCap(app: App): Promise<void> {
  if (fixture === null) throw new Error("the picker sessions fixture was not seeded");
  await pointPickerAt(app, fixture);
  await wait(AFTER_LAND_MS);
  const natural = await pickerPanelNaturalHeight(app);
  const full = await panelMeasure(app);
  const edges = await pickerEdges(app);
  const claimed = await reservations(app);
  note(
    `with the list at its cap: panel natural ${natural ?? -1}px, overflow ${full?.overflow ?? -1}, bottom slack ${(full?.bottomSlack ?? -1).toFixed(1)}px, header ${(edges?.headerBelowTitleBar ?? -1).toFixed(1)}px below the title bar, actions ${(edges?.actionsAbovePaneBottom ?? -1).toFixed(1)}px above the frame's bottom`,
  );
  note(
    `with the list at its cap the deck claims ${claimed?.p2 ?? -1}px for the member; this fixture seeded a bid of ${SEEDED_OPENING_BID_PX}`,
  );
  // ── The reservation is NOT inert on a Session card any more ([B03]). The
  //    deck derives the member's floor from the panel the sheet measured, so
  //    with the list at its cap that derivation and the height the card
  //    declared are the same number — one quantity where there were two, and
  //    the whole of why the claim used to decide nothing here. ──
  expect(
    Math.abs((claimed?.p2 ?? -1) - ((natural ?? -1) + SHEET_PANEL_TO_MEMBER_PX)),
    "the claim is what the member needs for this panel, not the panel's own height",
  ).toBeLessThanOrEqual(REPORTER_DRIFT);
  expect(full, "the picker's panel is on screen with the list at its cap").not.toBeNull();
  expect(
    full?.overflow ?? 999,
    "with the list at its cap the panel stands at its natural height rather than capped short",
  ).toBeLessThanOrEqual(EPSILON);
  // The panel not hanging past the frame it stands in. This is the reading
  // that catches a height constant one pixel too small: the clip's
  // `overflow: hidden` cuts the panel there without touching `scrollHeight`,
  // so the overflow reading above stays 0 while the card clips.
  expect(
    full?.bottomSlack ?? -1,
    "the panel's bottom edge sits inside the card's frame",
  ).toBeGreaterThanOrEqual(0);
  expect(edges, "the header, the action row and the title bar are all on screen").not.toBeNull();
  expect(
    edges?.headerBelowTitleBar ?? -1,
    "the Choose Session header sits wholly below the title bar",
  ).toBeGreaterThanOrEqual(0);
  expect(
    edges?.actionsAbovePaneBottom ?? -1,
    "and the action row sits wholly above the frame's bottom edge",
  ).toBeGreaterThanOrEqual(0);
}

/** Seed the deck, wait for all three frames, and let the imposer settle. */
async function seed(app: App, shares: Record<string, number>): Promise<void> {
  await app.seedDeckState({ state: deckShape(shares), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** Activate the Session card by its title bar, and wait for its picker. */
async function raisePicker(app: App): Promise<void> {
  await app.nativeClickAtElement(
    '[data-pane-id="p2"] [data-testid="tug-pane-title-bar"]',
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)("AT0569 — an unbound Session card stands at least at its picker's height", () => {
  test(
    "the card opens at the pinned height, the neighbour holds the rest, and a session opening gives it back",
    async () => {
      const app = await launchTugApp({ testName: "at0569-sheet-reservation" });
      try {
        // Three parts to one. Without the pin the Session card's own share
        // would leave it a sliver and its 600px floor would hold it up; the
        // declaration stands above both, so it is the floor that binds.
        await seed(app, { p1: 3, p2: 1 });
        const before = await rects(app, ["p1", "p2", "p3"]);
        const run = runOf(before);
        note(
          `pinned division: p1=${before.p1.height.toFixed(1)} p2=${before.p2.height.toFixed(1)} of run ${run.toFixed(1)}`,
        );

        // ── The pin stands, and it is the card's own declared height. ──
        expect(
          await pins(app),
          "the pin is keyed by the host pane and carries the declared height",
        ).toEqual({ p2: SEEDED_OPENING_BID_PX });

        // ── The card stands there: the declaration is the largest floor on
        //    the member, and the one-part share the hand gave it is smaller. ──
        expect(
          Math.abs(before.p2.height - SEEDED_OPENING_BID_PX),
          `the unbound card stands at SEEDED_OPENING_BID_PX (${SEEDED_OPENING_BID_PX})`,
        ).toBeLessThanOrEqual(EPSILON);

        // ── And the neighbour holds all of the rest of the run. ──
        expect(
          Math.abs(
            before.p1.height - (run - IMPOSITION_GAP_PX - SEEDED_OPENING_BID_PX),
          ),
          "the neighbour holds the run less the gap and the pinned height",
        ).toBeLessThanOrEqual(EPSILON);

        // ── And nothing is left BENEATH the lower member: the column divides
        //    its whole run. Read against slot 1's frame rather than against
        //    the two heights the claim is about, which could not show a band
        //    at all. A declaration that was a ceiling with no weight is what
        //    left one ([F01]). ──
        expect(
          Math.abs(bandBeneath(before)),
          "no run is left beneath the column's last member",
        ).toBeLessThanOrEqual(EPSILON);

        // ── The declaration is neither the stack floor nor the share. With
        //    these shares the weighted division would put the card at a
        //    quarter of the run and its 600px floor would lift it to 600; the
        //    picker's height is above both, which is why it is the number the
        //    card stands at, and why a reading here cannot be confused for
        //    either of them. ──
        expect(
          SEEDED_OPENING_BID_PX - SESSION_FLOOR_PX,
          "the declaration is above the stack floor, so it is the floor that binds",
        ).toBeGreaterThan(EPSILON);
        expect(
          (run - IMPOSITION_GAP_PX) * 0.25,
          "and above the share the hand gave it, so the share does not lift it",
        ).toBeLessThan(SEEDED_OPENING_BID_PX - EPSILON);

        await raisePicker(app);


        // ── The FIRST live report is held to the bid, and this bid was
        //    seeded rather than measured — so the report disagrees with it and
        //    is refused, with a row in the trace naming both numbers ([P04],
        //    [Spec S04]). The refusal is the point: a bid nobody measured is
        //    exactly the case the rule exists for, and the deck says so out
        //    loud instead of quietly re-targeting a settle already in flight. ──
        const refused = await bidMismatches(app);
        note(`first report against the seeded bid: ${JSON.stringify(refused)}`);
        expect(
          refused.map((m) => m.memberId),
          "the first live report on the seeded member was held to the bid",
        ).toEqual(["p2"]);
        expect(
          refused[0]?.bid,
          "and the row names the bid it was held to",
        ).toBe(SEEDED_OPENING_BID_PX);
        expect(
          Math.abs((refused[0]?.report ?? -1) - SEEDED_OPENING_BID_PX),
          "and a report far enough from it that no tolerance could have passed it",
        ).toBeGreaterThan(REPORTER_DRIFT);
        // The refused report wrote nothing, and a LATER one — the panel
        // settling a pixel or two under its own resize observer — comes
        // through the ordinary path and lands. That is the rule working
        // rather than a hole in it: the rule holds the FIRST report to the
        // bid, and a bid nobody measured loses that argument once.
        note(
          `the claim that stands after the refusal: ${JSON.stringify(await reservations(app))}`,
        );

        const panel = await panelMeasure(app);
        expect(panel, "the picker's panel is on screen").not.toBeNull();
        note(
          `panel natural ${panel?.natural ?? -1}px, overflow ${panel?.overflow ?? -1}, bottom slack ${(panel?.bottomSlack ?? -1).toFixed(1)}px`,
        );

        // ── And the panel does not clip at the pinned height, read both
        //    ways: uncapped in its own box, and inside the frame around it. ──
        expect(
          panel?.overflow ?? 999,
          "the panel stands at its natural height rather than capped short",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          panel?.bottomSlack ?? -1,
          "and its bottom edge sits inside the frame rather than clipped by it",
        ).toBeGreaterThanOrEqual(0);

        // ── The picker is up and the card has not moved for it: the
        //    declaration was already the picker's height, so there was nothing
        //    to make room for. This is what "no per-frame measurement" buys. ──
        const open = await rects(app, ["p1", "p2"]);
        expect(
          Math.abs(open.p2.height - before.p2.height),
          "raising the picker moves nothing — the card was already its height",
        ).toBeLessThanOrEqual(EPSILON);

        // ── The same picker over a project with more sessions than the
        //    list's cap holds — the case a real project presents, on the
        //    lower member of a split column, which is the case that clipped. ──
        await assertFitAtListCap(app);

        // ── A session opens: the picker goes with the binding, the claim and
        //    the bid come down with the sheet ([B02]), and the card falls back
        //    into the share the hand gave it. ──
        await app.bindSession("B");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) === null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        expect(
          await pins(app),
          "the bid came down with the sheet, absent rather than empty",
        ).toBeNull();
        expect(
          await reservations(app),
          "and the claim came down with the sheet",
        ).toBeNull();

        const settled = await rects(app, ["p1", "p2"]);
        note(
          `settled: p1=${settled.p1.height.toFixed(1)} p2=${settled.p2.height.toFixed(1)}`,
        );
        // Three parts to one over the run, with the Session card's 600px floor
        // holding its share up — which is what this fixture's shares are for.
        expect(
          Math.abs(settled.p2.height - SESSION_FLOOR_PX),
          "the bound card is back at the height its stored share gives it",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          Math.abs(settled.p1.height - (run - IMPOSITION_GAP_PX - SESSION_FLOOR_PX)),
          "and the neighbour gave the room back",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          Math.abs(settled.p2.height - before.p2.height),
          "the card really did move — the pin was doing something",
        ).toBeGreaterThan(EPSILON);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a large stored share DOES lift the unbound member — the declaration is a floor, not a ceiling",
    async () => {
      const app = await launchTugApp({
        testName: "at0569-sheet-reservation-share-lifts",
      });
      try {
        // The shares the other way up, which is the case from the screenshot:
        // three parts of four is well clear of everything the member declares,
        // so the room goes to the card that can use it. This test asserted the
        // opposite until the declaration stopped being a ceiling — the card
        // stood at its declared height with the rest of the column left to the
        // neighbour, which is the dead band the one-rule change removed.
        await seed(app, { p1: 1, p2: 3 });
        const before = await rects(app, ["p1", "p2", "p3"]);
        const run = runOf(before);
        note(
          `share 1:3 unbound: p1=${before.p1.height.toFixed(1)} p2=${before.p2.height.toFixed(1)} of run ${run.toFixed(1)}`,
        );
        expect(
          Math.abs(before.p2.height - (run - IMPOSITION_GAP_PX) * 0.75),
          "the unbound card takes its three parts of four",
        ).toBeLessThanOrEqual(EPSILON);
        // Read the other way, so a division that merely happened to land near
        // the declaration could not pass: the card stands ABOVE what it
        // declared, which a ceiling could never allow.
        expect(
          before.p2.height,
          "which is well above the height it declared — no ceiling held it",
        ).toBeGreaterThan(SEEDED_OPENING_BID_PX + EPSILON);
        expect(
          Math.abs(
            before.p1.height - (run - IMPOSITION_GAP_PX) * 0.25,
          ),
          "and the neighbour keeps its own one part, no more",
        ).toBeLessThanOrEqual(EPSILON);

        // ── The other half of the roomy case: the card that took the room
        //    reaches the bottom of the run, with no band under it. ──
        expect(
          Math.abs(bandBeneath(before)),
          "the member that took the room reaches the bottom of the run",
        ).toBeLessThanOrEqual(EPSILON);

        await raisePicker(app);

        // The same refusal as the first test's, for the same reason: the bid
        // this fixture seeded is a number no picker measures, so the first
        // live report is held to it and written nowhere. What this test is
        // about is downstream of that — the DIVISION, which ignores the bid
        // whichever way the report went.
        const refused = await bidMismatches(app);
        note(`first report against the seeded bid: ${JSON.stringify(refused)}`);
        expect(
          refused.map((m) => m.memberId),
          "the first live report on the seeded member was held to the bid",
        ).toEqual(["p2"]);

        const panel = await panelMeasure(app);
        const open = await rects(app, ["p1", "p2"]);
        expect(
          panel?.overflow ?? 999,
          "and the panel was never capped short here either",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          panel?.bottomSlack ?? -1,
          "nor clipped by the frame around it",
        ).toBeGreaterThanOrEqual(0);
        expect(
          Math.abs(open.p2.height - before.p2.height),
          "raising the picker moves nothing — the card is already taller than the claim",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          Math.abs(open.p1.height - before.p1.height),
          "so the neighbour does not move either",
        ).toBeLessThanOrEqual(EPSILON);

        await assertFitAtListCap(app);

        // ── And binding moves NOTHING here, which is the other half of the
        //    same fact: the card was already standing at its stored share, so
        //    dropping the declaration takes nothing away from it. Under the
        //    old ceiling this was the moment the card jumped. ──
        await app.bindSession("B");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) === null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const settled = await rects(app, ["p1", "p2"]);
        note(
          `bound at 1:3: p1=${settled.p1.height.toFixed(1)} p2=${settled.p2.height.toFixed(1)}`,
        );
        expect(
          Math.abs(settled.p2.height - before.p2.height),
          "the card does not move across the binding",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          settled.p2.height,
          "the bound card takes its three parts of four, well clear of its floor",
        ).toBeGreaterThan(SESSION_FLOOR_PX + EPSILON);
        expect(
          Math.abs(settled.p2.height - (run - IMPOSITION_GAP_PX) * 0.75),
          "and the division really is the stored 3:1",
        ).toBeLessThanOrEqual(EPSILON);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a card added on the production path bids what it measured, and the picker reports the same number",
    async () => {
      const app = await launchTugApp({
        testName: "at0569-measured-bid",
      });
      try {
        // No Session card and no seeded bid in this fixture: the card arrives
        // through `addCard`, which is the only thing that MEASURES one. Slot 0
        // is a split column holding a single `hello` card, so the newcomer
        // joins it as a second member rather than stacking.
        await app.seedDeckState({
          state: {
            cards: [
              { id: "A", componentId: "hello", title: "Card A", closable: true },
              { id: "C", componentId: "hello", title: "Card C", closable: true },
            ],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 600, height: 400 },
                cardIds: ["A"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["maker"],
                slot: 0,
              },
              {
                id: "p3",
                position: { x: 40, y: 40 },
                size: { width: 600, height: 400 },
                cardIds: ["C"],
                activeCardId: "C",
                title: "",
                acceptsFamilies: ["maker"],
                slot: 1,
              },
            ],
            activePaneId: "p1",
            imposition: {
              kind: "two-up",
              sidebars: {},
              columns: { 0: { mode: "split", order: ["p1"] } },
            },
            hasFocus: true,
          },
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("show-card", { component: "session" }), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);

        const newcomer = await app.evalJS<string | null>(
          `(function () {
            var seeded = ["p1", "p3"];
            var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
            for (var i = 0; i < frames.length; i += 1) {
              var id = frames[i].getAttribute("data-pane-id");
              if (seeded.indexOf(id) === -1) return id;
            }
            return null;
          })()`,
        );
        expect(newcomer, "the card arrived").not.toBeNull();

        // ── ONE ROW. A fresh instance's `sessions.db` is empty, so the picker
        //    the card raises lists a single "New session" row and its panel is
        //    the short one. The number the deck holds for the member is what
        //    the app measured off that panel before it committed the pane, and
        //    the panel the user is now looking at reports the same number
        //    through the same arithmetic ([P02], [P04]). ──
        const oneRowPanel = await pickerPanelNaturalHeight(app);
        const oneRowHeld =
          (await reservations(app))?.[newcomer ?? ""] ??
          (await pins(app))?.[newcomer ?? ""] ??
          -1;
        note(
          `one-row picker: panel natural ${(oneRowPanel ?? -1).toFixed(1)}px, the deck holds ${oneRowHeld.toFixed(1)}px for the member`,
        );
        expect(oneRowPanel, "the picker's panel is on screen").not.toBeNull();
        expect(
          Math.abs(oneRowHeld - ((oneRowPanel ?? -1) + SHEET_PANEL_TO_MEMBER_PX)),
          "the first live report is the bid — the number the app measured before the commit",
        ).toBeLessThanOrEqual(MEASURED_BID_DRIFT);
        expect(
          await bidMismatches(app),
          "and the deck recorded no disagreement, because there was none",
        ).toEqual([]);

        // ── AT THE CAP. Filling the list is a genuine change to the picker,
        //    so the report it provokes is an honest update rather than a
        //    contradiction ([P05]). The member's number follows it, and the
        //    two heights are far enough apart that no single constant could
        //    have been right at both — which is the whole case for measuring.
        //    ──
        if (fixture === null) {
          throw new Error("the picker sessions fixture was not seeded");
        }
        await pointPickerAt(app, fixture);
        await wait(AFTER_LAND_MS);
        const cappedPanel = await pickerPanelNaturalHeight(app);
        const cappedHeld = (await reservations(app))?.[newcomer ?? ""] ?? -1;
        note(
          `list at its cap: panel natural ${(cappedPanel ?? -1).toFixed(1)}px, the deck holds ${cappedHeld.toFixed(1)}px for the member`,
        );
        expect(
          Math.abs(cappedHeld - ((cappedPanel ?? -1) + SHEET_PANEL_TO_MEMBER_PX)),
          "the claim follows the picker that changed under it",
        ).toBeLessThanOrEqual(REPORTER_DRIFT);
        expect(
          cappedHeld - oneRowHeld,
          "and the two pickers are far enough apart that no constant fits both",
        ).toBeGreaterThan(100);
        expect(
          await bidMismatches(app),
          "an honest update is not a mismatch",
        ).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
