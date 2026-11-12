/**
 * at0010-cold-boot-selection.test.ts — DOM selection restore across
 * full Tug.app process restart on a markdown fixture card.
 *
 * ## Two-phase contract
 *
 * | Phase | Tugbank state at launch | Action                        | Assertion                                            |
 * |-------|-------------------------|-------------------------------|------------------------------------------------------|
 * | A     | empty (fresh temp DB)   | seed deck → anchor a 20-char  | tugbank disk has a populated `domSelection` with     |
 * |       |                         | range in card → quitGracefully | non-empty anchor/focus paths                        |
 * | B     | populated (from A)      | re-seed deck with bag from    | `__tug.getCaretState("A")` returns the saved range  |
 * |       |                         | disk → wait for ready         | AND native `::selection` paints it                   |
 *
 * Phase A failure ⇒ selection capture didn't reach disk on quit.
 * Phase B failure ⇒ load + apply at fresh mount didn't re-anchor
 * the selection.
 *
 * ## Why `fixture-markdown-1kb`, not `fixture-markdown-50kb`
 *
 * 1KB of static markdown fits in one viewport at the fixture card's
 * default size, so the selection the test anchors is on screen without
 * scrolling. The saved `domSelection` paths (which are child-index
 * sequences rooted at the card boundary) reference DOM nodes that
 * exist in both Phase A and Phase B.
 *
 * ## Why seedDeckState in Phase B
 *
 * See the matching note in `at0014-cold-boot-scroll.test.ts`. Test
 * mode skips main.tsx's tugbank-driven rehydrate; the harness
 * reads the bag back via the `tugbank` CLI and re-injects it.
 *
 * ## Status: PASSING (in the default Justfile sweep)
 *
 * With every block rendered, the saved `domSelection` paths resolve
 * to the same DOM nodes on re-mount and selectionGuard re-anchors the
 * range.
 *
 * Run individually via:
 *
 *     just test-in-app-fast at0010-cold-boot-selection.test.ts
 *
 * ## Closes
 *
 * [AT0010] cold-boot variant. The existing `at0010-markdown-selection.test.ts`
 * gates tab-switch + cmd-tab round-trips inside one Tug.app
 * process; this file adds the cross-process variant.
 *
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/lib/tugbank-client.ts
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 * @covers tugdeck/src/fixtures/fixture-markdown-static.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugapp/Sources/TugbankClient.swift
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const SELECTION_LENGTH = 20;

const CARD_ID = "A";

interface SeededSelection {
  text: string;
  startOffset: number;
  endOffset: number;
}

function deckShape() {
  return {
    cards: [
      { id: CARD_ID, componentId: "fixture-markdown-1kb", title: "MD A", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 720, height: 480 },
        cardIds: [CARD_ID],
        activeCardId: CARD_ID,
        title: "",
        acceptsFamilies: ["fixture"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("m10: selection cold-boot across full process restart", () => {
  test(
    "DOM selection survives quitGracefully + relaunch",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);

      try {
        let seeded: SeededSelection;

        // ── Phase A: seed deck, anchor selection, quitGracefully. ──
        {
          const app = await launchTugApp({
            testName: "at0010-cold-boot-selection-A",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });

          await app.seedDeckState({
            state: deckShape(),
            focusCardId: CARD_ID,
          });

          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD_ID)})`,
          );

          // The render window must cover the head of the document, in BOTH
          // phases, or the saved `nodeToPath` resolves against a different set
          // of blocks. The fixture asks for `followBottom: false`, but the
          // region still boots scrolled, so put it at the head explicitly —
          // through the event, which tells SmartScroll to disengage
          // follow-bottom AND apply the position (a raw `scrollTop` write
          // races the bake-in and gets re-slammed).
          await app.body("A").evalJS<void>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(`[data-card-id="A"] [data-tug-scroll-key="markdown-view"]`)});
              if (el === null) return;
              el.dispatchEvent(new CustomEvent('tug-region-scroll-set', {
                detail: { top: 0, left: 0 },
                cancelable: true,
                bubbles: false,
              }));
            })()`,
          );
          await app.body("A").waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(`[data-card-id="A"] [data-tug-scroll-key="markdown-view"]`)});
              return el !== null && el.scrollTop <= 4;
            })()`,
            { timeoutMs: 3000 },
          );
          // Wait for the document to render: the head block must be
          // present AND the block count must be stable across two
          // consecutive observations. The fixture renders the same
          // document in full on every mount, which keeps the
          // `nodeToPath` capture stable across the relaunch + restore
          // (Phase B mounts the same fixture and resolves the saved
          // path back to the same node).
          await app.body(CARD_ID).waitForCondition<boolean>(
            `(function(){
              var first = document.querySelector('[data-card-id=${JSON.stringify(CARD_ID)}] .tugx-md-block');
              if (first === null || first.getAttribute("data-content-hash") === null) return false;
              if (first.textContent === null || first.textContent.length <= ${SELECTION_LENGTH}) return false;
              var cardRoot = document.querySelector('[data-card-host][data-card-id=${JSON.stringify(CARD_ID)}]');
              if (cardRoot === null) return false;
              var count = cardRoot.querySelectorAll('.tugx-md-block').length;
              var w = window;
              if (w.__at0010ColdBootBlockCount === count) return true;
              w.__at0010ColdBootBlockCount = count;
              return false;
            })()`,
            { timeoutMs: 4000 },
          );

          // Anchor focus on the card before driving the selection
          // gesture (mirrors at0010-markdown-selection's preflight).
          await app.body(CARD_ID).nativeClickAtElement(`[data-card-id="${CARD_ID}"] [data-tug-scroll-key="markdown-view"]`);
          // The click's anchor is the deck's: the card it activated. (The
          // deck's `hasFocus` is seeded true by the fixture, so it never said
          // anything, and a body's `document.hasFocus()` is false in a window
          // the harness never activates.)
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() === ${JSON.stringify(CARD_ID)}`,
            { timeoutMs: 2000 },
          );

          // Programmatically anchor a 20-char range inside the first
          // block's first text node. The fixture's selectionchange
          // listener publishes the Range to selectionGuard.cardRanges["A"].
          const seededOpt = await app.body(CARD_ID).evalJS<SeededSelection | null>(
            `(function(){
              var blockEls = document.querySelectorAll('[data-card-id=${JSON.stringify(CARD_ID)}] .tugx-md-block');
              if (blockEls.length === 0) return null;
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
          if (seededOpt === null) {
            throw new Error("[at0010-cold-boot] could not seed a selection — first block had no usable text node");
          }
          seeded = seededOpt;

          // Wait for the publish to land in selectionGuard.
          await app.body(CARD_ID).waitForCondition<boolean>(
            `(function(){
              var s = window.__tug.getCaretState(${JSON.stringify(CARD_ID)});
              return s !== null && s.kind === "range" && s.text === ${JSON.stringify(seeded.text)};
            })()`,
            { timeoutMs: 2000 },
          );

          await app.quitGracefully();
        }

        // ── Phase A assertion: bag has populated domSelection. ──
        const onDisk = tugbankRead<{
          domSelection?: {
            anchorPath?: number[];
            anchorOffset?: number;
            focusPath?: number[];
            focusOffset?: number;
          } | null;
        }>(
          tugbankPath,
          "dev.tugapp.deck.cardstate",
          CARD_ID,
        );
        expect(onDisk).not.toBeNull();
        expect(onDisk?.type).toBe("json");
        const domSelection = onDisk?.value?.domSelection;
        expect(domSelection).toBeTruthy();
        expect(Array.isArray(domSelection?.anchorPath)).toBe(true);
        expect((domSelection?.anchorPath ?? []).length).toBeGreaterThan(0);
        expect(Array.isArray(domSelection?.focusPath)).toBe(true);
        expect((domSelection?.focusPath ?? []).length).toBeGreaterThan(0);

        // ── Phase B: relaunch, re-seed bag, assert restore. ──
        {
          const app = await launchTugApp({
            testName: "at0010-cold-boot-selection-B",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            const bagRecord: Record<string, unknown> = {};
            bagRecord[CARD_ID] = onDisk!.value;

            await app.seedDeckState({
              state: deckShape(),
              cardStates: bagRecord,
              focusCardId: CARD_ID,
            });

            await app.waitForCondition<boolean>(
              `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD_ID)})`,
            );

            // The render window must cover the head of the document, in BOTH
            // phases, or the saved `nodeToPath` resolves against a different set
            // of blocks. The fixture asks for `followBottom: false`, but the
            // region still boots scrolled, so put it at the head explicitly —
            // through the event, which tells SmartScroll to disengage
            // follow-bottom AND apply the position (a raw `scrollTop` write
            // races the bake-in and gets re-slammed).
            await app.body("A").evalJS<void>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(`[data-card-id="A"] [data-tug-scroll-key="markdown-view"]`)});
                if (el === null) return;
                el.dispatchEvent(new CustomEvent('tug-region-scroll-set', {
                  detail: { top: 0, left: 0 },
                  cancelable: true,
                  bubbles: false,
                }));
              })()`,
            );
            await app.body("A").waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(`[data-card-id="A"] [data-tug-scroll-key="markdown-view"]`)});
                return el !== null && el.scrollTop <= 4;
              })()`,
              { timeoutMs: 3000 },
            );
            // Wait for the document to render: the head block must be
            // present AND the block count must be stable — the same
            // document as Phase A, so the same path indices resolve to
            // the same node.
            await app.body(CARD_ID).waitForCondition<boolean>(
              `(function(){
                var first = document.querySelector('[data-card-id=${JSON.stringify(CARD_ID)}] .tugx-md-block');
                if (first === null || first.getAttribute("data-content-hash") === null) return false;
                if (first.textContent === null || first.textContent.length <= ${SELECTION_LENGTH}) return false;
                var cardRoot = document.querySelector('[data-card-host][data-card-id=${JSON.stringify(CARD_ID)}]');
                if (cardRoot === null) return false;
                var count = cardRoot.querySelectorAll('.tugx-md-block').length;
                var w = window;
                if (w.__at0010ColdBootBlockCountB === count) return true;
                w.__at0010ColdBootBlockCountB = count;
                return false;
              })()`,
              { timeoutMs: 4000 },
            );

            // Wait for the restore to land the saved range in
            // selectionGuard.cardRanges["A"]. getCaretState reads
            // from there.
            await app.body(CARD_ID).waitForCondition<boolean>(
              `(function(){
                var s = window.__tug.getCaretState(${JSON.stringify(CARD_ID)});
                return s !== null && s.kind === "range" && s.text === ${JSON.stringify(seeded.text)};
              })()`,
              { timeoutMs: 4000 },
            );

            const restoredCaret = await app.getCaretState(CARD_ID);
            expect(restoredCaret).not.toBeNull();
            expect(restoredCaret?.kind).toBe("range");
            if (restoredCaret?.kind === "range") {
              expect(restoredCaret.text).toBe(seeded.text);
            }

            // Native `::selection` should also carry the restored
            // range on the focused card. selectionGuard's
            // updatePaint runs synchronously inside the deck-store
            // notify, but the seed flow may queue a selectionchange
            // we need to wait for.
            await app.body(CARD_ID).waitForCondition<boolean>(
              `(function(){
                var sel = window.getSelection();
                if (!sel || sel.rangeCount === 0) return false;
                return sel.getRangeAt(0).toString() === ${JSON.stringify(seeded.text)};
              })()`,
              { timeoutMs: 2000 },
            );

            const nativeText = await app.body(CARD_ID).evalJS<string>(
              `(function(){
                var sel = window.getSelection();
                if (!sel || sel.rangeCount === 0) return "";
                return sel.getRangeAt(0).toString();
              })()`,
            );
            expect(nativeText).toBe(seeded.text);
          } finally {
            // Use quitGracefully (NOT close) so tugcast shuts down via
            // UDS and doesn't linger past the next test's launch.
            // close() sends SIGTERM which bypasses
            // applicationShouldTerminate's processManager.stop, leaving
            // tugcast alive until parent_watch notices — which can take
            // longer than the recipe's inter-file sleep, causing
            // port-55255 collisions on the next launch.
            await app.quitGracefully();
          }
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
