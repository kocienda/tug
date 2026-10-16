/**
 * at0038-deactivation-inactive-paint-typed.test.ts — deactivation publishes
 * the user's selection to selectionGuard at the same DOM positions
 * the user actually selected ([AT0038] regression gate).
 *
 * Renamed from `m27-*` during the AT-series audit; the
 * original `m27` prefix collided with the AT0027 layout-state tag
 * (gated by `at0027-layout-state-persistence.test.ts`). AT0038 was
 * assigned in the canonical inventory at `tuglaws/at-series-inventory.md`.
 *
 * ## What this gates
 *
 * Manual repro: user types enough content into dev /
 * gallery-prompt-entry to make it scroll,
 * makes a selection, clicks any other card to deactivate. The
 * inactive-paint highlight ends up at the wrong text content — at
 * the absolute position in the component equal to the
 * relative/visible position when scrolled, instead of at the user's
 * actual selection.
 *
 * `paintMirrorAsInactive(publish)` rebuilds a DOM
 * Range from `mirror.selection` flat offsets via `flatToDom`. If
 * either the mirror's offsets are stale or the rebuilt Range's
 * DOM positions differ from the user's original Range, the
 * inactive highlight paints at the wrong place.
 *
 * This test verifies: at the moment of deactivation, the Range
 * landed in `selectionGuard.cardRanges` for the deactivated card has
 * the SAME DOM start/end (anchor/focus paths) as the user's
 * pre-deactivation selection in `window.getSelection()`.
 *
 * ## Test scenarios
 *
 * Two scenarios per target card:
 *   - SEED — bag.content is pre-seeded with text + selection +
 *     scrollTop; the engine restores it on mount; we deactivate.
 *   - TYPE — content is typed via `nativeType`; selection is set
 *     programmatically via the live DOM after user-driven typing
 *     populates the editor.
 *
 * Three cards × two scenarios = six tests. Each clicks a sibling
 * tab to deactivate, then asserts the cardRanges Range matches the
 * pre-deactivation live Range.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * Foreground: the selection this publishes lives in a CM6 editor, and CM6
 * tracks its selection from `view.hasFocus` — real DOM focus. A background
 * window’s document never has focus, so there is no live selection for
 * deactivation to hand to the inactive-selection highlight.
 *
 * Cut from `at0038-deactivation-inactive-paint` to fit the 20 s budget. This
 * file carries type-and-scroll; `at0038-deactivation-inactive-paint-seeded`
 * carries the seeded and the live-selection scenarios. The deck, the content
 * and the range snapshots are `deactivation-paint-fixture.ts`.
 *
 * @family at0038-deactivation-inactive-paint
 *
 * @foreground
 *
 * @covers tugdeck/src/engine-hooks.ts
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/focus-transfer.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import {
  PROMPT_INPUT_SELECTOR,
  SCROLLER_SELECTOR,
  SEED_LINES,
  SEED_SCROLL_TOP,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  deckShape,
  pause,
  snapshotCardRange,
  snapshotLiveRange,
} from "./deactivation-paint-fixture";

describe.skipIf(!SHOULD_RUN)(
  "m38: deactivation publishes inactive paint at the user's exact DOM position",
  () => {
    test(
      "gallery-prompt-entry — TYPE-and-SCROLL then deactivate preserves scroll + selection",
      async () => {
        const app = await launchTugApp({
          testName: "at0027-type-gallery-prompt-entry",
          foreground: true,
        });
        try {
          await app.enableDeckTrace(true);
          // Empty seed — user types from scratch.
          await app.seedDeckState({
            state: deckShape("gallery-prompt-entry"),
            cardStates: {},
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );
          await app.awaitEngineReady("A");
          // Initial layout settle — let the engine ResizeObserver
          // fire once for the mounted editor before we start typing.
          await pause(150);

          // Click into A's editor.
          await app.nativeClickAtElement(`[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}`);
          await app.waitForCondition<boolean>(
            `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT_SELECTOR)})`,
          );
          await pause(100);

          // Type the content one line at a time with a Return
          // keypress between lines. Real typing is paced over many
          // tens of milliseconds per character; ramming all 30 lines
          // in one burst doesn't give the engine's input-handler /
          // autoResize / scrollCaretIntoView / ResizeObserver /
          // mirror chain time to commit between characters. We chunk
          // by line and pause so each line's effects settle before
          // the next.
          //
          // `nativeType` accepts ASCII-only and rejects "\n" (no
          // VirtualKeyMap entry). Use `nativeKey("Return")` between
          // lines — the engine's beforeinput handler converts the
          // resulting `insertParagraph` to `insertLineBreak`, which
          // produces a `<br>` (matching the engine's content model).
          for (let i = 0; i < SEED_LINES.length; i++) {
            await app.nativeType(SEED_LINES[i]);
            await pause(40);
            if (i < SEED_LINES.length - 1) {
              await app.nativeKey("Return");
              await pause(40);
            }
          }
          // Wait for the engine's getText to reflect the typed
          // content. The engine reads from DOM via
          // `getEmCardState`; this waits until DOM and engine
          // agree.
          await app.waitForCondition<boolean>(
            `(function(){
              var s = window.__tug.getEmCardState("A");
              return s !== null && s.text.length > 800;
            })()`,
            { timeoutMs: 4000 },
          );
          await pause(200);

          // Native-scroll the editor — mimics mouse-wheel scrolling.
          // CM6 owns scroll on `.cm-scroller`, not on the contenteditable.
          await app.evalJS<void>(
            `(function(){
              var ed = document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}');
              ed.scrollTop = ${SEED_SCROLL_TOP};
            })()`,
          );
          // Wait for the scroll listener to update mirror (settle).
          await app.waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}');
              return Math.abs(ed.scrollTop - ${SEED_SCROLL_TOP}) < 4;
            })()`,
            { timeoutMs: 2000 },
          );
          await pause(150);

          // Native-select a span. Pick text nodes that are visible
          // at the current scroll so WebKit doesn't auto-scroll on
          // setBaseAndExtent. With scrollTop=120 and ~24px line
          // height, the visible window starts ~5 lines in;
          // nodes[10..14] should be in that window.
          await app.evalJS<void>(
            `(function(){
              var ed = document.querySelector('[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}');
              ed.focus();
              var walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
              var nodes = [];
              var t;
              while ((t = walker.nextNode())) nodes.push(t);
              if (nodes.length < 16) throw new Error("not enough text nodes: " + nodes.length);
              var startNode = nodes[10];
              var endNode = nodes[12];
              var range = document.createRange();
              range.setStart(startNode, 5);
              range.setEnd(endNode, 10);
              var sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            })()`,
          );
          // Wait for the selectionchange listener to update mirror.
          await app.waitForCondition<boolean>(
            `(function(){
              var s = window.__tug.getEmCardState("A");
              return s !== null && s.engineSelection !== null;
            })()`,
            { timeoutMs: 2000 },
          );
          await pause(150);

          const liveBefore = await snapshotLiveRange(app, "A");
          expect(liveBefore).not.toBeNull();
          const scrollBefore = await app.evalJS<number>(
            `document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}').scrollTop`,
          );

          // Click into B's editor to deactivate A — the user-action
          // moment.
          await app.nativeClickAtElement(
            `[data-card-id="B"] [data-tug-state-key="gallery-input/size/sm"]`,
          );
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && (window.__tug.getActiveCardId() === "B")`,
            { timeoutMs: 2000 },
          );
          // Settle window for transferFocusForActivation +
          // selectionGuard.updatePaint + any post-deactivation
          // ResizeObserver firings.
          await pause(200);

          await app.waitForCondition<boolean>(
            `(function(){
              if (typeof CSS === "undefined" || !CSS.highlights) return false;
              var h = CSS.highlights.get("inactive-selection");
              if (!h) return false;
              var iter = h.values ? h.values() : h[Symbol.iterator]();
              var step = iter.next();
              var ed = document.querySelector('[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}');
              if (!ed) return false;
              while (!step.done) {
                if (ed.contains(step.value.startContainer)) return true;
                step = iter.next();
              }
              return false;
            })()`,
            { timeoutMs: 2000 },
          );
          const inactiveAfter = await snapshotCardRange(app, "A");
          const scrollAfter = await app.evalJS<number>(
            `document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}').scrollTop`,
          );

          if (
            JSON.stringify(inactiveAfter) !== JSON.stringify(liveBefore) ||
            Math.abs(scrollBefore - scrollAfter) > 8
          ) {
            process.stderr.write(
              `\n[at0027-diag type-and-scroll] LIVE-BEFORE=${JSON.stringify(liveBefore)} INACTIVE-AFTER=${JSON.stringify(inactiveAfter)} SCROLL-BEFORE=${scrollBefore} SCROLL-AFTER=${scrollAfter}\n`,
            );
          }
          expect(inactiveAfter).toEqual(liveBefore!);
          expect(Math.abs(scrollBefore - scrollAfter)).toBeLessThanOrEqual(8);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
