/**
 * at0462-card-slot-badge.test.ts — a card says which slot it stands in.
 *
 * Under a multi-slot imposition the deck has numbered places, and until the
 * badge the only surface that named them was the Lens: a reader looking at a
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
 *      guard the Lens's own slot picker applies.
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
 *      choosing one dispatches the same `assign-slot` the Lens dispatches, so
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
 * @covers tugdeck/src/components/tugways/card-slot-badge.tsx
 * @covers tugdeck/src/components/tugways/card-slot-badge.css
 * @covers tugdeck/src/components/tugways/tug-slot.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The settle window, with room for the imposition's landing tween. */
const AFTER_LAND_MS = 900;

const BADGE = '[data-testid="card-slot-badge"]';
const FRAME = '[data-slot="session-masthead"]';
const CLUSTER = '[data-testid="tug-pane-title-bar-controls"]';
const TRIGGER = '[data-testid="card-slot-badge-trigger"]';
const POPUP = '[data-testid="card-slot-badge-popup"]';
const PICKER = '[data-testid="card-slot-badge-picker"]';
const PICKER_CHIPS = `${PICKER} [data-slot="tug-slot"]`;
/** The first card's pane, so a click lands on ITS badge and not a neighbour's. */
const PANE_A = '.tug-pane[data-pane-id="p1"]';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * A deck of `count` session cards, one per slot, under the matching imposition.
 * Session cards because the badge lives in the masthead tier and a Session card
 * wears one from a bare seed — no fixture repo, no published payload.
 */
function deckShape(count: number): Record<string, unknown> {
  const ids = ["A", "B", "C", "D"].slice(0, count);
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "session",
      title: `Session ${id}`,
      closable: true,
    })),
    panes: ids.map((id, index) => ({
      id: `p${index + 1}`,
      position: { x: 40 + index * 40, y: 40 },
      size: { width: 675, height: 520 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["standard"],
      slot: index,
    })),
    activePaneId: "p1",
    imposition: {
      kind: ["one-up", "two-up", "three-up", "four-up"][count - 1],
    },
    hasFocus: true,
  };
}

/** Every badge on the deck, paired with the pane it stands in. */
async function readBadges(
  app: App,
): Promise<{ paneId: string; digit: string; state: string }[]> {
  return app.evalJS(
    `(function () {
      return Array.prototype.slice.call(
        document.querySelectorAll(${JSON.stringify(BADGE)})
      ).map(function (el) {
        var pane = el.closest("[data-pane-id]");
        var chip = el.querySelector('[data-slot="tug-slot"]');
        return {
          paneId: pane === null ? "" : pane.getAttribute("data-pane-id"),
          digit: chip === null ? "" : chip.textContent,
          state: chip === null ? "" : chip.getAttribute("data-state"),
        };
      });
    })()`,
  );
}

/**
 * Seed, bind, and wait for the deck to settle into the imposition.
 *
 * The binding is not decoration: an UNBOUND session card renders the project
 * picker and wears no masthead at all, so a badge that never mounted would read
 * as a badge that correctly declined. Every session card here is bound.
 */
async function openDeck(
  app: App,
  state: Record<string, unknown>,
  focusCardId: string,
): Promise<void> {
  await app.seedDeckState({ state, focusCardId });
  const sessionCards = (state.cards as Record<string, unknown>[])
    .filter((card) => card.componentId === "session")
    .map((card) => card.id as string);
  for (const cardId of sessionCards) {
    await app.bindSession(cardId, {
      tugSessionId: `at0462-${cardId}`,
      projectDir: "/tmp/at0462",
    });
  }
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(FRAME)}).length === ${sessionCards.length}`,
    { timeoutMs: 15_000 },
  );
  await wait(AFTER_LAND_MS);
}

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
        const ink = await app.evalJS<{
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
          await app.evalJS<boolean>(
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
        // The Lens picker's cut. Same job, same target — a reader who learns
        // the gesture on one surface meets the same size on the other.
        expect(room.width, "chips are the Lens picker's width").toBe(18);
        expect(room.height, "chips are the Lens picker's height").toBe(22);
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
