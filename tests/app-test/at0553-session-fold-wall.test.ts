/**
 * at0553-session-fold-wall.test.ts — a slot full of folded sessions.
 *
 * ## What this gates
 *
 * The wall is what the whole feature is for ([B07]): one split slot holding
 * many sessions that are being watched rather than talked to, with one of them
 * open at a time. Three claims, in the order the reader meets them:
 *
 *   1. **A wall packs.** Five folded Session cards in one slot each stand at
 *      the tier and tile from the top of the run, one imposition gap apart —
 *      they do not divide the run between them, and the surplus stays as run
 *      beneath the wall rather than being spent stretching the bottom card.
 *   2. **One open per wall, and the reveal keeps your place.** Opening the
 *      third card stands it at its own floor, folds nothing else open, and
 *      scrolls the column so the SECOND card — the neighbour above — sits at
 *      the top of the run.
 *   3. **Opening another folds the first.** Showing the fifth folds the
 *      third again, so the wall stays a wall.
 *
 * The cards are unbound: what is under test is the allocator and the commit,
 * and a bound session would add five engines to a test about geometry.
 *
 * `deck-manager.ts` is NOT named in `@covers`, though the wall commit lives
 * there and this file drives it. It stands at the selection budget's ceiling
 * (21 accepted), and the recorded debt may be paid down but not refinanced.
 * What the omission costs is small, because the wall's decisions are pure
 * helpers with unit tests of their own — `columnIsWall` and
 * `panesWithWallFolded` in `pane-folded.test.ts`, one case of which names
 * the exact defect this file found while it was being written: the reveal was
 * gated on the FOLD having changed something, so a settled wall, the common
 * case, never scrolled. A unit test that names the bug is a better gate for
 * it than a five-card app-test anyway.
 *
 * The fold goes through `set-card-folded`, the registry-routed setter
 * ([P02]), rather than through `toggle-session-fold` — the toggle is
 * key-card-scoped and this test needs to name WHICH of five cards it means.
 * at0550 is where the doors themselves are gated.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/deck-store-selectors.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The imposition's top gap (`lib/layout-imposer.ts`). */
const GAP = 5;
/** `SESSION_FOLDED_HEIGHT_PX` — see at0552, which measures it. */
const TIER = 144;
/** The Session card's open height floor, from its registration. */
const OPEN_FLOOR = 600;
/** Geometry tolerance: every member's top carries the offset's own rounding. */
const EPSILON = 2;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

const PANE_IDS = ["p1", "p2", "p3", "p4", "p5"] as const;
const CARD_IDS = ["A", "B", "C", "D", "E"] as const;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Rect {
  top: number;
  bottom: number;
  height: number;
}

/** Five Session cards sharing slot 0 of a one-up. */
function deckShape() {
  return {
    cards: CARD_IDS.map((id) => ({
      id,
      componentId: "session",
      title: `Session ${id}`,
      closable: true,
    })),
    panes: PANE_IDS.map((id, index) => ({
      id,
      position: { x: 40, y: 40 },
      size: { width: 675, height: 620 },
      cardIds: [CARD_IDS[index]],
      activeCardId: CARD_IDS[index],
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    })),
    activePaneId: "p1",
    imposition: { kind: "one-up" },
    hasFocus: true,
  };
}

/** Every pane's live frame, in viewport coordinates. */
async function rects(app: App): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      ${JSON.stringify([...PANE_IDS])}.forEach(function (id) {
        var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
        if (el === null) return;
        var r = el.getBoundingClientRect();
        out[id] = { top: r.top, bottom: r.bottom, height: r.height };
      });
      return out;
    })()`,
  );
}

/** The top of the run a column's members stand in, in viewport coordinates. */
async function runTop(app: App): Promise<number> {
  return app.evalJS<number>(
    `document
       .querySelector("[data-deck-canvas-background]")
       .getBoundingClientRect().top + ${GAP}`,
  );
}

/** Slot 0's stored column offset, as the live store holds it. */
async function columnOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `((window.tugdeck.diag.getDeckState().columnOffsets || {})[0] || 0)`,
  );
}

/** Whether a pane reads as folded in the deck's own record. */
async function folded(app: App, paneId: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `window.__tug.getPaneRecord(${JSON.stringify(paneId)}).folded`,
  );
}

/** Fold or show one named card, through the one write path ([P02]). */
async function setFolded(
  app: App,
  cardId: string,
  value: boolean,
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(cardId)}, folded: ${value} }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)("AT0553: a wall of folded sessions", () => {
  test(
    "five fold into a wall, one opens at a time, and the reveal keeps the neighbour above in view",
    async () => {
      const app = await launchTugApp({ testName: "at0553-fold-wall" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        for (const cardId of CARD_IDS) {
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(cardId)})`,
            { timeoutMs: 30_000 },
          );
        }
        // Split the slot: five members dividing one run is what a wall is.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);

        // ── 1. The wall packs ──
        for (const cardId of CARD_IDS) await setFolded(app, cardId, true);

        const top = await runTop(app);
        const wall = await rects(app);
        note(
          "wall tops",
          PANE_IDS.map((id) => Math.round(wall[id].top - top)).join(", "),
        );
        note("wall heights", PANE_IDS.map((id) => Math.round(wall[id].height)).join(", "));

        for (const id of PANE_IDS) {
          expect(
            Math.abs(wall[id].height - TIER),
            `${id} stands at the tier`,
          ).toBeLessThan(EPSILON);
        }
        // Tiled from the run's own top, one gap apart — not divided between
        // them, and not pushed down by a centring term.
        PANE_IDS.forEach((id, index) => {
          expect(
            Math.abs(wall[id].top - (top + index * (TIER + GAP))),
            `${id} tiles from the run's top`,
          ).toBeLessThan(EPSILON);
        });
        // The wall fits, so there is nothing to scroll.
        expect(await columnOffset(app)).toBe(0);

        // ── 2. One open, with the neighbour above in view ──
        await setFolded(app, "C", false);

        const opened = await rects(app);
        const offset = await columnOffset(app);
        note("offset after opening the third", offset);
        note(
          "heights after opening the third",
          PANE_IDS.map((id) => Math.round(opened[id].height)).join(", "),
        );

        expect(await folded(app, "p3")).toBe(false);
        // The opened card takes its own floor — a reading share, not the
        // whole column.
        expect(
          Math.abs(opened.p3.height - OPEN_FLOOR),
          "the opened card stands at its floor",
        ).toBeLessThan(EPSILON);
        // Every other member holds the tier.
        for (const id of ["p1", "p2", "p4", "p5"]) {
          expect(
            Math.abs(opened[id].height - TIER),
            `${id} holds the tier`,
          ).toBeLessThan(EPSILON);
          expect(await folded(app, id)).toBe(true);
        }
        // And the reveal's whole claim ([B07]): the member ABOVE the opened
        // one sits at the top of the run, so the reader keeps their place.
        expect(
          Math.abs(opened.p2.top - top),
          "the neighbour above is at the run's top",
        ).toBeLessThan(EPSILON);
        expect(offset).toBeGreaterThan(0);

        // ── 3. Opening another folds the first ──
        await setFolded(app, "E", false);

        expect(await folded(app, "p5")).toBe(false);
        expect(await folded(app, "p3")).toBe(true);
        const second = await rects(app);
        expect(
          Math.abs(second.p3.height - TIER),
          "the previously open card is back at the tier",
        ).toBeLessThan(EPSILON);
        expect(
          Math.abs(second.p5.height - OPEN_FLOOR),
          "the newly opened card stands at its floor",
        ).toBeLessThan(EPSILON);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
