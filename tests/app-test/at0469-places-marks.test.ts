/**
 * at0469-places-marks.test.ts — the deck's picture, wearing its places: the marks.
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
 * claims 1–3 and 5 (every place is marked with what it is set to, a mark
 * stands under the place it names, a mark is a button);
 * `at0469-places-sidebar-rows` carries claim 4 and the toggle row's keyboard
 * walk, and `at0469-places-drawing` claims 6–8. The deck and the readers are
 * `layout-places-fixture.ts`.
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
  blockRect,
  deckShape,
  hover,
  mark,
  readMarks,
  wait,
} from "./layout-places-fixture";

describe.skipIf(!SHOULD_RUN)("at0469 — the drawing wears its places: the marks", () => {
  test(
    "every occupied place is marked with what it is SET to",
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

        const marks = await readMarks(app);
        note(
          `marks: ${Object.keys(marks)
            .sort()
            .map((k) => `${k}=${marks[k].mode}`)
            .join(", ")}`,
        );

        // ── Every drawn slot is marked, the empty one included. ──
        //
        // The drawing draws all three of three-up's blocks, and an arrangement
        // outlives its membership all the way to zero — an empty slot can
        // still store a split — so every drawn block wears a mark. Slot 2 is
        // empty in this fixture, and marked at its default.
        expect(
          Object.keys(marks).sort(),
          "every slot the kind defines, and no rail",
        ).toEqual(["col-0", "col-1", "col-2"]);
        expect(marks["col-2"].mode, "the empty slot reads its default").toBe(
          "stack",
        );

        // ── The shared, untouched slot reads stacked. ──
        expect(marks["col-0"].mode).toBe("stack");

        // ── THE TRAP, VISIBLE. ──
        //
        // Slot 1 stores a split and holds one card. The drawing beneath shows
        // one undivided block, honestly — and the mark says the slot is set to
        // split, which is the fact that had nowhere to live.
        expect(
          marks["col-1"].mode,
          "slot 1 is SET to split, and says so even standing one card deep",
        ).toBe("split");

        // ── And every mark rests at ONE weight. ──
        //
        // An earlier cut whispered the places with fewer than two cards under
        // them. Two tints in one picture read as a rendering fault before they
        // read as a distinction, and the distinction was about membership,
        // which is not what a mark is for. Read as computed opacity across the
        // whole set — a declared value would prove only that the rule exists.
        const weights = await app.body("L").evalJS<number[]>(
          `Array.prototype.map.call(
            document.querySelectorAll('${TOGGLES} [data-testid^="layout-card-place-"]'),
            function (el) { return Number(getComputedStyle(el).opacity); }
          )`,
        );
        note(`resting weights: ${weights.join(", ")}`);
        expect(
          new Set(weights).size,
          "every mark rests at the same weight, whatever stands under it",
        ).toBe(1);
        expect(weights[0], "and that weight is full").toBe(1);

        // And the drawing is still telling its own truth: one block per
        // occupied slot, slot 1 undivided.
        const splitMembers = await app.evalJS<number>(
          `document.querySelectorAll('.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-block[data-column-member]').length`,
        );
        expect(
          splitMembers,
          "the picture draws what is on screen: no divided column",
        ).toBe(0);

        // ── A rail is NOT one of the marked places. ──
        //
        // It is always divided ([B01]), so there is no arrangement of its own
        // for a mark to state. The Layout card holds the right edge here and
        // the picture still leaves that side its width — it just wears nothing.
        expect(
          Object.keys(marks).filter((key) => key.startsWith("rail-")),
          "no rail is marked",
        ).toEqual([]);

        // ── The rows are fixed, and the count does not move. ──
        //
        // The per-place rows are gone: the section asks the deck-wide
        // questions in words — plus one boot-fixed row per registered sidebar
        // card — and every per-place question on the drawing. What this pins
        // is not tidiness but a height: a section whose row count tracked the
        // deck made everything below it jump as cards moved.
        const rows = await app.body("L").evalJS<string[]>(
          `Array.prototype.map.call(
            document.querySelectorAll('[data-testid="layout-card-section"] [data-slot="tug-choice-group"]'),
            function (el) { return el.getAttribute("data-testid"); }
          )`,
        );
        note(`rows: ${rows.join(", ")}`);
        expect(
          rows.slice(0, 5),
          "the five deck-wide rows lead, in a fixed order",
        ).toEqual([
          "layout-card-kind",
          "layout-card-zoom",
          "layout-card-layout",
          "layout-card-width",
          "layout-card-resize",
        ]);
        // Under them, the place rows — one per slot with something to arrange
        // (part 7); a rail gets none, because it is always divided — and under
        // those, one row per REGISTERED sidebar card: the show/hide + side
        // question the picture cannot ask, because a hidden card is exactly
        // what the picture does not draw. The registry is a boot step, so that
        // count is fixed too.
        const placeRows = rows
          .slice(5)
          .filter((id) => id.startsWith("layout-card-column-"));
        expect(
          rows.filter((id) => id.startsWith("layout-card-rail-")),
          "a rail has no arrangement row",
        ).toEqual([]);
        // The section closes on the sidebar rows.
        const sidebarRows = rows.slice(5 + placeRows.length);
        expect(
          sidebarRows.length,
          "every remaining row is a sidebar card's",
        ).toBeGreaterThanOrEqual(1);
        for (const id of sidebarRows) {
          expect(id).toMatch(/^layout-card-sidebar-/);
        }
        expect(sidebarRows).toContain("layout-card-sidebar-layout");
        const retired = await app.evalJS<number>(
          `document.querySelectorAll(
            '[data-testid^="layout-card-side-"]'
          ).length`,
        );
        expect(retired, "the old per-card side rows are gone, not hidden").toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mark stands under the place it names",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('${mark("col-0")}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const marks = await readMarks(app);
        // The toggle row replicates the strip's flex row, which replicates the
        // drawing's, and places each mark at the drawing's own span — this is
        // the claim that says so: a mark whose geometry drifted by the
        // drawing's padding or its 2px gap would stand under the neighbouring
        // block instead of its own.
        const stripBottom = await app.body("L").evalJS<number>(
          `document.querySelector('[data-testid="flow-strip"]').getBoundingClientRect().bottom`,
        );
        for (const slot of [0, 1, 2]) {
          const block = await blockRect(app, slot);
          const m = marks[`col-${slot}`];
          expect(block, `slot ${slot} is drawn`).not.toBeNull();
          expect(m, `slot ${slot} is marked`).toBeDefined();
          const r = m.rect!;
          // Fit stands each mark at its span's LEADING edge — the one part of
          // a lapped card always visible — so the claim is that the mark
          // starts inside its block's span.
          const lead = r.left + 1;
          expect(
            lead >= block!.left - 1 && lead <= block!.right,
            `slot ${slot}'s mark stands under slot ${slot}'s block ` +
              `(mark ${Math.round(r.left)}–${Math.round(r.right)}, ` +
              `block ${Math.round(block!.left)}–${Math.round(block!.right)})`,
          ).toBe(true);
          // Under the numbered strip: the marks are the legend's second line,
          // not stickers on the drawing.
          expect(
            r.top >= stripBottom - 1 && r.top > block!.bottom,
            `slot ${slot}'s mark stands below the strip, off the drawing`,
          ).toBe(true);
        }

        const b0 = await blockRect(app, 0);
        note(
          `mark col-0 at ${Math.round(marks["col-0"].rect!.left)}–` +
            `${Math.round(marks["col-0"].rect!.right)} over block ` +
            `${Math.round(b0!.left)}–${Math.round(b0!.right)}`,
        );

        // Every mark is a real target, not a speck on a picture. Sixteen
        // pixels square is the floor a press can actually find at this scale.
        const targets = await app.body("L").evalJS<Record<string, [number, number]>>(
          `(function () {
            var out = {};
            var nodes = document.querySelectorAll('${TOGGLES} [data-testid^="layout-card-place-"]');
            Array.prototype.forEach.call(nodes, function (el) {
              var r = el.getBoundingClientRect();
              out[el.getAttribute("data-testid")] = [r.width, r.height];
            });
            return out;
          })()`,
        );
        note(
          `hit targets: ${Object.keys(targets)
            .sort()
            .map(
              (k) =>
                `${k.replace("layout-card-place-", "")} ` +
                `${Math.round(targets[k][0])}×${Math.round(targets[k][1])}`,
            )
            .join(", ")}`,
        );
        for (const [id, [w, h]] of Object.entries(targets)) {
          expect(w, `${id} is wide enough to press`).toBeGreaterThanOrEqual(16);
          expect(h, `${id} is tall enough to press`).toBeGreaterThanOrEqual(16);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mark is a button: it answers a hand, and it does not audition",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('${mark("col-0")}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── Hovering a mark changes the MARK, and nothing else. ──
        //
        // A mark is a two-state toggle whose effect is the glyph it wears, so
        // there is nothing an audition could show that the mark is not already
        // showing — and the marks stand close enough together that raising a
        // layer per crossing made the whole section strobe as the hand moved.
        // What a hover does instead is what it does on any button: the control
        // answers, and the plan stays where it is.
        await hover(app, mark("col-0"));
        await wait(300);
        expect(
          await app.body("L").evalJS<boolean>(
            `document.querySelector('[data-testid="layout-card-plan"]').hasAttribute("data-previewing")`,
          ),
          "hovering a mark does not swap the plan out from under the reader",
        ).toBe(false);
        // And there is no layer standing by to be raised: a preview nothing can
        // reach is dead weight in the DOM, not a spare.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(
              '[data-plan-preview-id^="columnmode:"], [data-plan-preview-id^="railmode:"]'
            ).length`,
          ),
          "the arrangement layers are gone, not merely unreachable",
        ).toBe(0);

        // ── THE TRAP, CLOSED. ──
        //
        // Slot 1 kept a split nobody could see and nobody could reach. Press
        // its mark and the stored arrangement goes back to stack — which is the
        // gesture the membership-gated column row denied outright, because it
        // refused to exist for a slot standing one card deep.
        await app.body("L").click(mark("col-1"));
        await wait(AFTER_LAND_MS);
        const afterFix = await readMarks(app);
        expect(
          afterFix["col-1"].mode,
          "pressing the one-card split's mark put the slot back to stack",
        ).toBe("stack");

        // ── And the same press works the other way, with real geometry. ──
        //
        // Slot 0 is genuinely shared, so splitting it must divide the run: two
        // frames, tiling, which is what `at0455` measures in full. Here the
        // claim is only that the mark reached the column command at all.
        const before = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-column-split]').length`,
        );
        expect(before, "nothing is split to begin with").toBe(0);
        await app.body("L").click(mark("col-0"));
        await wait(AFTER_LAND_MS);
        const after = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-column-split]').length`,
        );
        expect(
          after,
          "pressing slot 0's mark divided the slot its two cards share",
        ).toBe(2);
        const nowMarks = await readMarks(app);
        expect(
          nowMarks["col-0"].mode,
          "and the mark now reads what the slot is set to",
        ).toBe("split");
        note(
          `after presses: ${Object.keys(nowMarks)
            .sort()
            .map((k) => `${k}=${nowMarks[k].mode}`)
            .join(", ")}`,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
