/**
 * at0552-session-minimize-height.test.ts — the tier a minimized card stands at.
 *
 * ## What this gates
 *
 * `SESSION_MINIMIZED_HEIGHT_PX` is a declared number that has to equal a
 * measured one ([P04]). The three bands of the minimized form — the masthead
 * tier, the Z2 status row, and the Show Transcript bar — add up to whatever
 * the built app's cascade says they do, and the size policy pins the frame at
 * the constant. If the two disagree the card either clips its own bar or
 * carries dead air under it, and neither is visible in a unit test: the
 * constant would agree with itself.
 *
 * So this file measures the built app and asserts four things:
 *
 *   1. **The frame stands at the constant**, within a pixel.
 *   2. **It sits at the top of its run**, not floating mid-canvas — the
 *      `anchor: "start"` half of [P04]. About is centred because a dialog box
 *      is; a minimized card is a row in a wall and reads from the top.
 *   3. **Nothing is clipped**: the card body's `scrollHeight` equals its
 *      `clientHeight`, so the tier is not one pixel short of its own content.
 *   4. **No dead air**: the slack between the bar's bottom and the frame's is
 *      under 2px, so the tier is not generous either.
 *
 * And it `note()`s the measured height and how many minimized cards fit a
 * 900px run, which is the number [Q02] asked for and this is the only place
 * that can answer it.
 *
 * The seeded pane's stored height is the OPEN card's 620, which is what the
 * ceiling added to `frameHeight` has to override — nothing rewrites a stored
 * size on a minimize, and nothing should, because showing the card again must
 * put it back at the size it was. That number is what the imposer is handed as
 * the pinned height, so claim 1 is the clamp's test as well as the tier's.
 *
 * @covers tugdeck/src/card-registry.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-registration.tsx
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0552-session";
const PANE_ID = "p1";
const PANE = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const CARD = '[data-card-id="A"]';
const BAR = `${CARD} [data-slot="session-show-transcript"]`;

/**
 * `SESSION_MINIMIZED_HEIGHT_PX` from `session-card-registration.tsx`,
 * duplicated rather than imported: an app-test drives the BUILT app, and
 * importing the constant would assert the source against itself.
 */
const SESSION_MINIMIZED_HEIGHT_PX = 173;

/** The imposition's gaps (`lib/layout-imposer.ts`). */
const GAP = 5;
const GAP_BOTTOM = 32;

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

describe.skipIf(!SHOULD_RUN)("AT0552: the minimized card's tier", () => {
  test(
    "the frame stands at the tier, at the top of its run, fitting its content exactly",
    async () => {
      const app = await launchTugApp({ testName: "at0552-minimize-height" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-minimized"), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BAR)}) !== null`,
          { timeoutMs: 8000 },
        );
        // The bar arrives with the FORM; the fit is a claim about where the
        // form comes to REST, and between the two is the fold ([B06]). The
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
        }>(
          `(function () {
            var frame = document.querySelector(${JSON.stringify(PANE)});
            var body = document.querySelector(${JSON.stringify(CARD)} + " .session-card");
            var bar = document.querySelector(${JSON.stringify(BAR)});
            var fr = frame.getBoundingClientRect();
            return {
              frameTop: fr.top,
              frameHeight: fr.height,
              frameBottom: fr.bottom,
              bodyClient: body === null ? -1 : body.clientHeight,
              bodyScroll: body === null ? -1 : body.scrollHeight,
              barBottom: bar === null ? -1 : bar.getBoundingClientRect().bottom,
            };
          })()`,
        );

        note("minimized tier px", geo.frameHeight);
        // [Q02]'s number: how many minimized cards a 900px run holds, at the
        // imposer's 5px seam between members.
        note(
          "fit at 900px",
          Math.floor((900 + GAP) / (geo.frameHeight + GAP)),
        );
        note("body scroll vs client", `${geo.bodyScroll} / ${geo.bodyClient}`);
        note("slack under the bar px", geo.frameBottom - geo.barBottom);

        // 1. The declared tier is the measured one.
        expect(Math.abs(geo.frameHeight - SESSION_MINIMIZED_HEIGHT_PX)).toBeLessThanOrEqual(1);

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

        // 4. …and not generous either: the bar's bottom is the card's bottom.
        expect(geo.frameBottom - geo.barBottom).toBeLessThan(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
