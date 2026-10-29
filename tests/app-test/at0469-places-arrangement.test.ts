/**
 * at0469-places-arrangement.test.ts — the deck's picture, wearing its places: the arrangement.
 *
 * The Layout section draws the deck at scale and now marks every arrangeable
 * place on that drawing: a slot's mark says whether the slot is stacked or
 * split, a side's mark says the same for its rail. What makes the marks worth
 * having — and what this file is for — is that they read the STORED
 * arrangement rather than the drawn one.
 *
 * The two come apart at exactly one card. Membership churn preserves an
 * arrangement (`columnDrawsSplit` in `deck-store-selectors.ts`), so a slot set
 * to split and standing one card deep renders as one undivided card. Before the
 * overlay that stored split was invisible on every surface and unreachable from
 * the Layout card, because the section's column rows were gated on `members.length > 1`
 * — so it sat there until a second card arrived and it resurfaced as a surprise.
 *
 *   1. **Every slot the kind defines is marked**, occupied or not, and each
 *      mark says that slot's own stored arrangement.
 *   2. **A one-card split is visible**, drawn split: the arrangement is real,
 *      there is just nothing standing under it yet.
 *   3. **The marks stand under the places they name.** They live in a row
 *      beneath the numbered strip, one under each number, and each stands
 *      within its block's span — the drawing's blocks wear their cards'
 *      faces, so the marks left the drawing for the legend.
 *   4. **A rail is a place too**, and wears the same vocabulary.
 *   5. **A mark is a button.** It answers a hand and does not audition, and
 *      every mark rests at one weight — the picture states arrangements, not
 *      how many cards stand under them.
 *   6. **Every block wears its card's face, and hovering one names the card.**
 *      A stack shows its sheets behind the front card; the hover says what the
 *      card is called, where it stands, what is behind it, and what a press
 *      does.
 *   7. **A place wears ONE mark, and the note says which thing scrolls.** The
 *      mark says stack or split and nothing more — the layout glyph it wore
 *      for a while is gone — and a rail put on flow through its mixer row
 *      draws as a strip in the miniature while the plan's note names the rail
 *      as the thing that scrolls.
 *
 *   A place's arrangement used to be a row in the mixer as well — a
 *   `Column N` `Stack | Split` row under Gap per shared slot. It restated the
 *   place toggle under the strip in words, and was removed; `at0469-places-marks`
 *   asserts the mixer carries no such row.
 *
 * Read from live `getBoundingClientRect()` and `data-` attributes. Nothing here
 * reads back a declared style value.
 *
 * Cut from `at0469-layout-places` to fit the 20 s budget. This file carries
 * claim 7 (a place wears one mark); `at0469-places-marks` carries claims 1–3 and 5,
 * `at0469-places-sidebar-rows` claim 4, and `at0469-places-drawing` claim 6.
 * The deck and the readers are `layout-places-fixture.ts`.
 *
 * @family at0469-places
 * @covers tugdeck/src/components/layout/layout-places.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/components/layout/miniature-faces.tsx
 * @covers tugdeck/src/components/layout/miniature-card-tip.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  AFTER_LAND_MS,
  PLACES,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TOGGLES,
  deckShape,
  wait,
} from "./layout-places-fixture";

describe.skipIf(!SHOULD_RUN)("at0469 — the drawing wears its places: the arrangement", () => {
  test(
    "a place wears one mark, and the note says which thing scrolls",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── One mark per place, whatever its layout. ──
        //
        // Slot 1 is SET to split and slot 0 is stacked, and each wears exactly
        // one affordance: the layout glyph that once stood beside a split
        // place's mark is gone, and nothing on the picture says fit or flow.
        const affordances = await app.body("L").evalJS<Record<string, number>>(
          `(function () {
            var out = {};
            Array.prototype.forEach.call(
              document.querySelectorAll('${TOGGLES} .layout-places-mark[data-place]'),
              function (el) {
                out[el.getAttribute("data-place")] =
                  el.querySelectorAll('[data-testid^="layout-card-place-"]').length;
              },
            );
            return out;
          })()`,
        );
        note(`affordances per mark: ${JSON.stringify(affordances)}`);
        expect(affordances["col-1"], "the split slot wears one mark").toBe(1);
        expect(affordances["col-0"], "and so does the stacked one").toBe(1);
        expect(
          await app.body("L").evalJS<number>(
            `document.querySelectorAll('${TOGGLES} [data-place-layout], ${TOGGLES} [data-testid$="-layout"]').length`,
          ),
          "no mark carries a layout — glyph or attribute",
        ).toBe(0);

        // ── A rail wears NO mark at all. ──
        //
        // It is always divided ([B01], [B02]), so there is nothing about its
        // arrangement for a glyph to state or a press to change. The picture
        // still leaves the side its width; the marks over the field are the
        // slots' alone.
        await app.body("L").click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="right"]`,
        );
        await wait(AFTER_LAND_MS);
        const railMarks = await app.body("L").evalJS<number>(
          `document.querySelectorAll('${TOGGLES} .layout-places-mark[data-place^="rail-"], ${PLACES} .layout-places-mark').length`,
        );
        note(`rail marks, and marks on the picture: ${railMarks}`);
        expect(
          railMarks,
          "no mark stands for either rail, and none stands on the drawing",
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
