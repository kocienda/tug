/**
 * at0023-cross-card-selection.test.ts — drag-select across two
 * markdown-view cards. The paint system must not crash, and the
 * selection's resting state must be self-consistent.
 *
 * ## What this audits
 *
 * The browser's single-`Selection` model lets a single drag span
 * any text in the document.
 * `selectionGuard.updateCardDomSelection` accepts a Range keyed
 * by ONE cardId — its design assumption is "one card owns the
 * active selection at any time." A cross-card range would either
 * get mis-attributed (whoever published last wins) or, worse,
 * throw inside paint when `range.commonAncestorContainer` isn't
 * under any registered card root.
 *
 * Expected outcome (per the plan): WebKit naturally scopes drag
 * selections to the contenteditable / boundary the drag began in.
 * If a real cross-card range survives, the test logs it
 * informationally for [25C] follow-up — no fail, since the audit
 * is about the paint system not crashing, not specific selection
 * behavior.
 *
 * ## Test layout
 *
 * Two side-by-side panes, each with a single
 * `fixture-markdown-50kb` card (50KB baked-in static markdown).
 * `nativeDragElement` from card A's content into card B's
 * content. Inspect:
 *
 *   1. `window.getSelection()` doesn't throw, and
 *      `range.toString()` is callable.
 *   2. `__tug.getSelection(cardId)` for each card returns either
 *      a snapshot or `null` — never throws.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 * @covers tugdeck/src/components/tugways/text-selection-adapter.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-view.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!SHOULD_RUN)("m23: cross-card drag-select doesn't crash the paint system", () => {
  test("native-drag from MV card A into MV card B yields a self-consistent selection state", async () => {
    const app = await launchTugApp({ testName: "at0023-cross-card-selection" });
    try {
      await app.enableDeckTrace(true);

      // Side-by-side panes so both MV cards render simultaneously.
      // Single-pane layouts only render the active card; cross-card
      // selection is impossible there.
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
              size: { width: 480, height: 360 },
              cardIds: ["A"],
              activeCardId: "A",
              title: "",
              acceptsFamilies: ["fixture"],
            },
            {
              id: "p2",
              position: { x: 560, y: 40 },
              size: { width: 480, height: 360 },
              cardIds: ["B"],
              activeCardId: "B",
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
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
      );

      // Wait for both cards' baked-in content to render.
      await app.waitForCondition<boolean>(
        `(function(){
          var a = document.querySelector('[data-card-id="A"] [data-tug-scroll-key="markdown-view"]');
          var b = document.querySelector('[data-card-id="B"] [data-tug-scroll-key="markdown-view"]');
          return a !== null && b !== null && a.scrollHeight > 200 && b.scrollHeight > 200;
        })()`,
        { timeoutMs: 4000 },
      );

      // Drag-select from a point inside A's content to a point
      // inside B's content. Use viewport bounds because the cards
      // live in different panes.
      await app.nativeDragElement(
        `[data-card-id="A"] [data-tug-scroll-key="markdown-view"]`,
        { selector: `[data-card-id="B"] [data-tug-scroll-key="markdown-view"]` },
      );

      // Window-level selection: must not throw, must be self-consistent.
      const winSel = await app.evalJS<{
        rangeCount: number;
        rangeStart: { tag: string; cardOf: string | null } | null;
        rangeEnd: { tag: string; cardOf: string | null } | null;
        text: string;
        threw: string | null;
      }>(
        `(function(){
          try {
            var sel = window.getSelection();
            if (!sel) return { rangeCount: 0, rangeStart: null, rangeEnd: null, text: "", threw: null };
            var rc = sel.rangeCount;
            if (rc === 0) return { rangeCount: 0, rangeStart: null, rangeEnd: null, text: "", threw: null };
            var r = sel.getRangeAt(0);
            function describe(node) {
              if (!node) return null;
              var el = node.nodeType === 1 ? node : node.parentElement;
              if (!el) return null;
              var card = el.closest("[data-card-id]");
              return {
                tag: el.tagName,
                cardOf: card ? card.getAttribute("data-card-id") : null,
              };
            }
            return {
              rangeCount: rc,
              rangeStart: describe(r.startContainer),
              rangeEnd: describe(r.endContainer),
              text: r.toString(),
              threw: null,
            };
          } catch (e) {
            return { rangeCount: -1, rangeStart: null, rangeEnd: null, text: "", threw: String(e) };
          }
        })()`,
      );

      // Paint must not crash.
      expect(winSel.threw).toBeNull();

      // Diagnostic log on cross-card. NOT a fail — the audit is
      // about the paint system not crashing.
      if (winSel.rangeCount > 0 && winSel.rangeStart && winSel.rangeEnd) {
        const sameCard = winSel.rangeStart.cardOf === winSel.rangeEnd.cardOf;
        const bothInCardSet =
          (winSel.rangeStart.cardOf === "A" || winSel.rangeStart.cardOf === "B") &&
          (winSel.rangeEnd.cardOf === "A" || winSel.rangeEnd.cardOf === "B");
        if (bothInCardSet && !sameCard) {
          process.stderr.write(
            `[m23] audit: cross-card range observed — start=${winSel.rangeStart.cardOf} end=${winSel.rangeEnd.cardOf}; ` +
              `text length=${winSel.text.length}. Surfaces the [AT0023] gap for follow-up.\n`,
          );
        }
      }

      // Per-card __tug.getSelection() must return either a snapshot
      // or null — never throw.
      const aSel = await app.getSelection("A");
      const bSel = await app.getSelection("B");
      expect(aSel === null || typeof aSel === "object").toBe(true);
      expect(bSel === null || typeof bSel === "object").toBe(true);
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(`\n[at0023-cross-card-selection] log tail:\n${tail}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);
});
