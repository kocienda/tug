/**
 * AT0608: a Session card dragged into another pane keeps drawing its tape.
 *
 * ## The report this pins
 *
 * A tape that was running stops for good once its card is moved — dragged to
 * another pane, or otherwise reparented — and never resumes, however much the
 * session goes on to do. The old design had two mechanisms that could each
 * produce exactly that and neither of which could be told apart from the
 * other after the fact: an `IntersectionObserver` gate that parked the tape
 * when the box left the scroller it had registered against (and never
 * re-registered it against the new one), and a dormancy machine that retired
 * the scroll and then had nothing left to wake it.
 *
 * Both are gone. The instrument's tick is a function of the store's bins and
 * the clock and of nothing about where the element is in the tree, so a
 * reparent is a remount that draws again from the same window. This test is
 * what keeps it that way: it is a regression pin on a whole class, not on a
 * mechanism, because the mechanisms it was written against no longer exist.
 *
 * ## What it does
 *
 * Seeds two multi-tab panes, binds a session to the Session card in the
 * first, drives activity until its masthead tape is ticking, then drags the
 * card's tab into the second pane's tab bar — the same
 * `store.moveCardToPane` path at0006 exercises. After the move it drives
 * activity again and requires the instrument to be ticking on a sized canvas
 * with a value on it. A tape that froze on the reparent reads as `ticking:
 * false` here for as long as the timeout allows, which is the failure the
 * report describes.
 *
 * Then it REBINDS the same card to a second session and requires the tape to
 * draw that one. A rebind brings a fresh tape element — a marker stamped on
 * the old canvas does not survive it — so what this half pins is the claim
 * path end to end on a card that has already made one: the new element is
 * claimed, the subscription follows the new session, and the picture is that
 * session's work. The same reading answers it: ticking, on a sized canvas,
 * not at rest.
 *
 * @covers tugdeck/src/components/tugways/tug-sparkline.tsx
 * @covers tugdeck/src/lib/sparkline-host.ts
 * @covers tugdeck/src/lib/sparkline-instrument.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0608-session";
/** The second binding, for the claim a rebound card makes all over again. */
const SID2 = "at0608-session-two";
/**
 * The masthead's tape, addressed without naming a pane — the deck holds one
 * Session card, and following it across the move is the point. A pane-scoped
 * selector would stop matching at the moment the assertion starts to matter.
 */
const SPARK = `.session-masthead-row [data-slot="tug-sparkline"]`;

function tabSelectorFor(cardId: string): string {
  return `[data-testid="tug-tab-${cardId}"]`;
}

function tabBarSelectorFor(paneId: string): string {
  return `.tug-tab-bar[data-pane-id="${paneId}"]`;
}

/** Two multi-tab panes, so the drop resolves against a real tab bar. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
      { id: "C", componentId: "gallery-input", title: "Card C", closable: true },
      { id: "D", componentId: "gallery-input", title: "Card D", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 720, height: 520 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 800, y: 40 },
        size: { width: 720, height: 520 },
        cardIds: ["C", "D"],
        activeCardId: "C",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The instrument's own reading, plus whether it has a surface to draw on. */
interface Reading {
  state: { ticking: boolean; newest: number; atRest: boolean } | null;
  width: number;
  canvasW: number;
  canvasH: number;
}

async function readInstrument(app: App): Promise<Reading> {
  return app.evalJS<Reading>(
    `(function () {
       var box = document.querySelector(${JSON.stringify(SPARK)});
       var canvas = box === null ? null : box.querySelector("canvas");
       return {
         state: box === null
           ? null
           : window.__tug.sparklineInstrumentState(${JSON.stringify(SPARK)}),
         width: box === null ? -1 : box.getBoundingClientRect().width,
         canvasW: canvas === null ? -1 : canvas.width,
         canvasH: canvas === null ? -1 : canvas.height,
       };
     })()`,
  );
}

/** Drive real units through the store, the way a working session would. */
async function driveActivity(app: App, times: number, session = SID): Promise<void> {
  for (let i = 0; i < times; i++) {
    await app.evalJS<boolean>(
      `window.__tug.recordActivity(${JSON.stringify(session)}, "tools", 900)`,
    );
    await new Promise<void>((r) => setTimeout(r, 120));
  }
}

/**
 * Wait for the instrument to be drawing on a sized canvas. `atRest` is the
 * reading rather than `newest`: the newest plotted value sits two bins behind
 * the open one, so it can be zero in the instant a burst is sampled, while
 * `atRest` false means a value stands somewhere in the picture.
 */
async function waitForTicking(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var box = document.querySelector(${JSON.stringify(SPARK)});
       if (box === null) return false;
       var canvas = box.querySelector("canvas");
       if (canvas === null || canvas.width <= 0) return false;
       var s = window.__tug.sparklineInstrumentState(${JSON.stringify(SPARK)});
       return s !== null && s.ticking && !s.atRest;
     })()`,
    { timeoutMs: 15_000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0608: a reparented Session card's tape keeps drawing",
  () => {
    test(
      "dragging the card into another pane, then rebinding it, leaves the instrument ticking",
      async () => {
        const app = await launchTugApp({ testName: "at0608-sparkline-reparent" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { tugSessionId: SID });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SPARK)}) !== null`,
            { timeoutMs: 20_000 },
          );

          await driveActivity(app, 6);
          await waitForTicking(app);
          const before = await readInstrument(app);
          note("at0608 instrument before the move", JSON.stringify(before));

          // The move itself — the same path a user's tab drag commits.
          await app.nativeDragElement(tabSelectorFor("A"), {
            selector: tabBarSelectorFor("p2"),
          });
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(tabSelectorFor("A"))})
                ?.closest('.tug-pane[data-pane-id]')
                ?.getAttribute('data-pane-id')) === "p2"`,
            { timeoutMs: 15_000 },
          );

          // The card is under a different pane now. Drive the session on and
          // require the tape to be drawing it — this is the whole assertion.
          await driveActivity(app, 6);
          await waitForTicking(app);
          const after = await readInstrument(app);
          note("at0608 instrument after the move", JSON.stringify(after));

          expect(after.width, "the tape is still mounted and sized").toBeGreaterThan(8);
          expect(after.canvasW, "the canvas has a backing store").toBeGreaterThan(0);
          expect(after.canvasH, "the canvas has a backing store").toBeGreaterThan(0);
          expect(after.state, "the instrument answers for itself").not.toBeNull();
          expect(after.state!.ticking, "the reparented tape is drawing").toBe(true);
          expect(
            after.state!.atRest,
            "and it is drawing the session's activity",
          ).toBe(false);

          // The rebind: a second session on a card that has already claimed
          // once, so the whole claim path runs again on a live deck.
          await app.bindSession("A", { tugSessionId: SID2 });
          await driveActivity(app, 6, SID2);
          await waitForTicking(app);
          const rebound = await readInstrument(app);
          note("at0608 instrument after the rebind", JSON.stringify(rebound));

          expect(rebound.width, "the rebound card has a sized tape").toBeGreaterThan(8);
          expect(rebound.canvasW, "on a canvas with a backing store").toBeGreaterThan(0);
          expect(rebound.state, "the instrument answers for itself").not.toBeNull();
          expect(rebound.state!.ticking, "the rebound tape is drawing").toBe(true);
          expect(
            rebound.state!.atRest,
            "and it is drawing the new session's activity",
          ).toBe(false);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0608] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
