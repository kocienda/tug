/**
 * at0140-cycle-session-card-arrows.test.ts — arrows give the session card's
 * focus cycle a 2D feel: a toolbar ring and a seam to the status row; a
 * disabled stop is skipped; the editor is not an arrow stop.
 *
 * One of the at0140-cycle-session-card split, a test to a file so each launch
 * fits its own budget; the others are `at0140-cycle-session-card-walk`,
 * `-picker` and `-space-toggle`. Why the session card joins the focus cycle,
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
  CARD,
  CLAUDE_CHIP,
  CYCLING,
  DICTATE,
  EDITOR,
  EDITOR_FOCUSED,
  ROUTE_HAS_KEY_VIEW,
  SHOULD_RUN,
  SUBMIT,
  SUBMIT_HAS_KEY_VIEW,
  TEST_TIMEOUT_MS,
  Z2_STATE,
  Z2_TIME,
  effortModelCapabilities,
  engageAndTabToRoute,
  hasKeyView,
} from "./cycle-session-card-fixture";

describe.skipIf(!SHOULD_RUN)("AT0140: the session card joins the focus cycle", () => {
  test(
    "arrows give the cycle a 2D feel: a toolbar ring + a seam to the status row; a disabled stop is skipped; the editor is not an arrow stop",
    async () => {
      const app = await launchTugApp({ testName: "at0140-cycle-session-card-arrows" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 760, height: 560 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        // Seed an effort-capable model so the EFFORT chip is enabled and
        // joins the Tab cycle (a disabled chip drops out — see helper).
        await app.ingestSessionMetadata("A", effortModelCapabilities());
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SUBMIT)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Caret in the editor (base mode).
        await app.body("A").nativeClickAtElement(EDITOR);
        await new Promise((resolve) => setTimeout(resolve, 150));

        // ---- Phase 1: a disabled stop is skipped --------------------------------
        // Empty editor → the submit is disabled. Engage and reach the route; Tab to the
        // AI chip, then ArrowRight steps to the mic — the row's one
        // unconditional stop — and from there resolves toward the (disabled)
        // submit, which the navigator must NOT strand the ring on: it skips to
        // the next live stop (STATE, the Z2 row's first member), never beeping.
        await engageAndTabToRoute(app);
        // route→Claude Code→AI (2 Tabs).
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("ArrowRight");
        await app.body("A").waitForCondition<boolean>(hasKeyView(DICTATE), { timeoutMs: 6000 });
        await app.nativeKey("ArrowRight");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<boolean>(SUBMIT_HAS_KEY_VIEW)).toBe(false);

        // ArrowUp from the Z2 row seams back to the toolbar (its first member,
        // the route group) — and NOT to the editor, which is excluded from the
        // grid.
        await app.nativeKey("ArrowUp");
        await app.body("A").waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);

        // Exit, type so the full toolbar (incl. submit) is live.
        await app.nativeKey("Tab", ["alt"]);
        await app.body("A").waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
        await app.body("A").waitForCondition<boolean>(EDITOR_FOCUSED, { timeoutMs: 6000 });
        await app.nativeType("hello");
        await app.body("A").waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(SUBMIT)});return el!==null && el.closest(${JSON.stringify(`${CARD} [data-slot="tug-prompt-entry"]`)})?.getAttribute("data-empty")==="false";})()`,
          { timeoutMs: 6000 },
        );

        // ---- Phase 2: the toolbar ring + the cross-row seam ---------------------
        await engageAndTabToRoute(app);

        // Tab to the AI chip (a leaf), then Left/Right ring the toolbar.
        // route→Claude Code→AI (2 Tabs).
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("ArrowRight");
        await app.body("A").waitForCondition<boolean>(hasKeyView(DICTATE), { timeoutMs: 6000 });
        await app.nativeKey("ArrowRight");
        await app.body("A").waitForCondition<boolean>(SUBMIT_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // Right off the last toolbar member wraps the closed ring back to the
        // row's first — the route group, now that the fold seat has moved
        // down into Z2 ([B03]).
        await app.nativeKey("ArrowRight");
        await app.body("A").waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // Left reverses (route → submit, the ring's other edge).
        await app.nativeKey("ArrowLeft");
        await app.body("A").waitForCondition<boolean>(SUBMIT_HAS_KEY_VIEW, { timeoutMs: 6000 });

        // The cross-row seam: Down from a toolbar chip enters the status row; Up
        // returns to the toolbar. Arrow back to the AI chip first.
        await app.nativeKey("ArrowLeft"); // submit → mic
        await app.body("A").waitForCondition<boolean>(hasKeyView(DICTATE), { timeoutMs: 6000 });
        await app.nativeKey("ArrowLeft"); // mic → AI
        await app.body("A").waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("ArrowDown");
        // Down from a toolbar chip enters the Z2 row at its first member —
        // STATE — and Right from there is TIME. The fold control is the
        // row's LAST member ([B03]).
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        await app.nativeKey("ArrowRight");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        await app.nativeKey("ArrowUp");
        await app.body("A").waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // Across the whole arrow sequence the caret never landed in the editor
        // and the card never left cycling (no dead-end, no beep).
        expect(await app.body("A").evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);
        expect(await app.body("A").evalJS<string | null>(CYCLING)).toBe("true");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0140-cycle-session-card-arrows] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
