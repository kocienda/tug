/**
 * at0016-tab-close-handoff.test.ts — Closing the active tab hands focus to
 * its successor (handoff, [AT0016]).
 *
 * Scenario:
 *
 *   Seed a pane with three FC cards [c1, c2, c3], activate c2, click
 *   c2's close button. Verify c1 (the previous-sibling handoff target
 *   — see the handoff-target section below) becomes the deck's focused
 *   card. The production path `flushSaveCallbackBeforeDestruction` DOES
 *   save c2's bag (so the AT0011 reopen path has state), so the plan's
 *   original "no save" contract was wrong and the ordered-subset
 *   asserts `save-callback c2` is present.
 *
 * The close button click uses `nativeClickAtElement` — a trusted
 * `CGEvent.post`-backed mousedown. The close button carries
 * `data-no-activate` so `pane-focus-controller`'s pointerdown
 * classification skips it entirely; React's click handler on the
 * button dispatches `closeTab` through the pane controller.
 *
 * Probes
 * ------
 * Cards use `componentId: "gallery-input"`, which stamps
 * `data-tug-state-key="gallery-input/size/sm"` on a persisted
 * `<TugInput>` — the same probe surface m01 and m03 use. Each closable
 * tab renders a close-button stamped `data-testid="tug-tab-close-${id}"`
 * (see `tugdeck/src/components/tugways/tug-tab-bar.tsx`). Clicking that
 * button dispatches `closeTab` through the pane controller, which is the
 * production close path.
 *
 * Handoff target
 * --------------
 * `spliceCardFromStack` in `tugdeck/src/deck-manager.ts` picks the
 * PREVIOUS sibling when closing an active card:
 *
 *     activeCardId = cardIds[cardIndex > 0 ? cardIndex - 1 : 0];
 *
 * For [c1, c2, c3] with c2 active (index 1), removing c2 yields
 * activeCardId = c1. IDE-style: the user's "eye" stays on the tab
 * adjacent to the removed one rather than jumping rightward.
 *
 * Gating
 * ------
 * The whole describe block is wrapped in `describe.skipIf(!SHOULD_RUN)`.
 * CI and local `bun x tsc --noEmit` runs without `TUGAPP_APP_TEST=1`
 * skip every test, matching the README recipe (`tests/app-test/README.md`).
 *
 * @covers tugdeck/src/card-state-cache.ts
 * @covers tugdeck/src/components/tugways/tug-tab-bar.tsx
 * @covers tugdeck/src/lib/card-lifecycle.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, registerSubsetMatcher } from "./_harness";

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
 * Selector for a tab in the current pane's tab bar. `tug-tab-bar`
 * stamps `data-testid="tug-tab-${cardId}"` on each tab; this is the
 * canonical click target for tab-switch drivers.
 */
function tabSelectorFor(cardId: string): string {
  return `[data-testid="tug-tab-${cardId}"]`;
}

/**
 * Selector for a tab's close button. `tug-tab-bar` stamps
 * `data-testid="tug-tab-close-${cardId}"` on the × button rendered
 * when a tab is `closable: true`. Clicking this button dispatches
 * `closeTab` through the pane controller — the production close path.
 */
function tabCloseSelectorFor(cardId: string): string {
  return `[data-testid="tug-tab-close-${cardId}"]`;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("m16: closing active tab hands focus to successor without save", () => {
  test("seed [c1,c2,c3] active=c2, close c2, c3 focused, no save-callback for c2", async () => {
    // `app` is declared outside the try so the `catch` block can tail
    // the subprocess log before rethrowing.
    const app = await launchTugApp({ testName: "at0016-tab-close-handoff" });
    try {
      // Deck-trace defaults to disabled; flip it on so the "no
      // save-callback for c2" assertion later can read the trace.
      await app.enableDeckTrace(true);

      // -----------------------------------------------------------------
      // Seed: one pane with three FC cards. `gallery-input` is the
      // gallery componentId that renders persisted TugInputs. `c2` is
      // the initially-active card so the close click targets an active
      // tab (the production handoff path). All three cards are
      // `closable: true` so the close-button renders.
      // -----------------------------------------------------------------
      await app.seedDeckState({
        state: {
          cards: [
            { id: "c1", componentId: "gallery-input", title: "Card c1", closable: true },
            { id: "c2", componentId: "gallery-input", title: "Card c2", closable: true },
            { id: "c3", componentId: "gallery-input", title: "Card c3", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 520, height: 360 },
              cardIds: ["c1", "c2", "c3"],
              activeCardId: "c2",
              title: "",
              acceptsFamilies: ["maker"],
            },
          ],
          activePaneId: "p1",
          hasFocus: true,
        },
        focusCardId: "c2",
      });

      // Mount may emit `card-host-mount` / `destination-flip` events on
      // the initial activation of c2; the successor (c3) does not mount
      // until the handoff runs, so only gate on c2's root here. The tabs
      // for c1/c2/c3 all live in the tab bar (not inside card hosts),
      // so they are click-targetable before the handoff.
      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("c2")`,
      );

      // Sanity: c2 is the deck's first-responder / focused card.
      await app.expectFocusedCard("c2");
      expect(await app.getActiveCardId()).toBe("c2");

      // -----------------------------------------------------------------
      // Gesture: click c2's close button. Take a trace mark first so the
      // ordered-subset and no-save assertions below scope to just the
      // close → handoff transition.
      // -----------------------------------------------------------------
      const markClose = await app.markDeckTrace();
      await app.nativeClickAtElement(tabCloseSelectorFor("c2"));

      // Waiting on `expectFocusedCard` rather than polling state reads
      // keeps the assertion inside the harness's structured timeout.
      //
      // Production picks the PREVIOUS sibling (c1) as the handoff
      // target when closing an active card — see
      // `spliceCardFromStack` in `tugdeck/src/deck-manager.ts`:
      //
      //     activeCardId = cardIds[cardIndex > 0 ? cardIndex - 1 : 0];
      //
      // so removing c2 (index 1) yields activeCardId = c1.
      // Rationale: IDE-style tab close keeps the visual "eye" on
      // the tab immediately adjacent to the removed one rather
      // than jumping rightward. The plan's original expectation
      // of c3 (next sibling) was a guess; reality wins.
      await app.expectFocusedCard("c1");
      expect(await app.getActiveCardId()).toBe("c1");

      // -----------------------------------------------------------------
      // Trace assertions for the close → handoff transition.
      //
      // Production emission order (post-commit split,
      // 2026-04-24 — `_removeCard` routes the FR flip through
      // `transferFocusForActivation`, whose `flushSync` forces React
      // to commit the activation transition synchronously inside the
      // helper):
      //   1. destination-flip c1 → true, destination-flip c2 → false
      //      (observer fires after store mutates inside the helper's
      //      flushSync).
      //   2. fr-flip c2 → c1 with trigger="_removeCard".
      //   3. A3 activation effect for c1 runs synchronously inside
      //      flushSync; c1 was never saved, so the default-focus
      //      fallback fires focus-call with site="a3-default-focus"
      //      (see tugdeck/src/components/chrome/card-host.tsx
      //      DEFAULT_FOCUS_SELECTORS). The helper itself emits no
      //      focus-call: `resolveActivationTarget(c1)` returns
      //      `kind: "none"` because c1 has no saved bag.focus.
      //   4. save-callback c2 (via `flushSaveCallbackBeforeDestruction`
      //      — deck-manager preserves the closed card's bag so the
      //      AT0011 reopen path has state to restore). Runs in
      //      `_removeCard`'s phase 2 after the helper returns.
      //   5. card-host-unmount c2.
      //
      // Pre-split-(b), the focus-call landed AFTER save-callback +
      // card-host-unmount because React's re-render was deferred
      // outside the synchronous _removeCard call. Routing through the
      // helper pulls the React commit (and the [A3] effect's
      // focus-call) into the activation transition itself. User-
      // visible behavior is unchanged: c1 receives focus either way.
      // [A3] is retired in split (c); at that point the focus-call
      // disappears for cards with no saved bag.focus and the
      // assertion list is revisited.
      // -----------------------------------------------------------------
      const traceClose = await app.getDeckTrace({ since: markClose });
      expect(traceClose).toContainOrderedSubset([
        { kind: "destination-flip", cardId: "c1", to: true },
        { kind: "fr-flip", to: "c1", trigger: "_removeCard" },
        { kind: "focus-call", cardId: "c1" },
        { kind: "save-callback", cardId: "c2" },
        { kind: "card-host-unmount", cardId: "c2" },
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
          `\n[at0016-tab-close-handoff] Tug.app log tail (last 200 lines):\n${tail}\n`,
        );
      }
      // AT0016 fails via `TimeoutError` from `waitForCondition` before
      // any in-test `getDeckTrace` runs, so the caller's catch has
      // no trace context. Dump the full ring buffer to a sibling
      // file so post-mortem diagnosis has the event sequence that
      // produced the wrong handoff target.
      // Path is relative to the test's cwd (tests/app-test/), so
      // `logs/...` lands next to the subprocess-log files.
      const tracePath = await app.dumpTraceToFile(
        "logs/at0016-tab-close-handoff-trace.json",
      );
      if (tracePath !== null) {
        process.stderr.write(`[at0016-tab-close-handoff] trace dumped to ${tracePath}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  });
});

// Note: `tabSelectorFor` is exported-shaped but unused in this test —
// m16 exercises only the close-button click path, not tab selection.
// Retained for parity with m01/m03 helper shapes so future variants
// (e.g. "close the non-active tab" scenarios) can reuse the module.
void tabSelectorFor;
