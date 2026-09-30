/**
 * at0650-picker-present-first-responder.test.ts — a picker deferred past the
 * paint presents only if its card is STILL the card the user is looking at.
 *
 * ## What this gates
 *
 * An unbound Session card mounts its picker when it becomes first responder,
 * and since [D204] that present takes the after-paint door rather than the
 * activation's own stack: `showSheet` is a React state write, and a picker
 * mounted inside `transferFocusForActivation`'s `flushSync` pays for its whole
 * panel inside the click task — on the four-up bench that was the flush's
 * 44 ms, the whole of the lead between the gesture and the slide's first
 * frame.
 *
 * The deferral inserts a painted frame between the decision and the act, and
 * every precondition the stack would have read is a fact about the frame the
 * gesture fired in. First responder is one of those facts. Two activations
 * inside one task — a chain fan-out, a restore that raises two cards, a click
 * that lands while a keyboard activation is in flight — leave two presents
 * queued at the door, and the first of them runs onto a card that stopped
 * being first responder before the callback ever fired. The sheet lands on a
 * card the user is no longer looking at, which is the exact symptom the
 * present was gated on first responder to avoid in the first place.
 *
 * So the deferred present re-reads first responder at the door ([B06]),
 * alongside the latch, the fold, and the host-live ref it already re-read.
 *
 * ## The gesture and the reading
 *
 * Three panes: a Text card at rest holding first responder, and two unbound
 * Session cards that have therefore never activated and never presented. One
 * task activates X and then Y. Both presents are deferred; only Y's card is
 * first responder when they run.
 *
 * The reading is the pane frame each sheet portals into. A sheet is a child
 * of its card's pane frame (`TugPaneFrameContext`), so `.tug-pane[data-pane-id]
 * .tug-sheet-content` says exactly whose picker is up, with no instrument
 * added for the test.
 *
 * Two guards keep the reading from being free: X and Y start with no sheet at
 * all (otherwise the claim is about a sheet nobody presented), and Y really is
 * first responder afterwards (otherwise neither activation happened and zero
 * sheets is the trivially right answer).
 *
 * ## What the pre-fix reading was
 *
 * Falsified with the first-responder line alone reverted under a `file probe`:
 * red, and on the **rest guard** rather than on the claim — `p-x 0 / p-y 1`
 * before any gesture. The restore raises Y past R on its way to seating first
 * responder, so a present is already queued at the after-paint door at launch,
 * and with nothing re-reading first responder it lands on Y while R holds the
 * deck. The defect is therefore not confined to a two-activation task: it is
 * reachable on a cold start, which is the shape a user would report as "a
 * picker opened on a card I wasn't using". The guard closes both, and the rest
 * guard reads 0 / 0 with it in place.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** Long enough for an after-paint present to land and for a settle to end. */
const AFTER_GESTURE_MS = 1_200;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * One workspace, three panes. `R` is a Text card and holds first responder
 * from launch, so neither Session card has ever activated — which is what
 * leaves both pickers unpresented and both latches unset at the gesture.
 */
const THREE_PANE_BLOB = {
  version: 5,
  activeSpaceId: "at0650-one",
  spaces: [
    {
      id: "at0650-one",
      name: "One",
      deck: {
        cards: [
          { id: "R", componentId: "text", title: "File", closable: true },
          { id: "X", componentId: "session", title: "X", closable: true },
          { id: "Y", componentId: "session", title: "Y", closable: true },
        ],
        panes: [
          {
            id: "p-r",
            position: { x: 40, y: 60 },
            size: { width: 420, height: 460 },
            cardIds: ["R"],
            activeCardId: "R",
            title: "",
          },
          {
            id: "p-x",
            position: { x: 480, y: 60 },
            size: { width: 420, height: 460 },
            cardIds: ["X"],
            activeCardId: "X",
            title: "",
            acceptsFamilies: ["maker"],
          },
          {
            id: "p-y",
            position: { x: 920, y: 60 },
            size: { width: 420, height: 460 },
            cardIds: ["Y"],
            activeCardId: "Y",
            title: "",
            acceptsFamilies: ["maker"],
          },
        ],
        activePaneId: "p-r",
        imposition: { kind: "three-up", sidebars: {} },
        hasFocus: true,
      },
    },
  ],
};

/** How many sheet panels stand inside the named pane's frame. */
const sheetsIn = (app: App, paneId: string): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(` +
      `'.tug-pane[data-pane-id="${paneId}"] .tug-sheet-content'` +
      `).length`,
  );

/** The card the deck calls first responder, by its own derivation. */
const firstResponder = (app: App): Promise<string | null> =>
  app.evalJS<string | null>(
    `(function () {
       var d = window.tugdeck.diag.getDeckState();
       var pane = d.panes.find(function (p) { return p.id === d.activePaneId; });
       return pane === undefined ? null : (pane.activeCardId || null);
     })()`,
  );

async function launch(): Promise<{ app: App; tugbankPath: string }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.deck.layout",
    "layout",
    "json",
    JSON.stringify(THREE_PANE_BLOB),
  );
  const app = await launchTugApp({
    testName: "at0650-picker-present-first-responder",
    env: { TUGBANK_PATH: tugbankPath },
    skipAccessibilityPreflight: true,
    persistInTestMode: true,
    restoreInTestMode: true,
  });
  await app.waitForCondition<boolean>(
    `typeof window.tugdeck !== "undefined" && ` +
      `window.tugdeck.diag.getDeckState().panes.length === 3`,
    { timeoutMs: 30_000 },
  );
  await wait(AFTER_GESTURE_MS);
  return { app, tugbankPath };
}

describe.skipIf(!SHOULD_RUN)(
  "at0650 — the deferred picker present re-checks first responder",
  () => {
    test(
      "two activations in one task present one picker, on the card that ends up first responder",
      async () => {
        const { app, tugbankPath } = await launch();
        try {
          const restingFr = await firstResponder(app);
          const sheetsXBefore = await sheetsIn(app, "p-x");
          const sheetsYBefore = await sheetsIn(app, "p-y");
          note(
            `at0650 at rest: first responder ${restingFr}, sheets ` +
              `p-x ${sheetsXBefore} / p-y ${sheetsYBefore}`,
          );

          expect(
            sheetsXBefore + sheetsYBefore,
            `at rest neither Session card may have presented — p-x ` +
              `${sheetsXBefore}, p-y ${sheetsYBefore}. A picker already up ` +
              `before the gesture makes the claim below about a sheet this ` +
              `test never caused`,
          ).toBe(0);

          // Both activations inside ONE task, so both presents are queued at
          // the after-paint door together and neither has painted yet.
          await app.evalJS<null>(
            `(window.__tug.activateCard("X"), ` +
              `window.__tug.activateCard("Y"), null)`,
          );
          await wait(AFTER_GESTURE_MS);

          const frAfter = await firstResponder(app);
          const sheetsX = await sheetsIn(app, "p-x");
          const sheetsY = await sheetsIn(app, "p-y");
          note(
            `at0650 after X-then-Y: first responder ${frAfter}, sheets ` +
              `p-x ${sheetsX} / p-y ${sheetsY}`,
          );

          expect(
            frAfter,
            `the gesture really happened — first responder went ` +
              `${restingFr} -> ${frAfter}. Without Y ending up first ` +
              `responder the two activations did not both run and "no sheet ` +
              `on X" is true for the wrong reason`,
          ).toBe("Y");

          expect(
            sheetsX,
            `X stopped being first responder inside the same task that ` +
              `activated it, so its deferred picker must not present — read ` +
              `${sheetsX} sheet(s) in p-x. A sheet here is the [B06] defect: ` +
              `a panel mounted a painted frame later on a card the user is ` +
              `no longer looking at`,
          ).toBe(0);

          expect(
            sheetsY,
            `Y is first responder, so its deferred picker must present — ` +
              `read ${sheetsY} sheet(s) in p-y. Zero here means the guard ` +
              `swallowed the present it was supposed to let through`,
          ).toBe(1);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
