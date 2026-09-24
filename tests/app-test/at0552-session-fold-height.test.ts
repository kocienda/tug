/**
 * at0552-session-fold-height.test.ts — the tier a folded card stands at.
 *
 * ## What this gates
 *
 * `SESSION_FOLDED_HEIGHT_PX` is a declared number that has to equal a
 * measured one ([P04]). The two bands of the folded form — the masthead
 * tier and the Z2 status row, whose leading edge carries the card's one
 * fold control ([B03]) — add up to whatever the built app's cascade says
 * they do, and the size policy pins the frame at the constant. If the two
 * disagree the card either clips its own instruments or carries dead air
 * under them, and neither is visible in a unit test: the constant would agree
 * with itself.
 *
 * So this file measures the built app and asserts five things:
 *
 *   1. **The frame stands at the constant**, within a pixel.
 *   2. **It sits at the top of its run**, not floating mid-canvas — the
 *      `anchor: "start"` half of [P04]. About is centred because a dialog box
 *      is; a folded card is a row in a wall and reads from the top.
 *   3. **Nothing is clipped**: the card body's `scrollHeight` equals its
 *      `clientHeight`, so the tier is not one pixel short of its own content.
 *   4. **No dead air**: the slack between Z2's bottom and the frame's is
 *      under 2px, so the tier is not generous either. Z2 is the form's last
 *      band now that the transcript bar has retired into it, so it is
 *      the edge the frame has to meet.
 *   5. **Z2 is the same strip folded**: the status bar's width and the TIME
 *      cell's display are what they were open. A fold changes no width, so it
 *      may change nothing the row's `@container` rungs read — and 3 is not
 *      cosmetic precisely because it did: the overhang raised a scrollbar,
 *      which took 12px of inline size, which dropped a cell.
 *
 * And it `note()`s the measured height and how many folded cards fit a
 * 900px run, which is the number [Q02] asked for and this is the only place
 * that can answer it.
 *
 * The seeded pane's stored height is the OPEN card's 620, which is what the
 * ceiling added to `frameHeight` has to override — nothing rewrites a stored
 * size on a fold, and nothing should, because showing the card again must
 * put it back at the size it was. That number is what the imposer is handed as
 * the pinned height, so claim 1 is the clamp's test as well as the tier's.
 *
 * @covers tugdeck/src/card-registry.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-registration.tsx
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0552-session";
const PANE_ID = "p1";
const PANE = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const CARD = '[data-card-id="A"]';
/** The form's last band — and the seat of its one door ([B03]). */
const STATUS_BAR = `${CARD} [data-slot="session-card-status-bar"]`;
const CONTROL = `${STATUS_BAR} [data-slot="session-fold-control"] button`;

/**
 * `SESSION_FOLDED_HEIGHT_PX` from `session-card-registration.tsx`,
 * duplicated rather than imported: an app-test drives the BUILT app, and
 * importing the constant would assert the source against itself.
 *
 * It moved with the masthead tier to 158 for one arc, while the description
 * line took a LOOSE type setting, and came back with it. What this file
 * measures is unchanged either way: that Z2 neither overhangs the frame nor
 * leaves air under it.
 *
 * It went 144 → 145 when claim 3 caught the tier a pixel short of the strip's
 * built 53.8px. The overhang was not cosmetic: `.tug-pane-content` is
 * `overflow: auto`, so it raised a scrollbar, the scrollbar took 12px of the
 * pane's INLINE size, and Z2's `@container` rungs dropped the TIME cell
 * against a width nothing had changed — a folded card whose instruments
 * re-laid-out on every fold.
 */
const SESSION_FOLDED_HEIGHT_PX = 145;

/** The imposition's gaps (`lib/layout-imposer.ts`). */
const GAP = 5;
const GAP_BOTTOM = 32;

/**
 * Claim 5's reading: the box Z2's `@container` rungs are asked about, and
 * whether the first cell they can drop is standing. Taken open and folded, and
 * the two must agree — see the claim itself.
 */
const READ_STRIP = `(function () {
  var bar = document.querySelector(${JSON.stringify(STATUS_BAR)});
  var time = document.querySelector(
    ${JSON.stringify(CARD)} + ' .session-telemetry-status-cell[data-priority="time"]'
  );
  return {
    barWidth: bar === null ? -1 : bar.clientWidth,
    time: time === null ? "absent" : getComputedStyle(time).display,
  };
})()`;

/** One Session card alone in a one-up slot at the slim width. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 675, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
    ],
    activePaneId: PANE_ID,
    imposition: { kind: "one-up" },
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("AT0552: the folded card's tier", () => {
  test(
    "the frame stands at the tier, at the top of its run, fitting its content exactly",
    async () => {
      const app = await launchTugApp({ testName: "at0552-fold-height" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // Claim 5's first half, read while the card is still OPEN: the width
        // Z2's container queries are about to be asked again, and whether the
        // first of the cells they can drop is standing.
        const openStrip = await app.evalJS<{ barWidth: number; time: string }>(
          READ_STRIP,
        );

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).folded === true`,
          { timeoutMs: 8000 },
        );
        // The flag flips at once; the fit is a claim about where the form
        // comes to REST, and between the two is the fold ([B06]). The
        // card writes `data-fold="settled"` when the motion lands, so this is
        // the edge to measure from — reading before it measures a card
        // halfway through collapsing, whose content genuinely does overflow
        // the tier it is still on its way down to.
        await app.waitForCondition<boolean>(
          `(function () {
             var card = document.querySelector(${JSON.stringify(CARD)} + " .session-card");
             return card !== null && card.getAttribute("data-fold") === "settled";
           })()`,
          { timeoutMs: 8000 },
        );

        const geo = await app.evalJS<{
          frameTop: number;
          frameHeight: number;
          frameBottom: number;
          bodyClient: number;
          bodyScroll: number;
          barBottom: number;
          controlLabel: string;
        }>(
          `(function () {
            var frame = document.querySelector(${JSON.stringify(PANE)});
            var body = document.querySelector(${JSON.stringify(CARD)} + " .session-card");
            var bar = document.querySelector(${JSON.stringify(STATUS_BAR)});
            var control = document.querySelector(${JSON.stringify(CONTROL)});
            var fr = frame.getBoundingClientRect();
            return {
              frameTop: fr.top,
              frameHeight: fr.height,
              frameBottom: fr.bottom,
              bodyClient: body === null ? -1 : body.clientHeight,
              bodyScroll: body === null ? -1 : body.scrollHeight,
              barBottom: bar === null ? -1 : bar.getBoundingClientRect().bottom,
              controlLabel: control === null ? "" : (control.getAttribute("aria-label") || ""),
            };
          })()`,
        );

        note("folded tier px", geo.frameHeight);
        // [Q02]'s number: how many folded cards a 900px run holds, at the
        // imposer's 5px seam between members.
        note(
          "fit at 900px",
          Math.floor((900 + GAP) / (geo.frameHeight + GAP)),
        );
        note("body scroll vs client", `${geo.bodyScroll} / ${geo.bodyClient}`);
        note("slack under Z2 px", geo.frameBottom - geo.barBottom);

        // 1. The declared tier is the measured one.
        expect(Math.abs(geo.frameHeight - SESSION_FOLDED_HEIGHT_PX)).toBeLessThanOrEqual(1);

        // 2. Anchored to the run's START ([P04]). The run is the canvas less
        // its top gap and the deeper bottom one, read off the canvas the deck
        // actually painted; a CENTRED pin would put this frame hundreds of
        // pixels lower, so the claim is not a rounding one.
        const runTop = await app.evalJS<number>(
          `document
             .querySelector("[data-deck-canvas-background]")
             .getBoundingClientRect().top + ${GAP}`,
        );
        const runBottom = await app.evalJS<number>(
          `document
             .querySelector("[data-deck-canvas-background]")
             .getBoundingClientRect().bottom - ${GAP_BOTTOM}`,
        );
        note("run px", `${runTop} .. ${runBottom}`);
        expect(Math.abs(geo.frameTop - runTop)).toBeLessThan(1);
        // The run is genuinely taller than the tier, so "at the top" is a
        // choice the anchor made rather than the only place the frame fits.
        expect(runBottom - runTop).toBeGreaterThan(geo.frameHeight + 100);

        // 3. Nothing is clipped: the tier is not a pixel short of its bands.
        expect(geo.bodyScroll).toBeLessThanOrEqual(geo.bodyClient);

        // 4. …and not generous either: Z2's bottom is the card's bottom.
        expect(geo.frameBottom - geo.barBottom).toBeLessThan(2);

        // …and the door the tier no longer pays a band for is in the row it
        // came down to, wearing the verb the form is asking for ([B03]).
        expect(geo.controlLabel).toBe("Unfold");

        // 5. Z2 IS THE SAME STRIP FOLDED. Nothing about a fold changes the
        // card's width, so nothing about a fold may change the box Z2's
        // `@container` rungs are asked about, or which of its cells are
        // standing. This is the claim the tier's missing pixel broke: the
        // 0.8px overhang raised a scrollbar on `.tug-pane-content`, the
        // scrollbar took 12px of inline size, and the first rung dropped the
        // TIME cell — the instruments re-laying-out on a fold, which they
        // must never do.
        const foldedStrip = await app.evalJS<{ barWidth: number; time: string }>(
          READ_STRIP,
        );
        note("Z2 width open → folded", `${openStrip.barWidth} → ${foldedStrip.barWidth}`);
        note("TIME cell open → folded", `${openStrip.time} → ${foldedStrip.time}`);
        expect(foldedStrip.barWidth).toBe(openStrip.barWidth);
        expect(foldedStrip.time).toBe(openStrip.time);
        expect(foldedStrip.time).not.toBe("none");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
