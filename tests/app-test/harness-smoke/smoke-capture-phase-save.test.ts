/**
 * smoke-capture-phase-save.test.ts — Layer 1 gate for selection
 * capture-phase save.
 *
 * ## What this gates
 *
 * Premise: `bag.*` is the single source of truth.
 * The contract requires that the deactivation save fires while focus
 * is still in the outgoing card — `document.activeElement` correctly
 * identifies the focused element AND `el.selectionStart`/`End` /
 * `el.scrollTop` carry the user's intent. Layer 2 (drop the engine
 * `_browserMirror`) depends on this — without correct capture-phase
 * timing, removing the mirror would silently break the m36 class of
 * bug.
 *
 * ## Audit findings (Layer 1)
 *
 * Each activation-trigger source was verified to save BEFORE focus
 * can move or layout can clamp scroll:
 *
 *   - **Inter-pane click** (`pane-focus-controller.ts#onPointerDown`,
 *     line 277): pointerdown listener registered with
 *     `{ capture: true }`. Inside the capture-phase handler,
 *     `transferFocusForActivation` calls `invokeSaveCallback(outgoing)`
 *     before the activation mutation commits. Native mousedown for
 *     the same click hasn't fired yet, so `document.activeElement`
 *     still points at the outgoing card's focused input.
 *
 *   - **Intra-pane tab click** (`tug-tab-bar.tsx#handleTabPointerDown`,
 *     line 397): React `onPointerDown` runs in the bubble phase of
 *     native pointerdown, which precedes native mousedown. The
 *     handler calls `cardDragCoordinator.notifyPotentialDragStart`
 *     → `captureFocusForDragStart` → `invokeSaveCallback`. Save
 *     fires before mousedown's default focus action runs.
 *
 *   - **Window blur** (`deck-manager.ts#installDeckStoreFocusListeners`,
 *     line 134): synchronous `invokeSaveCallback(firstResponder, "window-blur")`
 *     fires from the `window.blur` listener. Per WebKit, form-control
 *     `selectionStart`/`End` and `document.activeElement` survive
 *     window blur, so the capture is correct mid-blur.
 *
 * ## What this asserts
 *
 * For each of the three activation-trigger shapes, after the
 * deactivation gesture lands, the outgoing card's `bag.focus`
 * correctly identifies the focused form-control AND
 * `bag.formControls[componentStatePreservationKey]` carries the user's typed value
 * + selection. No reliance on the at0036-era
 * `lastFocusedPersistKeyRef` fallback.
 *
 * ## Why a smoke, not an AT-tag test
 *
 * The smoke gates Layer 2's safety. AT-tag tests (at0024-m36) assert
 * end-to-end user-visible behavior. This smoke asserts a structural
 * invariant of the persistence pipeline — capture-phase save timing
 * — that's invisible to user-visible checks but is the load-bearing
 * premise of the simplification.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tests/app-test/_harness/
 * @covers tugdeck/src/components/chrome/pane-focus-controller.ts
 * @covers tugdeck/src/components/tugways/tug-tab-bar.tsx
 * @covers tugdeck/src/card-state-orchestrator.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "../_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const INPUT_MD_KEY = "gallery-input/size/md";

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) =>
    (
      globalThis as unknown as {
        setTimeout: (fn: () => void, ms: number) => unknown;
      }
    ).setTimeout(() => resolve(), ms),
  );
}

function tabSelectorFor(cardId: string): string {
  return `[data-testid="tug-tab-${cardId}"]`;
}

function inputSelector(cardId: string, componentStatePreservationKey: string): string {
  return `[data-card-id="${cardId}"] input[data-tug-state-key="${componentStatePreservationKey}"]`;
}

interface FormControlSnap {
  value?: string;
  selectionStart?: number;
  selectionEnd?: number;
}

interface BagFocusSnap {
  kind: string;
  componentStatePreservationKey?: string;
}

interface BagShape {
  focus?: BagFocusSnap;
  formControls?: Record<string, FormControlSnap>;
}

/**
 * Type "md" into card A's md input, programmatically select 0..2,
 * and verify the live DOM reflects that state.
 */
async function seedFocusedSelection(app: App, cardA: string): Promise<void> {
  const aMdSel = inputSelector(cardA, INPUT_MD_KEY);
  await app.nativeClickAtElement(aMdSel);
  await app.waitForCondition<boolean>(
    `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(aMdSel)})`,
    { timeoutMs: 2000 },
  );
  await app.nativeType("md");
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(aMdSel)});
      return el !== null && el.value === "md";
    })()`,
    { timeoutMs: 2000 },
  );
  await app.evalJS<void>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(aMdSel)});
      if (!el) throw new Error("[smoke] A's md input missing");
      el.focus();
      el.setSelectionRange(0, 2);
    })()`,
  );
  await pause(150);
}

/**
 * Read card A's bag (from cardStateCache via `__tug.getCardStateBag`)
 * and return the focus + md-form-control snapshot. Triggers a
 * synchronous save first so the bag reflects current state.
 */
async function readBagFocus(app: App, cardId: string): Promise<{
  focus: BagFocusSnap | null;
  mdSnap: FormControlSnap | null;
}> {
  // The activation-driven save has already fired in production code
  // paths (transferFocusForActivation, window-blur listener, etc.),
  // so getCardStateBag returns the post-deactivation bag without
  // needing an explicit save trigger here. But poll briefly in case
  // notify ordering puts the bag write a tick after the harness
  // observes the activeCardId change.
  const bag = await app.evalJS<BagShape | null>(
    `(function(){
      if (typeof window.__tug === "undefined") return null;
      return window.__tug.getCardStateBag(${JSON.stringify(cardId)});
    })()`,
  );
  if (bag === null) return { focus: null, mdSnap: null };
  const focus = bag.focus ?? null;
  const mdSnap = bag.formControls?.[INPUT_MD_KEY] ?? null;
  return { focus, mdSnap };
}

describe.skipIf(!SHOULD_RUN)(
  "smoke: capture-phase save preserves bag.focus + bag.formControls across every activation-trigger shape",
  () => {
    test(
      "inter-pane click — bag.focus identifies focused input before activation commits",
      async () => {
        const app = await launchTugApp({
          testName: "smoke-capture-phase-save-inter-pane",
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: {
              cards: [
                { id: "A", componentId: "gallery-input", title: "A", closable: true },
                { id: "B", componentId: "gallery-input", title: "B", closable: true },
              ],
              panes: [
                {
                  id: "p1",
                  position: { x: 40, y: 40 },
                  size: { width: 460, height: 360 },
                  cardIds: ["A"],
                  activeCardId: "A",
                  title: "",
                  acceptsFamilies: ["maker"],
                },
                {
                  id: "p2",
                  position: { x: 540, y: 40 },
                  size: { width: 460, height: 360 },
                  cardIds: ["B"],
                  activeCardId: "B",
                  title: "",
                  acceptsFamilies: ["maker"],
                },
              ],
              activePaneId: "p1",
              hasFocus: true,
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );

          await seedFocusedSelection(app, "A");

          // Click into B's md input — inter-pane activation. The
          // pane-focus-controller's capture-phase pointerdown listener
          // fires; transferFocusForActivation calls
          // invokeSaveCallback(A) before the activation mutation
          // commits. At save time, document.activeElement is still
          // A's md input (mousedown for the same click hasn't fired
          // yet), so captureFocus reads the right element directly.
          await app.nativeClickAtElement(inputSelector("B", INPUT_MD_KEY));
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() === "B"`,
            { timeoutMs: 2000 },
          );
          await pause(150);

          const { focus, mdSnap } = await readBagFocus(app, "A");
          expect(
            focus,
            "inter-pane: bag.focus must be present after deactivation save",
          ).not.toBeNull();
          expect(
            focus?.kind,
            "inter-pane: bag.focus.kind must be form-control (focused element WAS in card root at save time)",
          ).toBe("form-control");
          expect(
            focus?.componentStatePreservationKey,
            "inter-pane: bag.focus.componentStatePreservationKey must identify the md input",
          ).toBe(INPUT_MD_KEY);
          expect(
            mdSnap?.value,
            "inter-pane: bag.formControls[md].value carries the typed value",
          ).toBe("md");
          expect(
            mdSnap?.selectionStart,
            "inter-pane: bag.formControls[md].selectionStart carries 0",
          ).toBe(0);
          expect(
            mdSnap?.selectionEnd,
            "inter-pane: bag.formControls[md].selectionEnd carries 2",
          ).toBe(2);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "intra-pane tab click — bag.focus identifies focused input before tab switch",
      async () => {
        const app = await launchTugApp({
          testName: "smoke-capture-phase-save-intra-pane",
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: {
              cards: [
                { id: "A", componentId: "gallery-input", title: "A", closable: true },
                { id: "B", componentId: "gallery-input", title: "B", closable: true },
              ],
              panes: [
                {
                  id: "p1",
                  position: { x: 40, y: 40 },
                  size: { width: 600, height: 360 },
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
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );

          await seedFocusedSelection(app, "A");

          // Click B's tab. Native pointerdown precedes mousedown;
          // tug-tab-bar's React onPointerDown fires
          // captureFocusForDragStart → invokeSaveCallback for A
          // BEFORE focus moves.
          await app.nativeClickAtElement(tabSelectorFor("B"));
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() === "B"`,
            { timeoutMs: 2000 },
          );
          await pause(150);

          const { focus, mdSnap } = await readBagFocus(app, "A");
          expect(focus).not.toBeNull();
          expect(focus?.kind).toBe("form-control");
          expect(focus?.componentStatePreservationKey).toBe(INPUT_MD_KEY);
          expect(mdSnap?.value).toBe("md");
          expect(mdSnap?.selectionStart).toBe(0);
          expect(mdSnap?.selectionEnd).toBe(2);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "window blur (cmd-tab) — bag.focus identifies focused input via window-blur save",
      async () => {
        const app = await launchTugApp({
          testName: "smoke-capture-phase-save-window-blur",
          // Foreground: the subject is the resign that fires `window.blur`.
          // A background launch never activates the app, so `NSApp.deactivate()`
          // is a no-op, `didResignActive` never posts, and the verb times out.
          foreground: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: {
              cards: [
                { id: "A", componentId: "gallery-input", title: "A", closable: true },
              ],
              panes: [
                {
                  id: "p1",
                  position: { x: 40, y: 40 },
                  size: { width: 460, height: 360 },
                  cardIds: ["A"],
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
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );

          await seedFocusedSelection(app, "A");

          // simulateAppResign → window.blur fires →
          // installDeckStoreFocusListeners' onBlur synchronously
          // calls invokeSaveCallback(firstResponder, "window-blur")
          // BEFORE setHasFocus(false).
          await app.simulateAppResign();
          await pause(200);

          const { focus, mdSnap } = await readBagFocus(app, "A");
          expect(focus).not.toBeNull();
          expect(focus?.kind).toBe("form-control");
          expect(focus?.componentStatePreservationKey).toBe(INPUT_MD_KEY);
          expect(mdSnap?.value).toBe("md");
          expect(mdSnap?.selectionStart).toBe(0);
          expect(mdSnap?.selectionEnd).toBe(2);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
