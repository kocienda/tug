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
 *   8. **A place's arrangement is a row in the mixer**, `Stack | Fit | Flow`
 *      per rail side and per slot with something to arrange. Stack writes the
 *      mode alone and the layout is remembered; Fit and Flow write the mode
 *      and the layout together. A rail row is disabled, never absent, while
 *      its side holds fewer than two cards; a column row is absent, never
 *      disabled, while its slot does.
 *
 * Read from live `getBoundingClientRect()` and `data-` attributes. Nothing here
 * reads back a declared style value.
 *
 * Cut from `at0469-layout-places` to fit the 20 s budget. This file carries
 * claims 7 and 8 (a place wears one mark, and a place's arrangement is a
 * mixer row); `at0469-places-marks` carries claims 1–3 and 5,
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

  // ── 7. The arrangement is a row in the mixer. ──
  //
  // The picture's marks state and toggle; a row states a choice among answers,
  // and this is the row: `Stack | Split` per SLOT, under Card Width and above
  // the per-card rows, told from the deck's own LAYOUT row by the caption
  // naming the place. A rail gets no row at all — it is always divided ([B01]),
  // so there is nothing to choose. Every press below is read back from the
  // STORED record rather than from the row, so a pass says the deck changed
  // and not that the segment lit.
  test(
    "a slot's arrangement is a Stack | Split row, and each segment writes the record it names",
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

        const columnRow = (slot: number) => `[data-testid="layout-card-column-${slot}"]`;
        const rowFacts = async (
          selector: string,
        ): Promise<{ present: boolean; disabled: boolean; value: string | null }> =>
          app.evalJS<{ present: boolean; disabled: boolean; value: string | null }>(
            `(function () {
              var row = document.querySelector('${selector}');
              if (row === null) return { present: false, disabled: false, value: null };
              var active = row.querySelector('[data-choice-value][data-state="active"]');
              return {
                present: true,
                disabled: row.hasAttribute("data-disabled"),
                value: active === null ? null : active.getAttribute("data-choice-value"),
              };
            })()`,
          );
        const stored = async (): Promise<{ mode: string | null }> =>
          app.evalJS<{ mode: string | null }>(
            `(function () {
              var imp = window.tugdeck.diag.getDeckState().imposition;
              var column = (imp.columns || {})[0] || {};
              return { mode: column.mode || null };
            })()`,
          );

        // ── The rows stand where the brief puts them. ──
        //
        // No rail row on either side. Slot 0 holds two cards and gets a row,
        // slot 1 holds one and gets none. The column rows come directly after
        // the last deck-wide row, Resizing, and the per-card rows last.
        const order = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll('.layouts-section-row [data-testid^="layout-card-"]'))
            .map(function (el) { return el.getAttribute("data-testid"); })`,
        );
        note(`mixer rows: ${order.join(" · ")}`);
        expect(
          order.filter((id) => id.startsWith("layout-card-rail-")),
          "a rail has no arrangement row: it is always divided",
        ).toEqual([]);
        expect(order.indexOf("layout-card-column-0"), "Column 1 follows the deck-wide rows").toBe(
          order.indexOf("layout-card-resize") + 1,
        );
        expect(
          order.indexOf("layout-card-column-1"),
          "a slot with one card has no row — absent, not disabled",
        ).toBe(-1);
        expect(
          order.indexOf("layout-card-sidebar-layout"),
          "and the per-card rows come after every place row",
        ).toBeGreaterThan(order.indexOf("layout-card-column-0"));

        // ── Split writes the slot's mode; Stack writes it back. ──
        const columnAtRest = await rowFacts(columnRow(0));
        expect(columnAtRest.present, "slot 0's row is there").toBe(true);
        expect(columnAtRest.disabled, "enabled — two cards stand in it").toBe(false);
        expect(columnAtRest.value, "reading Stack, which an untouched shared slot is").toBe("stack");

        await app.body("L").click(`${columnRow(0)} [data-choice-value="split"]`);
        await wait(AFTER_LAND_MS);
        let record = await stored();
        note(`after Split on Column 1: ${JSON.stringify(record)}`);
        expect(record.mode, "Split divided the slot").toBe("split");
        expect((await rowFacts(columnRow(0))).value, "and the row says Split").toBe("split");

        await app.body("L").click(`${columnRow(0)} [data-choice-value="stack"]`);
        await wait(AFTER_LAND_MS);
        record = await stored();
        note(`after Stack on Column 1: ${JSON.stringify(record)}`);
        expect(record.mode, "Stack stacks the slot").toBe("stack");
        expect((await rowFacts(columnRow(0))).value, "and the row says Stack").toBe("stack");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
