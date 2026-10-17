/**
 * at0451-cards-multiselect-escape.test.ts — a layout verb acts on the selection, and
 * moves all of it at once.
 *
 * Before the layout selection there was one target and one way to name it: the
 * deck's first responder. That reading has a hole the user falls into daily —
 * with the keyboard in the Cards list, the first responder IS the Cards card,
 * which is a rail, so `MOVE_TO_SLOT` refused every ⌘-digit typed while the list
 * had focus. The chord did nothing and said nothing, at exactly the moment the
 * user was looking at the list of cards and deciding where to put one.
 *
 * `resolveLayoutSelection` replaces that reading with a ladder — the selection,
 * else the row the Cards list's cursor is standing on, else the first
 * responder, else nothing — and this test drives every rung through the real
 * chords against a real deck.
 *
 * The second test is the Cards list's own key and pointer model, which the
 * ladder is only half of. Space and Return stopped meaning the same thing: one
 * NAMES a row, the other OPENS it, and a list that acts on both leaves the
 * keyboard no way to say "this one" without opening it. ⇧+arrow extends and
 * ⌘+arrow walks, both taking the row they start from, because extension names
 * where the cursor LANDS and the origin row would otherwise be the one row the
 * walk could never reach — and the seed is the ARROW's doing, not the
 * modifier's, so a bare Shift held down selects nothing and the first ⇧↓ spends
 * itself on the origin row without moving the caret off it. And a plain click
 * MOVES the selection rather than activating a row and leaving the fill behind
 * on another one.
 *
 * Escape drops the selection before it does anything else, and it does so from
 * BOTH sides of the keyboard — which is the claim worth two presses rather than
 * one. The engine's Escape ladder outranks the responder chain at every rung,
 * and a plain click on a Cards row fronts the card it names and takes the
 * keyboard out of the Cards card; so the press had two ways to be swallowed, each
 * reachable by an ordinary gesture, and which one the user was in was invisible.
 * The list CAPTURES Escape while it holds the keyboard and a set stands, and the
 * root responder registers a `CANCEL_DIALOG` entry for exactly as long as one
 * stands at all. Both presses are asserted, on a keyboard-made set and on a
 * mouse-made one.
 *
 * The second half is the batch. A multi-card move must be ONE arrangement, not
 * N: the FLIP settle in `settle-engine.ts` measures where the frames were on the
 * store event and where they landed after React's commit, so a gesture that
 * notifies once per card offers that measurement a half-moved deck each time
 * and re-arms the settle window on every one of them. That failure is invisible
 * to a geometry assertion — the cards still end up in the right places — so it
 * is held by the cut detector instead: a re-armed settle drops a frame mid-tween
 * and the detector records the jump. Zero cuts across a two-card move is the
 * assertion that the commit was single.
 *
 * The third test is the Escape table itself (`cards-escape.ts`,
 * `tuglaws/focus-language.md`): filter text, then the selection, then focus out
 * — and never anything else, from whichever first-responder shape the press
 * arrives in. Several handlers can answer it — the Cards list while it holds
 * the keyboard, the Cards card's own responder, the deck root's conditional entry —
 * and the defect the table exists to prevent is those handlers disagreeing
 * about their inputs and their order, which is what the user sees as "Escape
 * does something different every time". So the two cases here drive the two
 * shapes that used to resolve differently: a set whose rows are not on screen
 * at all (the group folded over it), and a press answered from OUTSIDE the Cards card
 * after a click fronted a card and took the keyboard with it. The invariant
 * both assert is the same one: each press shrinks exactly one rung, and the
 * rung above it is untouched.
 *
 * Cut from `at0451-cards-multiselect` to fit the 20 s budget. This file
 * carries the third test, the Escape table; `at0451-cards-multiselect-chords`
 * carries the layout chords and the batch, and `-list` the Cards list's key
 * and pointer model. The deck and the readers are
 * `cards-multiselect-fixture.ts`.
 *
 * @family at0451-cards-multiselect
 * @covers tugdeck/src/lib/cards-selection-store.ts
 * @covers tugdeck/src/lib/layout-selection.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/tugways/list-multi-select.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/cards/cards-escape.ts
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import {
  AFTER_LAND_MS,
  CURSOR_ROW,
  FILTER_INPUT,
  FRAMES,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  clickFilterField,
  clickRowTitled,
  cursorTitle,
  deckShape,
  filterQuery,
  focusCardsList,
  getSelection,
  rowCount,
  seedCardsPreferred,
  setSelection,
  wait,
} from "./cards-multiselect-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0451 — the layout selection is what a layout verb acts on",
  () => {
    test(
      "Escape shrinks Cards state in one order, whatever the rows are showing",
      async () => {
        const app = await launchTugApp({ testName: "at0451-cards-escape-table" });
        try {
          await seedCardsPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          await setSelection(app, []);

          // ---- A set the rows are not showing is still a set ---------------
          //
          // The list's Escape gate used to read `selectedIds` — a projection
          // over the rows on screen — so folding the group the selected cards
          // live in made the list report "nothing selected" about a selection
          // that was standing perfectly well. The press then went to the
          // ladder and threw the keyboard out of the Cards card instead, and the set
          // came back into view still selected when the group re-opened. What
          // the user is taking back is the SET, not the visible part of it.
          await focusCardsList(app);
          await app.nativeKey("Home");
          await wait(200);
          // Row 0 is the WORKSPACE header now — the list's outermost level —
          // so one step down is the first group header, which is the row this
          // case needs the cursor on. What is being checked here is the
          // Escape gate over a folded-away selection, not where Home lands.
          await app.nativeKey("ArrowDown");
          await wait(200);
          expect(
            await cursorTitle(app),
            "Home lands on the group header the fold is driven from",
          ).toContain("Tools");
          await setSelection(app, ["B", "C"]);

          await app.nativeKey(" ");
          await wait(300);
          expect(
            await rowCount(app),
            "the fold took the card rows off the list",
          // Two rows left: the workspace header, and the Tools header the
          // fold is driven from.
          ).toBe(2);
          expect(
            await getSelection(app),
            "and left the selection exactly where it was",
          ).toEqual(["B", "C"]);

          await app.nativeKey("Escape");
          await wait(300);
          expect(
            await getSelection(app),
            "Escape clears a set none of whose rows are showing",
          ).toEqual([]);
          expect(
            await app.body("L").evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            ),
            "and spends the press there — the keyboard stays in the Cards card",
          ).toBe(true);

          // Unfold for the next case.
          await app.nativeKey(" ");
          await wait(300);
          expect(await rowCount(app)).toBeGreaterThan(1);

          // ---- Filter text is the first rung, the selection the second -----
          //
          // The table is the same table from every first-responder shape, and
          // this half drives the one the Cards card's own responder cannot answer:
          // a click on a Cards row FRONTS the card it names and takes the
          // keyboard out of the Cards card, so the press is answered by the deck
          // root's conditional entry. It used to clear the selection flatly,
          // skipping the query standing above it — two handlers, two different
          // answers to one key, which is what the user sees as "Escape does
          // something different every time".
          const clickedField = await clickFilterField(app);
          expect(clickedField, "found the Cards filter field").toBe(true);
          await app.nativeType("Card");
          await app.body("L").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(FILTER_INPUT)})?.value === "Card"`,
            { timeoutMs: 4_000 },
          );

          const clicked = await clickRowTitled(app, "Card A");
          expect(clicked, "found the row to click").toBe(true);
          await wait(400);
          expect(
            await getSelection(app),
            "the click names a card and fronts it",
          ).toEqual(["A"]);
          expect(
            await app.body("L").evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            ),
            "and takes the keyboard out of the Cards card with it",
          ).toBe(false);

          await app.nativeKey("Escape");
          await wait(350);
          expect(
            await filterQuery(app),
            "press 1 spends itself on the query — the most local thing standing",
          ).toBe("");
          expect(
            await getSelection(app),
            "and leaves the selection alone",
          ).toEqual(["A"]);

          await app.nativeKey("Escape");
          await wait(350);
          expect(
            await getSelection(app),
            "press 2 takes the selection",
          ).toEqual([]);

          await app.nativeKey("Escape");
          await wait(400);
          expect(
            await getSelection(app),
            "press 3 has nothing left to shrink, and hands back no selection",
          ).toEqual([]);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
