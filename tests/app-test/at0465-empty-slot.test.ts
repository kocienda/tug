/**
 * at0465-empty-slot.test.ts — a slot with no card in it is still a place.
 *
 * Flow used to read the deck's slots as a SEQUENCE of occupied ones: an empty
 * slot contributed nothing to the strip, not even a gap. So a deck holding
 * cards in slots 0, 1 and 3 stood as a run of three and drew itself `1|2|4`,
 * and a chord naming slot 4 moved its card nowhere the eye could follow —
 * because that card's place was already the third position in the run. Fit
 * never had the fault: a fit anchor is a travel fraction, and an empty slot has
 * always kept its share of the band. Flow was the outlier, and both modes now
 * number the same deck the same way.
 *
 * A held-open slot also has to BE somewhere, and being somewhere is what makes
 * it reachable. `drop-zones.ts` has advertised an empty anchor as one of its
 * four zone kinds since it shipped, and that branch was unreachable the whole
 * time: the measurement walked panes, and an empty slot has none, so the slot
 * advertised nothing and a card could only ever be dropped where another card
 * already stood. The vacancy tile closes it — a real box at the anchor and the
 * width a card landing there would take, measured off the DOM like every other
 * rect the engine is handed, rather than re-solved in TypeScript from geometry
 * the CSS `calc()` chain owns.
 *
 * What this file pins:
 *
 *   1. **An empty slot paints a tile**, one per slot of the kind no pane
 *      stands in, and none for a slot that is occupied. It stands at the empty
 *      slot's own anchor, which on a two-up with the card at the far end means
 *      the near end of the band. The tile is the MEASUREMENT — the full room a
 *      card landing there would take — and the badge centered in it is the
 *      PICTURE, a numbered chip in the vocabulary the strip and the masthead
 *      already name places with. Two different sizes on purpose: the room
 *      drawn as a hairline outline read as a rendering fault rather than as a
 *      statement, and a several-hundred-pixel empty rectangle says nothing an
 *      empty place needs said.
 *   2. **A card dragged onto the tile lands in that slot** — the gesture that
 *      was impossible before this existed — and the slot the card LEFT becomes
 *      a held-open place in its turn.
 *   3. **⌘N moves a card onto an empty slot, and the card MOVES.** The store
 *      write always worked; what did not was the card ending up anywhere the
 *      user could see, which is why the assertion is on pixels as well as on
 *      `pane.slot`.
 *   4. **In flow the strip draws every slot**, so a deck with a gap in its
 *      numbering reads `1|2|3` rather than collapsing to `1|2`.
 *
 * @covers tugdeck/src/components/chrome/slot-vacancy.css
 * @covers tugdeck/src/components/tugways/tug-slot.tsx
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** Geometry tolerance, in px. */
const EPSILON = 3;

const LENS_WIDTH = 380;
const PANE_WIDTH = 420;
/**
 * What a held-open slot reserves here: the widest card standing in the chain
 * (`vacancyExtent`), which on this fixture is one card at `PANE_WIDTH`. Not the
 * deck's content preset — the reserved room is drawn, and a gap sized to a
 * preset the cards are not at reads as wrong however defensible the number is.
 */
const RESERVED_PX = PANE_WIDTH;

const frame = (paneId: string): string => `.tug-pane[data-pane-id="${paneId}"]`;
const titleBar = (paneId: string): string =>
  `${frame(paneId)} .tug-pane-title-bar`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Rect {
  top: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

function paneOf(id: string, cardId: string, slot: number) {
  return {
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  };
}

function lensPane() {
  return {
    id: "pLens",
    position: { x: 0, y: 0 },
    size: { width: LENS_WIDTH, height: 900 },
    cardIds: ["L"],
    activeCardId: "L",
    title: "Lens",
    acceptsFamilies: [],
  };
}

function cardsFor(ids: readonly string[]) {
  return [
    ...ids.map((id) => ({
      id,
      componentId: "hello",
      title: `Card ${id}`,
      closable: true,
    })),
    { id: "L", componentId: "lens", title: "Lens", closable: true },
  ];
}

/**
 * One card, in the SECOND slot of a two-up, with the Lens pinned right.
 *
 * The far slot deliberately: with the card at the band's far end and slot 0
 * standing empty at its near end, the tile and the card are at opposite ends
 * of the band, so "the tile is where the empty slot is" is a claim about
 * pixels rather than a coincidence of overlap.
 */
function oneCardDeck() {
  return {
    cards: cardsFor(["A"]),
    panes: [paneOf("p1", "A", 1), lensPane()],
    activePaneId: "p1",
    imposition: { kind: "two-up", sidebars: { lens: { side: "right" } } },
    hasFocus: true,
  };
}

/** Two cards in a three-up flow deck, at slots 0 and 2 — a gap in the middle. */
function gappedFlowDeck() {
  return {
    cards: cardsFor(["A", "B"]),
    panes: [paneOf("p1", "A", 0), paneOf("p2", "B", 2), lensPane()],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      layout: "flow",
      sidebars: { lens: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** Every vacancy tile on the canvas, by the slot it stands in. */
async function vacancies(app: App): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      document.querySelectorAll(".tug-slot-vacancy[data-vacant-slot]").forEach(
        function (el) {
          var r = el.getBoundingClientRect();
          out[el.getAttribute("data-vacant-slot")] = {
            top: r.top, left: r.left, right: r.right,
            width: r.width, height: r.height,
          };
        },
      );
      return out;
    })()`,
  );
}

async function paneRect(app: App, paneId: string): Promise<Rect> {
  return app.evalJS<Rect>(
    `(function () {
      var r = document
        .querySelector(${JSON.stringify(frame(paneId))})
        .getBoundingClientRect();
      return {
        top: r.top, left: r.left, right: r.right,
        width: r.width, height: r.height,
      };
    })()`,
  );
}

/** Which slot a pane stands in, or null when it stands in none. */
async function slotOf(app: App, paneId: string): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.filter(function (p) {
        return p.id === ${JSON.stringify(paneId)};
      })[0];
      if (pane === undefined) return null;
      return pane.slot === undefined ? null : pane.slot;
    })()`,
  );
}

/** The numbers the flow strip's segments carry, left to right. */
async function stripNumbers(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.prototype.map.call(
      document.querySelectorAll(
        '[data-testid="flow-strip"] [data-slot="tug-slot-layout"] [data-slot="tug-slot"]',
      ),
      function (el) { return (el.textContent || "").trim(); },
    )`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0465 — the held-open slot", () => {
  test(
    "an empty slot stands, paints, and takes a card",
    async () => {
      const app = await launchTugApp({ testName: "at0465-empty-slot" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: oneCardDeck(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── 1. One tile, for the one empty slot, at that slot's anchor. ──
        let tile: Rect;
        {
          const tiles = await vacancies(app);
          const card = await paneRect(app, "p1");
          note(
            `vacancies ${JSON.stringify(Object.keys(tiles).sort())} ` +
              `| slot 0 ${JSON.stringify(tiles["0"])} | card left ${Math.round(card.left)}`,
          );
          expect(
            Object.keys(tiles).sort(),
            "slot 0 is the only place of the two with nothing in it",
          ).toEqual(["0"]);
          tile = tiles["0"];
          expect(
            Math.abs(tile.width - RESERVED_PX),
            "the tile is the size of the card that would land in it",
          ).toBeLessThanOrEqual(EPSILON);
          expect(
            tile.left,
            "and it stands at the near end of the band, where slot 0 is",
          ).toBeLessThan(card.left - EPSILON);
        }

        // ── 1a. The badge names the place, centered in the room. ──
        // The tile is a measurement and the badge is the picture, and they are
        // deliberately different sizes: the first cut drew the whole reserved
        // room as a dim outline and read as a rendering fault. What is pinned
        // is that the drawing is SMALL and CENTERED in both axes — an outline
        // that came back would fill the box and fail the first assertion, and
        // a badge that drifted to a corner would fail the other two.
        {
          const badge = await app.evalJS<{
            text: string;
            width: number;
            height: number;
            dx: number;
            dy: number;
          } | null>(
            `(function () {
              var tile = document.querySelector(
                '.tug-slot-vacancy[data-vacant-slot="0"]');
              if (tile === null) return null;
              var el = tile.querySelector('[data-slot="tug-slot"]');
              if (el === null) return null;
              var t = tile.getBoundingClientRect();
              var b = el.getBoundingClientRect();
              return {
                text: (el.textContent || "").trim(),
                width: b.width,
                height: b.height,
                dx: (b.left + b.width / 2) - (t.left + t.width / 2),
                dy: (b.top + b.height / 2) - (t.top + t.height / 2)
              };
            })()`,
          );
          note(
            badge === null
              ? "vacancy badge: ABSENT"
              : `vacancy badge "${badge.text}" ${Math.round(badge.width)}x` +
                `${Math.round(badge.height)} offset from tile centre ` +
                `(${badge.dx.toFixed(1)}, ${badge.dy.toFixed(1)})`,
          );
          expect(badge, "the tile draws a badge").not.toBeNull();
          expect(
            badge?.text,
            "and the badge is the place's own number, 1-based like every slot chip",
          ).toBe("1");
          expect(
            badge!.width,
            "the badge is a badge, not an outline of the whole room",
          ).toBeLessThan(tile.width / 4);
          expect(
            Math.abs(badge!.dx),
            "centered horizontally in the room it names",
          ).toBeLessThanOrEqual(1.5);
          expect(
            Math.abs(badge!.dy),
            "and vertically",
          ).toBeLessThanOrEqual(1.5);
        }

        // ── 2. A card dragged onto the tile lands in that slot. ──
        {
          // The tile's near quarter: far enough from the card's own frame that
          // the pointer is inside exactly one zone, so the indication is a
          // containment answer rather than a distance tie-break.
          await app.nativeDragElement(titleBar("p1"), {
            x: Math.round(tile.left + tile.width * 0.25),
            y: Math.round(tile.top + 120),
          });
          await wait(AFTER_LAND_MS);
          const landed = await slotOf(app, "p1");
          const tiles = await vacancies(app);
          note(
            `drag onto the empty tile: p1 slot ${landed}, ` +
              `vacancies now ${JSON.stringify(Object.keys(tiles).sort())}`,
          );
          expect(
            landed,
            "the drop landed the card in the slot the tile stood in",
          ).toBe(0);
          expect(
            Object.keys(tiles).sort(),
            "and the slot it left is a held-open place in its turn",
          ).toEqual(["1"]);
        }

        // ── 3. ⌘2 sends it back, and the card travels. ──
        {
          const before = await paneRect(app, "p1");
          await app.nativeKey("2", ["cmd"]);
          await wait(AFTER_LAND_MS);
          const after = await paneRect(app, "p1");
          const tiles = await vacancies(app);
          note(
            `cmd-2: slot ${await slotOf(app, "p1")}, ` +
              `left ${Math.round(before.left)} -> ${Math.round(after.left)}`,
          );
          expect(await slotOf(app, "p1"), "the chord named slot 1").toBe(1);
          expect(
            after.left,
            "and the card actually travelled there",
          ).toBeGreaterThan(before.left + EPSILON);
          expect(
            Object.keys(tiles).sort(),
            "slot 0 is a held-open place again",
          ).toEqual(["0"]);
        }
      } finally {
        await app.quitGracefully();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "in flow the strip draws every slot, gap or no gap",
    async () => {
      const app = await launchTugApp({ testName: "at0465-empty-slot-flow" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: gappedFlowDeck(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector(".flow-strip-map") !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const numbers = await stripNumbers(app);
        const tiles = await vacancies(app);
        note(
          `flow strip ${numbers.join("|")} | vacancies ` +
            `${JSON.stringify(Object.keys(tiles).sort())}`,
        );
        expect(
          numbers,
          "the arrangement reads by its own numbering, not as a run of two",
        ).toEqual(["1", "2", "3"]);
        expect(
          Object.keys(tiles).sort(),
          "and slot 1 holds its place on the canvas as well as in the strip",
        ).toEqual(["1"]);

        // The card in slot 2 stands PAST the room slot 1 keeps — the whole of
        // what the hold-open rule buys. Collapsed, it would have stood where
        // slot 1's tile now is. The strip overflows the band here, so slot 2's
        // frame is legitimately off screen; a box outside the viewport still
        // measures, and where it measures is the claim.
        const behind = await paneRect(app, "p2");
        const held = tiles["1"];
        note(
          `slot 1 tile ${Math.round(held.left)}..${Math.round(held.right)} ` +
            `| slot 2 frame at ${Math.round(behind.left)}`,
        );
        expect(
          behind.left,
          "slot 2 stands behind the room slot 1 keeps, not on top of it",
        ).toBeGreaterThan(held.right - EPSILON);
      } finally {
        await app.quitGracefully();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
