/**
 * at0404-title-bar-tooltips-names.test.ts — every control at the trailing end of a
 * title bar says what it does before you press it.
 *
 * The cluster is a row of icons and a count: a stack badge, a bullseye target,
 * the active card's own verbs (a Text card contributes Reveal in Finder and
 * Card Settings…), a width control, and the close box. All but the count are
 * glyphs with no text anywhere near them, and the count is a bare number. Read
 * cold, none of them is self-evident — so each carries a tooltip, and two of
 * them carry the chord that does the same thing without the mouse.
 *
 * What is worth proving here:
 *
 *   1. Each control opens a bubble, and the bubble names an ACT. The phrase is
 *      the thing the press will do ("Center this card in bullseye"), not a
 *      restatement of the glyph ("Bullseye") — the glyph is already on screen
 *      and repeating it in prose tells the reader nothing they did not have.
 *
 *   2. The chord chip is READ, never authored. Bullseye and close both
 *      duplicate a keyboard shortcut, so both are `TugActionTooltip`s whose
 *      chip comes from the keymap registry through `commandShortcut`. The
 *      proof that it is read is a REBIND: the test writes an override the way
 *      any other process would, through the defaults path, and the chip says
 *      the new chord on its next hover with no reload. An authored "⌃⌘B"
 *      would pass every assertion above this one and fail this one. The width
 *      control gets NO chip: its chords are ⌃⌘1/2/3, one per preset, and the
 *      trigger is none of them.
 *
 * That the phrase turns with the state it describes, and that the hover
 * wrapper leaves the control working, is `at0404-title-bar-tooltips-state`;
 * the deck and the hover gestures are `title-bar-tooltips-fixture.ts`.
 *
 * Hover is synthesized the way at0334 does it — a `pointerenter` plus a
 * `pointermove` on the trigger — because a background app-test window runs no
 * rAF and nothing here may hang off an animation completing. The Text card
 * draws its pane's chrome in its own page, so every control, bubble and menu
 * is read there (`app.body("A")`), and the page's one pane needs no scope.
 * The bubble is portaled to the page's canvas overlay, so it is found
 * globally rather than under the pane.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/lib/pane-title-bar-items-store.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/tug-action-tooltip.tsx
 * @covers tugdeck/src/components/tugways/tug-tooltip.tsx
 * @covers tugdeck/src/components/tugways/tug-tooltip.css
 * @family at0404-title-bar-tooltips
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import {
  AFTER_LAND_MS,
  BADGE,
  BULLSEYE,
  CLOSE_BUTTON,
  FIXTURE_CONTENT,
  FOLD_BUTTON,
  MOVE_SPACE_BUTTON,
  OPTIONS_BUTTON,
  REVEAL_BUTTON,
  SHOULD_RUN,
  SLOT_BADGE,
  TEST_TIMEOUT_MS,
  WIDTH_BUTTON,
  cardChrome,
  chipText,
  deckShape,
  hoverPhrase,
  resetOverride,
  waitForChip,
  wait,
  writeOverride,
} from "./title-bar-tooltips-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0404 — the title bar's trailing controls name their acts",
  () => {
    test(
      "each control opens a bubble that names what pressing it does",
      async () => {
        const app = await launchTugApp({ testName: "at0404-title-bar-tooltips" });
        try {
          await app.seedDeckState({
            state: deckShape(),
            cardStates: {
              A: { content: { path: mkTextFixture("at0404-", FIXTURE_CONTENT).file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 2`,
            { timeoutMs: 5000 },
          );
          const chrome = await cardChrome(app);
          await wait(AFTER_LAND_MS);

          // --- The column badge: the count, then the acts, then the chord. -
          // The badge is small and its glyph is schematic, so a reader hovering
          // it is asking two questions at once — what am I looking at, and what
          // happens if I press. The phrase answers them in that order.
          //
          // Reading the count off the phrase is not redundant with the numeral
          // the badge draws: the numeral is one character behind a stack of
          // slices at 11px, and the bubble is where it gets said in words.
          expect(
            await hoverPhrase(chrome, BADGE),
            "the badge says how many cards share the column, then what pressing it does",
          ).toBe("2 cards in this column — press to show one, or split it");
          expect(
            await chipText(chrome, BADGE),
            "and names the chord that splits without the mouse",
          ).toBe("⌃⌘/");

          // --- The slot badge: where the card is, and that it can move. ----
          // The chip's numeral says where the card stands and nothing on it
          // says the number is changeable, which is the whole reason it has a
          // bubble. No chord: assigning a slot holds no binding of its own.
          expect(
            await hoverPhrase(chrome, SLOT_BADGE),
            "the chip says the position it holds, out of how many, and that pressing moves the card",
          // The seed names no imposition, so the deck stands in its default
          // three-up: the chip reports the arrangement it is actually in, not
          // the number of panes that happen to be on the deck.
          ).toBe("In position 1 of 3 — press to move this card");
          expect(
            await chipText(chrome, SLOT_BADGE),
            "slot assignment has no chord to advertise",
          ).toBeNull();

          // --- Bullseye: the act, plus the chord that does it. ------------
          expect(
            await hoverPhrase(chrome, BULLSEYE),
            "out of bullseye, the target offers the way in",
          ).toBe("Center this card in bullseye");
          expect(
            await chipText(chrome, BULLSEYE),
            "and names the chord that does the same thing without the mouse",
          ).toBe("⌃⌘B");

          // --- The card's own verbs: each button says its command. --------
          // Both phrases are READ from the command table, the same source the
          // File menu's items and any chord read, so a button and its command
          // cannot say different things.
          expect(
            await hoverPhrase(chrome, REVEAL_BUTTON),
            "the folder glyph names the act, from the registry",
          ).toBe("Reveal in Finder");
          expect(
            await hoverPhrase(chrome, OPTIONS_BUTTON),
            "the gear opens the card's own view settings",
          ).toBe("Card Settings…");

          // --- Fold: the act, plus ⌃⌘Y. ----------------------------------
          // The pane's verb, like Move beside it — every content card folds —
          // and the same command View ▸ Fold Card and the chord reach.
          expect(
            await hoverPhrase(chrome, FOLD_BUTTON),
            "the fold glyph names the act",
          ).toBe("Fold");
          expect(
            await chipText(chrome, FOLD_BUTTON),
            "and the chord that folds without the mouse",
          ).toBe("⌃⌘Y");

          // --- Move to Workspace: the act, and why it is dimmed. ----------
          // One workspace stands in this deck, so the trigger is disabled and
          // the phrase has to say so — which is the whole reason the bubble
          // hangs off the anchoring span rather than the button ([L31]): a
          // disabled button takes no pointer events, and the one state that
          // most needs explaining would explain nothing.
          expect(
            await hoverPhrase(chrome, MOVE_SPACE_BUTTON),
            "dimmed, it says what it would do and why it cannot",
          ).toBe("Move this card to another workspace — there is only one");
          expect(
            await chipText(chrome, MOVE_SPACE_BUTTON),
            "the move has no chord yet — drag is its fast path",
          ).toBeNull();

          // --- Width: the act, and the width it is holding now. -----------
          expect(
            await hoverPhrase(chrome, WIDTH_BUTTON),
            "a seeded pane carries no preset, so the phrase claims none",
          ).toBe("Set this card's width");
          expect(
            await chipText(chrome, WIDTH_BUTTON),
            "the width chords are one per preset; this trigger is none of them",
          ).toBeNull();

          // --- Close: the act, and ⌘W. ------------------------------------
          expect(
            await hoverPhrase(chrome, CLOSE_BUTTON),
            "one card in the pane, so the phrase is singular",
          ).toBe("Close this card");
          expect(await chipText(chrome, CLOSE_BUTTON), "with ⌘W beside it").toBe("⌘W");

          // --- The row's spine, right to left. ----------------------------
          // Bullseye, card width, Move to Workspace, Fold, Reveal in Finder —
          // the verbs more than one kind of card offers, at the end that holds
          // still. Only the leftmost positions belong to what a particular
          // card adds, which here is Card Settings.
          //
          // Move to Workspace is authored in the spine rather than published
          // through the items store, because a card of ANY kind moves and the
          // verb is therefore the pane's; it sits before card width so
          // bullseye and width keep the two spots already learned. Fold is the
          // pane's for the same reason and stands just before Move.
          //
          // The failure this catches is the one it was written for: a Text
          // card published Reveal then Settings and the Session masthead
          // portalled Reveal then its summary, so the same act sat at a
          // different offset on each kind and the hand had to learn two rows.
          // Ordering is enforced now — `SHARED_VERB_RANK` for the items store,
          // by hand in the masthead for its portal — and this is the assertion
          // that the two agree.
          expect(
            await chrome.evalJS<string[]>(
              `Array.from(
                 document.querySelectorAll(
                   ".tug-pane-title-bar-rollup-row .tug-button"
                 )
               ).map(function (el) { return el.getAttribute("aria-label"); })`,
            ),
            "the card's own verb leads, then the shared spine",
          ).toEqual([
            "Card Settings…",
            "Reveal in Finder",
            "Fold",
            "Move to workspace",
            "Card width",
            "Bullseye",
          ]);

          // --- The chips are READ, not authored. --------------------------
          // Rebind bullseye through the defaults path — the same route any
          // other process takes — and the bubble says the new chord on its
          // next hover. No reload: the override store notifies the registry
          // and `TugActionTooltip` is subscribed to it.
          await writeOverride(app, "toggle-bullseye", [
            {
              chord: { key: "KeyB", meta: true, alt: true },
              scope: { kind: "global" },
            },
          ]);
          expect(
            await hoverPhrase(chrome, BULLSEYE),
            "the phrase is untouched by a rebind",
          ).toBe("Center this card in bullseye");
          expect(
            await waitForChip(chrome, BULLSEYE, "⌥⌘B"),
            "but the chip followed the override, with nothing reloaded",
          ).toBe("⌥⌘B");

          // Put it back, so the chord this instance leaves behind is the one
          // that ships — and so the restore path is exercised too.
          await resetOverride(app, "toggle-bullseye");
          expect(await waitForChip(chrome, BULLSEYE, "⌃⌘B"), "reset restores the default").toBe(
            "⌃⌘B",
          );

        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
