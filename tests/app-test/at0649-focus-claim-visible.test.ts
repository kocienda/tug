/**
 * at0649-focus-claim-visible.test.ts — an activation defers its React commit
 * only when the incoming card is already on screen.
 *
 * ## What this gates
 *
 * `transferFocusForActivation` commits the activation inside a `flushSync`
 * and then, three steps later, calls `.focus()` on the incoming card's
 * destination. Those two halves are joined by an assumption: that the commit
 * has reached the DOM by the time the claim is made. `deferCommit` breaks the
 * join on purpose — it leaves the deck's React commit to land after the next
 * painted frame ([D204]) so the settle's first frame is not paid for inside
 * the click task — and its own contract says so: **only for a caller whose
 * incoming card is already mounted and displayed.**
 *
 * `raiseCard` used to pass it unconditionally, and two of its callers cannot
 * satisfy the precondition:
 *
 *   1. **A card in a PARKED workspace.** `focus-session-card` calls
 *      `activateSpace` and then `raiseCard`, in one task. The layer's
 *      `data-space-shown` is written by React from the snapshot — the
 *      snapshot of the commit that is still a frame away — so the claim lands
 *      under `visibility: hidden`.
 *   2. **A card that is a NON-ACTIVE TAB of its pane.** Its subtree is
 *      `display: none` until the very commit being deferred flips it to
 *      `display: contents`.
 *
 * In both, `.focus()` on a hidden element is a no-op the DOM reports nothing
 * about; the outgoing card is then blurred by the transfer's own safety net,
 * and focus falls to `body` ([F06]).
 *
 * ## What is claimed, and what is only noted
 *
 * The claim is the **decision**, read off the marks the transfer already
 * writes: on both paths a `tug:react-notify` must land inside the
 * activation's own `tug:flushSync-start`..`tug:flushSync-end` window. That is
 * what "the commit was not deferred" means in one reading, it is exactly what
 * `mayDeferCommit` now decides, and it is red on the pre-fix code, where the
 * notify lands a painted frame later and the window holds none.
 *
 * Beside it, two guards keep the reading from being free: the workspace
 * really switched, and the tab really flipped. A gesture that moved nothing
 * flushes nothing either.
 *
 * Falsified with `raiseCard` restored to `deferCommit: true` under a
 * `file probe`: the parked leg read zero notifies inside an 11 ms window.
 *
 * **Where focus actually landed is a `note()` here rather than a claim, and
 * the reason is the fixture.** Neither an unbound Session card nor a Text
 * card with no file gives `applyBagFocus` a framework destination to claim in
 * this harness: the run records no `focus-call` and no `focus-measurement`
 * rows at all, and `document.activeElement` stands on a DIV outside every
 * card subtree before any gesture. A claim about where focus lands would
 * therefore be red for a reason that has nothing to do with `deferCommit`,
 * and the `focus-claim-hidden` row — which fires only inside
 * `applyBagFocus`'s `"applied"` branch — cannot fire either. The rows are
 * noted so the next reader sees the same thing without re-deriving it, and
 * the instrument's own liveness is left for a fixture that can claim focus.
 *
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/deck-trace.ts
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

const SPACE_ONE = "at0649-one";
const SPACE_TWO = "at0649-two";

/** Long enough for a deferred commit to land and for a settle to finish. */
const AFTER_GESTURE_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Two workspaces. The active one holds a pane with TWO tabs, so the
 * background-tab path has a background tab; the parked one holds a card of
 * its own, so the parked path has somewhere to go.
 */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [
    {
      id: SPACE_ONE,
      name: "One",
      deck: {
        cards: [
          { id: "A", componentId: "session", title: "A", closable: true },
          { id: "C", componentId: "session", title: "C", closable: true },
        ],
        panes: [
          {
            id: "p-a",
            position: { x: 60, y: 60 },
            size: { width: 700, height: 500 },
            cardIds: ["A", "C"],
            activeCardId: "A",
            title: "",
            acceptsFamilies: ["maker"],
          },
        ],
        activePaneId: "p-a",
        imposition: { kind: "one-up", sidebars: {} },
        hasFocus: true,
      },
    },
    {
      id: SPACE_TWO,
      name: "Two",
      deck: {
        cards: [
          { id: "B", componentId: "session", title: "B", closable: true },
        ],
        panes: [
          {
            id: "p-b",
            position: { x: 60, y: 60 },
            size: { width: 700, height: 500 },
            cardIds: ["B"],
            activeCardId: "B",
            title: "",
            acceptsFamilies: ["maker"],
          },
        ],
        activePaneId: "p-b",
        imposition: { kind: "one-up", sidebars: {} },
        hasFocus: true,
      },
    },
  ],
};

/** What the activation's own flush window contains. */
interface FlushReading {
  /** How many `tug:flushSync-start` marks the gesture wrote. */
  flushes: number;
  /** How many `tug:react-notify` marks it wrote anywhere. */
  notifies: number;
  /** How many of those lie inside the FIRST flush window. */
  inside: number;
  /** That window's width, for the diagnostics line. */
  windowMs: number;
}

/**
 * Read the activation's flush window off the marks the transfer already
 * writes.
 *
 * The FIRST window is the raise's: on the parked path `activateSpace` runs
 * ahead of it as a plain store call, outside any `flushSync`, so nothing
 * earlier can be mistaken for the activation's own.
 */
const flushReading = (app: App): Promise<FlushReading> =>
  app.evalJS<FlushReading>(
    `(function () {
       var at = function (n) {
         return performance.getEntriesByName(n).map(function (e) {
           return e.startTime;
         });
       };
       var starts = at("tug:flushSync-start");
       var ends = at("tug:flushSync-end");
       var notifies = at("tug:react-notify");
       if (starts.length === 0 || ends.length === 0) {
         return {
           flushes: starts.length,
           notifies: notifies.length,
           inside: 0,
           windowMs: -1,
         };
       }
       var s = starts[0];
       var e = ends[0];
       return {
         flushes: starts.length,
         notifies: notifies.length,
         inside: notifies.filter(function (t) {
           return t >= s && t <= e;
         }).length,
         windowMs: Math.round((e - s) * 10) / 10,
       };
     })()`,
  );

/**
 * Which card owns DOM focus, by id — or the focused element's tag name when
 * no card does. Noted rather than claimed; the header says why.
 */
const focusOwner = (app: App): Promise<string> =>
  app.evalJS<string>(
    `(function () {
       var ae = document.activeElement;
       if (ae === null) return "none";
       var host = ae.closest("[data-card-id]");
       return host === null ? ae.tagName : host.getAttribute("data-card-id");
     })()`,
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

/** Every `focus-claim-hidden` row since `mark`, as `cardId:reason`. */
const hiddenClaims = (app: App, mark: number): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark})
       .filter(function (e) { return e.kind === "focus-claim-hidden"; })
       .map(function (e) { return e.cardId + ":" + e.reason; })`,
  );

/** The focus-channel rows since `mark`, compressed to one string each. */
const focusRows = (app: App, mark: number): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark})
       .filter(function (e) {
         return e.kind === "focus-call" || e.kind === "focus-measurement" ||
                e.kind === "focus-claim-hidden" ||
                e.kind === "macrotask-focus-claim";
       })
       .map(function (e) {
         return e.kind + "|" + (e.cardId || "-") + "|" +
           (e.phase || e.resolution || e.reason || "-");
       })`,
  );

const activeSpaceId = (app: App): Promise<string> =>
  app.evalJS<string>(`window.tugdeck.diag.getSpaces().activeSpaceId`);

const traceMark = (app: App): Promise<number> =>
  app.evalJS<number>(`window.__deckTrace.since(0).length`);

/** Drop every standing mark so the next gesture's window is its own. */
const clearMarks = (app: App): Promise<null> =>
  app.evalJS<null>(`(performance.clearMarks(), null)`);

async function launch(): Promise<{ app: App; tugbankPath: string }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.deck.layout",
    "layout",
    "json",
    JSON.stringify(TWO_SPACE_BLOB),
  );
  const app = await launchTugApp({
    testName: "at0649-focus-claim-visible",
    env: { TUGBANK_PATH: tugbankPath },
    skipAccessibilityPreflight: true,
    persistInTestMode: true,
    restoreInTestMode: true,
  });
  await app.waitForCondition<boolean>(
    `typeof window.tugdeck !== "undefined" && ` +
      `window.tugdeck.diag.getSpaces().spaces.length === 2`,
    { timeoutMs: 30_000 },
  );
  await wait(AFTER_GESTURE_MS);
  return { app, tugbankPath };
}

describe.skipIf(!SHOULD_RUN)(
  "at0649 — an activation defers its commit only where the card is visible",
  () => {
    test(
      "into a parked workspace, and onto a background tab, the raise flushes its commit inside the activation",
      async () => {
        const { app, tugbankPath } = await launch();
        try {
          await app.enableDeckTrace(true);
          note(`at0649 at rest: focus owner ${await focusOwner(app)}`);

          // ---- Leg 1: a card in a parked workspace. -------------------
          const parkedMark = await traceMark(app);
          const spaceBefore = await activeSpaceId(app);
          await clearMarks(app);
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("focus-session-card", ` +
              `{ cardId: "B" }), null)`,
          );
          await wait(AFTER_GESTURE_MS);
          const parkedFlush = await flushReading(app);
          const spaceAfter = await activeSpaceId(app);
          const parkedFr = await firstResponder(app);
          note(
            `at0649 parked: space ${spaceBefore} -> ${spaceAfter}, ` +
              `first responder ${parkedFr}, flush ` +
              `${JSON.stringify(parkedFlush)}`,
          );
          note(
            `at0649 parked focus: owner ${await focusOwner(app)}, rows ` +
              `${JSON.stringify(await focusRows(app, parkedMark))}, hidden ` +
              `${JSON.stringify(await hiddenClaims(app, parkedMark))}`,
          );

          expect(
            spaceAfter,
            `parked: the workspace really switched — ${spaceBefore} -> ` +
              `${spaceAfter}. Without the switch the card was never in a ` +
              `parked space and this leg reads a plain activation`,
          ).toBe(SPACE_TWO);
          expect(parkedFr, `parked: and the raise really fronted B`).toBe("B");
          expect(
            parkedFlush.flushes,
            `parked: the raise really opened a flush window — ` +
              `${JSON.stringify(parkedFlush)}. With no window the clause ` +
              `below is about nothing`,
          ).toBeGreaterThan(0);
          expect(
            parkedFlush.inside,
            `parked: the React commit landed INSIDE the activation's own ` +
              `flush ([B05]) — ${parkedFlush.inside} of ` +
              `${parkedFlush.notifies} notifies inside a ` +
              `${parkedFlush.windowMs}ms window. Zero is the deferred ` +
              `commit: \`activateSpace\` ran ahead of the raise and its ` +
              `notify is still a painted frame away, so the layer carries ` +
              `no \`data-space-shown\` when step 4 claims focus`,
          ).toBeGreaterThan(0);

          // ---- Leg 2: a card that is a background tab of its pane. ----
          //
          // Back in workspace one, where pane `p-a` fronts A and holds C
          // behind it. `activateCard` is the test surface's door onto
          // `raiseCard` — the same function `focus-session-card` calls — so
          // this is the raise itself rather than a tab-bar click, which
          // would go through `performSelectCard` and its own flush.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", ` +
              `{ spaceId: ${JSON.stringify(SPACE_ONE)} }), null)`,
          );
          await wait(AFTER_GESTURE_MS);

          const tabMark = await traceMark(app);
          const tabBefore = await firstResponder(app);
          await clearMarks(app);
          await app.evalJS<null>(`(window.__tug.activateCard("C"), null)`);
          await wait(AFTER_GESTURE_MS);
          const tabFlush = await flushReading(app);
          const tabAfter = await firstResponder(app);
          note(
            `at0649 background tab: first responder ${tabBefore} -> ` +
              `${tabAfter}, flush ${JSON.stringify(tabFlush)}`,
          );
          note(
            `at0649 background tab focus: owner ${await focusOwner(app)}, ` +
              `rows ${JSON.stringify(await focusRows(app, tabMark))}, ` +
              `hidden ${JSON.stringify(await hiddenClaims(app, tabMark))}`,
          );

          expect(
            tabBefore,
            `background tab: C really was the BACKGROUND tab before the ` +
              `raise — the pane fronted ${tabBefore}. A pane already ` +
              `fronting C is a no-op activation and proves nothing`,
          ).toBe("A");
          expect(
            tabAfter,
            `background tab: and the raise really fronted C`,
          ).toBe("C");
          expect(
            tabFlush.flushes,
            `background tab: the raise really opened a flush window — ` +
              `${JSON.stringify(tabFlush)}`,
          ).toBeGreaterThan(0);
          expect(
            tabFlush.inside,
            `background tab: the React commit landed INSIDE the ` +
              `activation's own flush ([B05]) — ${tabFlush.inside} of ` +
              `${tabFlush.notifies} notifies inside a ${tabFlush.windowMs}ms ` +
              `window. Zero is the deferred commit, and a background tab is ` +
              `\`display: none\` until that commit reaches React`,
          ).toBeGreaterThan(0);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
