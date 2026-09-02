/**
 * at0284-title-bar-floor.test.ts — a title bar is never above the deck top.
 *
 * The rule (DeckState invariant 7): a pane whose `position.y` is negative puts
 * its title bar where nothing can reach it. The deck does not scroll, so that
 * title bar cannot be grabbed and the pane can never be moved back — the user
 * is simply stuck with a card they cannot address.
 *
 * The drag gesture has always clamped, but a gesture is one writer among many.
 * The floor therefore lives at `DeckManager.notify` — the single commit point
 * every mutation passes through — so a layout restored from disk, a detach, or
 * an arrange lands on the deck too. This test drives the restore path, which is
 * the one that used to be able to persist a bad `y` and reinstate it on every
 * launch.
 *
 * Imposed panes are the other half of the rule and are checked here too. Their
 * frame is derived, not stored: the imposer pins them a gap below the canvas
 * top in CSS, so for them the law holds by construction. Since Tug takes an
 * active hand in placing them, that is asserted rather than assumed.
 *
 * @covers tugdeck/src/layout-tree.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 30_000;

/** Well above the title bar's own height, so a failure is unambiguous. */
const ABOVE_THE_DECK = -240;

/** A pane seeded above the deck top, as a persisted layout could hold. */
function freeDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
    panes: [
      {
        id: "pFree",
        position: { x: 60, y: ABOVE_THE_DECK },
        size: { width: 520, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pFree",
    hasFocus: true,
  };
}

/** Three imposed panes, each ALSO seeded above the deck top. The imposer must
 *  place them regardless — their stored geometry is not what they render at. */
function imposedDeckShape() {
  const card = (id: string) => ({
    id,
    componentId: "gallery-accordion",
    title: `Card ${id}`,
    closable: true,
  });
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: ABOVE_THE_DECK },
    size: { width: 420, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [card("A"), card("B"), card("C")],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
    ],
    activePaneId: "p1",
    imposition: { kind: "three-up", sidebars: {} },
    hasFocus: true,
  };
}

/** Every pane's title-bar top edge, in viewport coordinates. */
async function titleBarTops(app: App): Promise<number[]> {
  return app.evalJS<number[]>(
    `Array.from(document.querySelectorAll('.tug-pane .tug-pane-title-bar'))
       .map(function(el){ return Math.round(el.getBoundingClientRect().top); })`,
  );
}

/** The committed `position.y` of every pane in the store. */
async function committedYs(app: App): Promise<number[]> {
  return app.evalJS<number[]>(
    `window.tugdeck.diag.getDeckState().panes.map(function(p){ return p.position.y; })`,
  );
}

/** The deck root's top edge, in viewport coordinates. */
async function deckTop(app: App): Promise<number> {
  return app.evalJS<number>(
    `Math.round(document.getElementById("deck-container").getBoundingClientRect().top)`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0284 — the title-bar floor", () => {
  test(
    "a free pane restored above the deck top is clamped onto it",
    async () => {
      const app = await launchTugApp({ testName: "at0284-title-bar-floor-free" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: freeDeckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="pFree"] .tug-pane-title-bar') !== null`,
          { timeoutMs: 5_000 },
        );

        // The store never holds the out-of-bounds value it was handed.
        expect(await committedYs(app)).toEqual([0]);

        // And the title bar is really on the deck, not merely renumbered.
        const top = await deckTop(app);
        const tops = await titleBarTops(app);
        expect(tops.length).toBe(1);
        expect(tops[0]).toBeGreaterThanOrEqual(top);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0284] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "imposed panes place below the deck top whatever their stored y says",
    async () => {
      const app = await launchTugApp({ testName: "at0284-title-bar-floor-imposed" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: imposedDeckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.tug-pane .tug-pane-title-bar').length === 3`,
          { timeoutMs: 5_000 },
        );

        const top = await deckTop(app);
        const tops = await titleBarTops(app);
        expect(tops.length).toBe(3);
        for (const t of tops) expect(t).toBeGreaterThanOrEqual(top);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0284] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
