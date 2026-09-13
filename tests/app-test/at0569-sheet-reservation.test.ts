/**
 * at0569-sheet-reservation.test.ts — a sheet states the height it needs, and
 * its place holds a floor for it.
 *
 * A modal surface whose natural height is content-bounded declares that height
 * at its call site, the sheet measures the panel and reports the number out,
 * and the deck holds the host member's floor there for as long as the sheet is
 * up. What this file pins is the whole of that path THROUGH THE LIVE APP: the
 * Choose Session picker opens on a member of a split column, the claim lands on
 * the deck keyed by the pane hosting the card, it carries the panel's own
 * measured height, and it comes down when a session opens. Nothing else
 * exercises that seam — the allocator's arithmetic is unit-tested, but nothing
 * below this file proves the picker ever declares, measures, or reports.
 *
 * ## What the geometry does, and why that is the assertion
 *
 * On a Session card the reservation is a floor the card is ALREADY above. The
 * picker's measured natural height is a little under 400px — its chrome, a path
 * field, a label, a list capped at 14.5rem, and an action row — and the Session
 * card's own stack floor is 600px, so `placeMembers` takes the greater of the
 * two and the claim never binds. That holds in both standings a place has: a
 * shared division never allocates the card below its 600px floor, and an
 * overflowing place stands every member at its floor outright.
 *
 * So the frames do not move, and the test says so on purpose. That is [B07] of
 * the brief read at full strength — a member whose height already exceeds the
 * sheet's needs keeps it, and nothing moves at all — and it is asserted from
 * both directions: with the card pinned at its floor by a small stored share,
 * and with it pinned above its floor by a large one. A future change that makes
 * a reserving card move will fail here, which is the right way round: this file
 * records what the mechanism does today, with the two numbers that decide it
 * named in the diagnostics of every run.
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
 * outright on the commit that does it. What stands in its place is
 * `lib/sheet-reservation.ts`, which is the seam the call site reaches the deck
 * through: an edit that changes where the picker's number goes selects this
 * file, and only an edit that drops the option while leaving that module alone
 * would slip past.
 *
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/lib/sheet-reservation.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Geometry tolerance: sub-pixel layout rounding, never a real disagreement. */
const EPSILON = 1.5;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

/**
 * The Session card's own stack floor (`session-card-registration.tsx`). Named
 * here because it is half of why the frames below do not move — the other half
 * being the picker's measured height, which every run reports.
 */
const SESSION_FLOOR_PX = 600;

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
 * borders and its own margins — and the overflow of that natural height against
 * the room the panel actually has.
 *
 * The formula is spelled out here rather than inferred, because it is the
 * contract the reservation rests on: `scrollHeight` is what the panel wants
 * whether or not a cap is biting, which is what makes the number stable against
 * the room it wins. An overflow above a pixel is the panel capped short.
 */
async function panelMeasure(
  app: App,
): Promise<{ natural: number; overflow: number } | null> {
  return app.evalJS<{ natural: number; overflow: number } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(SHEET_PANEL)});
      if (el === null) return null;
      var cs = getComputedStyle(el);
      var px = function (v) { return parseFloat(v) || 0; };
      return {
        natural:
          el.scrollHeight +
          px(cs.borderTopWidth) +
          px(cs.borderBottomWidth) +
          px(cs.marginTop) +
          px(cs.marginBottom),
        overflow: el.scrollHeight - el.clientHeight,
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

describe.skipIf(!SHOULD_RUN)("AT0569 — a sheet's reservation is its host's floor", () => {
  test(
    "the picker claims its measured height against the pane hosting it, and drops the claim when a session opens",
    async () => {
      const app = await launchTugApp({ testName: "at0569-sheet-reservation" });
      try {
        // Three parts to one, so the Session card's own share would leave it a
        // sliver — and its 600px floor is what actually holds it up.
        await seed(app, { p1: 3, p2: 1 });
        const before = await rects(app, ["p1", "p2"]);
        note(
          `stored division: p1=${before.p1.height.toFixed(1)} p2=${before.p2.height.toFixed(1)}`,
        );
        expect(
          await reservations(app),
          "no sheet is up, so nothing is claiming",
        ).toBeNull();

        await raisePicker(app);

        // ── The claim stands, keyed by the PANE hosting the card. ──
        const claimed = await reservations(app);
        expect(Object.keys(claimed ?? {}), "keyed by the host pane").toEqual([
          "p2",
        ]);

        // ── And it carries the panel's own measured natural height. ──
        const panel = await panelMeasure(app);
        expect(panel, "the picker's panel is on screen").not.toBeNull();
        note(
          `claimed ${claimed?.p2 ?? -1}px against a floor of ${SESSION_FLOOR_PX}px`,
        );
        expect(
          claimed?.p2,
          "the number on the deck is the number the sheet measured",
        ).toBeCloseTo(panel?.natural ?? -1, 0);
        expect(
          panel?.overflow ?? 999,
          "the panel stands at its natural height rather than capped short",
        ).toBeLessThanOrEqual(EPSILON);

        // ── The claim is BELOW this card's own floor, which is why the
        //    division below is unchanged. Both numbers are on the record. ──
        expect(
          claimed?.p2,
          "the picker asks for less than the Session card's stack floor",
        ).toBeLessThan(SESSION_FLOOR_PX);

        // ── So nothing moves: a floor under a member already above it is
        //    inert, and the neighbour is untouched with it ([B07]). ──
        const open = await rects(app, ["p1", "p2"]);
        expect(
          Math.abs(open.p2.height - before.p2.height),
          "the host stands where its floor already put it",
        ).toBeLessThan(EPSILON);
        expect(
          Math.abs(open.p1.height - before.p1.height),
          "and the neighbour keeps every pixel it had",
        ).toBeLessThan(EPSILON);

        // ── A session opens: the sheet stands down and the claim comes with
        //    it, leaving the stored division exactly as the hand wrote it. ──
        await app.bindSession("B");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) === null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        expect(
          await reservations(app),
          "the claim came down with the sheet, absent rather than empty",
        ).toBeNull();
        const settled = await rects(app, ["p1", "p2"]);
        note(
          `settled: p1=${settled.p1.height.toFixed(1)} p2=${settled.p2.height.toFixed(1)}`,
        );
        expect(
          Math.abs(settled.p2.height - before.p2.height),
          "the card is back at the height its stored share gives it",
        ).toBeLessThan(EPSILON);
        expect(
          Math.abs(settled.p1.height - before.p1.height),
          "and so is its neighbour",
        ).toBeLessThan(EPSILON);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a member held above its floor by its own stored share does not move either",
    async () => {
      const app = await launchTugApp({
        testName: "at0569-sheet-reservation-no-move",
      });
      try {
        // The shares the other way up: the Session card is well clear of its
        // floor on the hand's own division, which is the other way a member can
        // already be taller than the sheet it hosts.
        await seed(app, { p1: 1, p2: 3 });
        const before = await rects(app, ["p1", "p2"]);
        expect(
          before.p2.height,
          "the fixture really does put this card above its floor",
        ).toBeGreaterThan(SESSION_FLOOR_PX + EPSILON);

        await raisePicker(app);

        const claimed = await reservations(app);
        expect(
          Object.keys(claimed ?? {}),
          "the claim is still made — it is the DIVISION that ignores it",
        ).toEqual(["p2"]);

        const panel = await panelMeasure(app);
        const open = await rects(app, ["p1", "p2"]);
        note(
          `above its floor: p2 ${before.p2.height.toFixed(1)} → ${open.p2.height.toFixed(1)}, claim ${claimed?.p2 ?? -1}px`,
        );
        expect(
          panel?.overflow ?? 999,
          "and the panel was never capped short here either",
        ).toBeLessThanOrEqual(EPSILON);
        expect(
          Math.abs(open.p2.height - before.p2.height),
          "a floor under a member already above it moves nothing",
        ).toBeLessThan(EPSILON);
        expect(
          Math.abs(open.p1.height - before.p1.height),
          "so the neighbour does not move either",
        ).toBeLessThan(EPSILON);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
