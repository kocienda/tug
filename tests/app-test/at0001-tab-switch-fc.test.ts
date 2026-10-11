/**
 * at0001-tab-switch-fc.test.ts — Intra-pane tab switch, form-control caret
 * round-trip ([AT0001] FC half).
 *
 * Scenario:
 *
 *   Seed a pane with two FC cards (A, B). Click into card A's form-
 *   control input and type "alpha", click tab B, verify B is the
 *   focused card with its own (empty) caret state, click back to tab
 *   A, verify A's caret is restored at offset 5 (end of "alpha").
 *
 *   The trace assertion asserts the "activate A → activate B → activate
 *   A again" ordered triple of (fr-flip, destination-flip → true,
 *   focus-call) groups.
 *
 * Every user-gesture click is a trusted `nativeClickAtElement` —
 * `CGEvent.post`-backed `isTrusted: true` mousedown — so the browser's
 * hardware-event default focus-change on mousedown runs the same way
 * it does for a real user's mouse. Typing uses JS-synthesized input
 * events (keystroke-into-focused-input is isTrusted-independent).
 *
 * Probes
 * ------
 * Cards use `componentId: "gallery-input"`, which renders `<TugInput>`
 * instances that stamp `data-tug-state-key="gallery-input/size/sm"`
 * (and similar) on the underlying `<input>` element. That attribute is
 * the exact marker the harness reads via `__tug.getCaretState` and
 * `__tug.getFormControlValue` ([#s03-tug-surface]), so no bespoke test
 * card is needed — the gallery registration already supplies the
 * production surface under test.
 *
 * Gating
 * ------
 * The whole describe block is wrapped in `describe.skipIf(!SHOULD_RUN)`.
 * CI and local `bun x tsc --noEmit` runs without `TUGAPP_APP_TEST=1`
 * skip every test, matching the README recipe (`tests/app-test/README.md`).
 *
 * @covers tugdeck/src/components/tugways/tug-tab-bar.tsx
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";
import {
  launchTugApp,
  registerSubsetMatcher,
  type CaretState,
} from "./_harness";
import { inputSelectorFor, INPUT_PERSIST_KEY } from "./_harness/fixtures";

// ---------------------------------------------------------------------------
// Matcher registration (once per module load)
// ---------------------------------------------------------------------------

// Enables `expect(trace).toContainOrderedSubset([...])` below. The
// pure-predicate form remains available on the named import for test
// authors who prefer not to extend `expect`.
registerSubsetMatcher();

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

// ---------------------------------------------------------------------------
// Seed fixtures
// ---------------------------------------------------------------------------

/**
 * Shared selector for the first-size (`sm`) TugInput inside a given
 * gallery-input card. Both cards render the same componentStatePreservationKey set, but
 * they live in different `[data-card-id]` subtrees, so qualifying the
 * lookup by cardId disambiguates them. We probe the `sm` variant
 * because it is the first input in the gallery-input content, which
 * keeps the click target stable against future gallery reorganizations.
 */

/**
 * Selector for a tab in the current pane's tab bar. `tug-tab-bar`
 * stamps `data-testid="tug-tab-${cardId}"` on each tab; that is the
 * canonical click target for tab-switch drivers.
 */
function tabSelectorFor(cardId: string): string {
  return `[data-testid="tug-tab-${cardId}"]`;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("m01: intra-pane tab switch preserves FC caret", () => {
  test("type 'alpha' in A, tab to B, tab back to A restores caret at offset 5", async () => {
    // `app` is declared outside the try so the `catch` block can tail
    // the subprocess log before rethrowing.
    const app = await launchTugApp({ testName: "at0001-tab-switch-fc" });
    try {
      // Deck-trace defaults to disabled; recording is a no-op until
      // we flip the enable flag. All trace assertions below depend on
      // this being on.
      await app.enableDeckTrace(true);

      // -----------------------------------------------------------------
      // Seed: one pane with two FC cards. `gallery-input` is the
      // maker-family gallery componentId that renders persisted TugInputs.
      // -----------------------------------------------------------------
      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
            { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 480, height: 360 },
              cardIds: ["A", "B"],
              activeCardId: "A",
              title: "",
              acceptsFamilies: ["maker"],
            },
          ],
          activePaneId: "p1",
          hasFocus: true,
        },
        focusCardId: "A",
      });

      // Mount may emit `card-host-mount` / `destination-flip` events on
      // the initial activation of A; wait until the host root is
      // registered before driving gestures so our selectors resolve.
      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );

      // -----------------------------------------------------------------
      // Gesture 1: click into A's input to focus it, type "alpha".
      //
      // Wait for focus to actually land before typing: the mousedown
      // default focus-change is async relative to the RPC return, so a
      // fast follow-up could race and insert text into body.
      // -----------------------------------------------------------------
      await app.nativeClickAtElement(inputSelectorFor("A"));
      await app.waitForCondition<boolean>(
        `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(inputSelectorFor("A"))})`,
      );
      await app.type(inputSelectorFor("A"), "alpha");

      // Sanity: the input's persisted value reads back as "alpha".
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("alpha");

      // Expected caret after typing 5 chars into an initially-empty
      // input: [5, 5], direction "none" (WebKit's default after
      // character insertion; `readSelectionDirection` normalizes any
      // null to "none" on read).
      const caretAAfterType: CaretState = {
        kind: "input",
        selectionStart: 5,
        selectionEnd: 5,
        selectionDirection: "none",
        value: "alpha",
      };
      await app.expectCaret("A", caretAAfterType);

      // -----------------------------------------------------------------
      // Gesture 2: click tab B. Take a trace mark first so the ordered-
      // subset assertion below scopes to just the A→B transition.
      // -----------------------------------------------------------------
      const markSwitchToB = await app.markDeckTrace();
      await app.nativeClickAtElement(tabSelectorFor("B"));

      // Waiting on `expectFocusedCard` rather than polling state reads
      // keeps the assertion inside the harness's structured timeout.
      await app.expectFocusedCard("B");
      expect(await app.getActiveCardId()).toBe("B");

      // B is a fresh gallery-input card; its `sm` input is empty and
      // unfocused until a gesture targets it. The plan's phrasing —
      // "B is focused (via expectFocusedCard) with its own caret state"
      // — is the deck-level focus marker, not DOM focus on the input.
      // We assert the deck-level marker (already done above) and that
      // B's getCaretState is null or an empty-input snapshot; both are
      // acceptable "own caret state" outcomes for an unfocused FC card.
      const caretBAfterSwitch = await app.getCaretState("B");
      // `null` means the card root is registered but no form-control
      // has focus inside it yet — the natural post-tab-switch state.
      // We do not force the caret-restore path on B here; the plan's
      // assertion is about A's restore behavior on the return trip.
      expect(caretBAfterSwitch === null || caretBAfterSwitch.kind === "input").toBe(true);

      // Ordered-subsequence trace assertion for the A→B transition.
      //
      // Production emits events in this order during intra-pane tab
      // switch:
      //   1. store state mutates (activeCardId flips in memory)
      //   2. destination-flip observer fires for each card whose
      //      isFocusDestination bit changed (A→false, then B→true) —
      //      both records carry the POST-mutation store snapshot.
      //   3. _flipFirstResponder records fr-flip with
      //      trigger="_setActiveCardInPane" (not "activateCard" —
      //      intra-pane switches go through the internal helper).
      //   4. A3 activation effect for B runs; with no saved bag,
      //      the default-focus fallback fires focus-call with
      //      site="a3-default-focus" targeting the first focusable
      //      element in B's card root (see
      //      tugdeck/src/components/chrome/card-host.tsx
      //      DEFAULT_FOCUS_SELECTORS).
      const traceSwitchToB = await app.getDeckTrace({ since: markSwitchToB });
      expect(traceSwitchToB).toContainOrderedSubset([
        { kind: "destination-flip", cardId: "B", to: true },
        { kind: "fr-flip", to: "B", trigger: "_setActiveCardInPane" },
        { kind: "focus-call", cardId: "B" },
      ]);

      // -----------------------------------------------------------------
      // Gesture 3: click tab A. Fresh mark for the B→A transition.
      // -----------------------------------------------------------------
      const markSwitchToA = await app.markDeckTrace();
      await app.nativeClickAtElement(tabSelectorFor("A"));

      await app.expectFocusedCard("A");
      expect(await app.getActiveCardId()).toBe("A");

      // The core restore assertion: A's caret should land back at the
      // end of "alpha" (offset 5). `expectCaret` polls via
      // `waitForCondition` so restore paths that complete asynchronously
      // (e.g. the Step-10 cold-boot-style `restoreCardDomSelection` /
      // `applyFocusSnapshot` sequencing) settle within the budget.
      await app.expectCaret("A", caretAAfterType);
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("alpha");

      // Ordered-subsequence trace assertion for the return trip.
      // Same production ordering as the outgoing trip
      // (destination-flip → fr-flip). Unlike the outgoing trip, A DOES
      // have a saved bag from the typing gesture at Gesture 1, so
      // the A3 effect's `applyFocusSnapshot` runs and emits
      // `focus-call`.
      const traceSwitchToA = await app.getDeckTrace({ since: markSwitchToA });
      expect(traceSwitchToA).toContainOrderedSubset([
        { kind: "destination-flip", cardId: "A", to: true },
        { kind: "fr-flip", to: "A", trigger: "_setActiveCardInPane" },
        { kind: "focus-call", cardId: "A" },
      ]);
    } catch (err) {
      // On failure, dump the last 200 lines of the subprocess log to
      // stderr *before* rethrowing so Bun's assertion error prints
      // after the diagnostic tail — production diagnostic prints
      // (pane-focus-controller, [A3] effect, close-tab) land together
      // with the assertion, not 400 lines below a JSON trace dump.
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(
          `\n[at0001-tab-switch-fc] Tug.app log tail (last 200 lines):\n${tail}\n`,
        );
      }
      // Dump the full deck-trace ring to a sibling file so post-
      // mortem diagnosis has the event sequence that produced the
      // wrong focus / caret outcome. Matches the AT0003/AT0016 pattern.
      const tracePath = await app.dumpTraceToFile(
        "logs/at0001-tab-switch-fc-trace.json",
      );
      if (tracePath !== null) {
        process.stderr.write(`[at0001-tab-switch-fc] trace dumped to ${tracePath}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  });
});
