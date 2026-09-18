/**
 * at0371-card-width.test.ts — the width popup sets one card's width, and only
 * that card's.
 *
 * Width had two doors and now has one and a half. The chords ⌃⌘1/2/3 were
 * retired: setting a card's width is a once-a-session act, and the Tug tier's
 * digits went to Go to Slot, which is a verb of the reading hour. What remains
 * is the title bar's own width popup — the door width was designed around
 * ([D130]) — and the View ▸ Slim / Comfy / Wide rows beside it, which carry
 * no key equivalent of their own now.
 *
 * So this file drives the popup, and the claim worth pinning end to end is
 * unchanged: the picker lands on `set-card-width` and takes the clamp and the
 * `widthPreset` stamp from it, rather than reaching `movePane` with a raw
 * number. A separate path would look right on a plain content pane and diverge
 * exactly where the popup's rules bite.
 *
 * What the assertions are chosen to catch:
 *
 *  1. **Each row is its own preset, not a table somebody typed twice.** All
 *     three are chosen, in an order that is not the picker's, so a transposed
 *     pair fails rather than passing on the one that happens to match.
 *  2. **It is per-card.** The deck's Card Width default reaches every content
 *     pane at once (at0357); this must not. The second pane is measured after
 *     every choice and holds its seeded width to the pixel.
 *  3. **A rail has no width to set at all** — a sidebar's width is the space
 *     allocator's answer, never a preset ([P04]) — so the rail does not even
 *     draw the affordance. Structure, not enablement: the control is absent.
 *  4. **A card's width is not paid for out of a rail's.** The verb commits
 *     with the allocator held off, unlike the deck-wide Card Width default.
 *     Re-solving here would shrink the rail to its floor every time a reader
 *     widened a card — the user's rail spent by a gesture that never mentioned
 *     it. The rail's measured width after every choice is what holds that.
 *
 * What LEFT this file with the chords, and where it went: the selection ladder
 * — "the verb resolves through the layout selection, so a chord typed with the
 * keyboard in the Cards card lands on the card the user last worked in". That is a
 * property of the resolver rather than of width, and it is still driven
 * natively by three verbs that kept their chords: ⌘1..9 (at0465), the nudge
 * pair (at0452), and ⌃⌘B (at0372). The popup cannot hold it, because a popup
 * names the pane it opened on — there is no selection to resolve.
 *
 * Widths are read off the painted frame rather than the store, which is what
 * makes this an app-test rather than a unit test: slim (675) and comfy (800)
 * both fit any canvas the harness launches at, and wide (1230) is asserted
 * against the same rect so a canvas too narrow to hold it would fail loudly
 * rather than silently proving nothing. `gallery-accordion` carries no size
 * policy tighter than the presets, so no clamp is in play here — the clamp
 * itself is at0357's fixture and the store's own tests.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/action-dispatch.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { chooseWidth, widthButton } from "./fixtures/card-width";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The presets, as `lib/layout-imposer.ts` fixes them. */
const SLIM = 675;
const COMFY = 800;
const WIDE = 1230;

/** Seeded widths chosen so no preset resolves to them: a pane that moved
 *  because something reached every pane is unmistakable from one that did
 *  not move at all. */
const SEEDED_WIDTH = 511;
const RAIL_WIDTH = 412;

/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: SEEDED_WIDTH, height: 620 },
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
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 2, "B"),
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
    imposition: { kind: "three-up", sidebars: { layout: { side: "right" } } },
    hasFocus: true,
  };
}

const PANE_WIDTH_JS = (paneId: string): string =>
  `Math.round(document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().width)`;

async function paneWidth(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(PANE_WIDTH_JS(paneId));
}

/**
 * Choose a preset and wait for the pane to LAND on the expected width — so a
 * slow settle reads as a timeout at the choice rather than as a wrong number
 * three assertions later.
 */
async function setWidth(
  app: App,
  paneId: string,
  preset: "slim" | "comfy" | "wide",
  expected: number,
): Promise<void> {
  await chooseWidth(app, paneId, preset);
  await app.waitForCondition<boolean>(
    `(${PANE_WIDTH_JS(paneId)}) === ${expected}`,
    { timeoutMs: 8_000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0371 — the width popup sets one card's width",
  () => {
    test(
      "each row lands its own preset, on its own pane only, and no rail pays for it",
      async () => {
        const app = await launchTugApp({ testName: "at0371-card-width" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          expect(await paneWidth(app, "p1")).toBe(SEEDED_WIDTH);
          expect(await paneWidth(app, "p2")).toBe(SEEDED_WIDTH);

          // --- Each row is its own preset. ----------------------------------
          // Chosen in an order that is not the picker's, so a handler that
          // ignored the payload and cycled would land on the wrong one.
          await setWidth(app, "p1", "comfy", COMFY);
          await setWidth(app, "p1", "slim", SLIM);
          await setWidth(app, "p1", "wide", WIDE);
          note(`p1 walked comfy -> slim -> wide, landing at ${await paneWidth(app, "p1")}`);

          // --- Per-card, not deck-wide. -------------------------------------
          // The deck's Card Width default reaches every content pane at once
          // (at0357). Three choices later, the other pane has not moved.
          expect(
            await paneWidth(app, "p2"),
            "the pane the popup did not open on keeps its seeded width",
          ).toBe(SEEDED_WIDTH);
          // --- And no rail paid for it. -------------------------------------
          expect(
            await paneWidth(app, "pRail"),
            "a card's width is not spent out of the rail's",
          ).toBe(RAIL_WIDTH);

          // --- The second pane answers its own popup. -----------------------
          await setWidth(app, "p2", "slim", SLIM);
          expect(
            await paneWidth(app, "p1"),
            "and the first pane keeps the width it had",
          ).toBe(WIDE);
          expect(await paneWidth(app, "pRail")).toBe(RAIL_WIDTH);

          // --- A rail has no width to set, so it draws no affordance. -------
          // Absence, not a disabled control: a sidebar's width is the
          // allocator's answer, so there is no preset for a picker to offer.
          const railButtons = await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(widthButton("pRail"))}).length`,
          );
          note(`rail width buttons: ${railButtons}`);
          expect(
            railButtons,
            "a rail draws no width picker at all",
          ).toBe(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
