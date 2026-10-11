/**
 * at0003-pane-activation.test.ts — Cross-pane activation via title-bar click
 * ([AT0003]).
 *
 * Scenario:
 *
 *   Seed two panes each with one FC card (A1 in p1, A2 in p2). Click
 *   into A1's form-control input and type a short string so A1 carries
 *   a non-trivial caret position. Click pane 2's title bar; the
 *   pane-focus-controller's capture-phase pointerdown handler
 *   classifies this as a Branch-A activation and calls
 *   `store.activateCard(A2)`. Verify A2 becomes the deck's focused
 *   card. Verify A1's state was saved between the click and the
 *   `fr-flip` (ordered-subset trace assertion). Click pane 1's title
 *   bar to return; verify A1's caret is restored at the typed offset.
 *
 * Every user-gesture click is a trusted `nativeClickAtElement` —
 * `CGEvent.post`-backed `isTrusted: true` mousedown — so the browser's
 * hardware-event default focus-change on mousedown runs the same way
 * it does for a real user's mouse. Typing uses JS-synthesized input
 * events (keystroke-into-focused-input is isTrusted-independent and
 * has no mousedown-default path to miss).
 *
 * Probes
 * ------
 * Cards use `componentId: "gallery-input"`, which stamps
 * `data-tug-state-key="gallery-input/size/sm"` on a persisted
 * `<TugInput>` — the same probe surface m01 uses. Each pane's root
 * element carries `data-pane-id={id}`, and the title text inside the
 * `CardTitleBar` stamps `data-testid="tug-pane-title"` (see
 * `tugdeck/src/components/chrome/tug-pane.tsx`). That span sits inside
 * the pane's `.tug-pane[data-pane-id]` frame, so clicks on it reach
 * `pane-focus-controller`'s document-level capture pointerdown —
 * exactly the production activation path.
 *
 * Save-callback source
 * --------------------
 * The plan phrases the save-callback assertion with `source: "..."`
 * because the production source tag for cross-pane activation is not
 * fixed by the plan (it might be `"manual"`, `"debounced"`, or a new
 * tag the AT-series fix introduces). The ordered-subset matcher matches
 * on the fields we specify, so omitting `source` from the expected
 * entry accepts any source — that is the correct contract here.
 *
 * Gating
 * ------
 * The whole describe block is wrapped in `describe.skipIf(!SHOULD_RUN)`.
 * CI and local `bun x tsc --noEmit` runs without `TUGAPP_APP_TEST=1`
 * skip every test, matching the README recipe (`tests/app-test/README.md`).
 *
 * @covers tugdeck/src/components/chrome/pane-focus-controller.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";
import {
  launchTugApp,
  registerSubsetMatcher,
  type App,
  type CaretState,
} from "./_harness";
import { inputSelectorFor, INPUT_PERSIST_KEY } from "./_harness/fixtures";

/**
 * Block until the composite first-responder bit names `cardId`. The harness
 * has `expectFocusedCard` for the z-order bit; this is its counterpart for the
 * bit the focus engine follows as its key card, which settles independently.
 */
async function expectActiveCard(app: App, cardId: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `window.__tug.getActiveCardId() === ${JSON.stringify(cardId)}`,
    { timeoutMs: 6000 },
  );
}

// ---------------------------------------------------------------------------
// Matcher registration (once per module load)
// ---------------------------------------------------------------------------

registerSubsetMatcher();

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

// ---------------------------------------------------------------------------
// Seed fixtures
// ---------------------------------------------------------------------------

/**
 * Shared selector for the first-size (`sm`) TugInput inside a given
 * gallery-input card. Each seeded card lives under its own
 * `[data-card-id]` subtree, so qualifying the lookup by cardId
 * disambiguates them even though both cards render the same componentStatePreservationKey
 * set. The `sm` variant is the first input in the gallery-input content
 * — the same target m01 probes.
 */

/**
 * Selector for a pane's title text. `CardTitleBar` stamps
 * `data-testid="tug-pane-title"` on the span that holds the pane's
 * title; the enclosing `.tug-pane` frame stamps `data-pane-id={id}`.
 * The combined selector picks out the title span of a specific pane,
 * which is the click target `pane-focus-controller`'s capture-phase
 * pointerdown listener classifies as an activation gesture.
 */
function paneTitleSelectorFor(paneId: string): string {
  return `[data-pane-id="${paneId}"] [data-testid="tug-pane-title"]`;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("m03: pane-chrome click activates other pane and saves outgoing card", () => {
  test("focus A1, click pane 2 title, A2 focused; click pane 1 title, A1's caret restored", async () => {
    const app = await launchTugApp({ testName: "at0003-pane-activation" });
    try {
      // Deck-trace defaults to disabled; flip it on before any events
      // we want to assert against can be recorded.
      await app.enableDeckTrace(true);

      // -----------------------------------------------------------------
      // Seed: two panes, one card each. `gallery-input` is the gallery
      // componentId that renders persisted TugInputs; the two panes are
      // placed with non-overlapping positions so the title bars are both
      // hit-testable without one occluding the other.
      // -----------------------------------------------------------------
      await app.seedDeckState({
        state: {
          cards: [
            { id: "A1", componentId: "gallery-input", title: "Card A1", closable: true },
            { id: "A2", componentId: "gallery-input", title: "Card A2", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 420, height: 320 },
              cardIds: ["A1"],
              activeCardId: "A1",
              title: "",
              acceptsFamilies: ["maker"],
            },
            {
              id: "p2",
              position: { x: 520, y: 40 },
              size: { width: 420, height: 320 },
              cardIds: ["A2"],
              activeCardId: "A2",
              title: "",
              acceptsFamilies: ["maker"],
            },
          ],
          activePaneId: "p1",
          hasFocus: true,
        },
        focusCardId: "A1",
      });

      // Mount may emit `card-host-mount` / `destination-flip` events on
      // the initial activation of A1; wait until both host roots are
      // registered before driving gestures so our selectors resolve.
      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A1") && window.__tug.assertHostRootRegistered("A2")`,
      );

      // -----------------------------------------------------------------
      // Gesture 1: click into A1's input to focus it, then type "hello"
      // so A1 carries a non-trivial caret position. The restore
      // assertion at the end needs a non-zero offset to be meaningful;
      // 5 chars give us selectionStart=selectionEnd=5.
      //
      // Wait for focus to actually land before typing: the mousedown
      // default focus-change is async relative to the RPC return, so a
      // fast follow-up could race and insert text into body.
      // -----------------------------------------------------------------
      await app.nativeClickAtElement(inputSelectorFor("A1"));
      await app.waitForCondition<boolean>(
        `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(inputSelectorFor("A1"))})`,
      );
      await app.type(inputSelectorFor("A1"), "hello");

      // Sanity: the input's persisted value reads back as "hello" and
      // the caret is at offset 5.
      expect(await app.getFormControlValue("A1", INPUT_PERSIST_KEY)).toBe("hello");
      const caretA1AfterType: CaretState = {
        kind: "input",
        selectionStart: 5,
        selectionEnd: 5,
        selectionDirection: "none",
        value: "hello",
      };
      await app.expectCaret("A1", caretA1AfterType);

      // Sanity: A1 is the deck's first-responder / focused card.
      await app.expectFocusedCard("A1");

      // -----------------------------------------------------------------
      // Gesture 2: click pane 2's title bar. Take a trace mark first so
      // the ordered-subset assertion below scopes to just the p1→p2
      // activation transition.
      // -----------------------------------------------------------------
      const markSwitchToP2 = await app.markDeckTrace();
      await app.nativeClickAtElement(paneTitleSelectorFor("p2"));

      await app.expectFocusedCard("A2");
      // `expectFocusedCard` polls the z-order bit (`getFocusedCardId` — the
      // topmost pane's active card). The composite first-responder bit
      // (`getActiveCardId`) settles on its own schedule, so read it with a
      // poll too: an unpolled read here can catch the pre-flip value on a
      // loaded machine, which reads as an activation regression.
      await expectActiveCard(app, "A2");

      // Ordered-subsequence trace assertion for the p1→p2 transition.
      //
      // Production emission order on cross-pane activation:
      //   1. save-callback on outgoing A1 (pane-focus-controller
      //      invokes save before flipping — see
      //      components/chrome/pane-focus-controller.ts).
      //   2. destination-flip A1 → false, destination-flip A2 → true
      //      (observer in deck-trace.ts fires per-card after the
      //      store mutates).
      //   3. fr-flip on A2 with trigger="activateCard" (cross-pane
      //      goes through `store.activateCard`, unlike intra-pane
      //      which uses `_setActiveCardInPane`).
      //   4. A3 activation effect for A2 runs; with no saved bag,
      //      the default-focus fallback fires focus-call with
      //      site="a3-default-focus" (see
      //      tugdeck/src/components/chrome/card-host.tsx
      //      DEFAULT_FOCUS_SELECTORS).
      const traceSwitchToP2 = await app.getDeckTrace({ since: markSwitchToP2 });
      expect(traceSwitchToP2).toContainOrderedSubset([
        { kind: "save-callback", cardId: "A1" },
        { kind: "destination-flip", cardId: "A2", to: true },
        { kind: "fr-flip", to: "A2", trigger: "activateCard" },
        { kind: "focus-call", cardId: "A2" },
      ]);

      // -----------------------------------------------------------------
      // Gesture 3: click pane 1's title bar to return. Fresh mark for
      // the p2→p1 transition; the restore-caret assertion below is the
      // plan's core correctness check.
      // -----------------------------------------------------------------
      const markSwitchToP1 = await app.markDeckTrace();
      await app.nativeClickAtElement(paneTitleSelectorFor("p1"));

      await app.expectFocusedCard("A1");
      await expectActiveCard(app, "A1");

      // Core restore assertion: A1's caret should land back at offset 5
      // (end of "hello"). `expectCaret` polls via `waitForCondition` so
      // restore paths that complete asynchronously (cold-boot-style
      // `restoreCardDomSelection` / `applyFocusSnapshot` sequencing)
      // settle within the budget.
      await app.expectCaret("A1", caretA1AfterType);
      expect(await app.getFormControlValue("A1", INPUT_PERSIST_KEY)).toBe("hello");

      // Ordered-subsequence trace assertion for the return trip.
      // Same production ordering as outgoing (destination-flip →
      // fr-flip). A1 DOES have a saved bag from Gesture 1's typing,
      // so the A3 effect's `applyFocusSnapshot` runs and emits
      // `focus-call`. (No save-callback assertion here — A2 was
      // never typed into, so whether its save fires or not is
      // uninteresting; the plan's contract was only on the outgoing
      // p1→p2 transition.)
      const traceSwitchToP1 = await app.getDeckTrace({ since: markSwitchToP1 });
      expect(traceSwitchToP1).toContainOrderedSubset([
        { kind: "destination-flip", cardId: "A1", to: true },
        { kind: "fr-flip", to: "A1", trigger: "activateCard" },
        { kind: "focus-call", cardId: "A1" },
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
          `\n[at0003-pane-activation] Tug.app log tail (last 200 lines):\n${tail}\n`,
        );
      }
      // Dump the full deck-trace ring to a sibling file so post-
      // mortem diagnosis has the event sequence that produced the
      // wrong focus / caret outcome. Path is relative to the test's
      // cwd (tests/app-test/), so `logs/...` lands next to the
      // subprocess-log files.
      const tracePath = await app.dumpTraceToFile(
        "logs/at0003-pane-activation-trace.json",
      );
      if (tracePath !== null) {
        process.stderr.write(`[at0003-pane-activation] trace dumped to ${tracePath}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  });
});
