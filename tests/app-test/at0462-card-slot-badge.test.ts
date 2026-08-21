/**
 * at0462-card-slot-badge.test.ts — a card says which slot it stands in.
 *
 * Under a multi-slot imposition the deck has numbered places, and until the
 * badge the only surface that named them was the Lens: a reader looking at a
 * card had to look somewhere else to learn where it stood. The badge brings
 * that fact back onto the card — one numbered chip in the masthead frame's
 * leading column, in the space the three-level stack leaves empty beneath the
 * phase dot.
 *
 * What this file pins:
 *
 *   1. **The digit is the pane's place.** Under a three-up imposition each
 *      card's badge carries its own pane's `slot + 1`, and carries it
 *      `outlined` — a card at rest wears no accent.
 *   2. **No slot, no chip.** One-up has one place and therefore no position to
 *      report, and the badge is ABSENT rather than dimmed: dimming would say
 *      there is a position here and it is unimportant, which is false.
 *   3. **A sidebar is not a member of the chain.** A pane the deck treats as a
 *      sidebar gets no badge even when the state hands it a slot — the same
 *      guard the Lens's own slot picker applies.
 *   4. **It stands in the dead leading column.** The chip sits inside the
 *      masthead frame, below the phase dot, on the mark's own vertical, leading
 *      of the title, and centered in the tier's lower band — the region the
 *      stack indents away from. Measured against those elements rather than
 *      against numbers.
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
 * @covers tugdeck/src/components/tugways/masthead-frame.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The settle window, with room for the imposition's landing tween. */
const AFTER_LAND_MS = 900;

const BADGE = '[data-testid="card-slot-badge"]';
const FRAME = '[data-slot="session-masthead"]';
const DOT = ".tug-session-row-dot";
const DESCRIPTION = ".tug-session-row-description";
const TITLE = ".tug-session-row-name-line .tug-list-row-title";
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
    "each card's badge carries its own pane's slot, outlined",
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
          "a card at rest wears no accent — outlined, never filled",
        ).toEqual(["outlined", "outlined", "outlined"]);
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
        // The Lens's pane, stacked with a Session card so it wears a masthead,
        // and handed a slot outright. Both of the cheaper guards — no host, no
        // slot — are therefore satisfied, which leaves the sidebar guard as the
        // only thing that can keep the chip off it.
        const state = deckShape(2);
        (state.cards as Record<string, unknown>[]).push({
          id: "L",
          componentId: "lens",
          title: "Lens",
          closable: true,
        });
        (state.panes as Record<string, unknown>[])[1] = {
          id: "p2",
          position: { x: 900, y: 0 },
          size: { width: 420, height: 900 },
          cardIds: ["L", "B"],
          activeCardId: "B",
          title: "Lens",
          acceptsFamilies: [],
          slot: 1,
        };
        (state.imposition as Record<string, unknown>).sidebars = {
          lens: { side: "right" },
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
    "it stands in the column the three-level stack leaves empty",
    async () => {
      const app = await launchTugApp({ testName: "at0462-card-slot-badge" });
      try {
        await openDeck(app, deckShape(2), "A");

        const geometry = await app.evalJS<{
          insideFrame: boolean;
          chip: { left: number; top: number; right: number; bottom: number };
          dot: { bottom: number; axis: number };
          description: { top: number; inkLeft: number };
          title: { left: number };
          frameBottom: number;
        }>(
          `(function () {
            var frame = document.querySelector(${JSON.stringify(FRAME)});
            var badge = frame.querySelector(${JSON.stringify(BADGE)});
            // The CHIP, not its container: the container spans the tier's lower
            // region so it can center the chip in it, and a placement assertion
            // has to measure the thing that was placed.
            var chip = badge.querySelector('[data-slot="tug-slot"]');
            var dot = frame.querySelector(${JSON.stringify(DOT)});
            var desc = frame.querySelector(${JSON.stringify(DESCRIPTION)});
            var title = frame.querySelector(${JSON.stringify(TITLE)});
            var c = chip.getBoundingClientRect();
            var d = dot.getBoundingClientRect();
            var s = desc.getBoundingClientRect();
            var t = title.getBoundingClientRect();
            return {
              insideFrame: frame.contains(badge),
              chip: { left: c.left, top: c.top, right: c.right, bottom: c.bottom },
              // The dot BOX is the tier's leading column — the mark centres in
              // it and paints a disc half its width, and the badge centres in
              // the same column. Axes, therefore, not edges.
              dot: { bottom: d.bottom, axis: d.left + d.width / 2 },
              // The sub-lines take their indent as PADDING, so the box's own
              // left edge is the column edge and the ink starts inside it. The
              // dead column is bounded by the INK, so that is what is read.
              description: {
                top: s.top,
                inkLeft: s.left + parseFloat(getComputedStyle(desc).paddingInlineStart),
              },
              title: { left: t.left },
              frameBottom: frame.getBoundingClientRect().bottom,
            };
          })()`,
        );

        // The pair beneath the title: from the description's block start to the
        // tier's own end. The tape already reads centered on it, and the chip
        // takes the same rule rather than inventing a second answer.
        //
        // Within a couple of pixels, and the couple is accounted for: the chip
        // centers in the tier's LOWER BAND — everything below the first chrome
        // band — which begins a shade later than the description does, because
        // the phase dot's box is taller than the title's line and the name line
        // takes the taller of the two. Half that difference is the offset. The
        // tolerance is there to hold that one fact, not to hold a drift: a chip
        // that stopped being seated on the pair at all misses by tens.
        const pairCenter =
          (geometry.description.top + geometry.frameBottom) / 2;
        const chipCenter = (geometry.chip.top + geometry.chip.bottom) / 2;
        const chipCenterX = (geometry.chip.left + geometry.chip.right) / 2;

        note(
          `chip ${geometry.chip.left.toFixed(1)},${geometry.chip.top.toFixed(1)}` +
            `–${geometry.chip.right.toFixed(1)},${geometry.chip.bottom.toFixed(1)} ` +
            `dot axis=${geometry.dot.axis.toFixed(1)} bottom=${geometry.dot.bottom.toFixed(1)} ` +
            `desc ink=${geometry.description.inkLeft.toFixed(1)} top=${geometry.description.top.toFixed(1)} ` +
            `title left=${geometry.title.left.toFixed(1)} ` +
            `pairCenter=${pairCenter.toFixed(1)} chipCenter=${chipCenter.toFixed(1)}`,
        );

        expect(geometry.insideFrame, "mounted in the masthead frame").toBe(true);
        expect(
          geometry.chip.top,
          "below the phase dot — the column beneath it is the empty region",
        ).toBeGreaterThanOrEqual(geometry.dot.bottom);
        expect(
          geometry.chip.right,
          "and leading of the title, whose vertical the sub-lines indent to",
        ).toBeLessThanOrEqual(geometry.title.left);
        expect(
          geometry.chip.right,
          "so it clears the description's ink as well",
        ).toBeLessThanOrEqual(geometry.description.inkLeft);
        // The frame gives the tier ONE leading column, and the mark and the
        // chip both centre in it. An edge match would hold only while the two
        // were the same width, and a phase dot's ink is half this chip's —
        // which is exactly the coincidence at0464 watches across card types.
        expect(
          Math.abs(chipCenterX - geometry.dot.axis),
          "on the mark's own axis",
        ).toBeLessThanOrEqual(0.51);
        expect(
          Math.abs(chipCenter - pairCenter),
          "centered on the pair beneath the title, the tape's own rule",
        ).toBeLessThanOrEqual(2);
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
