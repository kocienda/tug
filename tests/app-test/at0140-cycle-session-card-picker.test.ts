/**
 * at0140-cycle-session-card-picker.test.ts — committing a settings picker
 * opened from a cycle stop keeps cycling and returns the ring to the
 * originating chip ([P15] retain).
 *
 * One of the at0140-cycle-session-card split, a test to a file so each launch
 * fits its own budget; the others are `at0140-cycle-session-card-walk`,
 * `-arrows` and `-space-toggle`. Why the session card joins the focus cycle,
 * and the shared selectors and opening move, are
 * `cycle-session-card-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/hooks/
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/cards/prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-chip.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-config-sheet.tsx
 * @covers tugdeck/src/lib/model-label.ts
 * @covers tugdeck/src/components/tugways/cards/session-placard.tsx
 * @covers tugdeck/src/components/tugways/tug-popover.tsx
 * @family at0140-cycle-session-card
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  AI_CHIP,
  CLAUDE_CHIP,
  CYCLING,
  EDITOR,
  SHEET_OPTION,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  engageAndTabToRoute,
  hasKeyView,
} from "./cycle-session-card-fixture";

describe.skipIf(!SHOULD_RUN)("AT0140: the session card joins the focus cycle", () => {
  test(
    "committing a settings picker opened from a cycle stop keeps cycling and returns the ring to the originating chip ([P15] retain)",
    async () => {
      const app = await launchTugApp({ testName: "at0140-cycle-session-card-picker" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 760, height: 560 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(AI_CHIP)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Caret in the editor, then ⌥⇥ + Tab to the route: engaging rings the
        // editor's own stop, and the first Tab out of it wraps to the route.
        await app.body("A").nativeClickAtElement(EDITOR);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await engageAndTabToRoute(app);

        // Tab to the AI chip and open its sheet by keyboard (so the engine owns
        // close-focus and the cycle is preserved underneath).
        // route→Claude Code→AI (2 Tabs).
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Return");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET_OPTION)}) !== null`,
          { timeoutMs: 6000 },
        );
        // The sheet (a nested trap) covers the cycle scope but the card is STILL
        // cycling — opening a picker is not an exit.
        expect(await app.body("A").evalJS<string | null>(CYCLING)).toBe("true");

        // Return commits the sheet's default (OK). Under the card's chosen
        // disposition (`SESSION_CYCLE_PICKER_COMMIT_DISPOSITION = "retain"`) committing
        // a setting from a cycle stop KEEPS the card cycling and returns the ring
        // to the originating chip — the user can keep cycling. (The framework
        // supports "relinquish" too: commit exits cycling, caret to the prompt.)
        await app.nativeKey("Return");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET_OPTION)}) === null`,
          { timeoutMs: 6000 },
        );
        await app.body("A").waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        expect(
          await app.body("A").evalJS<string | null>(CYCLING),
          "committing a cycle-stop picker keeps the card cycling (retain)",
        ).toBe("true");
        expect(
          await app.body("A").evalJS<boolean>(hasKeyView(AI_CHIP)),
          "the ring returns to the originating chip (retain)",
        ).toBe(true);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0140-cycle-session-card-picker] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
