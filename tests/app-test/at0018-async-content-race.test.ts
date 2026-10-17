/**
 * at0018-async-content-race.test.ts — `restorePendingRef` audit:
 * saves do not clobber `bag.content` with engine stub state when
 * the engine has just restored.
 *
 * ## What this audits
 *
 * After `seedDeckState` writes `bag.content` with engine state,
 * the mount-restore path applies it via `engine.restoreState`. A
 * save fired AFTER restore must capture the restored content (not
 * stub). The race window — `onSave` firing while restore is
 * pending — is closed only once `restorePendingRef.current` gates
 * `onSave`, per [AT0018]'s closing requirement. Until then, an async
 * factory could lose state to a `saveState` RPC fired during the
 * gap.
 *
 * On-roster content factories (`gallery-prompt-entry`,
 * session-card editor) restore synchronously
 * inside Phase-1's layout effect, so the race window is sub-frame
 * and not reproducible from the harness without explicit
 * instrumentation. The behavioral assertion this test makes —
 * "save after seed-and-mount captures the seeded content" — is
 * what user-facing correctness requires; the gate becomes load-
 * bearing only when an async factory ships.
 *
 * If a future async factory exposes the race, this test will
 * start failing; [AT0018] covers the async-content race.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const SEED_TEXT = "seeded-content-text";
const TUG_PROMPT_ENTRY_DEFAULT_ROUTE = "❯";

describe.skipIf(!SHOULD_RUN)("m18: async-content-race audit", () => {
  test("saveState() after seed-and-mount preserves seeded bag.content", async () => {
    const app = await launchTugApp({ bodies: false,
    // Foreground: drives a real app resign / hide / become-active cycle,
    // which only happens to an app that is actually active (pid-mode default
    // never activates).
    foreground: true, testName: "at0018-async-content-race" });
    try {
      await app.enableDeckTrace(true);

      // Wrapper shape produced by gallery-prompt-entry's onSave —
      // pre-cooking it lets the mount-restore path invoke the
      // engine with the exact text the engine round-trips itself.
      const seededContent = {
        currentRoute: TUG_PROMPT_ENTRY_DEFAULT_ROUTE,
        perRoute: {
          [TUG_PROMPT_ENTRY_DEFAULT_ROUTE]: {
            text: SEED_TEXT,
            atoms: [],
            selection: { start: 0, end: 0 },
          },
        },
        maximized: false,
      };

      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "gallery-prompt-entry", title: "EM A", closable: true },
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
        cardStates: {
          A: { content: seededContent },
        },
        focusCardId: "A",
      });

      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );
      await app.awaitEngineReady("A");

      // saveState forces invokeSaveCallback for every card; on a
      // freshly-restored card the captured engine state should
      // carry the seeded text. If a stub-state slip-through exists,
      // bag.content.text becomes "" here.
      await app.evalJS<void>(
        `(function(){
          if (!window.tugdeck || typeof window.tugdeck.saveState !== "function") {
            throw new Error("window.tugdeck.saveState missing");
          }
          window.tugdeck.saveState();
        })()`,
      );

      const text = await app.evalJS<string | null>(
        `(function(){
          var bag = window.__tug.getCardStateBag("A");
          if (bag === null || bag.content === undefined) return null;
          var content = bag.content;
          // Current TugPromptEntry wrapper: { route, draft }.
          if (typeof content.route === "string" && content.draft && typeof content.draft.text === "string") {
            return content.draft.text;
          }
          // Legacy TugPromptEntry wrapper: { currentRoute, perRoute }.
          if (typeof content.currentRoute === "string" && typeof content.perRoute === "object" && content.perRoute !== null) {
            var inner = content.perRoute[content.currentRoute];
            if (inner && typeof inner.text === "string") return inner.text;
          }
          if (typeof content.text === "string") return content.text;
          return null;
        })()`,
      );
      expect(text).toBe(SEED_TEXT);

      // Second pass: the window-blur save path goes through
      // identical machinery; verify it also preserves content.
      // Anchor focus first so the resign produces a real blur.
      await app.nativeClickAtElement(`[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content`);
      await app.waitForCondition<boolean>(
        `window.__tug.getHasFocus() === true`,
        { timeoutMs: 2000 },
      );
      await app.simulateAppResign();
      await app.simulateAppBecomeActive();

      const textAfterCycle = await app.evalJS<string | null>(
        `(function(){
          var bag = window.__tug.getCardStateBag("A");
          if (bag === null || bag.content === undefined) return null;
          var content = bag.content;
          if (typeof content.route === "string" && content.draft && typeof content.draft.text === "string") {
            return content.draft.text;
          }
          if (typeof content.currentRoute === "string" && typeof content.perRoute === "object" && content.perRoute !== null) {
            var inner = content.perRoute[content.currentRoute];
            if (inner && typeof inner.text === "string") return inner.text;
          }
          if (typeof content.text === "string") return content.text;
          return null;
        })()`,
      );
      expect(textAfterCycle).toBe(SEED_TEXT);
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(`\n[at0018-async-content-race] log tail:\n${tail}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);
});
