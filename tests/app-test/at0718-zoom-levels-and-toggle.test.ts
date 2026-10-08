/**
 * at0718-zoom-levels-and-toggle.test.ts — View › Zoom moves along a fixed set
 * of levels, the Layout card's Zoom row chooses one directly, and ⌥⌘0 goes to
 * 100 % and back.
 *
 * | Test                   | What would break without it                       |
 * |------------------------|---------------------------------------------------|
 * | the row, the note and  | a Zoom row that asks the host for nothing, a row  |
 * | the steps              | that does not follow a zoom it did not make, a    |
 * |                        | note that hides the factor, or ⌘+ / ⌘− stepping   |
 * |                        | by 10 % past the levels the row offers            |
 * | the toggle             | ⌥⌘0 with no item behind it, or one that forgets   |
 * |                        | where it came from                                |
 *
 * Every factor is read where the deck applies it: the root's `transform`.
 * The Layout card sits in the right rail of a two-up, opened the way at0454
 * opens it.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/lib/page-zoom-store.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App, type NativeModifier } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const RAIL_WIDTH = 420;
const ZOOM_GROUP = '[data-testid="layout-card-zoom"]';
const NOTE = '[data-testid="layout-card-plan"] [data-plan-layer="committed"] .layouts-plan-note';

const OPTION = 1 << 19;
const COMMAND = 1 << 20;

/** Long enough for a step to apply, paint and settle. */
const SETTLE_MS = 600;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
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
      { id: "B", componentId: "hello", title: "Card B", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
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
    imposition: {
      kind: "two-up",
      sidebars: { layout: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** The factor the deck root is drawn at. */
function factor(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var t = document.getElementById("deck-container").style.transform;
      var m = /scale\\(([0-9.]+)\\)/.exec(t);
      return m === null ? 1 : Number(m[1]);
    })()`,
  );
}

/** The Zoom row's selected segment, or "" with none. */
function selected(app: App): Promise<string> {
  return app.evalJS<string>(
    `document.querySelector('${ZOOM_GROUP} [data-choice-value][data-state="active"]')?.getAttribute("data-choice-value") ?? ""`,
  );
}

function noteText(app: App): Promise<string> {
  return app.evalJS<string>(`document.querySelector(${JSON.stringify(NOTE)})?.textContent ?? ""`);
}

/** The Zoom row's segment labels, in order. */
function labels(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll('${ZOOM_GROUP} [data-choice-value]')).map(function (el) { return el.textContent; })`,
  );
}

async function clickLevel(app: App, level: string): Promise<void> {
  await app.click(`${ZOOM_GROUP} [data-choice-value="${level}"]`);
  await wait(SETTLE_MS);
}

async function key(app: App, k: string, modifiers: readonly NativeModifier[]): Promise<void> {
  await app.nativeKey(k, modifiers);
  await wait(SETTLE_MS);
}

async function standUp(): Promise<App> {
  const app = await launchTugApp({ testName: "at0718-zoom-levels-and-toggle" });
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('${ZOOM_GROUP} [data-choice-value]').length > 0`,
    { timeoutMs: 8_000 },
  );
  return app;
}

describe.skipIf(!SHOULD_RUN)("AT0718: View › Zoom levels, the Layout card's Zoom row, and ⌥⌘0", () => {
  test(
    "the row offers the levels and chooses one, the note names it, and ⌘+ / ⌘− step along the same levels",
    async () => {
      const app = await standUp();
      try {
        expect(await labels(app), "the row offers the four everyday levels").toEqual([
          "70", "80", "90", "100",
        ]);
        // The row in a rail at its narrow width stays inside the card, like
        // every other row.
        const fit = await app.evalJS<{ group: number; card: number }>(
          `(function () {
            var group = document.querySelector('${ZOOM_GROUP}').getBoundingClientRect();
            var card = document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect();
            return { group: group.right, card: card.right };
          })()`,
        );
        note("fit", JSON.stringify(fit));
        expect(fit.group, "the row fits the rail").toBeLessThanOrEqual(fit.card);
        expect(await selected(app), "100 % stands selected at launch").toBe("1");
        expect(await noteText(app), "at 100 % the note says nothing of zoom").not.toContain("%");

        await clickLevel(app, "0.8");
        expect(await factor(app), "the row's choice reaches the deck").toBeCloseTo(0.8, 5);
        expect(await selected(app)).toBe("0.8");
        const at80 = await noteText(app);
        note("note at 80%", at80);
        expect(at80, "the note names the factor").toContain("px, 80%");

        await key(app, "=", ["cmd"]);
        expect(await factor(app), "⌘= steps to the next level").toBeCloseTo(0.9, 5);
        expect(await selected(app), "the row follows a zoom it did not make").toBe("0.9");

        await key(app, "-", ["cmd"]);
        await key(app, "-", ["cmd"]);
        await key(app, "-", ["cmd"]);
        expect(await factor(app), "⌘− steps down past the row's levels").toBeCloseTo(0.5, 5);
        expect(await labels(app), "a level off the row joins it as a fifth segment, in order").toEqual([
          "50", "70", "80", "90", "100",
        ]);
        expect(await selected(app), "and it is the one selected").toBe("0.5");

        await clickLevel(app, "0.9");
        expect(await factor(app)).toBeCloseTo(0.9, 5);
        expect(await labels(app), "back on the row, the fifth segment goes").toEqual([
          "70", "80", "90", "100",
        ]);

        for (let i = 0; i < 2; i += 1) await key(app, "=", ["cmd"]);
        expect(await factor(app), "⌘= steps up past 100 %").toBeCloseTo(1.25, 5);
        expect(await labels(app), "above the row, the fifth segment trails it").toEqual([
          "70", "80", "90", "100", "125",
        ]);

        // A factor between levels — only the harness sets one — is shown the
        // same way, and the next step lands on a level rather than 10 % on.
        expect(await app.setPageZoom(0.75)).toBeCloseTo(0.75, 5);
        expect(await selected(app), "between levels, the factor is its own segment").toBe("0.75");
        await key(app, "=", ["cmd"]);
        expect(await factor(app), "a step from between levels lands on the next one").toBeCloseTo(
          0.8,
          5,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "⌥⌘0 goes to 100 % from a level and back to it from 100 %",
    async () => {
      const app = await standUp();
      try {
        const item = await app.menuItemState("view.toggleActualSize");
        expect(item.found, "View › Toggle Actual Size exists").toBe(true);
        if (item.found) {
          expect(item.keyEquivalent).toBe("0");
          expect(item.modifierMask & (COMMAND | OPTION)).toBe(COMMAND | OPTION);
          expect(item.enabled, "at 100 % with nothing chosen, there is nowhere to go").toBe(false);
        }

        await clickLevel(app, "0.8");
        expect(await factor(app)).toBeCloseTo(0.8, 5);

        await key(app, "0", ["cmd", "alt"]);
        expect(await factor(app), "⌥⌘0 from 80 % goes to 100 %").toBeCloseTo(1, 5);

        await key(app, "0", ["cmd", "alt"]);
        expect(await factor(app), "⌥⌘0 from 100 % goes back to 80 %").toBeCloseTo(0.8, 5);

        // ⌘0 to 100 % keeps the level too: it is the last one chosen that
        // isn't 100 %.
        await key(app, "0", ["cmd"]);
        expect(await factor(app)).toBeCloseTo(1, 5);
        await key(app, "0", ["cmd", "alt"]);
        expect(await factor(app), "⌥⌘0 after ⌘0 still goes back").toBeCloseTo(0.8, 5);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
