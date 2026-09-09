/**
 * at0357-content-width-default.test.ts — the deck's content width is a
 * deck-wide statement, and the Layouts section is where it is made.
 *
 * The per-pane popup narrows one card. **Card Width** in the Layouts section
 * says how wide content reads on this deck, which is a different claim and has
 * to behave like one:
 *
 *  1. It reaches the panes already open — every content pane at once, not the
 *     focused one and not the next one created.
 *  2. It never STAMPS a rail. A sidebar's width is the allocator's unknown
 *     ([P04]): a width click re-solves the rails (it is a Layouts click, and it
 *     moves every seam), but what a rail may get is the allocator's answer
 *     under its licence — never the content preset written in as if the rail
 *     were a card. The fixture overfills the band (four slotted cards want
 *     more than any plausible window holds, so no rail width tiles the
 *     chain), and the graded licence ([D136]) answers with the one width it
 *     may: the rail's hard floor, the deepest the rail can give against a
 *     chain that overlaps. THAT is the assertion — the rail lands on the
 *     floor, not on the preset a stamp would have written, and a second
 *     width click finds nothing left to give and moves it no further.
 *  3. It is what a NEW card opens at. The registrations no longer carry a
 *     literal opening width; a Session, Text, File, Diff, or DevTools card
 *     resolves one from this record at `addCard` time, so the first card of a
 *     session arrives at the width the deck is set to.
 *  4. Choosing again puts everything back on it. The default is not a one-shot
 *     seed, so re-asserting it is a real gesture — the same reasoning that
 *     keeps a side re-click from being a no-op.
 *
 * The widths asserted are slim (675) and comfy (800), both of which fit any
 * canvas the harness can launch at; wide is the same code path with a bigger
 * number, and asserting it would only be asserting the canvas.
 *
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/card-registry.ts
 * @covers tugdeck/src/components/tugways/cards/settings-card.tsx
 * @covers tugdeck/src/components/tugways/cards/keyboard-card.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The presets, as `lib/layout-imposer.ts` fixes them. */
const SLIM = 675;
const COMFY = 800;

/** The seeded rail width — a number no preset resolves to, so a rail that
 *  moved would be unmistakable. */
const RAIL_WIDTH = 412;

/** The Layout card's hard floor (`MIN_LAYOUT_WIDTH_PX`) — the allocator's whole answer
 *  on this overfilled deck: the deepest the rail may give against a chain
 *  that overlaps, and visibly not a preset. */
const RAIL_MIN = 320;

const WIDTH_TILE = (preset: string): string =>
  `[data-testid="layout-card-width"] [data-choice-value="${preset}"]`;

/** Four content panes filling four-up, plus the Layout card standing at its pin.
 *  Four, deliberately: at slim the chain wants a band of 2715px and at comfy
 *  3215px, so on any window the harness can launch the allocator's solve is
 *  far under every rail's shrink floor and the licence refuses — the rail
 *  width below is guaranteed to be untouched by the retune, canvas be what it
 *  may. */
function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 560, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-accordion", title: "Card B", closable: true },
      { id: "C", componentId: "gallery-accordion", title: "Card C", closable: true },
      { id: "D", componentId: "gallery-accordion", title: "Card D", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
      pane("p4", 3, "D"),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "four-up", layout: "fit", sidebars: { layout: { side: "right" } } },
    hasFocus: true,
  };
}

/** A pane's stored width, read off the deck rather than off the paint — the
 *  claim is about the geometry the deck holds, and a rounded frame rect would
 *  blur the one-pixel difference between "clamped" and "written". */
const PANE_WIDTH_JS = (paneId: string): string =>
  `Math.round(document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().width)`;

async function paneWidth(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(PANE_WIDTH_JS(paneId));
}

/** The width of the pane hosting a card, addressed by the card's own testid —
 *  the singleton configurators land on panes with generated ids. */
async function cardPaneWidth(app: App, testid: string): Promise<number> {
  return app.evalJS<number>(
    `Math.round(
       document.querySelector('[data-testid="${testid}"]')
         .closest('.tug-pane')
         .getBoundingClientRect().width
     )`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0357 — the deck's content width reaches every content pane",
  () => {
    test(
      "Card Width lands on both open cards, spares the rail, and is what the next card opens at",
      async () => {
        const app = await launchTugApp({
          testName: "at0357-content-width-default",
        });
        try {
          // The seed carries the rail pane, so the Layout card is already open —
          // toggling here would close it.
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WIDTH_TILE("slim"))}) !== null`,
            { timeoutMs: 8_000 },
          );

          // ── Slim, from the real control. ──
          await app.nativeClickAtElement(WIDTH_TILE("slim"));
          await app.waitForCondition<boolean>(
            `(${PANE_WIDTH_JS("p1")}) === ${SLIM}`,
            { timeoutMs: 8_000 },
          );
          // EVERY content pane, not just the active one: the deck's width is
          // the deck's.
          expect(await paneWidth(app, "p1")).toBe(SLIM);
          expect(await paneWidth(app, "p2")).toBe(SLIM);
          expect(await paneWidth(app, "p3")).toBe(SLIM);
          expect(await paneWidth(app, "p4")).toBe(SLIM);
          // The rail did not take the preset. The click's retune ran — no
          // rail width tiles this chain, so the graded licence gave the rail
          // to its hard floor against the overlap — and the floor is where it
          // stands: the allocator's answer, never the stamp's.
          expect(await paneWidth(app, "pRail")).toBe(RAIL_MIN);

          // ── A card opened now arrives at the deck's width. ──
          await app.dispatchControlAction("show-devtools");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane').length === 6`,
            { timeoutMs: 8_000 },
          );
          const openedWidth = await app.evalJS<number>(
            `(function () {
              var seeded = ["p1", "p2", "p3", "p4", "pRail"];
              var panes = Array.from(document.querySelectorAll('.tug-pane'));
              var fresh = panes.filter(function (el) {
                return seeded.indexOf(el.getAttribute("data-pane-id")) === -1;
              });
              return Math.round(fresh[0].getBoundingClientRect().width);
            })()`,
          );
          expect(openedWidth).toBe(SLIM);

          // ── Comfy: the default overwrites what slim had set, on every
          //    content pane including the one opened since. ──
          await app.nativeClickAtElement(WIDTH_TILE("comfy"));
          await app.waitForCondition<boolean>(
            `(${PANE_WIDTH_JS("p1")}) === ${COMFY}`,
            { timeoutMs: 8_000 },
          );
          expect(await paneWidth(app, "p1")).toBe(COMFY);
          expect(await paneWidth(app, "p2")).toBe(COMFY);
          // Standing at the floor already, the comfy click's retune has
          // nothing left to give and moves the rail no further — and still
          // does not stamp it.
          expect(await paneWidth(app, "pRail")).toBe(RAIL_MIN);
          expect(
            await app.evalJS<number[]>(
              `Array.from(document.querySelectorAll('.tug-pane'))
                .filter(function (el) {
                  return el.getAttribute("data-pane-id") !== "pRail";
                })
                .map(function (el) {
                  return Math.round(el.getBoundingClientRect().width);
                })`,
            ),
          ).toEqual([COMFY, COMFY, COMFY, COMFY, COMFY]);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the configurators are content cards: Settings and Keyboard Shortcuts open at the deck's width and follow it",
      async () => {
        const app = await launchTugApp({
          testName: "at0357-content-width-configurators",
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WIDTH_TILE("slim"))}) !== null`,
            { timeoutMs: 8_000 },
          );

          await app.nativeClickAtElement(WIDTH_TILE("slim"));
          await app.waitForCondition<boolean>(
            `(${PANE_WIDTH_JS("p1")}) === ${SLIM}`,
            { timeoutMs: 8_000 },
          );

          // Both configurators are reached the way the app menu reaches them.
          await app.evalJS(
            `window.__tug.dispatchControlAction("show-card", { component: "settings" })`,
          );
          await app.evalJS(
            `window.__tug.dispatchControlAction("show-keyboard-shortcuts", {})`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-testid="settings-card"]') !== null
             && document.querySelector('[data-testid="keyboard-card"]') !== null`,
            { timeoutMs: 8_000 },
          );

          // They arrive at the deck's width rather than at the number their
          // registrations used to freeze in (900 and 800).
          expect(await cardPaneWidth(app, "settings-card")).toBe(SLIM);
          expect(await cardPaneWidth(app, "keyboard-card")).toBe(SLIM);

          // And a later Card Width click reaches them like any other content
          // pane.
          await app.nativeClickAtElement(WIDTH_TILE("comfy"));
          await app.waitForCondition<boolean>(
            `(${PANE_WIDTH_JS("p1")}) === ${COMFY}`,
            { timeoutMs: 8_000 },
          );
          expect(await cardPaneWidth(app, "settings-card")).toBe(COMFY);
          expect(await cardPaneWidth(app, "keyboard-card")).toBe(COMFY);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
