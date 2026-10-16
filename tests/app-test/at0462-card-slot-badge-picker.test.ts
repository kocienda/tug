/**
 * at0462-card-slot-badge-picker.test.ts — a card says which slot it stands in.
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
 * claims 5 and 6; `at0462-card-slot-badge-readout` carries 1 and 2, and
 * `-placement` 3 and 4. The deck and the readers are
 * `card-slot-badge-fixture.ts`.
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
  AFTER_LAND_MS,
  PANE_A,
  PICKER,
  PICKER_CHIPS,
  POPUP,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TRIGGER,
  deckShape,
  openDeck,
  readBadges,
  wait,
} from "./card-slot-badge-fixture";

describe.skipIf(!SHOULD_RUN)("at0462 — the card's slot badge", () => {
  test(
    "the badge opens a picker, and a chip moves the card there",
    async () => {
      const app = await launchTugApp({ testName: "at0462-card-slot-badge" });
      try {
        await openDeck(app, deckShape(3), "A");

        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(POPUP)}).length`,
          ),
          "nothing is open until the badge is pressed",
        ).toBe(0);

        await app.nativeClickAtElement(`${PANE_A} ${TRIGGER}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 8_000 },
        );
        // The bubble enters on a scale keyframe, and a box read mid-flight
        // reports the interpolated pose — 17.33px for an 18px chip. Let it
        // land before measuring anything geometric.
        await wait(400);

        const chips = await app.evalJS<{ digits: string[]; states: string[] }>(
          `(function () {
            var chips = Array.prototype.slice.call(
              document.querySelectorAll(${JSON.stringify(PICKER_CHIPS)})
            );
            return {
              digits: chips.map(function (el) { return el.textContent; }),
              states: chips.map(function (el) { return el.getAttribute("data-state"); }),
            };
          })()`,
        );
        note(`picker: ${chips.digits.join("")} ${chips.states.join(",")}`);

        // The popup is a thing to PRESS, so it is neither cramped nor bitten
        // by the bubble it sits in. `TugPopover` pads nothing — its usual
        // consumers are lists that pad their own rows — so a run handed
        // straight to it sat flush against a border with an 8px radius, and
        // the corner chips were clipped by the curve.
        const room = await app.evalJS<{
          inset: number;
          width: number;
          height: number;
        }>(
          `(function () {
            var chips = Array.prototype.slice.call(
              document.querySelectorAll(${JSON.stringify(PICKER_CHIPS)})
            );
            // The bubble itself, reached from the run inside it: the popover
            // content is portalled and does not carry the picker's testid.
            var bubble = chips[0].closest(".tug-popover-content");
            var box = bubble.getBoundingClientRect();
            var first = chips[0].getBoundingClientRect();
            var last = chips[chips.length - 1].getBoundingClientRect();
            return {
              inset: Math.min(
                first.left - box.left,
                box.right - last.right,
                first.top - box.top,
                box.bottom - first.bottom
              ),
              width: first.width,
              height: first.height
            };
          })()`,
        );
        note(
          `popup room: inset ${room.inset} chip ${room.width}x${room.height}`,
        );
        // Enough to clear the bubble's own 8px corner radius on the chips that
        // stand in its corners.
        expect(
          room.inset,
          "the run is seated inside the bubble, not pressed against its border",
        ).toBeGreaterThanOrEqual(4);
        // The Cards picker's cut. Same job, same target — a reader who learns
        // the gesture on one surface meets the same size on the other.
        expect(room.width, "chips are the Cards picker's width").toBe(18);
        expect(room.height, "chips are the Cards picker's height").toBe(22);
        expect(chips.digits, "one chip per place in the arrangement").toEqual([
          "1",
          "2",
          "3",
        ]);
        // Accent lives here and nowhere else: a live selection inside an open
        // popup, not a card's resting state.
        expect(
          chips.states,
          "the card's own place is filled; the rest rest",
        ).toEqual(["filled", "rest", "rest"]);

        // Put it in the third place.
        await app.nativeClickAtElement(`${PICKER_CHIPS}:nth-of-type(3)`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) === null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const panes = await app.evalJS<{ id: string; slot: number | null }[]>(
          `window.tugdeck.diag.getDeckState().panes.map(function (p) {
             return { id: p.id, slot: p.slot === undefined ? null : p.slot };
           })`,
        );
        const badges = await readBadges(app);
        note(
          `after: ${panes.map((p) => `${p.id}@${p.slot}`).join(" ")} | ` +
            `badges ${badges.map((b) => `${b.paneId}=${b.digit}`).join(" ")}`,
        );

        expect(
          panes.find((p) => p.id === "p1")?.slot,
          "the store moved the card's pane to the third place",
        ).toBe(2);
        // `assign-slot` raises as well as assigns — a slot is a vertical stack,
        // and moving a card there means being able to see it.
        expect(
          panes[panes.length - 1]?.id,
          "and raised it to the top of the stacking order",
        ).toBe("p1");
        expect(
          badges.find((b) => b.paneId === "p1")?.digit,
          "the badge now reads the place the card is actually in",
        ).toBe("3");

        // --- The popup opens with the card's OWN chip under the chip. -----
        // Re-opened now that the card holds the THIRD place, which is the case
        // that means something: flush-left, the popup put slot 1 under the
        // trigger no matter which slot the card held, so the chip and the chip
        // meaning the same thing sat apart by a distance that varied with the
        // answer. Held at slot 0 the shift is only the popup's padding and a
        // regression would hide; held at slot 2 it is two chips and a gap.
        await app.nativeClickAtElement(`${PANE_A} ${TRIGGER}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 8_000 },
        );
        // The bubble enters on a scale keyframe; a box read mid-flight reports
        // the interpolated pose. Let it land before measuring.
        await wait(400);

        const aligned = await app.evalJS<{
          filledIndex: number;
          filledCentre: number;
          triggerCentre: number;
        }>(
          `(function () {
            var trigger = document.querySelector(
              ${JSON.stringify(PANE_A)} + " " + ${JSON.stringify(TRIGGER)}
            );
            var chips = Array.prototype.slice.call(
              document.querySelectorAll(${JSON.stringify(PICKER_CHIPS)})
            );
            var filledIndex = chips.findIndex(function (c) {
              return c.getAttribute("data-state") === "filled";
            });
            function centre(el) {
              var r = el.getBoundingClientRect();
              return r.left + r.width / 2;
            }
            return {
              filledIndex: filledIndex,
              filledCentre: filledIndex < 0 ? -1 : centre(chips[filledIndex]),
              triggerCentre: centre(trigger)
            };
          })()`,
        );
        note(
          `popup alignment: filled chip #${aligned.filledIndex} at ` +
            `${aligned.filledCentre.toFixed(1)} vs trigger ${aligned.triggerCentre.toFixed(1)}`,
        );
        expect(
          aligned.filledIndex,
          "the filled chip is the third — the place the card now holds",
        ).toBe(2);
        expect(
          Math.abs(aligned.filledCentre - aligned.triggerCentre),
          "and it opens directly under the chip that opened it",
        ).toBeLessThanOrEqual(0.51);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every chip in the popup is registered with the focus engine",
    async () => {
      const app = await launchTugApp({ testName: "at0462-card-slot-badge" });
      try {
        await openDeck(app, deckShape(3), "A");
        await app.nativeClickAtElement(`${PANE_A} ${TRIGGER}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 8_000 },
        );
        // The bubble enters on a scale keyframe, and a box read mid-flight
        // reports the interpolated pose — 17.33px for an 18px chip. Let it
        // land before measuring anything geometric.
        await wait(400);

        const registered = await app.evalJS<
          { focusable: boolean; key: string | null }[]
        >(
          `Array.prototype.map.call(
             document.querySelectorAll(${JSON.stringify(PICKER_CHIPS)}),
             function (el) {
               return {
                 focusable: el.hasAttribute("data-tug-focusable"),
                 key: el.getAttribute("data-tug-focus-key"),
               };
             })`,
        );
        note(
          `registered: ${registered
            .map((r) => `${r.focusable ? "y" : "n"}/${r.key ?? "-"}`)
            .join(" ")}`,
        );

        // This is the direct regression guard for the trigger's ref
        // composition. `TugPopoverTrigger` composes its capture ref onto the
        // child rather than assigning it, and `TugButton` reports its node to
        // the focus engine through the very ref a replacement would have
        // discarded — so a regression there costs the popup's chips their
        // registration, and nothing else in this file would notice: the popup
        // still opens, still clicks, and simply stops existing for the walk.
        expect(
          registered.every((r) => r.focusable),
          "each chip reports itself to the engine",
        ).toBe(true);
        expect(
          new Set(registered.map((r) => r.key)).size,
          "with a key of its own, so the walk can order them",
        ).toBe(registered.length);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
