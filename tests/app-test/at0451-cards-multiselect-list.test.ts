/**
 * at0451-cards-multiselect-list.test.ts — a layout verb acts on the selection, and
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
 * carries the second test, the Cards list's key and pointer model;
 * `at0451-cards-multiselect-chords` carries the layout chords and the batch,
 * and `-escape` the Escape table. The deck and the readers are
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

import { launchTugApp, note } from "./_harness";
import {
  AFTER_LAND_MS,
  CURSOR_ROW,
  FRAMES,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  clickRowTitled,
  cursorTitle,
  deckShape,
  focusCardsList,
  frontCard,
  getSelection,
  seedCardsPreferred,
  setSelection,
  slotsByCard,
  walkCursorTo,
  wait,
} from "./cards-multiselect-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0451 — the layout selection is what a layout verb acts on",
  () => {
    test(
      "the Cards list builds the selection from the keyboard and the mouse",
      async () => {
        const app = await launchTugApp({ testName: "at0451-cards-gestures" });
        try {
          await seedCardsPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          await setSelection(app, []);

          // ⌘L seeds the keyboard onto the Cards list, which is where every
          // gesture below is typed. From here the first responder is the CARDS
          // CARD — a rail — for the whole test, so nothing that follows could be
          // reaching the deck through the old first-responder reading.
          await focusCardsList(app);
          await walkCursorTo(app, "Card B");
          note(`cursor parked on: ${JSON.stringify(await cursorTitle(app))}`);

          // ---- The cursor is a statement, even with nothing selected -------
          //
          // The row under the caret is plainly what the user means. Requiring a
          // Space first would make the keyboard the one way of working that has
          // to announce itself twice — and reading the first responder instead
          // would find the Cards card and refuse.
          expect(await getSelection(app)).toEqual([]);
          await app.nativeKey("3", ["cmd"]);
          await wait(AFTER_LAND_MS);
          let slots = await slotsByCard(app);
          expect(slots.B, "⌘3 acts on the row the caret is on").toBe(2);
          expect(slots.A, "and on nothing else").toBe(0);
          expect(slots.C).toBe(2);

          // ---- Space selects without opening; Return opens ------------------
          //
          // The two keys are different acts. A list where both front the card
          // has no way to say "this row is what I mean" without also opening
          // it, which is the whole purpose of a selection.
          //
          // Driven on a row that is NOT already fronted, because assigning a
          // slot raises the card it moved — the ⌘3 above left B in front, and
          // asserting "Space did not front" against a card already in front
          // would pass whatever Space did.
          await focusCardsList(app);
          await setSelection(app, []);
          await walkCursorTo(app, "Card A");
          const frontBeforeSpace = await frontCard(app);
          expect(frontBeforeSpace).not.toBe("A");

          await app.nativeKey(" ");
          await wait(300);
          expect(
            await getSelection(app),
            "Space commits the caret row into the selection",
          ).toEqual(["A"]);
          expect(
            await frontCard(app),
            "and fronts nothing — Space names a row, it does not open it",
          ).toBe(frontBeforeSpace);

          await app.nativeKey("Enter");
          await wait(400);
          expect(await frontCard(app), "Return is the key that opens").toBe("A");

          // ---- Space toggles, so the keyboard can build a set --------------
          //
          // ⌘+arrow walks the caret past rows without disturbing the selection;
          // Space picks up the ones the walk stops on. Replace-on-Space would
          // make the pair useless and leave no keyboard route to a
          // discontiguous set at all.
          await focusCardsList(app);
          await setSelection(app, []);
          await walkCursorTo(app, "Card A");
          await app.nativeKey(" ");
          await wait(200);
          expect(await getSelection(app)).toEqual(["A"]);

          await app.nativeKey("ArrowDown", ["cmd"]);
          await wait(200);
          expect(
            await getSelection(app),
            "⌘+arrow walks over the selection rather than through it",
          ).toEqual(["A"]);
          expect(await cursorTitle(app)).toContain("Card B");

          await app.nativeKey("ArrowDown", ["cmd"]);
          await wait(200);
          await app.nativeKey(" ");
          await wait(200);
          expect(
            await getSelection(app),
            "Space adds the walked-to row instead of replacing the set",
          ).toEqual(["A", "C"]);

          await app.nativeKey(" ");
          await wait(200);
          expect(
            await getSelection(app),
            "and takes it back out again — Space is a toggle",
          ).toEqual(["A"]);

          // ---- The first modifier-arrow takes the row it starts on ---------
          //
          // Extension names where the caret LANDS, so without a seed the row
          // the user was looking at when they pressed ⇧↓ is the one row the
          // walk could never select.
          await setSelection(app, []);
          await walkCursorTo(app, "Card A");

          // ...and the modifier ALONE is not the gesture. A bare Shift keydown
          // carries `shiftKey: true` with no movement behind it, so a seed keyed
          // off the flag would select a row for resting a finger on the key.
          // `withModifiersHeld` posts the real physical press; `data-mods` going
          // to "shift" is the proof it reached JS, which is what keeps the
          // assertion under it from passing vacuously.
          // The press reaches the page holding the keyboard: the Cards card's
          // body, where the list reads it.
          await app.withModifiersHeld(["shift"], async () => {
            await app.body("L").waitForCondition<boolean>(
              `document.documentElement.getAttribute("data-mods") === "shift"`,
              { timeoutMs: 4_000 },
            );
            expect(
              await getSelection(app),
              "holding Shift is not a selection gesture",
            ).toEqual([]);
          });

          // The first ⇧↓ spends itself on the seed: it takes the row the caret
          // is standing on and leaves the caret there. Seeding AND moving would
          // select two rows on the first press, which is never what it means.
          await app.nativeKey("ArrowDown", ["shift"]);
          await wait(200);
          expect(
            await getSelection(app),
            "the first ⇧↓ takes the origin row",
          ).toEqual(["A"]);
          expect(
            await cursorTitle(app),
            "and does not move the caret off it",
          ).toContain("Card A");

          await app.nativeKey("ArrowDown", ["shift"]);
          await wait(200);
          expect(
            await getSelection(app),
            "the second ⇧↓ is the ordinary extend",
          ).toEqual(["A", "B"]);

          // ---- Escape drops the selection before it does anything else -----
          //
          // A selection is a standing statement about what the next verb acts
          // on, so the user needs a way to take it back that is not "select
          // something else". The Cards card keeps the keyboard: one press, one job.
          //
          // The list CAPTURES the press while a set stands, which is what makes
          // this the same answer every time. Every rung of the engine's Escape
          // ladder outranks the responder chain, so an uncaptured Escape typed
          // here would have gone to "leave the keyboard mode" instead — and the
          // same selection built with the mouse would have cleared. The case
          // below repeats the press on a mouse-made set for exactly that reason.
          await app.nativeKey("Escape");
          await wait(300);
          expect(
            await getSelection(app),
            "Escape clears the selection",
          ).toEqual([]);
          expect(
            await app.body("L").evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            ),
            "and stops there — it does not also throw the keyboard out of the Cards card",
          ).toBe(true);

          // ---- A plain click MOVES the selection ---------------------------
          //
          // Not "activate the clicked row and leave the selection behind": a
          // click is the plainest way there is to say which row you mean, and a
          // selection that stayed put after one would be describing a row the
          // user has visibly moved on from.
          await setSelection(app, ["C"]);
          const clicked = await clickRowTitled(app, "Card A");
          expect(clicked, "found the row to click").toBe(true);
          await wait(400);
          expect(
            await getSelection(app),
            "the click collapses the selection onto the row it landed on",
          ).toEqual(["A"]);

          // ---- ...and Escape clears THAT set too ---------------------------
          //
          // Same press, same answer, on a set the mouse made rather than the
          // keyboard. This is the half that used to fail: how a selection was
          // built decided which rung of the Escape ladder the press reached,
          // and the user has no way to know which state they are in.
          // The click FRONTED the card it named, which took the keyboard out of
          // the Cards card: the Cards list is not holding it, and the Cards card's own
          // responder is off the chain. So this press can only be answered by
          // the root — which is the point. A selection is deck state, and the
          // key that takes it back cannot depend on where the keyboard drifted.
          expect(
            await app.body("L").evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            ),
            "the click left the Cards card without the keyboard",
          ).toBe(false);
          await app.nativeKey("Escape");
          await wait(300);
          expect(
            await getSelection(app),
            "Escape clears a mouse-made selection the same way",
          ).toEqual([]);

          // ---- Escape only ever shrinks state -----------------------------
          //
          // Repeating the press must walk one way: selection, then focus, then
          // nothing. It used not to. Escape with an empty set focuses OUT of
          // the Cards card, which re-activates the card that was fronted before ⌘L —
          // and the deck attacher reads any content-card activation as "the
          // user moved on" and collapses the selection onto it. So the
          // focus-out MADE a selection, and the next press cleared the one the
          // press before it had created: press, clear, press, select, forever,
          // with the user watching a set they never asked for reappear.
          //
          // A restore is not a user activation. Four presses, and the set is
          // empty from the first one onward.
          await focusCardsList(app);
          await walkCursorTo(app, "Card A");
          await app.nativeKey(" ");
          await wait(200);
          expect(
            await getSelection(app),
            "a set to walk the presses against",
          ).toEqual(["A"]);

          for (let press = 1; press <= 4; press += 1) {
            await app.nativeKey("Escape");
            await wait(300);
            expect(
              await getSelection(app),
              `Escape #${press} leaves the selection empty`,
            ).toEqual([]);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
