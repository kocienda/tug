/**
 * at0466-center-slot.test.ts — ⌃⌘N sends the reader to slot N.
 *
 * The digit row has two readings and the tier says which. ⌘n sends the CARD to
 * a place; ⌃⌘n sends the READER there, moving the band the deck is seen through
 * and nothing else. The Tug tier's digits used to set a card's width, which is
 * a once-a-session act wearing an every-hour chord; they were handed over.
 *
 * What this file pins:
 *
 *   1. **The six rows carry the chord, and the width rows carry none.** Read
 *      off the live menu bar's key equivalents rather than off the registry,
 *      because the whole point of a promotion is that AppKit — not the JS
 *      funnel — is what claims the press. A width row that kept its ⌃⌘ digit
 *      would shadow the centering silently, and the registry cannot see that.
 *   2. **The rows light for the ARRANGEMENT, not for the selection.** Every
 *      other item in the group asks "what could happen to the card I am in";
 *      this one moves the band, so it is live on a deselected deck, dark under
 *      fit where nothing has anywhere to travel, and dark for a slot the
 *      current kind does not have.
 *   3. **The chord actually lands the centering** — one foreground test, since
 *      a promoted chord is resolved by AppKit's key-equivalent scan and dies
 *      silently in a background app-test. It asserts the same arithmetic the
 *      strip's own click commits, so the pointer and the keyboard cannot
 *      disagree about where a named place belongs.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugapp/Sources/AppDelegate.swift
 * @foreground
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const LENS_WIDTH = 420;
/** The settle window, with room for a landing tween. */
const AFTER_LAND_MS = 900;
/** The slim content-width preset. */
const SLIM_PX = 675;
/** `IMPOSITION_GAP_PX` — what stands between two slots of the strip. */
const GAP_PX = 5;

/**
 * `NSEvent.ModifierFlags` as the menu snapshot reports them: ⌃ = 1 << 18,
 * ⌘ = 1 << 20. The Tug tier is both together.
 */
const CONTROL = 1 << 18;
const COMMAND = 1 << 20;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** A deck of `count` content cards, one per slot, with the Lens on the right. */
function deckShape(count: number, layout: "fit" | "flow"): Record<string, unknown> {
  const ids = ["A", "B", "C", "D", "E"].slice(0, count);
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: SLIM_PX, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
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
      kind: ["one-up", "two-up", "three-up", "four-up", "five-up"][count - 1],
      sidebars: { lens: { side: "right" } },
      layout,
    },
    hasFocus: true,
  };
}

async function openDeck(
  app: App,
  options: { cards: number; layout: "fit" | "flow" },
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
  );
  await app.seedDeckState({
    state: deckShape(options.cards, options.layout),
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="lens-layouts-plan"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** The band the strip is seen through — the same arithmetic `_flowBandWidth`
 *  does, read off the elements the deck actually drew. */
async function bandWidth(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var box = document.querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      var lens = document.querySelector('.tug-pane[data-pane-id="pLens"]')
        .getBoundingClientRect();
      return (lens.left - 5) - (box.left + 5);
    })()`,
  );
}

/** Where the store says the strip stands — the committed offset, in px. */
async function committedOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

/** The menu item, asserting it is there first — `menuItemState` returns a
 *  discriminated union, so a missing item carries no fields to read. */
async function menuItem(
  app: App,
  identifier: string,
): Promise<{ enabled: boolean; keyEquivalent: string; modifierMask: number }> {
  const state = await app.menuItemState(identifier);
  expect(state.found, `${identifier} present in the menu`).toBe(true);
  if (!state.found) throw new Error(`${identifier} missing`);
  return {
    enabled: state.enabled,
    keyEquivalent: state.keyEquivalent,
    modifierMask: state.modifierMask,
  };
}

describe.skipIf(!SHOULD_RUN)("⌃⌘N centers slot N", () => {
  test(
    "the Tug tier's digits belong to Center Slot, and the width rows are bare",
    async () => {
      const app = await launchTugApp({ testName: "at0466-center-slot" });
      try {
        // A flow deck, so the rows are live and the sweep that writes key
        // equivalents has a menuState push to run on.
        await openDeck(app, { cards: 5, layout: "flow" });

        for (let n = 1; n <= 6; n += 1) {
          const item = await menuItem(app, `window.centerSlot.${n}`);
          expect(
            item.keyEquivalent,
            `Center Slot ${n} carries its digit`,
          ).toBe(String(n));
          expect(
            item.modifierMask & (CONTROL | COMMAND),
            `and carries it on the Tug tier`,
          ).toBe(CONTROL | COMMAND);
        }
        note("center rows 1..6 carry ⌃⌘1..⌃⌘6");

        // The other half of the handover, and the half a registry test cannot
        // see: a width row that kept its digit would be resolved by AppKit
        // first and eat the press before the centering ever heard of it.
        for (const preset of ["slim", "comfy", "wide"]) {
          const item = await menuItem(app, `window.cardWidth.${preset}`);
          expect(
            item.keyEquivalent,
            `the ${preset} row gave its digit up`,
          ).toBe("");
          expect(
            item.enabled,
            `and kept its place in the menu`,
          ).toBe(true);
        }
        note("width rows: no key equivalent, still enabled");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the rows light for the arrangement, and go dark under fit",
    async () => {
      const app = await launchTugApp({ testName: "at0466-center-slot" });
      try {
        await openDeck(app, { cards: 3, layout: "flow" });
        const flow = await Promise.all(
          [1, 2, 3, 4, 5, 6].map((n) =>
            menuItem(app, `window.centerSlot.${n}`).then((i) => i.enabled),
          ),
        );
        note(`three-up flow: ${flow.map((e) => (e ? "on" : "off")).join(" ")}`);
        expect(flow.slice(0, 3), "a three-up deck has three places").toEqual([
          true,
          true,
          true,
        ]);
        expect(
          flow.slice(3),
          "and a row for a place it does not have would be a row that lies",
        ).toEqual([false, false, false]);

        // Centering moves the band, and under fit there is no band to move —
        // every slot's anchor is a fraction of one the reader can already see.
        await openDeck(app, { cards: 3, layout: "fit" });
        const fit = await Promise.all(
          [1, 2, 3].map((n) =>
            menuItem(app, `window.centerSlot.${n}`).then((i) => i.enabled),
          ),
        );
        note(`three-up fit: ${fit.map((e) => (e ? "on" : "off")).join(" ")}`);
        expect(fit, "fit has nowhere to travel").toEqual([false, false, false]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * `foreground: true` because the chord is menu-promoted: AppKit resolves a
   * key equivalent before the web view sees the keydown, and that scan needs
   * the app to be active. A background run would report a silent no-op as a
   * failure of the centering, which it would not be.
   */
  test(
    "the chord commits the same centering the strip's own click does",
    async () => {
      const app = await launchTugApp({
        testName: "at0466-center-slot-chord",
        foreground: true,
      });
      try {
        await openDeck(app, { cards: 5, layout: "flow" });
        expect(await committedOffset(app), "the strip starts home").toBe(0);

        const band = await bandWidth(app);
        const stripWidth = 5 * SLIM_PX + 4 * GAP_PX;
        const centered = (k: number): number =>
          Math.min(
            Math.max(0, k * (SLIM_PX + GAP_PX) + SLIM_PX / 2 - band / 2),
            stripWidth - band,
          );

        await app.nativeKey("3", ["ctrl", "cmd"]);
        await wait(AFTER_LAND_MS);
        const landed = await committedOffset(app);
        note(
          `⌃⌘3: offset 0 -> ${Math.round(landed)}px, ` +
            `expected ${Math.round(centered(2))}px (band ${Math.round(band)})`,
        );
        expect(landed, "⌃⌘3 puts slot 3 in the middle of the band").toBeCloseTo(
          centered(2),
          0,
        );

        // A second digit travels from wherever the first left it — the answer
        // is a destination, so it does not depend on where the band stood.
        await app.nativeKey("5", ["ctrl", "cmd"]);
        await wait(AFTER_LAND_MS);
        const far = await committedOffset(app);
        note(`⌃⌘5: offset ${Math.round(landed)} -> ${Math.round(far)}px`);
        expect(
          far,
          "and ⌃⌘5 reaches the far end, which the clamp pins flush",
        ).toBeCloseTo(stripWidth - band, 0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
