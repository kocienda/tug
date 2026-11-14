/**
 * at0469-places-sidebar-rows-toggle-walk.test.ts — the deck's picture,
 * wearing its places: the toggle row is one stop; arrows walk it, Space
 * commits.
 *
 * One of the at0469-places-sidebar-rows split, a test to a file so each
 * launch fits its own budget. The sidebar-rows files carry claim 4 (a rail is
 * a place too: its row shows, moves and hides the real card) and the toggle
 * row's keyboard walk. The claims the at0469-places family reads, the deck
 * and the readers are `layout-places-fixture.ts`.
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
    "the toggle row is one stop: arrows walk it, Space commits",
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
          const at = await app.body("L").evalJS<string | null>(
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
        const stops = await app.body("L").evalJS<number>(
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
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('${TOGGLES} [data-key-cursor]') !== null`,
          { timeoutMs: 4_000 },
        );
        await app.nativeKey("ArrowRight");
        await wait(400);
        const cursorFacts = await app.body("L").evalJS<{
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
                    .getPropertyValue("--tugx-slot-badge-stroke")
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
});
