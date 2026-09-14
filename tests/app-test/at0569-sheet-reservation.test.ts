/**
 * at0569-sheet-reservation.test.ts — an unbound Session card stands at its
 * picker's height, and gives the room back when a session opens.
 *
 * Two mechanisms meet on one card here, and this file is where the meeting is
 * pinned THROUGH THE LIVE APP.
 *
 * A modal surface whose natural height is content-bounded declares that height
 * at its call site, the sheet measures the panel and reports the number out,
 * and the deck holds the host member's floor there for as long as the sheet is
 * up. That is the RESERVATION, and on a Session card it is inert — the picker
 * asks for a little under 400px and the card's own stack floor is 600 — so the
 * claim is still made, still keyed by the host pane, and still carries the
 * panel's own measured height, all of which this file checks, and the division
 * ignores it.
 *
 * What actually sizes the card is the other mechanism: the EXACT-HEIGHT PIN
 * ([P01]). A Session card with no session behind it is nothing but the picker
 * it exists to raise — no transcript, no composer, and so none of what the
 * 600px floor is for. So the card declares what it is worth unbound
 * (`SESSION_UNBOUND_HEIGHT_PX`), and `placeMembers` reads that pin as the
 * member's floor AND its ceiling with a weight of zero, exactly as it already
 * reads a folded member's tier. The card stands at the picker's height, the
 * neighbour holds the rest of the run, and the binding commit drops the pin so
 * the stored division comes back.
 *
 * ## Why the frames MOVE here, where they used to be asserted not to
 *
 * This file's older claim was that nothing moves at all, which was the honest
 * reading of the reservation alone: a floor under a member already above it is
 * inert. The pin is not a floor, and it binds BELOW the card's stack floor on
 * purpose — that is the whole difference between the two records, and it is
 * asserted directly below by checking the pinned height is the lesser number.
 * So the geometry assertions now say where the two frames stand rather than
 * that they did not move, and the binding commit's assertion is the one that
 * did not change: after `bindSession` the division is the stored one again.
 *
 * ## What this file does NOT prove
 *
 * That `addCard` WRITES a pin on the production path. This test SEEDS its deck,
 * and `addCard` is the only thing that writes one, so `deckShape` seeds
 * `exactMemberHeights` itself — `seedDeckState` is an atomic in-process state
 * replace, so a new `DeckState` field passes straight through it. What is under
 * test here is the ALLOCATOR's reading of a pin and the binding commit's drop
 * of one. The production write is claim 4 of the choreography test, which adds
 * its card at run time.
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
 * `lib/exact-height-pin.ts`: an edit that changes where the picker's numbers go
 * selects this file, and only an edit that drops a declaration while leaving
 * both modules alone would slip past.
 *
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/lib/sheet-reservation.ts
 * @covers tugdeck/src/lib/exact-height-pin.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-registration.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { IMPOSITION_GAP_PX } from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Geometry tolerance: sub-pixel layout rounding, never a real disagreement. */
const EPSILON = 1.5;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

/**
 * The Session card's own stack floor (`session-card-registration.tsx`). Named
 * here because the pin binding BELOW it is what separates a pin from a
 * reservation, and that is asserted rather than assumed.
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
 * `SESSION_UNBOUND_HEIGHT_PX` from `session-card-registration.tsx`, copied
 * rather than imported: that module is a `.tsx` and this project compiles
 * without `--jsx`, which is the same reason `at0552` carries its own copy of
 * `SESSION_FOLDED_HEIGHT_PX`.
 *
 * A copy that drifts fails here rather than passing quietly — every geometry
 * assertion below is against this number, so changing the constant without
 * changing this one turns the file red on the commit that does it.
 */
const SESSION_UNBOUND_HEIGHT_PX = 444;

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
 * `exactMemberHeights` is SEEDED because this fixture seeds rather than adds:
 * `addCard` is the only thing that writes a pin, and nothing here calls it. See
 * the header for what that does and does not leave proven.
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
    exactMemberHeights: { p2: SESSION_UNBOUND_HEIGHT_PX },
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

/** The exact-height pins the live store holds, keyed by member. */
async function pins(app: App): Promise<Record<string, number> | null> {
  return app.evalJS<Record<string, number> | null>(
    `(window.tugdeck.diag.getDeckState().exactMemberHeights || null)`,
  );
}

/** The run slot 0's column divides, as the two frames report it. */
function runOf(frames: Record<string, Rect>): number {
  return frames.p1.height + IMPOSITION_GAP_PX + frames.p2.height;
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

describe.skipIf(!SHOULD_RUN)("AT0569 — an unbound Session card stands at its picker's height", () => {
  test(
    "the card opens at the pinned height, the neighbour holds the rest, and a session opening gives it back",
    async () => {
      const app = await launchTugApp({ testName: "at0569-sheet-reservation" });
      try {
        // Three parts to one. Without the pin the Session card's own share
        // would leave it a sliver and its 600px floor would hold it up; with
        // the pin neither number decides anything.
        await seed(app, { p1: 3, p2: 1 });
        const before = await rects(app, ["p1", "p2"]);
        const run = runOf(before);
        note(
          `pinned division: p1=${before.p1.height.toFixed(1)} p2=${before.p2.height.toFixed(1)} of run ${run.toFixed(1)}`,
        );

        // ── The pin stands, and it is the card's own declared height. ──
        expect(
          await pins(app),
          "the pin is keyed by the host pane and carries the declared height",
        ).toEqual({ p2: SESSION_UNBOUND_HEIGHT_PX });

        // ── The card stands EXACTLY there — floor and ceiling both. ──
        expect(
          Math.abs(before.p2.height - SESSION_UNBOUND_HEIGHT_PX),
          `the unbound card stands at SESSION_UNBOUND_HEIGHT_PX (${SESSION_UNBOUND_HEIGHT_PX})`,
        ).toBeLessThanOrEqual(EPSILON);

        // ── And the neighbour holds all of the rest of the run. ──
        expect(
          Math.abs(
            before.p1.height - (run - IMPOSITION_GAP_PX - SESSION_UNBOUND_HEIGHT_PX),
          ),
          "the neighbour holds the run less the gap and the pinned height",
        ).toBeLessThanOrEqual(EPSILON);

        // ── The pin binds BELOW the card's stack floor. That is the whole
        //    difference between a pin and the reservation below it. ──
        expect(
          SESSION_UNBOUND_HEIGHT_PX,
          "the pin is under the floor a reservation could never get below",
        ).toBeLessThan(SESSION_FLOOR_PX);

        await raisePicker(app);

        // ── The reservation is still made, keyed by the host pane, carrying
        //    the panel's own measured height. The mechanism is untouched. ──
        const claimed = await reservations(app);
        expect(Object.keys(claimed ?? {}), "keyed by the host pane").toEqual([
          "p2",
        ]);
        const panel = await panelMeasure(app);
        expect(panel, "the picker's panel is on screen").not.toBeNull();
        note(
          `claimed ${claimed?.p2 ?? -1}px; panel natural ${panel?.natural ?? -1}px, overflow ${panel?.overflow ?? -1}, bottom slack ${(panel?.bottomSlack ?? -1).toFixed(1)}px`,
        );
        expect(
          Math.abs((claimed?.p2 ?? -1) - (panel?.natural ?? -1)),
          "the number on the deck is the number the sheet measured",
        ).toBeLessThanOrEqual(REPORTER_DRIFT);

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

        // ── The picker is up and the card has not moved for it: the pin was
        //    already the picker's height, so there was nothing to make room
        //    for. This is what "no per-frame measurement" buys. ──
        const open = await rects(app, ["p1", "p2"]);
        expect(
          Math.abs(open.p2.height - before.p2.height),
          "raising the picker moves nothing — the card was already its height",
        ).toBeLessThanOrEqual(EPSILON);

        // ── A session opens: the pin comes down with the binding commit, and
        //    the card falls back into the share the hand gave it. ──
        await app.bindSession("B");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) === null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        expect(
          await pins(app),
          "the pin came down with the binding, absent rather than empty",
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
          settled.p2.height,
          "the card really did grow — the pin was doing something",
        ).toBeGreaterThan(before.p2.height + EPSILON);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a large stored share does not lift a pinned member either — a pin is a ceiling",
    async () => {
      const app = await launchTugApp({
        testName: "at0569-sheet-reservation-no-move",
      });
      try {
        // The shares the other way up. Unpinned this card would stand well
        // clear of its floor; the pin is a CEILING as well as a floor, so the
        // stored share buys it nothing while it is unbound.
        await seed(app, { p1: 1, p2: 3 });
        const before = await rects(app, ["p1", "p2"]);
        const run = runOf(before);
        note(
          `share 1:3 pinned: p1=${before.p1.height.toFixed(1)} p2=${before.p2.height.toFixed(1)} of run ${run.toFixed(1)}`,
        );
        expect(
          Math.abs(before.p2.height - SESSION_UNBOUND_HEIGHT_PX),
          "the pinned card stands at its height whatever its share says",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          Math.abs(
            before.p1.height - (run - IMPOSITION_GAP_PX - SESSION_UNBOUND_HEIGHT_PX),
          ),
          "and the neighbour takes everything its own share could not have won",
        ).toBeLessThanOrEqual(EPSILON);

        await raisePicker(app);

        const claimed = await reservations(app);
        expect(
          Object.keys(claimed ?? {}),
          "the claim is still made — it is the DIVISION that ignores it",
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
          "raising the picker over a pinned card moves nothing",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          Math.abs(open.p1.height - before.p1.height),
          "so the neighbour does not move either",
        ).toBeLessThanOrEqual(EPSILON);

        // ── And the stored share is what it falls back into: the 3:1 the hand
        //    wrote, which is well above the floor. ──
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
});
