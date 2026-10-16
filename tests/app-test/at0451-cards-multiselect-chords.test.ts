/**
 * at0451-cards-multiselect-chords.test.ts — a layout verb acts on the selection, and
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
 * carries the first test, the layout chords through the selection ladder and
 * the batch; `at0451-cards-multiselect-list` carries the Cards list's key and
 * pointer model, and `-escape` the Escape table. The deck and the readers are
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
  FRAMES,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  deckShape,
  getSelection,
  seedCardsPreferred,
  setSelection,
  slotsByCard,
  wait,
  type CutRecord,
} from "./cards-multiselect-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0451 — the layout selection is what a layout verb acts on",
  () => {
    test(
      "the layout chords resolve through the selection, and move it as one",
      async () => {
        const app = await launchTugApp({ testName: "at0451-cards-multiselect" });
        try {
          await seedCardsPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          // ---- Rung 2: no selection, so the chord means the first responder ----
          //
          // The behavior that predates the selection, now the degenerate case.
          // It runs first so a later failure cannot be read as "the chord never
          // worked at all".
          await setSelection(app, []);
          await app.nativeKey("3", ["cmd"]);
          await wait(AFTER_LAND_MS);
          let slots = await slotsByCard(app);
          expect(slots.A, "⌘3 with no selection moves the first responder").toBe(
            2,
          );
          expect(slots.B, "and moves nothing else").toBe(1);

          // ---- Rung 1: a selection outranks the first responder ----
          //
          // A is still the first responder. The selection names B and C, and it
          // is B and C that move — the chord asks the resolver, not the deck.
          await setSelection(app, ["B", "C"]);
          expect(await getSelection(app)).toEqual(["B", "C"]);

          // Armed across the move: a per-card commit re-arms the settle window
          // mid-flight and the dropped frame reads as a jump. Zero is the proof
          // that both slot writes landed in one commit.
          await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
          await app.evalJS<unknown[]>(`window.__tug.takeCutRecords()`);

          await app.nativeKey("1", ["cmd"]);
          await wait(AFTER_LAND_MS);
          const cuts = await app.evalJS<CutRecord[]>(
            `window.__tug.takeCutRecords()`,
          );
          await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
          note(
            `two-card move cuts: ${cuts.length === 0 ? "none" : cuts.map((c) => `${c.paneId}:${c.kind}`).join(", ")}`,
          );
          expect(
            cuts.length,
            "a two-card slot move is one arrangement, so nothing cuts",
          ).toBe(0);

          slots = await slotsByCard(app);
          expect(slots.B, "the selection's first card took the slot").toBe(0);
          expect(slots.C, "and so did its second — one slot, both cards").toBe(0);
          expect(slots.A, "the unselected card kept its slot").toBe(2);

          // ---- The headline bug: the chord works with the keyboard in the Cards card ----
          //
          // Fronting the Cards card makes a RAIL the first responder. Read through the
          // first responder alone this refuses; read through the selection it
          // does what the user asked. The activation also proves the collapse
          // rule's limit: a rail taking focus is not the user leaving the
          // selection behind, so the set survives.
          await app.evalJS<null>(`(window.__tug.activateCard("L"), null)`);
          await wait(200);
          expect(
            await getSelection(app),
            "fronting a rail leaves the selection alone",
          ).toEqual(["B", "C"]);

          await app.nativeKey("2", ["cmd"]);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(
            slots.B,
            "⌘2 with the keyboard in the Cards card moves the selection",
          ).toBe(1);
          expect(slots.C, "both of it").toBe(1);

          // ---- A second verb, a different shape, the same ladder ----
          // The nudge is RELATIVE where ⌘n is absolute, so it exercises the
          // resolver's other half: the group either moves whole or refuses
          // whole. Still typed with the keyboard in the Cards card.
          await app.nativeKey("]", ["cmd", "alt", "shift"]);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.B, "⌥⇧⌘] carries the selection along the arrangement").toBe(2);
          expect(slots.C, "both of it").toBe(2);
          expect(slots.A, "and leaves the card outside it alone").toBe(2);

          // ---- Collapse: activating a CONTENT card outside the set ends it ----
          await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
          await wait(200);
          expect(
            await getSelection(app),
            "fronting an unselected content card collapses the set to it",
          ).toEqual(["A"]);

          // ---- Prune: a closed card cannot stay selected ----
          await setSelection(app, ["B", "C"]);
          await app.evalJS<null>(`(window.__tug.closePane("p3"), null)`);
          await wait(AFTER_LAND_MS);
          expect(
            await getSelection(app),
            "the closed card is pruned; the survivor stays",
          ).toEqual(["B"]);

          // The pruned-down selection is still what the next verb acts on.
          await app.nativeKey("3", ["cmd"]);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.B, "and the verb acts on what survived").toBe(2);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
