/**
 * at0469-places-sidebar-rows.test.ts — the deck's picture, wearing its places: the sidebar rows.
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
 * claim 4 (a rail is a place too: its row shows, moves and hides the real
 * card) and the toggle row's keyboard walk; `at0469-places-marks` carries
 * claims 1–3 and 5, and `at0469-places-drawing` claims 6–8. The deck and the
 * readers are `layout-places-fixture.ts`.
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
  readMarks,
  tabUntilKbd,
  wait,
} from "./layout-places-fixture";

describe.skipIf(!SHOULD_RUN)("at0469 — the drawing wears its places: the sidebar rows", () => {
  test(
    "a sidebar's row moves the real card; the picture carries no side arrows",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-sidebar-layout"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // Placement is the ROW's question, not the picture's: the schematic's
        // marks say only stack versus split, and the picture carries no
        // side-move affordance at all. The row can also say Off, which is the
        // answer no mark on a drawing of the open deck could offer.
        const arrows = await app.evalJS<number>(
          `document.querySelectorAll('[data-testid^="layout-card-place-side-"]').length`,
        );
        expect(
          arrows,
          "the picture carries no side-move affordance — the rows own placement",
        ).toBe(0);

        const railBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().left`,
        );
        const cardBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        expect(
          railBefore,
          "the Layout card starts to the right of the content cards",
        ).toBeGreaterThan(cardBefore);

        await app.click(
          `[data-testid="layout-card-sidebar-layout"] [data-choice-value="left"]`,
        );
        await wait(AFTER_LAND_MS);

        const railAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().left`,
        );
        const cardAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        // The real card moved, not just the row: the press went through the
        // section's own `set-sidebar-side` route.
        expect(
          railAfter,
          "pressing Left on the Layout card's row moved the real Layout card to the left edge",
        ).toBeLessThan(cardAfter);
        note(
          `rail ${Math.round(railBefore)} → ${Math.round(railAfter)}, ` +
            `card ${Math.round(cardBefore)} → ${Math.round(cardAfter)}`,
        );

        // And the row now reads the side it holds.
        const activeNow = await app.evalJS<string | null>(
          `(function () {
            var el = document.querySelector('[data-testid="layout-card-sidebar-layout"] [data-choice-value][data-state="active"]');
            return el === null ? null : el.getAttribute("data-choice-value");
          })()`,
        );
        expect(activeNow, "the row reads the move").toBe("left");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the toggle row is one stop: arrows walk it, Space commits",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── One stop for the whole row. ──
        //
        // Tab reaches the toggle row itself, not a mark inside it: the marks
        // are items the cursor walks, exactly as a segmented row's segments
        // are. A stop per mark would make Tab crawl the row. The drawing above
        // is no stop at all — its parts take the pointer, and the keyboard
        // reaches every card through the deck's own chords.
        // Seed the ring into the Layout card before walking it, exactly as at0454
        // does — Tab moves the ring within the key card, and without this the
        // walk starts wherever the deck happened to leave it.
        await app.dispatchControlAction("toggle-layout");
        await wait(300);
        await tabUntilKbd(app, '[data-testid="layout-card-kind"]');
        const walk: string[] = [];
        for (let i = 0; i < 16; i += 1) {
          await app.nativeKey("Tab");
          await wait(150);
          const at = await app.evalJS<string | null>(
            `(function () {
              var all = document.querySelectorAll('[data-key-view-kbd][data-testid]');
              var el = all[all.length - 1];
              return el ? el.getAttribute("data-testid") : null;
            })()`,
          );
          if (at === null || walk[walk.length - 1] === at) break;
          walk.push(at);
          // Stop on arrival: the claim is that the walk REACHES the row, and
          // stopping here leaves the ring on it for the arrows below.
          if (at === "layout-card-toggles") break;
        }
        note(`ladder below Cards: ${walk.join(" -> ")}`);
        expect(
          walk,
          "the toggle row is a rung on the ladder, not a control only a mouse can reach",
        ).toContain("layout-card-toggles");
        expect(
          walk,
          "the drawing's overlay is not a stop of its own",
        ).not.toContain("layout-card-places");
        const stops = await app.evalJS<number>(
          `document.querySelectorAll('${TOGGLES}[data-tug-focusable]').length`,
        );
        expect(stops, "the row registers exactly one focusable").toBe(1);

        // ── The cursor lands on a mark, and wears the mark's own hover face. ──
        //
        // Tab-into parks the cursor on the group's first item; an arrow steps
        // it along the run. Standing on a mark does not audition — a mark is a
        // button — so what says where the cursor is standing is the appearance
        // the mark gives a pointer, which the cursor takes as its own. That is
        // read as the accent the glyph carries, not as a declared value: the
        // resting stroke is the drawing's neutral ink and the reached-for one
        // is the control accent, so the two are simply different colours.
        await app.waitForCondition<boolean>(
          `document.querySelector('${TOGGLES} [data-key-cursor]') !== null`,
          { timeoutMs: 4_000 },
        );
        await app.nativeKey("ArrowRight");
        await wait(400);
        const cursorFacts = await app.evalJS<{
          testid: string | null;
          cursorStroke: string;
          restStroke: string;
          previewing: boolean;
        }>(
          `(function () {
            var el = document.querySelector('${TOGGLES} [data-key-cursor]');
            var strokeOf = function (node) {
              return node === null
                ? ""
                : getComputedStyle(node)
                    .getPropertyValue("--tugx-column-badge-stroke")
                    .trim();
            };
            var others = Array.prototype.filter.call(
              document.querySelectorAll('${TOGGLES} [data-testid^="layout-card-place-"]'),
              function (n) { return !n.hasAttribute("data-key-cursor"); }
            );
            return {
              testid: el === null ? null : el.getAttribute("data-testid"),
              cursorStroke: strokeOf(el),
              restStroke: strokeOf(others[0] || null),
              previewing: document
                .querySelector('[data-testid="layout-card-plan"]')
                .hasAttribute("data-previewing"),
            };
          })()`,
        );
        expect(cursorFacts.testid, "an arrow put the cursor on a mark").not.toBeNull();
        expect(
          cursorFacts.previewing,
          "and standing there auditions nothing — a mark is a button",
        ).toBe(false);
        expect(
          cursorFacts.cursorStroke,
          "the cursored mark is drawn differently from the ones at rest",
        ).not.toBe(cursorFacts.restStroke);
        note(
          `cursor on ${cursorFacts.testid}: ${cursorFacts.cursorStroke} ` +
            `vs ${cursorFacts.restStroke} at rest`,
        );

        // ── Space commits what the cursor is standing on. ──
        //
        // The mark carries the arrangement NOT in force, so what Space does is
        // exactly what a press does: it sets the other thing, and the glyph
        // under the cursor turns over to say so.
        const key = (cursorFacts.testid ?? "").replace(
          "layout-card-place-",
          "",
        );
        const before = (await readMarks(app))[key]?.mode;
        // Space, spelled as the character — `VirtualKeyMap` has no "Space" name.
        await app.nativeKey(" ");
        await wait(AFTER_LAND_MS);

        const after = (await readMarks(app))[key]?.mode;
        expect(
          after,
          `Space set ${key} to the arrangement its mark was offering`,
        ).toBe(before === "split" ? "stack" : "split");
        note(`Space committed ${key}: ${before} → ${after}`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sidebar row shows, moves, and hides the real card",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-sidebar-jots"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const activeOf = (id: string): Promise<string | null> =>
          app.evalJS<string | null>(
            `(function () {
              var el = document.querySelector('[data-testid="${id}"] [data-choice-value][data-state="active"]');
              return el === null ? null : el.getAttribute("data-choice-value");
            })()`,
          );

        // ── The rows read what stands: Layout open on the right, Jots off. ──
        expect(
          await activeOf("layout-card-sidebar-layout"),
          "the Layout card's row reads the side it holds",
        ).toBe("right");
        expect(
          await activeOf("layout-card-sidebar-jots"),
          "a hidden card's row reads Off",
        ).toBe("off");

        // ── And the drawing draws what stands: no rail for a hidden card. ──
        //
        // Membership is a live read of the OPEN cards. A registered-but-hidden
        // Jots is not on the deck, so its side is not drawn at all — the row
        // above is its one door. Read off the committed drawing rather than off
        // a mark: a rail wears none ([B01]).
        const drawnRails = async (): Promise<number> =>
          app.evalJS<number>(
            `document.querySelectorAll(
              '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-rail'
            ).length`,
          );
        expect(await drawnRails(), "only the occupied right side is drawn").toBe(1);

        // ── Pressing a side on a hidden card's row shows it THERE. ──
        await app.click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="left"]`,
        );
        await wait(AFTER_LAND_MS);
        expect(
          await activeOf("layout-card-sidebar-jots"),
          "the row now reads the side it was shown on",
        ).toBe("left");
        const jotsLeft = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length`,
        );
        expect(jotsLeft, "the real Jots card stands on the left edge").toBe(1);
        // The drawing follows: a left rail appears beside the right one.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(
            '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-rail'
          ).length === 2`,
          { timeoutMs: 4_000 },
        );
        expect(await drawnRails(), "both edges now carry a rail").toBe(2);

        // ── Off hides it again, and everything retracts together. ──
        await app.click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="off"]`,
        );
        await wait(AFTER_LAND_MS);
        expect(await activeOf("layout-card-sidebar-jots")).toBe("off");
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length`,
          ),
          "the real card left the deck",
        ).toBe(0);
        expect(await drawnRails(), "and its rail left the drawing").toBe(1);
        note("jots: off → left → off, with the deck and the drawing in step");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
