/**
 * at0627-app-modal-menu-freeze.test.ts — the menu bar goes dark for every
 * card-count item while an app-modal wizard is up, and the two wizards gate
 * each other's doors.
 *
 * `UpdateTug` is a Radix `AlertDialog` portalled into the canvas overlay, so
 * it traps the web view's pointer and focus. **AppKit is not trapped.**
 * Before this gate, ⌘N under an open wizard opened a Session card behind it,
 * File ▸ Open File… put a Text card there, and About opened a card the user
 * could not reach. The fix is one fact — `appModalOpen` — published to both
 * enablement tiers, and this test is the one place both tiers are read
 * through the real `NSMenuItemValidation` path at once:
 *
 *   - **Tier 1, the registry gate.** `file.newTextCard`, `file.openFile`,
 *     `file.openQuickly`, `file.closeCard`, `file.closeAllCardTabs` and
 *     `file.openRecent.clear` carry `changesCardCount: true`, so the
 *     frontend publishes `enabled: false` for the span the wizard is up.
 *   - **Tiers 3 and 5, host-owned.** `file.newSessionCard` has no registry
 *     entry at all; `app.about`, `app.settings` and `app.keyboardShortcuts`
 *     gate on `frontendReady`, which no push can see. All four read the
 *     top-level `menuState.appModalOpen` field in `validateMenuItem`.
 *
 * The second half is the one that would catch a latch: after Close, every
 * item is enabled again. A gate that froze the deck and never thawed it
 * would pass every disabled assertion here.
 *
 * `Window ▸` pane items and the Session menu are deliberately NOT asserted —
 * they move focus rather than the card count, and stay live ([B03]).
 *
 * The second test is the two-modal case ([B04]), and the asymmetry in it is
 * the decision rather than an oversight. Configure Tug… goes **dark** while
 * `UpdateTug` holds the app, because an update in flight is a thing the user
 * should not walk away from into a setup wizard. Check for Updates… stays
 * **enabled** while `ConfigureTug` holds it and its request is *dropped*, so
 * the door is still there when setup closes — a queued request would raise a
 * wizard the user asked for minutes earlier, over a screen they had moved on
 * from. Either way the two never stack, which is what Spec S02 forbids.
 *
 * No click in this file reaches the real updater: the wizard is driven by
 * pushing snapshots the way `MainWindow.bridgeUpdateState` does, and Close
 * posts nothing to the host.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/lib/app-modal-store.ts
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/update-tug.tsx
 * @covers tugdeck/src/components/tugways/configure-tug.tsx
 * @covers tugdeck/src/action-dispatch.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const WIZARD = `[data-testid="update-tug"]`;
const CLOSE = `[data-testid="update-tug-close"]`;
const SETUP = `[data-slot="configure-tug"]`;
const SETUP_DONE = `${SETUP} .tug-alert-actions button`;
const PILL = `[data-testid="update-pill"]`;
const CONFIGURE_TUG = "app.configureTug";
const CHECK_FOR_UPDATES = "app.checkForUpdates";

/** Items answered by the registry gate — `changesCardCount` entries. */
const REGISTRY_TIER = [
  "file.newTextCard",
  "file.openFile",
  "file.openQuickly",
  "file.closeCard",
  "file.closeAllCardTabs",
] as const;

/** Items the host still validates by hand, reading `appModalOpen` directly. */
const HOST_TIER = [
  "file.newSessionCard",
  "file.newJot",
  "app.about",
  "app.settings",
  "app.keyboardShortcuts",
] as const;

/** A two-card pane, so Close and Close All Tabs are both live at rest. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input", title: "A", closable: true },
      { id: "B", componentId: "gallery-input", title: "B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 900, height: 620 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** Push one snapshot the way `MainWindow.bridgeUpdateState` does. */
async function push(app: App, revealCount: number): Promise<void> {
  const payload = {
    stage: "available",
    version: "0.9.0",
    build: "900",
    currentVersion: "0.8.10",
    releaseNotes: null,
    releaseNotesFailed: false,
    userInitiated: false,
    percent: null,
    message: "",
    cancellable: false,
    revealCount,
  };
  await app.evalJS<null>(
    `(window.__tugBridge.onUpdateState(${JSON.stringify(payload)}), null)`,
  );
}

/**
 * Poll one item's validated state until it matches, then report it.
 *
 * The menuState push is async and coalesced on a microtask, so the host's
 * cache lags the wizard's own mount by a frame or two. Polling is what makes
 * this a test of the gate rather than of the push's latency.
 */
async function waitMenuEnabled(
  app: App,
  identifier: string,
  wantEnabled: boolean,
  timeoutMs = 10_000,
): Promise<{ found: boolean; enabled?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === wantEnabled) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** Assert every id in `ids` validates to `want`, naming the one that did not. */
async function expectAll(
  app: App,
  ids: readonly string[],
  want: boolean,
): Promise<void> {
  for (const id of ids) {
    const state = await waitMenuEnabled(app, id, want);
    expect(state.found, `${id} must exist in the menu bar`).toBe(true);
    expect(state.enabled, `${id} reads ${want ? "enabled" : "disabled"}`).toBe(want);
  }
}

describe.skipIf(!SHOULD_RUN)(
  "AT0627: an app modal freezes the deck's card count in the menu bar",
  () => {
    test(
      "every card-count item goes dark while UpdateTug is open and lights again after Close",
      async () => {
        const app = await launchTugApp({ testName: "at0627-app-modal-menu-freeze" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.waitForCondition<boolean>(
            `typeof window.__tugBridge !== "undefined"
               && typeof window.__tugBridge.onUpdateState === "function"`,
            { timeoutMs: 20_000 },
          );

          // ---- At rest, both tiers are live -----------------------------
          //
          // Asserted before the wizard so a gate that was dark for some other
          // reason — an unrelated regression, a deck that never focused —
          // cannot be mistaken for this one working.
          await expectAll(app, REGISTRY_TIER, true);
          await expectAll(app, HOST_TIER, true);
          expect(await elementCount(app, WIZARD)).toBe(0);
          note("at0627 at rest", "every card-count item enabled, no wizard");

          // ---- The wizard takes the app modally -------------------------
          await push(app, 1);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WIZARD)}) !== null`,
            { timeoutMs: 10_000 },
          );

          await expectAll(app, REGISTRY_TIER, false);
          await expectAll(app, HOST_TIER, false);
          note("at0627 under the modal", "both tiers dark");

          // ---- And the sibling wizard's door is dark too [B04] ----------
          //
          // Not a card-count rule — Configure Tug… opens a wizard rather than
          // a card — so it is asserted here rather than folded into either
          // tier above. The control frame is the same door by another route,
          // and must raise nothing.
          await expectAll(app, [CONFIGURE_TUG], false);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("configure-tug", {}), null)`,
          );
          await new Promise((r) => setTimeout(r, 600));
          expect(
            await elementCount(app, SETUP),
            "the configure-tug frame raises nothing under UpdateTug",
          ).toBe(0);
          note("at0627 sibling door", "Configure Tug… dark, its frame dropped");

          // ---- Close thaws it -------------------------------------------
          //
          // The half that catches a latch. Close posts nothing to the host —
          // a download behind a closed panel keeps running — so the only
          // thing that can re-enable these items is the store letting go.
          await waitForClickable(app, CLOSE);
          await app.click(CLOSE);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WIZARD)}) === null`,
            { timeoutMs: 10_000 },
          );

          await expectAll(app, REGISTRY_TIER, true);
          await expectAll(app, HOST_TIER, true);
          await expectAll(app, [CONFIGURE_TUG], true);
          note("at0627 after Close", "every card-count item enabled again");
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0627] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!SHOULD_RUN)(
  "AT0627: ConfigureTug drops the update wizard's request without taking its door away",
  () => {
    test(
      "a reveal under ConfigureTug raises nothing, and the same door works once setup closes",
      async () => {
        const app = await launchTugApp({ testName: "at0627-two-modal-precedence" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.waitForCondition<boolean>(
            `typeof window.__tugBridge !== "undefined"
               && typeof window.__tugBridge.onUpdateState === "function"`,
            { timeoutMs: 20_000 },
          );

          // ---- ConfigureTug takes the app -------------------------------
          //
          // The required wizard is suppressed under the harness, so the
          // on-demand frame is the only way it appears — which is also the
          // door step 2 gates in the other direction, exercised here in the
          // state where it is still supposed to work.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("configure-tug", {}), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SETUP)}) !== null`,
            { timeoutMs: 10_000 },
          );

          // ---- A find under it lights the pill and raises nothing --------
          await push(app, 1);
          // The push lands one of two ways: as a lit pill (what [B04] asks
          // for) or as a raised wizard (the regression). Wait for whichever
          // arrives rather than for the pill alone, so a wizard that opened
          // is reported as a wizard that opened instead of as a pill that
          // never came — the pill is suppressed while the wizard is up, so
          // waiting on it names the symptom and hides the cause.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PILL)}) !== null
               || document.querySelector(${JSON.stringify(WIZARD)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await new Promise((r) => setTimeout(r, 400));
          expect(
            await elementCount(app, WIZARD),
            "a reveal under ConfigureTug raises no update wizard",
          ).toBe(0);
          expect(
            await elementCount(app, PILL),
            "and the pill is lit, so the update is still findable",
          ).toBe(1);
          expect(
            await elementCount(app, SETUP),
            "and ConfigureTug is still the one holding the app",
          ).toBe(1);

          // The door itself is untouched — dropped, not taken away.
          const check = await waitMenuEnabled(app, CHECK_FOR_UPDATES, true);
          expect(check.found, "app.checkForUpdates must exist").toBe(true);
          expect(check.enabled, "Check for Updates… stays enabled").toBe(true);
          note("at0627 reverse gate", "pill lit, wizard dropped, menu item live");

          // ---- Setup closes, and the same door works --------------------
          //
          // The claim the drop rests on: nothing was queued, so the user
          // presses again and gets the wizard. A queued request would have
          // raised it the instant Done landed, before this second push.
          await waitForClickable(app, SETUP_DONE);
          await app.click(SETUP_DONE);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SETUP)}) === null`,
            { timeoutMs: 10_000 },
          );
          await new Promise((r) => setTimeout(r, 600));
          expect(
            await elementCount(app, WIZARD),
            "the dropped request was not queued behind Done",
          ).toBe(0);

          await push(app, 2);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WIZARD)}) !== null`,
            { timeoutMs: 10_000 },
          );
          note("at0627 door survives", "a second reveal after Done opens the wizard");
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0627-two-modal] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

async function elementCount(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

/**
 * Wait until `selector` is a thing a click can actually land on: two polls
 * agree on its box, and the centre of that box hit-tests back to it. The
 * wizard transitions in, so a click dispatched at mount lands where the
 * button is no longer.
 */
async function waitForClickable(app: App, selector: string): Promise<void> {
  await app.evalJS<null>(`(window.__at0627 = { box: null }, null)`);
  await app.waitForCondition<boolean>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) { window.__at0627.box = null; return false; }
       var r = el.getBoundingClientRect();
       if (r.width === 0 || r.height === 0) { window.__at0627.box = null; return false; }
       var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
       if (hit === null || !el.contains(hit)) { window.__at0627.box = null; return false; }
       var key = [r.left, r.top, r.width, r.height].join(",");
       var settled = window.__at0627.box === key;
       window.__at0627.box = key;
       return settled;
     })()`,
    { timeoutMs: 15_000, pollMs: 50 },
  );
}
