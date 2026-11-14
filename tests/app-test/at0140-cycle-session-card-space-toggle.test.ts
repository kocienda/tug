/**
 * at0140-cycle-session-card-space-toggle.test.ts — Space toggles an info
 * popover ([P02] space-dismiss): Space opens the STATE popover from its stop,
 * a second Space closes it and the ring returns to the stop.
 *
 * One of the at0140-cycle-session-card split, a test to a file so each launch
 * fits its own budget; the others are `at0140-cycle-session-card-walk`,
 * `-arrows` and `-picker`. Why the session card joins the focus cycle, and the
 * shared selectors and opening move, are `cycle-session-card-fixture.ts`.
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
  EDITOR_FOCUSED,
  POPOVER_OPEN,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  Z2_STATE,
  engageAndTabToRoute,
  hasKeyView,
} from "./cycle-session-card-fixture";

describe.skipIf(!SHOULD_RUN)("AT0140: the session card joins the focus cycle", () => {
  test(
    "Space toggles an info popover ([P02] space-dismiss): Space opens the STATE popover from its stop, a second Space closes it and the ring returns to the stop",
    async () => {
      const app = await launchTugApp({ testName: "at0140-cycle-session-card-space-toggle" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 760, height: 560 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(Z2_STATE)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Caret in the editor, then ⌥⇥ + Tab to the route: engaging rings the
        // editor's own stop, and the first Tab out of it wraps to the route.
        await app.body("A").nativeClickAtElement(EDITOR);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await engageAndTabToRoute(app);

        // Tab off the route popup onto the Claude Code chip, then the AI chip —
        // toolbar leaves — then ArrowDown seams from the toolbar straight to the
        // Z2 row's first member — STATE — independent of which stops are live.
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("ArrowDown");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });

        // Space OPENS the STATE popover (the cell button activates).
        await app.nativeKey(" ");
        await app.body("A").waitForCondition<boolean>(POPOVER_OPEN, { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<string | null>(CYCLING)).toBe("true");

        // A SECOND Space CLOSES it (space-dismiss): the popover dismisses, the ring
        // returns to the STATE cell, the card stays cycling, and DOM focus does not
        // fall back to the editor.
        await app.nativeKey(" ");
        await app.body("A").waitForCondition<boolean>(`${POPOVER_OPEN} === false`, { timeoutMs: 6000 });
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<string | null>(CYCLING)).toBe("true");
        expect(await app.body("A").evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);

        // There is no second stop to check the toggle against any more: the
        // BEAT label was the other one, and it retired with the Z2 strip when
        // the voice moved into the pane's masthead. The label is still a
        // popover trigger there, but as pointer-only chrome — a card-cycle
        // stop that walked out of the card and into its chrome would cross an
        // ownership boundary.
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0140-cycle-session-card-space-toggle] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
