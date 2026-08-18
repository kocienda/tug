/**
 * at0010-markdown-selection.test.ts — DOM selection on a
 * `tug-markdown-view` card round-trips across tab-switch and
 * cmd-tab, and the inactive-selection custom highlight paints
 * correctly while the card is dimmed.
 *
 * ## What this audits
 *
 * `selectionGuard` is the multi-card paint authority. Cards opt in
 * to its `cardRanges` by publishing a `Range` whenever the user
 * mutates their selection. Engine-managed cards (`tug-prompt-input`,
 * `tug-prompt-entry`) publish through `engine.onSelectionChanged`.
 * Markdown-view (no engine) publishes directly off
 * `document.selectionchange` once `selectionPublishKey` opt-in is
 * wired.
 *
 * Without that publish, `selectionGuard.cardRanges` stays empty for
 * markdown cards. `updatePaint` then treats the card as
 * "no published Range" — the inactive-selection highlight never
 * shows, and on tab-switch back the saved selection is gone. m10
 * gates that publish + paint round-trip.
 *
 * ## Test layout
 *
 * One pane with two cards: A = `fixture-markdown-50kb` (50KB baked-
 * in markdown, opted into `selectionPublishKey`), B = `fixture-markdown-50kb`
 * (the alternate tab — using the same component id keeps the layout
 * symmetric, sidesteps focus-mode / form-control variance).
 *
 * Steps:
 *
 *   1. Programmatically select a 20-character span inside A's first
 *      block. Read back `getCaretState("A")` as the saved snapshot.
 *   2. Tab-switch A → B. Assert A's snapshot still reachable via
 *      `getCaretState("A")`, and the inactive-selection highlight
 *      contains a Range whose `.toString()` matches the saved text.
 *   3. `simulateAppResign` + `simulateAppBecomeActive`. Assert
 *      A's snapshot still reachable. The window-blur dim flips
 *      every published range — including the focused card's — into
 *      the inactive highlight; the test is run while B is focused
 *      so this resign doesn't change the destination set.
 *   4. Tab-switch B → A. Assert A's snapshot still reachable AND
 *      `window.getSelection().toString()` matches — by then native
 *      `::selection` carries the focused card's range. ([L23],
 *      [A5])
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 * @covers tugdeck/src/components/tugways/text-selection-adapter.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-view.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const SELECTION_LENGTH = 20;

interface SeededSelection {
  text: string;
  blockIndex: number;
  startOffset: number;
  endOffset: number;
}

describe.skipIf(!SHOULD_RUN)("m10: markdown-view DOM selection round-trips through tab-switch + cmd-tab", () => {
  test("selection survives A→B→cmd-tab→A and paints in inactive-selection while dimmed", async () => {
    const app = await launchTugApp({
    // Foreground: drives a real app resign / hide / become-active cycle,
    // which only happens to an app that is actually active (pid-mode default
    // never activates).
    foreground: true, testName: "at0010-markdown-selection" });
    try {
      await app.enableDeckTrace(true);

      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "fixture-markdown-50kb", title: "MD A", closable: true },
            { id: "B", componentId: "fixture-markdown-50kb", title: "MD B", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 720, height: 480 },
              cardIds: ["A", "B"],
              activeCardId: "A",
              title: "",
              acceptsFamilies: ["fixture"],
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

      // Wait for A's baked content to render at least one block.
      await app.waitForCondition<boolean>(
        `(function(){
          var el = document.querySelector('[data-card-id="A"] .tugx-md-block');
          return el !== null && el.textContent !== null && el.textContent.length > ${SELECTION_LENGTH};
        })()`,
        { timeoutMs: 4000 },
      );

      // Anchor window focus on the markdown card before driving any
      // gesture. Same pattern as m14 / at0035-em — without an explicit
      // focus gesture, WKWebView's window-focus state can lag the
      // seed's `hasFocus: true` claim and downstream waits never
      // resolve.
      await app.nativeClickAtElement(`[data-card-id="A"] [data-tug-scroll-key="markdown-view"]`);
      await app.waitForCondition<boolean>(
        `window.__tug.getHasFocus() === true`,
        { timeoutMs: 2000 },
      );

      // Programmatically select a 20-char span inside A's first
      // block's first text node. Setting `window.getSelection()`
      // fires `selectionchange` synchronously in WebKit; the
      // listener installed by `tug-markdown-view` (selectionPublishKey="markdown-view")
      // publishes the Range to `selectionGuard.cardRanges["A"]`.
      const seeded = await app.evalJS<SeededSelection | null>(
        `(function(){
          var blockEls = document.querySelectorAll('[data-card-id="A"] .tugx-md-block');
          if (blockEls.length === 0) return null;
          // TugMarkdownView sets each block's content via innerHTML
          // from the parser cache, which preserves whitespace text
          // nodes between elements (e.g. a "\\n" between sibling
          // tags). The first text node a TreeWalker hits may be such
          // a whitespace node — len < 4 then trips the no-usable-
          // text-node guard. Walk forward across blocks until we
          // find a text node with enough non-whitespace content for
          // a stable selection seed.
          for (var b = 0; b < blockEls.length; b++) {
            var block = blockEls[b];
            var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            var node = walker.nextNode();
            while (node !== null) {
              var t = node.textContent;
              if (t !== null && t.replace(/^\\s+|\\s+$/g, "").length >= 4) {
                var len = Math.min(${SELECTION_LENGTH}, t.length);
                var range = document.createRange();
                range.setStart(node, 0);
                range.setEnd(node, len);
                var sel = window.getSelection();
                if (!sel) return null;
                sel.removeAllRanges();
                sel.addRange(range);
                return {
                  text: range.toString(),
                  blockIndex: b,
                  startOffset: 0,
                  endOffset: len,
                };
              }
              node = walker.nextNode();
            }
          }
          return null;
        })()`,
      );

      if (seeded === null) {
        throw new Error("[m10] could not seed a selection — first block had no usable text node");
      }

      // Wait for the listener to publish the range to selectionGuard.
      await app.waitForCondition<boolean>(
        `(function(){
          var s = window.__tug.getCaretState("A");
          return s !== null && s.kind === "range" && s.text === ${JSON.stringify(seeded.text)};
        })()`,
        { timeoutMs: 2000 },
      );

      const seededCaret = await app.getCaretState("A");
      expect(seededCaret).not.toBeNull();
      expect(seededCaret?.kind).toBe("range");
      if (seededCaret?.kind === "range") {
        expect(seededCaret.text).toBe(seeded.text);
      }

      // ---- Tab-switch A → B ----
      //
      // Card A's tab loses active state. Native `::selection`
      // collapses on the click; selectionGuard still has the saved
      // Range for A, so paint moves it into the inactive-selection
      // highlight.
      await app.nativeClickAtElement(`[data-testid="tug-tab-B"]`);
      await app.waitForCondition<boolean>(
        `window.__tug.getActiveCardId() === "B"`,
        { timeoutMs: 2000 },
      );

      // A's caret-state still readable from selectionGuard's
      // cardRanges — independent of native selection.
      const afterSwitchCaret = await app.getCaretState("A");
      expect(afterSwitchCaret).not.toBeNull();
      expect(afterSwitchCaret?.kind).toBe("range");
      if (afterSwitchCaret?.kind === "range") {
        expect(afterSwitchCaret.text).toBe(seeded.text);
      }

      // Inactive-selection highlight should contain a Range whose
      // text matches A's saved selection.
      const highlightProbe = await app.evalJS<{
        api: boolean;
        rangeCount: number;
        texts: string[];
      }>(
        `(function(){
          if (typeof CSS === "undefined" || CSS.highlights === undefined) {
            return { api: false, rangeCount: 0, texts: [] };
          }
          var hl = CSS.highlights.get("inactive-selection");
          if (!hl) return { api: true, rangeCount: 0, texts: [] };
          var texts = [];
          // Highlight extends Set<Range>.
          hl.forEach(function(r){ texts.push(r.toString()); });
          return { api: true, rangeCount: texts.length, texts: texts };
        })()`,
      );
      expect(highlightProbe.api, "CSS.highlights API expected to be present in WKWebView").toBe(true);
      expect(
        highlightProbe.texts.includes(seeded.text),
        `expected inactive-selection highlight to include "${seeded.text}"; saw ${JSON.stringify(highlightProbe.texts)}`,
      ).toBe(true);

      // ---- Cmd-tab cycle (resign + become-active while B focused) ----
      await app.simulateAppResign();
      await app.simulateAppBecomeActive();

      const afterCycleCaret = await app.getCaretState("A");
      expect(afterCycleCaret).not.toBeNull();
      expect(afterCycleCaret?.kind).toBe("range");
      if (afterCycleCaret?.kind === "range") {
        expect(afterCycleCaret.text).toBe(seeded.text);
      }

      // ---- Tab-switch B → A ----
      //
      // A becomes the active card again. selectionGuard's deck-store
      // subscription fires updatePaint which reads cardRanges["A"]
      // and `setBaseAndExtent`s native `::selection` to that Range.
      // The one-shot mousedown interceptor stops the click that
      // triggered the switch from immediately collapsing the
      // restored selection.
      await app.nativeClickAtElement(`[data-testid="tug-tab-A"]`);
      await app.waitForCondition<boolean>(
        `window.__tug.getActiveCardId() === "A"`,
        { timeoutMs: 2000 },
      );

      const restoredCaret = await app.getCaretState("A");
      expect(restoredCaret).not.toBeNull();
      expect(restoredCaret?.kind).toBe("range");
      if (restoredCaret?.kind === "range") {
        expect(restoredCaret.text).toBe(seeded.text);
      }

      // Native ::selection should now carry A's restored Range.
      // updatePaint runs synchronously inside the deck-store notify
      // handler, but the click that triggered the switch may have
      // queued a `selectionchange`; wait for the native selection
      // text to settle on the saved value.
      await app.waitForCondition<boolean>(
        `(function(){
          var sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return false;
          return sel.getRangeAt(0).toString() === ${JSON.stringify(seeded.text)};
        })()`,
        { timeoutMs: 2000 },
      );

      const nativeSelectionText = await app.evalJS<string>(
        `(function(){
          var sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return "";
          return sel.getRangeAt(0).toString();
        })()`,
      );
      expect(nativeSelectionText).toBe(seeded.text);
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(`\n[at0010-markdown-selection] log tail:\n${tail}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);
});
