/**
 * at0462-card-slot-badge-placement.test.ts — a card says which slot it stands in.
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
 * claims 3 and 4; `at0462-card-slot-badge-readout` carries 1 and 2, and
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
  CLUSTER,
  PANE_A,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  deckShape,
  openDeck,
  readBadges,
} from "./card-slot-badge-fixture";

describe.skipIf(!SHOULD_RUN)("at0462 — the card's slot badge", () => {
  test(
    "a sidebar pane gets no badge even when it holds a slot",
    async () => {
      const app = await launchTugApp({ testName: "at0462-card-slot-badge" });
      try {
        // A rail card's pane, stacked with a Session card so it wears a masthead,
        // and handed a slot outright. Both of the cheaper guards — no host, no
        // slot — are therefore satisfied, which leaves the sidebar guard as the
        // only thing that can keep the chip off it.
        const state = deckShape(2);
        (state.cards as Record<string, unknown>[]).push({
          id: "L",
          componentId: "layout",
          title: "Layout",
          closable: true,
        });
        (state.panes as Record<string, unknown>[])[1] = {
          id: "p2",
          position: { x: 900, y: 0 },
          size: { width: 420, height: 900 },
          cardIds: ["L", "B"],
          activeCardId: "B",
          title: "Layout",
          acceptsFamilies: [],
          slot: 1,
        };
        (state.imposition as Record<string, unknown>).sidebars = {
          layout: { side: "right" },
        };
        await openDeck(app, state, "A");

        const badges = await readBadges(app);
        note(`sidebar case: ${badges.map((b) => `${b.paneId}=${b.digit}`).join(" ")}`);
        expect(
          badges.map((b) => b.paneId),
          "the content pane reports its place; the sidebar reports nothing",
        ).toEqual(["p1"]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "it stands at the cluster's anchored end",
    async () => {
      const app = await launchTugApp({ testName: "at0462-card-slot-badge" });
      try {
        await openDeck(app, deckShape(2), "A");

        // The chip used to lead the row, on the reasoning that the head of the
        // cluster is the region that holds still. That was backwards. The
        // title bar is `space-between` with a `flex-shrink: 0` cluster, so the
        // cluster is anchored by its RIGHT edge — the head is precisely the
        // end that slides whenever one card carries one more verb than its
        // neighbour. A readout you are meant to take in at a glance cannot
        // live at the end that moves, so the chip now sits at the trailing
        // end: behind every verb in the rollup, ahead of only the column badge
        // that reads with it and the close box.
        const geometry = await app.evalJS<{
          insideCluster: boolean;
          chip: { left: number; right: number; axis: number };
          /** Controls the chip must TRAIL — everything inside the rollup. */
          behind: { right: number; axis: number }[];
          /** Controls the chip must LEAD — the column badge and the close box. */
          ahead: { left: number; axis: number }[];
        }>(
          `(function () {
            var pane = document.querySelector(${JSON.stringify(PANE_A)});
            var cluster = pane.querySelector(${JSON.stringify(CLUSTER)});
            var badge = cluster.querySelector(${JSON.stringify(BADGE)});
            // The CHIP, not its wrapper: the wrapper is an inline-flex box the
            // popover anchors to, and a placement assertion has to measure the
            // thing that was placed.
            var chip = badge.querySelector('[data-slot="tug-slot"]');
            var c = chip.getBoundingClientRect();
            var rollup = cluster.querySelector('[data-testid="tug-pane-title-bar-rollup"]');
            // The rollup's members are measured at REST, unrevealed. They are
            // an absolutely-positioned overlay rather than \`display: none\`,
            // precisely so they keep their boxes — which is what makes this a
            // geometry claim about the row's real order rather than a claim
            // about what happens to be painted.
            var behind = Array.prototype.slice.call(
              rollup === null ? [] : rollup.querySelectorAll(".tug-button")
            ).map(function (el) {
              var b = el.getBoundingClientRect();
              return { right: b.right, axis: b.top + b.height / 2 };
            });
            var ahead = Array.prototype.slice.call(
              cluster.querySelectorAll(
                '[data-testid="tug-pane-title-bar-stack-badge"], [data-testid="tug-pane-close-button"]'
              )
            ).map(function (el) {
              var b = el.getBoundingClientRect();
              return { left: b.left, axis: b.top + b.height / 2 };
            });
            return {
              insideCluster: cluster.contains(badge),
              chip: { left: c.left, right: c.right, axis: c.top + c.height / 2 },
              behind: behind,
              ahead: ahead
            };
          })()`,
        );

        note(
          `chip ${geometry.chip.left.toFixed(1)}–${geometry.chip.right.toFixed(1)} ` +
            `axis=${geometry.chip.axis.toFixed(1)} | ` +
            `behind ${geometry.behind
              .map((o) => `${o.right.toFixed(1)}@${o.axis.toFixed(1)}`)
              .join(" ")} | ` +
            `ahead ${geometry.ahead
              .map((o) => `${o.left.toFixed(1)}@${o.axis.toFixed(1)}`)
              .join(" ")}`,
        );

        expect(
          geometry.insideCluster,
          "mounted in the pane's control cluster, not in a masthead",
        ).toBe(true);
        expect(
          geometry.behind.length,
          "the rollup holds verbs for the chip to be measured against",
        ).toBeGreaterThan(0);
        expect(
          geometry.ahead.length,
          "the column badge and the close box stand behind the chip",
        ).toBe(2);

        for (const other of geometry.behind) {
          expect(
            geometry.chip.left,
            "trails every verb in the rollup",
          ).toBeGreaterThanOrEqual(other.right);
        }
        for (const other of geometry.ahead) {
          expect(
            geometry.chip.right,
            "and still leads the column badge and the close box",
          ).toBeLessThanOrEqual(other.left);
        }

        // And it stands ON the row rather than beside it. The cluster centres
        // its members in the first chrome band; a chip that took its own
        // vertical would read as a box dropped into the row.
        for (const other of [...geometry.behind, ...geometry.ahead]) {
          expect(
            Math.abs(geometry.chip.axis - other.axis),
            "on the row's own vertical",
          ).toBeLessThanOrEqual(0.51);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
