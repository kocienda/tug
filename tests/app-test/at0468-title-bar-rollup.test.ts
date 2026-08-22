/**
 * at0468-title-bar-rollup.test.ts — a card's verbs live behind one door.
 *
 * A pane's control cluster had grown to seven controls, and six of them were
 * verbs nobody was reaching for at any given moment. The rollup holds all of
 * them behind a single `⋯`: at rest a card shows its readouts, its two place
 * badges and its close box, and the verbs arrive the moment a hand does.
 *
 * What this file pins:
 *
 *   1. **At rest the verbs are unreachable, and they are still THERE.** The
 *      row is hidden by `opacity` + `pointer-events`, never by `display`, so
 *      every button keeps its box. That is what lets the reveal cost no layout
 *      pass — and it is why a geometry assertion about the cluster's order can
 *      be made without revealing anything.
 *   2. **The reveal moves nothing.** The row is an overlay anchored to the
 *      rollup's trailing edge, unfurling leftward across the bar's dead middle. The slot
 *      badge, the column badge and the close box hold their exact rects
 *      between the hidden and the shown state — the failure this catches is a
 *      row grown in the flex flow, which would widen the cluster and
 *      re-truncate the card's title on every pass of the pointer.
 *   3. **The row replaces the `⋯`, it does not sit beside it.** Both are
 *      anchored to the rollup's trailing edge, so the row unfurls leftward
 *      from the exact spot the mark occupies and the mark goes out as the row
 *      comes in — one control's worth of space, showing one thing at a time.
 *      The mark is a mark and not a button, deliberately: the row covers its
 *      own spot, so a button there could be pressed to open and never pressed
 *      again to close.
 *   4. **A menu opened from inside the row holds the row open.** A
 *      `TugPopupMenu` portals its rows outside the card, so the pointer
 *      travelling to one leaves the bar and ends the hover. Without the hold
 *      the row would collapse out from under a standing menu, leaving it
 *      anchored to something no longer painted.
 *   5. **The mark reports what it hides.** A card in bullseye wears `data-on`
 *      on its `⋯` — the one rolled-up control carrying a posture rather than
 *      an act, said from the row's resting state. Popping the target back out
 *      would tell the same truth by making the row's membership change under
 *      the hand; lighting the mark tells it with the geometry untouched.
 *   6. **Two ellipses, two jobs.** The rollup's mark is horizontal; the
 *      card's own assorted-commands menu is vertical. Two identical glyphs in
 *      one row meaning different things is the one thing this cluster cannot
 *      afford.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The settle window, with room for the imposition's landing tween. */
const AFTER_LAND_MS = 900;

const PANE_A = '.tug-pane[data-pane-id="p1"]';
const ROLLUP = '[data-testid="tug-pane-title-bar-rollup"]';
const ROLLUP_ROW = '[data-testid="tug-pane-title-bar-rollup-row"]';
const ROLLUP_MARK = '[data-testid="tug-pane-title-bar-rollup-mark"]';
const WIDTH_BUTTON = '[data-testid="tug-pane-title-bar-width-button"]';
const WIDTH_MENU = '[data-testid="tug-pane-title-bar-width-menu"]';
const BULLSEYE = '[data-testid="tug-pane-title-bar-bullseye-button"]';
const SLOT_BADGE = '[data-testid="card-slot-badge"]';
const COLUMN_BADGE = '[data-testid="tug-pane-title-bar-stack-badge"]';
const CLOSE_BUTTON = '[data-testid="tug-pane-close-button"]';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Two session cards, one per slot, under a two-up imposition.
 *
 * Session cards because they carry a masthead and the full set of title-bar
 * controls from a bare seed — no fixture repo, no published payload.
 */
function deckShape(): Record<string, unknown> {
  const ids = ["A", "B"];
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
    imposition: { kind: "two-up" },
    hasFocus: true,
  };
}

async function openDeck(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-pane-id]').length === 2`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** The anchored end's three rects, to the pixel. */
async function anchoredRects(app: App): Promise<Record<string, number[]>> {
  return app.evalJS<Record<string, number[]>>(
    `(function () {
      var pane = document.querySelector(${JSON.stringify(PANE_A)});
      function rect(sel) {
        var el = pane.querySelector(sel);
        if (el === null) return null;
        var r = el.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      }
      return {
        slot: rect(${JSON.stringify(SLOT_BADGE)}),
        column: rect(${JSON.stringify(COLUMN_BADGE)}),
        close: rect(${JSON.stringify(CLOSE_BUTTON)})
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0468 — the title bar's rollup", () => {
  test(
    "the verbs rest hidden, keep their boxes, and reveal without moving anything",
    async () => {
      const app = await launchTugApp({ testName: "at0468-title-bar-rollup" });
      try {
        await openDeck(app);

        // --- At rest: present, laid out, and not clickable. ---------------
        const atRest = await app.evalJS<{
          opacity: string;
          pointerEvents: string;
          display: string;
          buttons: number;
          boxed: number;
        }>(
          `(function () {
            var pane = document.querySelector(${JSON.stringify(PANE_A)});
            var row = pane.querySelector(${JSON.stringify(ROLLUP_ROW)});
            var cs = window.getComputedStyle(row);
            var buttons = Array.prototype.slice.call(row.querySelectorAll(".tug-button"));
            return {
              opacity: cs.opacity,
              pointerEvents: cs.pointerEvents,
              display: cs.display,
              buttons: buttons.length,
              // A button with a real box is one the reveal will not have to
              // lay out. \`display: none\` would report 0 here, which is the
              // implementation this claim rules out.
              boxed: buttons.filter(function (b) {
                var r = b.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              }).length
            };
          })()`,
        );
        note(
          `at rest: opacity=${atRest.opacity} pointer-events=${atRest.pointerEvents} ` +
            `display=${atRest.display} buttons=${atRest.buttons} boxed=${atRest.boxed}`,
        );
        expect(atRest.opacity, "the row is invisible at rest").toBe("0");
        expect(
          atRest.pointerEvents,
          "and unclickable — opacity alone would leave invisible buttons over the title",
        ).toBe("none");
        expect(
          atRest.display,
          "hidden by paint, not by layout: the boxes are what make the reveal free",
        ).not.toBe("none");
        expect(atRest.buttons, "the row holds the pane's verbs").toBeGreaterThan(0);
        expect(
          atRest.boxed,
          "every one of them keeps a real box while hidden",
        ).toBe(atRest.buttons);

        // --- The anchored end holds its pixel across the reveal. ----------
        const before = await anchoredRects(app);
        await app.revealPaneControls(PANE_A);
        const after = await anchoredRects(app);
        note(
          `anchored end before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
        );
        expect(before.slot, "the slot badge is on the cluster").not.toBe(null);
        expect(before.column, "and so is the column badge").not.toBe(null);
        expect(before.close, "and the close box").not.toBe(null);
        expect(
          after,
          "revealing the row moves nothing at the cluster's anchored end",
        ).toEqual(before);

        // Revealed, the row is reachable.
        const shown = await app.evalJS<{ opacity: string; pointerEvents: string }>(
          `(function () {
            var row = document.querySelector(${JSON.stringify(PANE_A)})
              .querySelector(${JSON.stringify(ROLLUP_ROW)});
            var cs = window.getComputedStyle(row);
            return { opacity: cs.opacity, pointerEvents: cs.pointerEvents };
          })()`,
        );
        expect(shown.opacity, "hovered, the row is painted").toBe("1");
        expect(shown.pointerEvents, "and takes the pointer").toBe("auto");

        // --- The row REPLACES the mark. -----------------------------------
        // Same trailing edge, so the row unfurls from the mark's own spot and
        // the mark goes out as it arrives. A row that grew BESIDE the mark
        // would leave both on screen and push the badges — the two claims
        // this pair rules out.
        const swap = await app.evalJS<{
          markOpacity: string;
          markRight: number;
          rowRight: number;
          markCentre: [number, number];
          lastCentre: [number, number];
          lastTestId: string | null;
        }>(
          `(function () {
            var pane = document.querySelector(${JSON.stringify(PANE_A)});
            var mark = pane.querySelector(${JSON.stringify(ROLLUP_MARK)});
            var row = pane.querySelector(${JSON.stringify(ROLLUP_ROW)});
            var buttons = row.querySelectorAll(".tug-button");
            var last = buttons[buttons.length - 1];
            function centre(el) {
              var r = el.getBoundingClientRect();
              return [r.left + r.width / 2, r.top + r.height / 2];
            }
            return {
              markOpacity: window.getComputedStyle(mark).opacity,
              markRight: mark.getBoundingClientRect().right,
              rowRight: row.getBoundingClientRect().right,
              markCentre: centre(mark),
              lastCentre: centre(last),
              lastTestId: last.getAttribute("data-testid")
            };
          })()`,
        );
        note(
          `swap: mark opacity=${swap.markOpacity} mark right=${swap.markRight.toFixed(1)} ` +
            `row right=${swap.rowRight.toFixed(1)} | mark centre ` +
            `${swap.markCentre.map((n) => n.toFixed(1)).join(",")} vs last ` +
            `${swap.lastCentre.map((n) => n.toFixed(1)).join(",")} (${swap.lastTestId})`,
        );
        expect(
          swap.markOpacity,
          "the mark is gone while the row stands — never both at once",
        ).toBe("0");
        expect(
          Math.abs(swap.rowRight - swap.markRight),
          "and the row ends where the mark ends: it took its place, it did not grow beside it",
        ).toBeLessThanOrEqual(0.51);

        // --- NO HOP. The centroids coincide. ------------------------------
        // The mark is three dots on a baseline and its middle dot is the
        // mark's centre; the row's last member is the bullseye target, whose
        // glyph is a dot in a ring. Land those two boxes on the same centre
        // and the swap reads as one glyph resolving into another in place.
        // Miss by two pixels — which is exactly what a trailing padding on the
        // row costs — and the eye reads a hop.
        //
        // The target must BE the last member for the claim to mean anything,
        // so that is asserted rather than assumed: any other control here
        // would put a hole, a bar or a folder where the dot was.
        expect(
          swap.lastTestId,
          "the bullseye target is the row's trailing member — the dot the mark becomes",
        ).toBe("tug-pane-title-bar-bullseye-button");
        expect(
          Math.abs(swap.lastCentre[0] - swap.markCentre[0]),
          "and its centre sits on the mark's centre horizontally — no hop",
        ).toBeLessThanOrEqual(0.51);
        expect(
          Math.abs(swap.lastCentre[1] - swap.markCentre[1]),
          "and vertically",
        ).toBeLessThanOrEqual(0.51);

        // --- Two ellipses, two jobs. --------------------------------------
        // The mark's glyph is lucide's horizontal ellipsis — one path
        // element, drawn as three dots on one baseline. The card's own
        // assorted-commands menu draws the vertical one. This reads the SVG's
        // circles rather than trusting the icon's name: a swap that put the
        // same glyph on both would pass a name check and fail the eye.
        const markAxis = await app.evalJS<string>(
          `(function () {
            var svg = document.querySelector(${JSON.stringify(PANE_A)})
              .querySelector(${JSON.stringify(ROLLUP_MARK)} + " svg");
            var dots = Array.prototype.slice.call(svg.querySelectorAll("circle"));
            if (dots.length < 3) return "not-three-dots:" + dots.length;
            var xs = dots.map(function (d) { return d.getAttribute("cx"); });
            var ys = dots.map(function (d) { return d.getAttribute("cy"); });
            var sameY = ys.every(function (y) { return y === ys[0]; });
            var sameX = xs.every(function (x) { return x === xs[0]; });
            return sameY ? "horizontal" : sameX ? "vertical" : "neither";
          })()`,
        );
        note("rollup mark glyph", markAxis);
        expect(
          markAxis,
          "the rollup mark is the HORIZONTAL ellipsis — more of this row",
        ).toBe("horizontal");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a standing menu holds the row open, and the handle reports what it hides",
    async () => {
      const app = await launchTugApp({ testName: "at0468-title-bar-rollup-held" });
      try {
        await openDeck(app);

        // --- A menu opened from inside the row holds it open. -------------
        // Hover the bar, press the width trigger, then walk the cursor OFF
        // the bar entirely — which is exactly what a hand reaching for a row
        // of the portalled menu does. Hover alone would have dropped the row
        // by now, and the trigger the menu hangs from with it.
        await app.revealPaneControls(PANE_A);
        await app.nativeClickAtElement(`${PANE_A} ${WIDTH_BUTTON}`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length > 0`,
          { timeoutMs: 5_000 },
        );
        await app.concealPaneControls(PANE_A);
        await wait(200);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(PANE_A)})
              .querySelector(${JSON.stringify(ROLLUP)}).hasAttribute("data-held")`,
          ),
          "the pointer has left the bar, and the standing menu holds the row",
        ).toBe(true);
        expect(
          await app.evalJS<string>(
            `window.getComputedStyle(
               document.querySelector(${JSON.stringify(PANE_A)})
                 .querySelector(${JSON.stringify(ROLLUP_ROW)})
             ).opacity`,
          ),
          "so the trigger the menu hangs from is still painted",
        ).toBe("1");

        // Dismissing the menu releases the row.
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length === 0`,
          { timeoutMs: 5_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PANE_A)})
            .querySelector(${JSON.stringify(ROLLUP)}).hasAttribute("data-held") === false`,
          { timeoutMs: 4_000 },
        );

        // --- The mark lights for a posture it is hiding. ------------------
        expect(
          await app.getElementAttribute(`${PANE_A} ${ROLLUP_MARK}`, "data-on"),
          "quiet while nothing behind it is engaged",
        ).toBe(null);

        await app.revealPaneControls(PANE_A);
        await app.nativeClickAtElement(`${PANE_A} ${BULLSEYE}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PANE_A)}).hasAttribute("data-bullseye")`,
          { timeoutMs: 8_000 },
        );
        expect(
          await app.getElementAttribute(`${PANE_A} ${ROLLUP_MARK}`, "data-on"),
          "a card in bullseye says so from the mark, with the target still hidden behind it",
        ).not.toBe(null);
        note(
          "bullseye reaches the mark",
          await app.evalJS<string>(
            `window.getComputedStyle(
               document.querySelector(${JSON.stringify(PANE_A)})
                 .querySelector(${JSON.stringify(ROLLUP_MARK)})
             ).color`,
          ),
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
