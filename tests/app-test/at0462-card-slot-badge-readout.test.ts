/**
 * at0462-card-slot-badge-readout.test.ts — a card says which slot it stands in.
 *
 * Under a multi-slot imposition the deck has numbered places, and until the
 * badge the only surface that named them was the Cards card: a reader looking at a
 * card had to look somewhere else to learn where it stood. The badge brings
 * that fact back onto the card — one numbered chip at the head of the pane's
 * control cluster, leading the stack badge beside it.
 *
 * What this file pins:
 *
 *   1. **The digit is the pane's place, in the row's own ink.** Under a
 *      three-up imposition each card's badge carries its own pane's
 *      `slot + 1`, and carries it in the pane title bar's icon colour with no
 *      fill — the ink of the glyphs it stands beside. Where a card is standing
 *      is the resting fact of the deck, and accent marks a live thing, so an
 *      accent here spent it on nothing and lit a chip on every masthead. The
 *      accent is not gone, it has moved to the hover knob, which is the one
 *      moment the chip is a control rather than a readout.
 *   2. **No slot, no chip.** One-up has one place and therefore no position to
 *      report, and the badge is ABSENT rather than dimmed: dimming would say
 *      there is a position here and it is unimportant, which is false.
 *   3. **A sidebar is not a member of the chain.** A pane the deck treats as a
 *      sidebar gets no badge even when the state hands it a slot — the same
 *      guard the Cards card's own slot picker applies.
 *   4. **It stands at the cluster's anchored end.** The chip trails every verb
 *      in the pane's rollup, leads the column badge and the close box, and
 *      sits on the row's own vertical. It led the row until that reasoning was
 *      checked against the layout: the title bar is `space-between` with a
 *      `flex-shrink: 0` cluster, so the cluster is anchored by its RIGHT edge
 *      and the head is the end that slides whenever one card carries one more
 *      verb than its neighbour. A readout meant to be taken in at a glance
 *      cannot live at the end that moves. Its first home was the masthead
 *      frame's leading column, which read well and was wrong about whose fact
 *      this is: a masthead is a card's own three lines and only two kinds of
 *      card wear one, so a badge seated there was a PANE fact drawn by a card,
 *      absent on every card that titles itself in one line.
 *   5. **The badge opens a picker that moves the card.** Pressing it opens a
 *      popup of every place in the arrangement with the card's own filled;
 *      choosing one dispatches the same `assign-slot` the Cards card dispatches, so
 *      the pane moves AND raises, and the badge repaints to the new place.
 *   6. **The picker's chips exist for the keyboard.** Every one of them
 *      reports itself to the focus engine with a key of its own — the direct
 *      guard for the trigger composing the child's ref rather than replacing
 *      it, since that ref is how the button reaches the engine at all.
 *
 *      What is NOT pinned here is the walk itself landing on a chip. Driving it
 *      needs the key view parked on a non-text stop first, and in this deck the
 *      ambient key view rests in the Session card's composer — a multi-line
 *      surface that owns Tab by construction, so every Tab is eaten before the
 *      walk sees one. Registration is what this harness can prove; the walk is
 *      a hand pass.
 *
 * Cut from `at0462-card-slot-badge` to fit the 20 s budget. This file carries
 * claims 1 and 2; `at0462-card-slot-badge-placement` carries 3 and 4, and
 * `-picker` 5 and 6. The deck and the readers are `card-slot-badge-fixture.ts`.
 *
 * @family at0462-card-slot-badge
 * @covers tugdeck/src/components/tugways/card-slot-badge.tsx
 * @covers tugdeck/src/components/tugways/card-slot-badge.css
 * @covers tugdeck/src/components/tugways/tug-slot.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  BADGE,
  FRAME,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  deckShape,
  openDeck,
  readBadges,
} from "./card-slot-badge-fixture";

describe.skipIf(!SHOULD_RUN)("at0462 — the card's slot badge", () => {
  test(
    "each card's badge carries its own pane's slot, in the row's own ink",
    async () => {
      const app = await launchTugApp({ testName: "at0462-card-slot-badge" });
      try {
        await openDeck(app, deckShape(3), "A");

        const badges = await readBadges(app);
        note(
          `three-up: ${badges
            .map((b) => `${b.paneId}=${b.digit}/${b.state}`)
            .join(" ")}`,
        );

        expect(badges.length, "one badge per imposed pane").toBe(3);
        expect(
          badges.map((b) => `${b.paneId}:${b.digit}`).sort(),
          "the digit is the pane's own slot, one-based",
        ).toEqual(["p1:1", "p2:2", "p3:3"]);
        expect(
          badges.map((b) => b.state),
          "a card at rest wears no accent at all — `rest`, never `outlined`",
        ).toEqual(["rest", "rest", "rest"]);

        // And `rest` here is not the primitive's default: the badge re-pairs
        // it through `TugSlot`'s knobs so the chip takes the pane title bar's
        // icon ink, which is what makes it read as a member of the row of
        // glyphs beside it rather than as a mark laid over them. Resolved
        // through the live document rather than compared to a literal, so the
        // assertion follows the theme instead of pinning one theme's numbers.
        // Card A draws its own chrome, so its badge and the glyphs beside it
        // are in its own page.
        const ink = await app.body("A").evalJS<{
          chipFg: string;
          chipBg: string;
          buttonFg: string;
          rowFg: string;
          accent: string;
          inTheFamily: boolean;
        }>(
          `(function () {
            var badge = document.querySelector(${JSON.stringify(BADGE)});
            var chip = badge.querySelector('[data-slot="tug-slot"]');
            var button = badge.querySelector(".card-slot-badge-button");
            var glyph = Array.prototype.filter.call(
              badge
                .closest("[data-pane-id]")
                .querySelectorAll(".tug-pane-title-bar-controls .tug-button"),
              function (el) { return !badge.contains(el); },
            )[0];
            var probe = document.createElement("span");
            probe.style.display = "none";
            badge.appendChild(probe);
            // The OUTLINED family's border, not its surface: an outlined
            // control has no fill, so its surface token is transparent and
            // comparing against it would compare nothing to nothing.
            probe.style.color = "var(--tug7-element-control-border-outlined-action-rest)";
            var accent = getComputedStyle(probe).color;
            probe.remove();
            return {
              chipFg: getComputedStyle(chip).color,
              chipBg: getComputedStyle(chip).backgroundColor,
              buttonFg: getComputedStyle(button).color,
              rowFg: getComputedStyle(glyph).color,
              accent: accent,
              // The row's colour rules — rest, hover, pressed, both focus
              // states — are all written against this selector. Matching it is
              // the whole of the claim: the badge is not painted LIKE its
              // neighbours, it is painted BY the same rules.
              inTheFamily: button.matches(
                ".tug-pane-title-bar-controls .tug-button",
              ),
            };
          })()`,
        );
        note(
          `badge ink: chip fg=${ink.chipFg} bg=${ink.chipBg} | ` +
            `badge button fg=${ink.buttonFg} | row glyph fg=${ink.rowFg} | ` +
            `accent=${ink.accent} | in the cluster's family=${ink.inTheFamily}`,
        );
        expect(
          ink.chipFg,
          "the resting chip takes the ink of the glyphs it stands with",
        ).toBe(ink.rowFg);
        expect(
          ink.chipBg,
          "and no fill — the title bar it stands on is the fill",
        ).toBe("rgba(0, 0, 0, 0)");
        expect(
          ink.chipFg,
          "which is emphatically not the accent it used to wear at rest",
        ).not.toBe(ink.accent);
        // The chip is the badge button's ICON, so its ink is `currentColor` —
        // the button's, therefore the row's. That is what retires the chip's
        // own state rules: it had a copy of the row's colours, kept in step by
        // hand, and the hover half of that copy named the outlined-action
        // family. One control in a row of six answered the pointer with an
        // accent rectangle while the rest answered with the row's hover box.
        expect(
          ink.chipFg,
          "because the chip's ink IS the button's, through currentColor",
        ).toBe(ink.buttonFg);
        // Asserted structurally rather than by hovering, because a background
        // app-test has no pointer to hover with — and structurally is the
        // stronger claim anyway: what carries every state now is membership.
        expect(
          ink.inTheFamily,
          "and the badge is one of the cluster's buttons, not an exception to them",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "one-up has no position to report, so it has no badge at all",
    async () => {
      const app = await launchTugApp({ testName: "at0462-card-slot-badge" });
      try {
        await openDeck(app, deckShape(1), "A");

        const badges = await readBadges(app);
        // Absent, not dimmed. A one-up pane does not stand in a slot, so a
        // chip here would state a fact that does not exist.
        expect(badges.length, "one place is no arrangement").toBe(0);
        // And the masthead it would have stood in is unquestionably there —
        // otherwise this case would pass for the wrong reason.
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(FRAME)}) !== null`,
          ),
          "the masthead is mounted; it is the badge that declined",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
