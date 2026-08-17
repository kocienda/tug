/**
 * at0303-imposer-space-allocator.test.ts — the space allocator, on the real
 * deck: each rail solved on its own, in registered greed order.
 *
 * A slot is an anchor at a fixed fraction of the band and a card's width is its
 * own, so whatever the band leaves over shows up as slack between the cards:
 * choose Five Up on a roomy deck and the cards stand apart, narrow the window
 * slightly and the same arrangement overlaps. The **space allocator** treats the
 * pinned rails' width as the flexible quantity — they are the band's other ends
 * — and solves for the total that puts every seam on one imposition gap. That
 * total is then shared out under a fixed order of invariants: floors are
 * inviolable, the tiling total outranks preferences, preferences fill in greed
 * order (the Overview is greedier than the Lens, which is greedier than Jots),
 * and the slim content width (675) caps everything. Nothing is graded and the
 * answer is a pure function of the canvas, the chain, and the rails' policies.
 *
 * The total is chosen by the picture it PAINTS — scored on `imposeRect`'s real
 * clamped geometry, worst occlusion first — and a rail carries two floors: the
 * width it cannot paint under, and the narrower-than-comfortable width it will
 * accept when accepting it is what clears the overlap.
 *
 * What has to hold:
 *
 *  1. It engages. Picking an arrangement whose solve is inside the rail's
 *     bounds lands the rail on that solve, and every seam in the chain on
 *     `IMPOSITION_GAP_PX`. The rail's crossing is a FLIP settle like any other
 *     arrangement change, not a cut.
 *  2. It leaves the preference alone. The allocated width is live geometry; the
 *     width the user CHOSE is what the Lens reopens at, and no number of
 *     re-tunes may touch it. Read through the production path — close the Lens,
 *     open it again, and it must come back at the preferred width. This is the
 *     no-ratchet guard, and it is now structural: the solver cannot see a rail's
 *     standing width at all.
 *  3. A surplus grows the rail PAST its preference, up to the ceiling. The old
 *     rule capped an untileable slack at the width the user chose and left the
 *     deck's slack pooled between the cards instead; preference is where the
 *     fill starts, not a cap on it. Asserted explicitly so the deleted cap
 *     cannot creep back.
 *  4. Re-asserting the layout re-tunes. Re-clicking the already-active Cards
 *     option used to be a total no-op; it now drives the same entry the
 *     settled-resize observer calls. The harness cannot resize the app's
 *     window, so this gesture is what covers that entry end to end.
 *  5. Joining the chain RE-TUNES. Assigning a card to a slot is the imposer's
 *     own verb — the user asked the deck to arrange itself, whichever door
 *     dispatched it — so the assign itself re-solves the rails for the chain
 *     it just completed, with no separate Layouts click needed.
 *  6. Two rails answer with two widths, in greed order. With the Overview on one
 *     edge and the Lens on the other, the two rails stand at DIFFERENT widths,
 *     and which one is wide is the registered greed order's answer: shrink what
 *     the chain leaves and the Lens drains to its floor while the Overview holds
 *     its measure.
 *  7. A crowded deck spends comfort to un-occlude the cards. When the chain
 *     overlaps at the rails' comfort floors but tiles below them, the Overview
 *     gives up its comfortable measure and the chain stands clear — showing
 *     the user's cards outranks a rail's preferred measure. Asserted on real
 *     pane rects: no two chain panes overlap, and the Overview is narrower than
 *     its comfort width while never under its hard floor.
 *  8. The hard floor is the DRAG floor, and it is genuinely reachable. A real
 *     edge drag can take the Overview below its comfort measure, down to the
 *     width it cannot paint under and no further. The rail's comfort measure
 *     constrains the ALLOCATOR; it may not trap the user's own hand.
 *
 * **THE HARNESS CANNOT RESIZE THE WINDOW**, which is why every fixture card
 * width is computed at runtime from the measured canvas: `T*` is
 * `canvas − gap·(R+2) − B*` and `B*` is a function of the chain's card widths,
 * so moving a fixture card's width moves the target exactly as moving the
 * canvas would. Seeding card widths and re-asserting the layout is how this
 * test reaches either side of a breakpoint. Preferences are seeded through
 * tugbank rather than assumed.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/card-registry.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import {
  COMFORT_OVERVIEW_WIDTH_PX,
  DEFAULT_OVERVIEW_WIDTH_PX,
  MIN_OVERVIEW_WIDTH_PX,
} from "../../tugdeck/src/lib/overview-measure";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The imposition gap (`lib/layout-imposer.ts`). */
const GAP = 5;
/** The widest any rail may stand: the slim content width. */
const CEILING = 675;
/** The preferred Lens width this test seeds, so nothing depends on the default. */
const PREFERRED = 420;
/** The Lens's registered floor (`lib/lens-store/types.ts`). */
const MIN_LENS_WIDTH_PX = 320;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** Frames are measured in device pixels; a rounded pin is within a pixel. */
const TOL = 1.5;

const FIVE_UP_TILE = '[data-testid="lens-layouts-kind"] [data-choice-value="five-up"]';
const KIND_TILES = '[data-testid="lens-layouts-kind"] [data-choice-value]';
const LENS_FRAME = `.tug-pane[data-pane-id="pLens"]`;
/** The three chain panes, in slot order. */
const CHAIN = ["p1", "p2", "p3"];

/**
 * A deck of three cards in slots 1, 3 and 5 (stored 0-based) at `paneWidth`,
 * with the Lens pinned right at `lensWidth`. The kind starts at two-up, so
 * choosing Five Up in the Layouts section is a real kind change.
 */
function deckShape(paneWidth: number, lensWidth: number) {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: paneWidth, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "hello", title: "Card A", closable: true },
      { id: "B", componentId: "hello", title: "Card B", closable: true },
      { id: "C", componentId: "hello", title: "Card C", closable: true },
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 2, "B"),
      pane("p3", 4, "C"),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: lensWidth, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "two-up", lens: "right" },
    hasFocus: true,
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Seed the user's preferred Lens width, the number the flex range centres on. */
async function seedPreferredWidth(app: App, widthPx: number): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${widthPx} }), null)`,
  );
}

/** The width of the canvas the chain is imposed across. */
async function canvasWidth(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector(".tug-pane").parentElement.clientWidth`,
  );
}

async function frameWidth(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().width`,
  );
}

/** The seam between each pair of adjacent chain panes, left to right. */
async function seams(app: App): Promise<number[]> {
  return app.evalJS<number[]>(
    `(function () {
      var rects = ${JSON.stringify(CHAIN)}.map(function (id) {
        return document.querySelector('.tug-pane[data-pane-id="' + id + '"]').getBoundingClientRect();
      });
      var out = [];
      for (var i = 0; i < rects.length - 1; i += 1) {
        out.push(rects[i + 1].left - rects[i].right);
      }
      return out;
    })()`,
  );
}

/**
 * The pane width whose exact solve puts the Lens `offset` px off the preferred
 * width. Three cards and two gaps fill the band, and the band is the canvas
 * less the Lens and three gaps — so `lens = canvas - 5·gap - 3·width`.
 */
function paneWidthFor(canvas: number, offset: number): number {
  return Math.floor((canvas - GAP * 5 - (PREFERRED + offset)) / 3);
}

/** What the allocator must answer for that fixture — the same arithmetic back. */
function predictedLensWidth(canvas: number, paneWidth: number): number {
  return canvas - GAP * 5 - paneWidth * 3;
}

/**
 * The pane width whose solve wants the two rails to total `railTotal`.
 *
 * With rails on both edges the canvas spends six gaps — one per rail, one at
 * each end of the band, and one interior seam per card pair — so
 * `canvas = railTotal + 6·gap + 3·pane`. Seeding the CARD width is how this
 * test moves the target: `T*` is a function of the chain's widths exactly as
 * it is of the canvas, and the harness cannot resize the window.
 */
function twoRailPaneWidth(canvas: number, railTotal: number): number {
  return Math.floor((canvas - GAP * 6 - railTotal) / 3);
}

/** The rail total that fixture actually asks for — the floor above leaves up
 *  to 2px on the table, and the assertions are exact, so they read it back. */
function railTotalFor(canvas: number, paneWidth: number): number {
  return canvas - GAP * 6 - paneWidth * 3;
}

/** The three-card chain with the Overview pinned left and the Lens right, each
 *  standing at the width its owner chose. */
async function seedTwoRails(
  app: App,
  paneWidth: number,
  kind: "two-up" | "five-up" = "two-up",
): Promise<void> {
  const shape = deckShape(paneWidth, PREFERRED);
  shape.cards.push({
    id: "G",
    componentId: "overview",
    title: "Overview",
    closable: true,
  });
  shape.panes.push({
    id: "pGaz",
    position: { x: 0, y: 0 },
    size: { width: DEFAULT_OVERVIEW_WIDTH_PX, height: 900 },
    cardIds: ["G"],
    activeCardId: "G",
    title: "Overview",
    acceptsFamilies: [],
  });
  await app.seedDeckState({
    state: {
      ...shape,
      imposition: {
        kind,
        sidebars: { lens: { side: "right" }, overview: { side: "left" } },
      },
    },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

async function seedFixture(
  app: App,
  paneWidth: number,
  lensWidth: number,
): Promise<void> {
  await app.seedDeckState({
    state: deckShape(paneWidth, lensWidth),
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
    { timeoutMs: 8_000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0303 — the space allocator flexes the Lens to tile the chain",
  () => {
    test(
      "an in-range solve lands exact seams, settles by FLIP, and leaves the preference alone",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-space-allocator",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await seedFixture(app, 400, PREFERRED);

          // The fixture is sized against the canvas the app actually launched
          // at, so the exact solve lands 30px above the preferred width —
          // inside the flex range whatever the window size.
          const canvas = await canvasWidth(app);
          const paneWidth = paneWidthFor(canvas, 30);
          expect(paneWidth).toBeGreaterThan(200);
          await seedFixture(app, paneWidth, PREFERRED);
          await wait(AFTER_LAND_MS);

          // At rest the Lens shows the preferred width: seeding a deck is not
          // one of the moments that re-tunes.
          expect(await frameWidth(app, "pLens")).toBeCloseTo(PREFERRED, 0);

          // ── The moment: choose Five Up. ──────────────────────────────────
          await app.nativeClickAtElement(FIVE_UP_TILE);

          // The Lens's new width crosses by the settle FLIP rather than
          // cutting — the width is part of the arrangement signature.
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") !== null`,
            { timeoutMs: 2_000 },
          );
          await wait(AFTER_LAND_MS);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector("[data-imposer-settling]") !== null`,
            ),
          ).toBe(false);

          expect(await frameWidth(app, "pLens")).toBeCloseTo(
            predictedLensWidth(canvas, paneWidth),
            0,
          );
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(TOL);
          }

          // ── The preference is untouched. Read through the path that owns
          // it: the Lens reopens at the width the user chose, never at the
          // width the allocator handed it. ─────────────────────────────────
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-lens"), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LENS_FRAME)}) === null`,
            { timeoutMs: 5_000 },
          );
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-lens"), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector('.tug-pane[data-lens-pane]') !== null`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          expect(
            await app.evalJS<number>(
              `document.querySelector('.tug-pane[data-lens-pane]').getBoundingClientRect().width`,
            ),
          ).toBeCloseTo(PREFERRED, 0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a surplus grows the rail past its preference, and stops at the ceiling",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-surplus",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await seedFixture(app, 400, PREFERRED);

          const canvas = await canvasWidth(app);

          // First, a surplus the rail can absorb: the solve sits 120px above
          // the chosen 420, well under the 675 ceiling. The rail takes all of
          // it. The width the user chose is where the fill STARTS — the
          // deleted rule capped an untileable slack here and left the deck's
          // spare pixels pooled between the cards instead.
          const reachable = paneWidthFor(canvas, 120);
          expect(reachable).toBeGreaterThan(200);
          await seedFixture(app, reachable, PREFERRED);
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pLens")).toBeCloseTo(PREFERRED, 0);

          await app.nativeClickAtElement(FIVE_UP_TILE);
          await wait(AFTER_LAND_MS);
          const grown = await frameWidth(app, "pLens");
          expect(grown).toBeCloseTo(predictedLensWidth(canvas, reachable), 0);
          expect(grown).toBeGreaterThan(PREFERRED);
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(TOL);
          }

          // Then a surplus it cannot: the solve sits 320px above the chosen
          // width — 65 past the slim ceiling. The rail grows as far as it may
          // and stops there, and the pixels it could not take stay in the
          // chain, which is why the cards still stand apart.
          const unreachable = paneWidthFor(canvas, 320);
          expect(unreachable).toBeGreaterThan(200);
          await app.seedDeckState({
            state: {
              ...deckShape(unreachable, PREFERRED),
              imposition: { kind: "five-up", lens: "right" },
            },
            focusCardId: "A",
          });
          await wait(AFTER_LAND_MS);
          await app.nativeClickAtElement(FIVE_UP_TILE);
          await wait(AFTER_LAND_MS);

          expect(await frameWidth(app, "pLens")).toBeCloseTo(CEILING, 0);
          for (const seam of await seams(app)) {
            expect(seam).toBeGreaterThan(GAP);
          }

          // Idempotent: the answer is a function of the inputs, not of where
          // the rail happens to be standing, so re-asserting changes nothing.
          await app.nativeClickAtElement(FIVE_UP_TILE);
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pLens")).toBeCloseTo(CEILING, 0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "re-clicking the active layout re-tunes, and nothing else does",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-reassert",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await seedFixture(app, 400, PREFERRED);

          const canvas = await canvasWidth(app);
          const first = paneWidthFor(canvas, 30);
          await seedFixture(app, first, PREFERRED);
          await wait(AFTER_LAND_MS);
          await app.nativeClickAtElement(FIVE_UP_TILE);
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pLens")).toBeCloseTo(
            predictedLensWidth(canvas, first),
            0,
          );

          // Now change what the chain wants, WITHOUT going through a moment:
          // the arrangement is already Five Up, so this is the state a card
          // resize leaves behind — seams gone ragged, and nothing has asked
          // for them back.
          const second = paneWidthFor(canvas, -30);
          await app.seedDeckState({
            state: {
              ...deckShape(second, predictedLensWidth(canvas, first)),
              imposition: { kind: "five-up", lens: "right" },
            },
            focusCardId: "A",
          });
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pLens")).toBeCloseTo(
            predictedLensWidth(canvas, first),
            0,
          );
          expect(
            Math.abs((await seams(app))[0] - GAP),
          ).toBeGreaterThan(TOL);

          // Re-click the layout that is ALREADY active. This used to be a
          // total no-op; it now runs the same re-tune the settled-resize
          // observer asks for.
          await app.nativeClickAtElement(FIVE_UP_TILE);
          await wait(AFTER_LAND_MS);

          expect(await frameWidth(app, "pLens")).toBeCloseTo(
            predictedLensWidth(canvas, second),
            0,
          );
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a card joining the chain re-tunes the rails in the same gesture",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-assign",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await seedFixture(app, 400, PREFERRED);

          // Sized so the THREE-card chain's exact solve sits 30px above the
          // preferred width — in range. The two-card chain it starts as is
          // never solved at all: seeding a deck is not one of the moments,
          // so the Lens rests at the preferred width until a gesture asks.
          const canvas = await canvasWidth(app);
          const paneWidth = paneWidthFor(canvas, 30);
          expect(paneWidth).toBeGreaterThan(200);

          const shape = deckShape(paneWidth, PREFERRED);
          const middle = shape.panes.find((p) => p.id === "p2");
          if (middle === undefined) throw new Error("fixture lost p2");
          delete (middle as { slot?: number }).slot;
          await app.seedDeckState({
            state: {
              ...shape,
              panes: [...shape.panes],
              imposition: { kind: "five-up", lens: "right" },
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pLens")).toBeCloseTo(PREFERRED, 0);

          // ── Put the loose card in slot 3 — the assign the Lens row's slot
          // picker dispatches (a ⌘N chord lands on the same verb). The assign
          // completes a chain the allocator can tile, and the assign ITSELF
          // is the moment: the user just asked the deck to arrange itself,
          // and the deck makes room for what it was asked to arrange. ──────
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("assign-slot", { cardId: "B", slot: 2 }), null)`,
          );
          await wait(AFTER_LAND_MS);

          expect(await frameWidth(app, "pLens")).toBeCloseTo(
            predictedLensWidth(canvas, paneWidth),
            0,
          );
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "two rails answer with two widths, and greed decides which one is wide",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-greed-order",
        });
        try {
          // Both preferences are seeded, so nothing here depends on a default:
          // the Overview at its ch-derived width, the Lens at 420.
          await seedPreferredWidth(app, PREFERRED);
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugtool.overview", "widthPx", { kind: "i64", value: ${DEFAULT_OVERVIEW_WIDTH_PX} }), null)`,
          );
          await seedFixture(app, 400, PREFERRED);

          const canvas = await canvasWidth(app);

          // ── Surplus. The chain wants 60px more rail than the two
          // preferences total. The GREEDIEST rail is fed first, so all of it
          // goes to the Overview and the Lens does not move at all. ──────────
          const surplusPane = twoRailPaneWidth(
            canvas,
            PREFERRED + DEFAULT_OVERVIEW_WIDTH_PX + 60,
          );
          expect(surplusPane).toBeGreaterThan(200);
          await seedTwoRails(app, surplusPane);
          await app.nativeClickAtElement(FIVE_UP_TILE);
          await wait(AFTER_LAND_MS);

          const surplusTotal = railTotalFor(canvas, surplusPane);
          const fedOverview = await frameWidth(app, "pGaz");
          const heldLens = await frameWidth(app, "pLens");
          expect(heldLens, "the less greedy rail is not fed first").toBeCloseTo(
            PREFERRED,
            0,
          );
          expect(fedOverview).toBeCloseTo(surplusTotal - PREFERRED, 0);
          expect(fedOverview).toBeGreaterThan(DEFAULT_OVERVIEW_WIDTH_PX);
          expect(Math.round(fedOverview)).not.toBe(Math.round(heldLens));
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(TOL);
          }

          // ── Deficit. Now the chain wants 140px LESS rail than the two
          // preferences total, which is more than the Lens alone can give.
          // The least greedy rail drains first and lands on its floor; only
          // then does the Overview give the remainder — and it is still the
          // wider of the two. ───────────────────────────────────────────────
          const deficitPane = twoRailPaneWidth(
            canvas,
            PREFERRED + DEFAULT_OVERVIEW_WIDTH_PX - 140,
          );
          expect(deficitPane).toBeGreaterThan(200);
          await seedTwoRails(app, deficitPane, "five-up");
          await app.nativeClickAtElement(FIVE_UP_TILE);
          await wait(AFTER_LAND_MS);

          const deficitTotal = railTotalFor(canvas, deficitPane);
          const drainedLens = await frameWidth(app, "pLens");
          const holdingOverview = await frameWidth(app, "pGaz");
          expect(
            drainedLens,
            "the least greedy rail drains all the way to its floor",
          ).toBeCloseTo(MIN_LENS_WIDTH_PX, 0);
          expect(holdingOverview).toBeCloseTo(deficitTotal - MIN_LENS_WIDTH_PX, 0);
          expect(holdingOverview).toBeGreaterThan(drainedLens);
          // And never under the Overview's own hard floor, the width below which
          // a post stops painting at all.
          expect(holdingOverview).toBeGreaterThanOrEqual(MIN_OVERVIEW_WIDTH_PX);
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a crowded deck spends the Overview's comfort measure to clear the overlap",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-crowded",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugtool.overview", "widthPx", { kind: "i64", value: ${DEFAULT_OVERVIEW_WIDTH_PX} }), null)`,
          );
          await seedFixture(app, 400, PREFERRED);

          const canvas = await canvasWidth(app);

          // The shape the whole addendum is about. Size the cards so the chain
          // tiles at a rail total inside the Overview's COMFORT BAND — under
          // what the two comfort floors add up to, but still above what the two
          // hard floors do. At the comfort floors these cards occlude one
          // another; a little lower they stand clear. The deck's duty to show
          // the user's cards outranks the Overview's comfortable measure, so
          // comfort is spent — and spent by the greediest rail last, only after
          // the Lens has given everything it has.
          //
          // Aimed at the MIDDLE of that band rather than a fixed number of
          // pixels below comfort: the band is exactly the distance between the
          // Overview's two floors, and retuning its type moves both. A hardcoded
          // descent asks for a total the rails may no longer be able to reach.
          const comfortTotal = MIN_LENS_WIDTH_PX + COMFORT_OVERVIEW_WIDTH_PX;
          const comfortBand = COMFORT_OVERVIEW_WIDTH_PX - MIN_OVERVIEW_WIDTH_PX;
          expect(
            comfortBand,
            "the Overview needs a comfort band for this case to mean anything",
          ).toBeGreaterThanOrEqual(16);
          const tiling = comfortTotal - Math.floor(comfortBand / 2);
          const crowdedPane = twoRailPaneWidth(canvas, tiling);
          expect(crowdedPane).toBeGreaterThan(200);
          await seedTwoRails(app, crowdedPane, "five-up");
          await app.nativeClickAtElement(FIVE_UP_TILE);
          await wait(AFTER_LAND_MS);

          const overview = await frameWidth(app, "pGaz");
          const lens = await frameWidth(app, "pLens");

          // The cards stand clear. This is the assertion the landed Phase 1
          // solver failed: it pinned the Overview at its comfort measure and let
          // the chain occlude by whatever the arithmetic left over.
          for (const seam of await seams(app)) {
            expect(seam, "no two chain panes overlap").toBeGreaterThan(0);
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(TOL);
          }

          // And it was bought with the Overview's comfort, at the Lens's
          // expense first and never below the width the Overview cannot paint
          // under.
          expect(
            lens,
            "the least greedy rail gives everything before comfort is spent",
          ).toBeCloseTo(MIN_LENS_WIDTH_PX, 0);
          expect(overview).toBeLessThan(COMFORT_OVERVIEW_WIDTH_PX);
          expect(overview).toBeGreaterThanOrEqual(MIN_OVERVIEW_WIDTH_PX);
          expect(overview + lens).toBeCloseTo(
            railTotalFor(canvas, crowdedPane),
            0,
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the user can drag the Overview below its comfort measure, down to its hard floor",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-drag-floor",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugtool.overview", "widthPx", { kind: "i64", value: ${DEFAULT_OVERVIEW_WIDTH_PX} }), null)`,
          );
          await seedFixture(app, 400, PREFERRED);
          await seedTwoRails(app, 400, "five-up");

          // The Overview holds the LEFT edge, so its one handle is its east
          // one — a rail exposes only its deck-facing edge.
          const handle = '.tug-pane[data-pane-id="pGaz"] .tug-pane-resize-e';
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(handle)}).length`,
            ),
          ).toBe(1);

          const grip = await app.evalJS<{ x: number; y: number }>(
            `(function () {
              var r = document.querySelector(${JSON.stringify(handle)}).getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            })()`,
          );

          // Drag it well past the comfort measure and past the hard floor too:
          // 300px in from a 580px rail asks for 280, which is under both. The
          // resize commit clamps to the registered `sizePolicy.min.width`, so
          // where it lands is the answer to "what floor does the user's own
          // hand actually meet".
          await app.nativeDrag(grip, { x: grip.x - 300, y: grip.y });
          await wait(AFTER_LAND_MS);

          const dragged = await frameWidth(app, "pGaz");
          expect(
            dragged,
            "the drag reaches the hard floor, not the comfort measure",
          ).toBeCloseTo(MIN_OVERVIEW_WIDTH_PX, 0);
          expect(dragged).toBeLessThan(COMFORT_OVERVIEW_WIDTH_PX);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
