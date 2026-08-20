/**
 * at0457-drop-zone-drag.test.ts — a dragged card lands where the deck said it
 * would.
 *
 * Before this, dragging an imposed card's title bar tore it out of the
 * arrangement: the frame converted to free pixels on the first moved frame and
 * the drop evicted it from its slot. There was exactly one advertised drop
 * target in the whole app — another pane's tab bar — and everywhere else a
 * release meant "leave".
 *
 * The engine turns that around ([P09]). The card moves freely under the
 * pointer, exactly one advertised zone is indicated at every instant, and the
 * release commits that zone's mutation. Because a zone is always live — the
 * card's own current position among them — an unmodified release is always
 * meaningful, and leaving the arrangement moves to ⌘ ([P13]).
 *
 * What this file pins, in the order the fixture walks them:
 *
 *   1. **A member reordered inside its own column.** Dragging past a sibling's
 *      middle lands the card at that index, and the column's stored SHARES are
 *      untouched — heights travel with cards, so a reorder is not a resize.
 *   2. **Escape cancels, and swallows.** Mid-drag Escape commits nothing and
 *      leaves the geometry where it was — *and* the Lens's selection survives,
 *      which is the half that proves the key was swallowed rather than merely
 *      handled. An unswallowed Escape would also reach the Lens's
 *      `CANCEL_DIALOG` responder and empty it.
 *   3. **A card crossing to another slot joins what stands there.**
 *   4. **A card crossing into another split column lands at an index**, in one
 *      commit — the slot and the order together.
 *   5. **A tab bar is still a drop zone.** The shipped merge gesture survives
 *      the generalization instead of being orphaned by it ([P10] (d)).
 *   6. **⌘ frees the card.** No indicator while it is held, and the drop puts
 *      the card at free pixels with no slot ([P13]).
 *   7. **The two vocabularies do not meet.** A content card dropped over a rail
 *      does not join it — rails are not zones for content cards ([P10]).
 *      at0401 asserts the other half from the rail side.
 *
 * The indicator is asserted by presence and place rather than by appearance:
 * what matters is that something stands in the zone the release will use, and
 * that it is gone the moment ⌘ says no zone is live. Its treatment is [Q01]'s
 * to tune.
 *
 * Deliberately NOT declaring `@covers tugdeck/src/deck-manager.ts`, for the
 * reason at0455 and at0456 state: that path is at the selection budget's
 * ceiling, and naming it here would make an edit to the store a run the budget
 * refuses.
 *
 * @covers tugdeck/src/lib/drop-zones.ts
 * @covers tugdeck/src/lib/drop-zone-indicator.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
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
const PANE_WIDTH = 380;

const frame = (paneId: string): string => `.tug-pane[data-pane-id="${paneId}"]`;
const titleBar = (paneId: string): string =>
  `${frame(paneId)} .tug-pane-title-bar`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/**
 * Four cards across a three-up with the Lens pinned right: two sharing slot 0,
 * one in slot 1, one in slot 2.
 *
 * Slot 0 starts with two so it can be split and reordered; slot 1 holds a lone
 * card to be joined; slot 2's card is the one that crosses.
 */
function deckShape() {
  const pane = (id: string, cardId: string, slot: number) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    // A holds a second tab from the drop, so p1 renders a real tab bar for
    // §5 to aim at: a single-card pane has none, and a tab-bar zone that
    // nothing draws is a zone nothing can be dropped on.
    cardIds: id === "p1" ? [cardId, "E"] : [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  const members: [string, string, number][] = [
    ["p1", "A", 0],
    ["p2", "B", 0],
    ["p3", "C", 1],
    ["p4", "D", 2],
  ];
  return {
    cards: [
      ...members.map(([, cardId]) => ({
        id: cardId,
        componentId: "hello",
        title: `Card ${cardId}`,
        closable: true,
      })),
      { id: "E", componentId: "hello", title: "Card E", closable: true },
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      ...members.map(([id, cardId, slot]) => pane(id, cardId, slot)),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: LENS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { lens: { side: "right" } },
      columns: { 0: { mode: "split" } },
    },
    hasFocus: true,
  };
}

async function rects(app: App, paneIds: string[]): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      ${JSON.stringify(paneIds)}.forEach(function (id) {
        var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
        if (el === null) return;
        var r = el.getBoundingClientRect();
        out[id] = {
          top: r.top, bottom: r.bottom, left: r.left, right: r.right,
          width: r.width, height: r.height,
        };
      });
      return out;
    })()`,
  );
}

/** Slot `n`'s member order, as the live store holds it. */
async function columnOrder(app: App, slot: number): Promise<string[]> {
  return app.evalJS<string[]>(
    `(((window.tugdeck.diag.getDeckState().imposition.columns || {})[${slot}] || {}).order || [])`,
  );
}

async function columnShares(
  app: App,
  slot: number,
): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(((window.tugdeck.diag.getDeckState().imposition.columns || {})[${slot}] || {}).shares || {})`,
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

/** The drop-zone indicator's rect, or null when nothing is indicated. */
async function indicator(app: App): Promise<Rect | null> {
  return app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector(".tug-drop-zone-indicator");
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return {
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        width: r.width, height: r.height,
      };
    })()`,
  );
}

/** Which pane ids the Lens's layout selection is holding. */
async function layoutSelection(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `(window.__tug.getLayoutSelection() || []).slice().sort()`,
  );
}

/** The point at the middle of a pane's title bar, in viewport coordinates. */
async function titleBarPoint(
  app: App,
  paneId: string,
): Promise<{ x: number; y: number }> {
  const bounds = await app.getElementBounds(titleBar(paneId));
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}

describe.skipIf(!SHOULD_RUN)("at0457 — the drop-zone drag", () => {
  test(
    "a dragged card lands in the zone the deck indicated, and ⌘ is what frees it",
    async () => {
      const app = await launchTugApp({ testName: "at0457-drop-zone-drag" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p4"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── 1. A member reordered inside its own column. ──
        {
          const before = await rects(app, ["p1", "p2"]);
          expect(
            before.p1.top,
            "the fixture starts with A above B",
          ).toBeLessThan(before.p2.top);
          const grab = await titleBarPoint(app, "p1");
          // Past B's middle: the half-overlap crossing the engine reads.
          await app.nativeDragElement(titleBar("p1"), {
            x: grab.x,
            y: Math.round(before.p2.top + before.p2.height * 0.75),
          });
          await wait(AFTER_LAND_MS);
          const order = await columnOrder(app, 0);
          note(`own-column reorder: order ${JSON.stringify(order)}`);
          expect(order, "the drag put A below B").toEqual(["p2", "p1"]);
          expect(
            Object.keys(await columnShares(app, 0)),
            "a reorder is not a resize — no shares were written",
          ).toEqual([]);
          const after = await rects(app, ["p1", "p2"]);
          expect(after.p2.top).toBeLessThan(after.p1.top);
          expect(
            await app.evalJS<string | null>(
              `document.querySelector(${JSON.stringify(frame("p1"))}).getAttribute("data-gesture")`,
            ),
            "the drop hands its parking transform to the settle and lets go",
          ).toBeNull();
        }

        // ── 2. Escape cancels, and the Lens's selection proves the swallow. ──
        {
          await app.evalJS<null>(
            `(window.__tug.setLayoutSelection(["A", "B"]), null)`,
          );
          expect(await layoutSelection(app)).toEqual(["A", "B"]);
          const before = await rects(app, ["p1", "p2"]);
          const target = await titleBarPoint(app, "p3");
          await app.nativeDragElementWithoutRelease(titleBar("p1"), target);
          expect(
            await indicator(app),
            "a zone is indicated while the drag is in flight",
          ).not.toBeNull();
          await app.nativeKey("Escape");
          // Wait for the cancel to land before releasing. The gesture is over
          // the moment Escape is handled, and the indicator going away is the
          // observable edge of that — so this is a wait and an assertion at
          // once, and the mouseUp below arrives at a pointer nothing is
          // listening to.
          await app.waitForCondition<boolean>(
            `document.querySelector(".tug-drop-zone-indicator") === null`,
            { timeoutMs: 5_000 },
          );
          await app.nativeMouseUp(target);
          await wait(AFTER_LAND_MS);

          expect(
            await columnOrder(app, 0),
            "a cancelled drag commits nothing",
          ).toEqual(["p2", "p1"]);
          expect(await slotOf(app, "p1"), "and moves nothing").toBe(0);
          expect(await indicator(app), "and leaves no indicator").toBeNull();
          const after = await rects(app, ["p1", "p2"]);
          expect(Math.abs(after.p1.top - before.p1.top)).toBeLessThan(EPSILON);
          expect(Math.abs(after.p1.left - before.p1.left)).toBeLessThan(EPSILON);
          expect(
            await layoutSelection(app),
            "the Escape was swallowed — the Lens never saw it",
          ).toEqual(["A", "B"]);
          note("escape cancelled with the selection intact");
        }

        // ── 3. A card crossing to another slot joins what stands there. ──
        {
          const target = await titleBarPoint(app, "p3");
          await app.nativeDragElement(titleBar("p4"), target);
          await wait(AFTER_LAND_MS);
          expect(await slotOf(app, "p4"), "D joined C's slot").toBe(1);
          expect(await slotOf(app, "p3"), "and C stayed there").toBe(1);
          note("cross-slot drop: D joined slot 1");
        }

        // ── 4. A card crossing INTO a split column lands at an index. ──
        {
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-column-mode", { slot: 1, mode: "split" }), null)`,
          );
          await wait(AFTER_LAND_MS);
          const members = await rects(app, ["p3", "p4"]);
          const top = members.p3.top < members.p4.top ? "p3" : "p4";
          const bottom = top === "p3" ? "p4" : "p3";
          const grab = await titleBarPoint(app, top);
          // Aim at the top member's own tile: arriving there means index 0.
          await app.nativeDragElement(titleBar("p2"), {
            x: Math.round(members[top].left + members[top].width / 2),
            y: Math.round(members[top].top + members[top].height * 0.25),
          });
          await wait(AFTER_LAND_MS);
          expect(await slotOf(app, "p2"), "B crossed into slot 1").toBe(1);
          const order = await columnOrder(app, 1);
          note(`cross-column drop: order ${JSON.stringify(order)} (grabbed from ${grab.x},${grab.y})`);
          expect(order[0], "and landed at the index it was dropped on").toBe(
            "p2",
          );
          expect(order.slice(1).sort()).toEqual([bottom, top].sort());
        }

        // ── 5. A tab bar is still a drop zone. ──
        {
          const before = await app.evalJS<number>(
            `window.tugdeck.diag.getDeckState().panes.filter(function (p) {
               return p.id === "p1";
             })[0].cardIds.length`,
          );
          expect(before, "p1 arrived holding two tabs, so it draws a tab bar").toBe(2);
          await app.nativeDragElement(titleBar("p3"), {
            selector: `${frame("p1")} .tug-tab-bar`,
          });
          await wait(AFTER_LAND_MS);
          const merged = await app.evalJS<string[]>(
            `(function () {
              var pane = window.tugdeck.diag.getDeckState().panes.filter(function (p) {
                return p.id === "p1";
              })[0];
              return pane === undefined ? [] : pane.cardIds.slice();
            })()`,
          );
          note(`tab-bar merge: p1 now holds ${JSON.stringify(merged)}`);
          expect(
            merged.length,
            "the shipped merge-onto-a-tab-bar gesture still works",
          ).toBe(3);
          expect(merged).toContain("C");
        }

        // ── 6. ⌘ frees the card. ──
        {
          const before = await rects(app, ["p1"]);
          const away = {
            x: Math.round(before.p1.left + 60),
            y: Math.round(before.p1.top + 160),
          };
          await app.withModifiersHeld(["cmd"], async () => {
            await app.nativeDragElementWithoutRelease(titleBar("p1"), away);
            expect(
              await indicator(app),
              "with ⌘ held no zone is live and the indicator is gone",
            ).toBeNull();
            await app.nativeMouseUp(away);
          });
          await wait(AFTER_LAND_MS);
          expect(
            await slotOf(app, "p1"),
            "⌘ is what takes a card out of the arrangement",
          ).toBeNull();
          note("cmd-drag evicted p1 to free pixels");
        }

        // ── 7. The two vocabularies do not meet. ──
        //
        // A content card dropped over the Lens's rail does not join the rail:
        // rails are not zones for a content card, and content slots are not
        // zones for a sidebar card ([P10]). at0401 asserts the other half —
        // a pinned card dragged deep into the content band stays on its rail.
        // Cross-place drops are a later feature, and the way they stay a later
        // feature is that neither vocabulary can name the other's places.
        {
          const railsBefore = await app.evalJS<string>(
            `JSON.stringify(window.tugdeck.diag.getDeckState().imposition.sidebars || {})`,
          );
          await app.nativeDragElement(titleBar("p4"), {
            selector: `${frame("pLens")} .tug-pane-title-bar`,
          });
          await wait(AFTER_LAND_MS);
          expect(
            await app.evalJS<string>(
              `JSON.stringify(window.tugdeck.diag.getDeckState().imposition.sidebars || {})`,
            ),
            "a content card cannot pin itself to a rail by being dropped on one",
          ).toBe(railsBefore);
          expect(
            await slotOf(app, "p4"),
            "it lands in a content slot, because that is the whole of its vocabulary",
          ).not.toBeNull();
          note("rails and content slots stayed out of each other's vocabularies");
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
