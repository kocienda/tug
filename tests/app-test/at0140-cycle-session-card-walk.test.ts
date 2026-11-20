/**
 * at0140-cycle-session-card-walk.test.ts — ⌥⇥ rings the stop the caret was
 * in, Tab tours the session card's chrome, the disabled submit is skipped, the
 * editor stop parks, and the mouse exits cycling.
 *
 * One of the at0140-cycle-session-card split, a test to a file so each launch
 * fits its own budget; the others are `at0140-cycle-session-card-arrows`,
 * `-picker` and `-space-toggle`. The eight-step walk this file drives, why the
 * session card joins the focus cycle, and the shared selectors and opening
 * move are `cycle-session-card-fixture.ts`.
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
  EDITOR_STOP_RINGED,
  FOLD_HAS_KEY_VIEW,
  POPOVER_OPEN,
  ROUTE_HAS_KEY_VIEW,
  SHOULD_RUN,
  SUBMIT,
  SUBMIT_HAS_KEY_VIEW,
  TEST_TIMEOUT_MS,
  Z2_ARC,
  Z2_CONTEXT,
  Z2_JOBS,
  Z2_STATE,
  Z2_TIME,
  effortModelCapabilities,
  engageAndTabToRoute,
  hasKeyView,
} from "./cycle-session-card-fixture";

describe.skipIf(!SHOULD_RUN)("AT0140: the session card joins the focus cycle", () => {
  test(
    "⌥⇥ rings the stop the caret was in, Tab tours route → Claude Code → AI → mic → submit → STATE → TIME → CONTEXT → JOBS → ARC → editor → wrap (each Z4B chip + Z2 cell a leaf stop), skips the disabled submit when empty, and the editor stop parks",
    async () => {
      const app = await launchTugApp({ testName: "at0140-cycle-session-card" });
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

        // The connected body is up: the submit button mounts and is authored
        // into the cycle scope (a registered focusable).
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SUBMIT)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SUBMIT)});
            return el !== null && el.hasAttribute("data-tug-focusable");
          })()`,
          { timeoutMs: 6000 },
        );

        // (1) Put the caret in the editor (base mode). The card is not cycling
        // and the submit holds no key view.
        await app.body("A").nativeClickAtElement(EDITOR);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await app.body("A").evalJS<string | null>(CYCLING)).toBe("false");
        expect(await app.body("A").evalJS<boolean>(SUBMIT_HAS_KEY_VIEW)).toBe(false);

        // (2) Empty editor → ⌥⇥ rings the editor's stop, Tab wraps to the route.
        // The submit is disabled (its
        // empty-input gate), so it is NOT a Tab target — touring the live stops
        // (route → Claude Code → AI → STATE → … → ARC → fold → editor →
        // wrap) skips it: Tab steps from AI straight to the STATE cell,
        // never the submit.
        await engageAndTabToRoute(app);
        await app.nativeKey("Tab");
        // route → Claude Code: the Session and Project chips left the code route
        // with the Z4B diet (their names read in the pane title bar instead).
        await app.body("A").waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // Claude Code → AI: Mode / Model / Effort merged into this one chip.
        await app.body("A").waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // AI → mic. The mic is the toolbar's one unconditional stop: unlike the
        // submit it is never disabled, so an empty composer still stops here.
        await app.body("A").waitForCondition<boolean>(hasKeyView(DICTATE), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // mic → STATE (the disabled submit is skipped). Each Z2 cell is its own leaf stop, so Tab steps
        // cell-to-cell through the rest of the row.
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<boolean>(SUBMIT_HAS_KEY_VIEW)).toBe(false);
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_CONTEXT), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_JOBS), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_ARC), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // ARC → the fold control, the last thing in the Z2 row ([B03]).
        await app.body("A").waitForCondition<boolean>(FOLD_HAS_KEY_VIEW, { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // fold → editor. ARC is the row's last cell: the BTW cell went away
        // with the Z2 diet, and `/btw` reaches its placard by being asked rather
        // than by a stop. The BEAT stop went with the strip — the voice moved
        // to the masthead, which is pane chrome and takes no card-cycle stop.
        // Arriving by engine movement PARKS the stop ([P12]): the ring lands on
        // the editor's stop and the caret does not.
        await app.body("A").waitForCondition<boolean>(EDITOR_STOP_RINGED, { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);
        // Tab from the parked stop keeps walking the cycle and wraps to the
        // FIRST stop — the route group, leftmost in the toolbar row. The stop
        // has no caret to indent for.
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // ⌥⇥ off → back to the editor caret.
        await app.nativeKey("Tab", ["alt"]);
        await app.body("A").waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
        await app.body("A").waitForCondition<boolean>(EDITOR_FOCUSED, { timeoutMs: 6000 });

        // Type into the editor so the submit becomes actionable (and thus a
        // cycle stop).
        await app.nativeType("hello");
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SUBMIT)});
            return el !== null && el.closest(${JSON.stringify(`${CARD} [data-slot="tug-prompt-entry"]`)})
              ?.getAttribute("data-empty") === "false";
          })()`,
          { timeoutMs: 6000 },
        );

        // (3) Non-empty editor → the same entry, and now the submit is a live
        // stop on the tour ([P10] revised order).
        await engageAndTabToRoute(app);

        // (4) Tab tours the stops left→right, up to the editor: route → Claude
        // Code → AI → submit → STATE … ARC → editor. The editor is the
        // last stop — a text stop that carries the editor's own focus contract,
        // so landing on it grants the caret. With a draft in the field the tour
        // ends there (Tab is the editor's again — it indents); the empty-editor
        // wrap back to the route was pinned in (2).
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<boolean>(ROUTE_HAS_KEY_VIEW)).toBe(false);
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(DICTATE), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(SUBMIT_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // submit → the five cells, each its own leaf stop ([P10] revised):
        // STATE → TIME → CONTEXT → JOBS → ARC. Each carries the leaf key
        // view (and the blue ring) in turn — no arrow-roving. The fold
        // control follows ARC at the row's trailing edge ([B03]).
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<boolean>(SUBMIT_HAS_KEY_VIEW)).toBe(false);
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<boolean>(hasKeyView(Z2_STATE))).toBe(false);
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_CONTEXT), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_JOBS), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_ARC), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(FOLD_HAS_KEY_VIEW, { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // fold → editor: the control is the last leaf before it. Under KBF mode
        // the landing PARKS the stop rather than granting it ([P12]) — the ring
        // lands on the editor's stop and the caret does not, because arriving by
        // engine movement is a request to move the ring, not to type. Return or
        // any printable character grants the caret from here.
        await app.body("A").waitForCondition<boolean>(EDITOR_STOP_RINGED, { timeoutMs: 6000 });
        expect(
          await app.body("A").evalJS<boolean>(EDITOR_FOCUSED),
          "a stop arrived at by movement is parked — no caret",
        ).toBe(false);

        // (5) ⌥⇥ from the parked stop exits cycling and the resting landing
        // puts the caret back in the editor, draft intact.
        await app.nativeKey("Tab", ["alt"]);
        await app.body("A").waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
        await app.body("A").waitForCondition<boolean>(EDITOR_FOCUSED, { timeoutMs: 6000 });

        // (6) A status-cell popover opened from a Z2 cell must not be read as a
        // cycle exit ([P10]). Re-enter, Tab to TIME, Return to open its popover,
        // Escape to close: the popover pushes a nested focus mode on top of the
        // card's cycle scope, but the card is STILL cycling (its scope remains
        // on the stack), so closing the popover returns the ring to the SAME
        // cell — focus is NOT yanked to the editor and the cycle position is not
        // lost.
        await engageAndTabToRoute(app);
        // route→Claude Code→AI→mic→submit→STATE→TIME (6 Tabs). Two fewer
        // than before the Z4B diet (which took Session and Project off this
        // route), two fewer again since Mode / Model / Effort became one chip,
        // and one more since the Z5 mic joined the row (Spec S06).
        // The fold control sits after ARC, so it is not on this path.
        for (let i = 0; i < 6; i++) await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        // Return opens the TIME cell's popover (the cell `<button>` activates).
        await app.nativeKey("Return");
        await app.body("A").waitForCondition<boolean>(POPOVER_OPEN, { timeoutMs: 6000 });
        // While the popover is open the card's cycle scope is covered but still
        // on the stack — the card reads as cycling, NOT exited.
        expect(await app.body("A").evalJS<string | null>(CYCLING)).toBe("true");
        // Escape closes the popover. The ring returns to the TIME cell, the card
        // is still cycling, and DOM focus did not fall back to the editor.
        await app.nativeKey("Escape");
        await app.body("A").waitForCondition<boolean>(`${POPOVER_OPEN} === false`, { timeoutMs: 6000 });
        await app.body("A").waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        expect(await app.body("A").evalJS<string | null>(CYCLING)).toBe("true");
        expect(await app.body("A").evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);

        // (7) Comprehensive rule: USING THE MOUSE EXITS CYCLING. From step 6
        // (still cycling, cycle is the top mode), a CLICK on the editor ends the
        // cycle and returns the caret — no ⌥⇥ needed.
        await app.body("A").nativeClickAtElement(EDITOR);
        await app.body("A").waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
        await app.body("A").waitForCondition<boolean>(EDITOR_FOCUSED, { timeoutMs: 6000 });

        // (8) The mouse-exit rule also fires for a click on a Z4B chip: re-enter
        // cycling, then a CLICK on the AI chip exits the cycle (a mouse click
        // leaves keyboard cycling) AND opens the chip's sheet. Closing it then
        // restores the prompt-entry caret (the cycle has exited — no keyboard key
        // view — so close-focus falls to the editor, not the chip).
        await app.nativeKey("Tab", ["alt"]);
        await app.body("A").waitForCondition<boolean>(`${CYCLING} === "true"`, { timeoutMs: 6000 });
        await app.body("A").nativeClickAtElement(AI_CHIP);
        await app.body("A").waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
      } catch (err) {
        // A walk failure says only which stop was expected; the useful fact is
        // which stop the ring actually reached.
        const where = await app.evalJS<string>(
          `(function(){
            var els = document.querySelectorAll('[data-key-view-kbd]');
            var out = [];
            for (var i = 0; i < els.length; i++) {
              out.push((els[i].getAttribute('data-slot') || els[i].className)
                + (els[i].getAttribute('data-priority')
                  ? ':' + els[i].getAttribute('data-priority')
                  : ''));
            }
            return out.join(' | ');
          })()`,
        );
        process.stderr.write(`\n[at0140-cycle-session-card] ring on: ${where}\n`);
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0140-cycle-session-card] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
