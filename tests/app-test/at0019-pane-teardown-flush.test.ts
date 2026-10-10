/**
 * at0019-pane-teardown-flush.test.ts — `_closePane` flushes every
 * card's save callback before destruction.
 *
 * ## Scenario
 *
 * Seed a pane with three FC cards. Type into each so each has
 * user state. Drive a whole-pane close via
 * `__tug.closePane(paneId)` — mirrors `deckManager.handlePaneClosed`,
 * the entry point a "close every card in this pane" UI affordance
 * would call. Assert:
 *
 *   1. A `save-callback` event fires for EVERY card in the pane,
 *      with `source: "close-handoff"`.
 *   2. Per-card save-callbacks precede the first `card-host-unmount` —
 *      flush phase 2 must run before destruction phase 3 ([Q05],
 *      [L23]).
 *
 * Production has no UI button for "close every card in this pane";
 * user-driven close is per-tab through the close button, which
 * routes through `_removeCard`. `_removeCard` only delegates to
 * `_closePane` for the last surviving card in a single-card pane,
 * so the `_closePane` flush loop (deck-manager.ts:760-762) is
 * exercised as the multi-card teardown path only via this entry
 * point. The test surface mirrors the existing public method.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/card-state-cache.ts
 * @covers tugdeck/src/teardown.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/lib/card-lifecycle.ts
 * @covers tugdeck/src/layout-tree.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const INPUT_PERSIST_KEY = "gallery-input/size/sm";

function inputSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-state-key="${INPUT_PERSIST_KEY}"]`;
}

describe.skipIf(!SHOULD_RUN)("m19: _closePane flushes every card before destruction", () => {
  test("multi-card pane close fires save-callback for every cardId before any card-host-unmount", async () => {
    const app = await launchTugApp({ testName: "at0019-pane-teardown-flush" });
    try {
      await app.enableDeckTrace(true);

      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
            { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
            { id: "C", componentId: "gallery-input", title: "Card C", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 480, height: 320 },
              cardIds: ["A", "B", "C"],
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

      // Type into A, then switch + type into B, then C. Each
      // card's bag should hold its user-typed value at close time —
      // a missing value post-flush points at a card whose save
      // callback didn't run.
      await app.nativeClickAtElement(inputSelectorFor("A"));
      await app.type(inputSelectorFor("A"), "alpha");
      await app.nativeClickAtElement(`[data-testid="tug-tab-B"]`);
      await app.waitForCondition<boolean>(`window.__tug.assertHostRootRegistered("B")`);
      await app.nativeClickAtElement(inputSelectorFor("B"));
      await app.type(inputSelectorFor("B"), "bravo");
      await app.nativeClickAtElement(`[data-testid="tug-tab-C"]`);
      await app.waitForCondition<boolean>(`window.__tug.assertHostRootRegistered("C")`);
      await app.nativeClickAtElement(inputSelectorFor("C"));
      await app.type(inputSelectorFor("C"), "charlie");

      // Tear down the whole pane in one call.
      const markClose = await app.markDeckTrace();
      await app.evalJS<void>(`window.__tug.closePane("p1")`);

      // Every card must have produced a save-callback (close-handoff)
      // event — proves _closePane's flush loop iterated each card. The
      // unmount is React's commit, which the deck store tells after the
      // next paint, so it is waited for too rather than read on return.
      await app.waitForCondition<boolean>(
        `(function(){
          var t = window.__tug.getDeckTrace({since: ${markClose}});
          var saved = {};
          var unmounted = false;
          for (var i = 0; i < t.length; i++) {
            if (t[i].kind === "save-callback" && t[i].source === "close-handoff") {
              saved[t[i].cardId] = true;
            }
            if (t[i].kind === "card-host-unmount") unmounted = true;
          }
          return saved.A && saved.B && saved.C && unmounted;
        })()`,
        { timeoutMs: 2000 },
      );

      // Ordering: per-card save-callbacks precede the first
      // card-host-unmount. _closePane runs flush phase BEFORE
      // destruction phase ([Q05], [L23]).
      const trace = await app.getDeckTrace({ since: markClose });
      let firstUnmountAt = Number.POSITIVE_INFINITY;
      const lastSaveAt: Record<string, number> = {};
      for (let i = 0; i < trace.length; i++) {
        const e = trace[i];
        if (e.kind === "card-host-unmount" && firstUnmountAt === Number.POSITIVE_INFINITY) {
          firstUnmountAt = i;
        }
        if (
          e.kind === "save-callback" &&
          e.source === "close-handoff" &&
          typeof e.cardId === "string"
        ) {
          lastSaveAt[e.cardId] = i;
        }
      }
      expect(firstUnmountAt).toBeLessThan(Number.POSITIVE_INFINITY);
      for (const cardId of ["A", "B", "C"]) {
        const saveAt = lastSaveAt[cardId];
        expect(saveAt, `expected close-handoff save for ${cardId} before any card-host-unmount`).toBeDefined();
        expect(saveAt).toBeLessThan(firstUnmountAt);
      }
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(`\n[at0019-pane-teardown-flush] log tail:\n${tail}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);
});
