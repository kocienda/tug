/**
 * at0032-em-cold-boot-selection.test.ts — saved selection round-trips
 * through the cold-boot / mount-restore path ([AT0032]).
 *
 * ## Scenario
 *
 * Seed a deck where an EM card is ACTIVE at mount, with pre-cooked
 * `bag.content` carrying a non-collapsed selection range. The
 * mount-restore path runs: `CardHost.registerPersistenceCallbacks`
 * fires the `cold-boot-restore-snapshot` diagnostic event with the
 * seeded selection, the factory's `onRestore` invokes the engine's
 * `restoreState` (which calls `setSelectedRange`), and the
 * `engine-restore-applied` diagnostic event echoes both the seeded
 * selection and the live `engine.getSelectedRange()` after the
 * restore returns.
 *
 * The contract this test gates:
 *   1. `cold-boot-restore-snapshot` fires with `hasContent: true`
 *      and the exact seeded `engineSelection`.
 *   2. `engine-restore-applied` fires with `selectionApplied`
 *      matching the seed AND `domSelectionAfter` matching the
 *      seed — i.e., the live DOM selection landed where the bag
 *      said it should.
 *
 * A divergence between `selectionApplied` and `domSelectionAfter`
 * is the smoking gun for triage candidates (2) (WebKit
 * selectionchange-on-focus quirk) or (3) (boot-time
 * `document.hasFocus()` race) from the Step 23F triage shortlist.
 *
 * ## What this test does NOT exercise
 *
 * Real OS-level cold boot (quit Tug.app → relaunch). The harness
 * uses `seedDeckState` to populate the deck inside an
 * already-running app, which keeps `document.hasFocus() === true`
 * and the WKWebView's window-active state warm. That's a strict
 * subset of the real cold-boot scenario — selection-paint failures
 * specific to OS-level focus timing won't reproduce here. Manual
 * verification (the user's "type+select+quit+relaunch" repro) is
 * the authoritative gate for that family.
 *
 * ## Coverage
 *
 * `gallery-prompt-entry` (TugPromptEntry wrapper, what session-card
 * uses internally). The legacy `gallery-prompt-input` was retired.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/serialization.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TUG_PROMPT_ENTRY_DEFAULT_ROUTE = "❯";

const SEED_TEXT = "alpha";
const SEED_SELECTION = { start: 0, end: SEED_TEXT.length };

function preSeededContent(
  componentId: string,
  text: string,
  selection: { start: number; end: number },
): Record<string, unknown> {
  const engineState = { text, atoms: [], selection };
  if (componentId === "gallery-prompt-entry") {
    return {
      currentRoute: TUG_PROMPT_ENTRY_DEFAULT_ROUTE,
      perRoute: { [TUG_PROMPT_ENTRY_DEFAULT_ROUTE]: engineState },
      maximized: false,
    };
  }
  return engineState;
}

async function runColdBootSelection(
  app: App,
  componentId: string,
): Promise<void> {
  await app.enableDeckTrace(true);

  const cardStates = {
    A: { content: preSeededContent(componentId, SEED_TEXT, SEED_SELECTION) },
  };

  await app.seedDeckState({
    state: {
      cards: [
        { id: "A", componentId, title: "EM A", closable: true },
      ],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 480, height: 320 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["maker"],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    },
    cardStates,
    focusCardId: "A",
  });

  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.awaitEngineReady("A");

  // Diagnostic event 1: cold-boot-restore-snapshot fires with the
  // seeded selection still intact in `bag.content` at the moment
  // CardHost hands it to the factory's onRestore.
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var t = window.__tug.getDeckTrace();
      for (var i = 0; i < t.length; i++) {
        var e = t[i];
        if (e.kind === "cold-boot-restore-snapshot"
            && e.cardId === "A"
            && e.hasContent === true
            && e.engineSelection !== null
            && e.engineSelection.start === ${SEED_SELECTION.start}
            && e.engineSelection.end === ${SEED_SELECTION.end}) return true;
      }
      return false;
    })()`,
    { timeoutMs: 2000 },
  );

  // Diagnostic event 2: engine-restore-applied fires with
  // selectionApplied matching the seed AND domSelectionAfter
  // matching the seed. Pre-fix, if `onRestore` ran while the
  // CardPortal slot was still detached, `engine.setSelectedRange`
  // would no-op and `domSelectionAfter` would be null.
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var t = window.__tug.getDeckTrace();
      for (var i = 0; i < t.length; i++) {
        var e = t[i];
        if (e.kind === "engine-restore-applied"
            && e.cardId === "A"
            && e.engine === ${JSON.stringify(componentId)}
            && e.selectionApplied !== null
            && e.selectionApplied.start === ${SEED_SELECTION.start}
            && e.selectionApplied.end === ${SEED_SELECTION.end}
            && e.domSelectionAfter !== null
            && e.domSelectionAfter.start === ${SEED_SELECTION.start}
            && e.domSelectionAfter.end === ${SEED_SELECTION.end}) return true;
      }
      return false;
    })()`,
    { timeoutMs: 2000 },
  );

  // Force a save so the bag reflects the live engine state, then
  // check the round-trip: text and selection both preserved.
  const state = await app.getEmCardState("A");
  expect(state).not.toBeNull();
  expect(state!.text).toBe(SEED_TEXT);
  expect(state!.engine).toBe(componentId);
  expect(state!.engineSelection).toEqual(SEED_SELECTION);
}

describe.skipIf(!SHOULD_RUN)("at0032-em: saved selection round-trips through cold-boot mount-restore", () => {
  test("gallery-prompt-entry (TugPromptEntry, session-card's editor): seeded selection lands in live DOM after restore", async () => {
    const app = await launchTugApp({ testName: "at0032-em-cold-boot-entry" });
    try {
      await runColdBootSelection(app, "gallery-prompt-entry");
    } finally {
      await app.close();
    }
  });
});
