/**
 * at0014-scroll-persistence.test.ts — region scroll round-trips
 * through tab switch, pane activation, and app resign/return on a
 * `tug-markdown-view` card.
 *
 * ## Scenarios (one launched Tug.app per test)
 *
 *   A. **Tab switch round-trip.** Mount a markdown card with 50KB
 *      of baked-in static content (`componentId:
 *      "fixture-markdown-50kb"`). Scroll the inner
 *      `data-tug-scroll-key="markdown-view"` container to a known
 *      offset. Tab-switch to a sibling card, then back. Assert
 *      scroll position survives.
 *
 *   B. **App resign / become-active.** Same baked-in content; same
 *      scroll. `simulateAppResign` + `simulateAppBecomeActive`.
 *      Assert scroll position survives.
 *
 * ## Why one component id per scenario
 *
 * The `fixture-markdown-50kb` registration mounts the card with
 * 50KB of static markdown loaded immediately via
 * `staticContentSize="50kb"`. The bake-in commits in the same
 * React render as mount (a `useLayoutEffect` in
 * `GalleryMarkdownView`), so by the time
 * `assertHostRootRegistered` returns true the scroll container is
 * already populated and the test can drive scroll without first
 * driving any UI gesture.
 *
 * Outer scroll (`bag.scroll`) is unit-tested in
 * `card-host-region-scroll.test.ts`; in-app gallery cards fill the
 * pane (`height: 100%`), so an in-app outer-scroll fixture would
 * require synthetic CSS that doesn't reflect production layouts.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/lib/region-map.ts
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-view.tsx
 * @covers tugdeck/src/card-state-orchestrator.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const REGION_SCROLL_TARGET = 600;

function markdownScrollSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-scroll-key="markdown-view"]`;
}

describe.skipIf(!SHOULD_RUN)("m14: region scroll persistence on fixture-markdown-50kb", () => {
  test("region scroll survives tab switch + back", async () => {
    const app = await launchTugApp({ testName: "at0014-scroll-tab-switch" });
    try {
      await app.enableDeckTrace(true);

      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "fixture-markdown-50kb", title: "MD A", closable: true },
            { id: "B", componentId: "gallery-input", title: "FC B", closable: true },
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

      // Wait for the baked content to render — scrollHeight grows
      // past clientHeight when blocks land.
      await app.waitForCondition<boolean>(
        `(function(){
          var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor("A"))});
          return el !== null && el.scrollHeight > el.clientHeight + 200;
        })()`,
        { timeoutMs: 4000 },
      );

      // Set scroll to a known offset.
      await app.evalJS<void>(
        `(function(){
          var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor("A"))});
          el.scrollTop = ${REGION_SCROLL_TARGET};
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
        })()`,
      );

      // Tab-switch A → B → A.
      await app.nativeClickAtElement(`[data-testid="tug-tab-B"]`);
      await app.waitForCondition<boolean>(
        `window.__tug.getActiveCardId() === "B"`,
      );
      await app.nativeClickAtElement(`[data-testid="tug-tab-A"]`);
      await app.waitForCondition<boolean>(
        `window.__tug.getActiveCardId() === "A"`,
      );

      const after = await app.evalJS<number>(
        `(function(){
          var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor("A"))});
          return el.scrollTop;
        })()`,
      );
      expect(after).toBeGreaterThanOrEqual(REGION_SCROLL_TARGET - 8);
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(`\n[at0014-scroll-tab-switch] log tail:\n${tail}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);

  test("region scroll survives app resign + become-active", async () => {
    // Foreground: the subject is the app resign / become-active cycle,
    // which only happens to an app that is actually active.
    const app = await launchTugApp({ testName: "at0014-scroll-app-cycle", foreground: true });
    try {
      await app.enableDeckTrace(true);

      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "fixture-markdown-50kb", title: "MD A", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 720, height: 480 },
              cardIds: ["A"],
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

      await app.waitForCondition<boolean>(
        `(function(){
          var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor("A"))});
          return el !== null && el.scrollHeight > el.clientHeight + 200;
        })()`,
        { timeoutMs: 4000 },
      );

      // Anchor window focus on the markdown card via a native click
      // before driving the app-cycle. Without an explicit DOM focus
      // gesture the WKWebView's window-focus state can lag the
      // seed's `hasFocus: true` claim, and `simulateAppResign`'s
      // internal wait for `__tug.getHasFocus() === false` then
      // never resolves (the focus chain never had to drain a real
      // active state, so the resign produces no blur transition).
      // Same pattern as m04 / at0035-em.
      await app.nativeClickAtElement(markdownScrollSelectorFor("A"));
      await app.waitForCondition<boolean>(
        `window.__tug.getHasFocus() === true`,
        { timeoutMs: 2000 },
      );

      await app.evalJS<void>(
        `(function(){
          var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor("A"))});
          el.scrollTop = ${REGION_SCROLL_TARGET};
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
        })()`,
      );

      await app.simulateAppResign();
      await app.simulateAppBecomeActive();

      await app.waitForCondition<boolean>(
        `(function(){
          var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor("A"))});
          return el !== null && el.scrollTop >= ${REGION_SCROLL_TARGET - 8};
        })()`,
        { timeoutMs: 2000 },
      );
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(`\n[at0014-scroll-app-cycle] log tail:\n${tail}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);
});
