/**
 * at0014-cold-boot-scroll.test.ts — region-scroll restore across full
 * Tug.app process restart on a `tug-markdown-view` card.
 *
 * ## Two-phase contract
 *
 * Each test runs **two separate Tug.app processes** sharing one
 * temp tugbank file. Phase A teardown precedes Phase B launch;
 * never parallel.
 *
 * | Phase | Tugbank state at launch | Action               | Assertion                                            |
 * |-------|-------------------------|----------------------|------------------------------------------------------|
 * | A     | empty (fresh temp DB)   | seed deck → scroll → | tugbank disk has regionScroll.markdown-view.y        |
 * |       |                         | quitGracefully       | matching the scrolled offset                         |
 * | B     | populated (from A)      | re-seed deck with    | live `el.scrollTop` matches the saved offset within  |
 * |       |                         | bag from disk →      | tolerance after the bake-in/virtualization race      |
 * |       |                         | wait for ready       | settles                                              |
 *
 * Phase A failure ⇒ save path didn't reach disk (or quitGracefully
 * skipped the save trigger). Phase B failure ⇒ load + apply at
 * fresh mount didn't land. Split makes diagnosis cheap.
 *
 * ## Why seedDeckState in Phase B
 *
 * Tug.app's launch path in test mode (TUGAPP_TEST_SOCKET set) skips
 * the production tugbank-driven rehydrate (`main.tsx` line 162-164:
 * `In test mode, DeckManager ignores the tugbank-sourced
 * arguments and starts empty`). So Phase B reads the persisted bag
 * via the `tugbank` CLI and re-injects it through `seedDeckState`'s
 * `cardStates` merge.
 *
 * The restore code under test — `CardHost`'s mount-time apply of
 * `bag.regionScroll` against the markdown-view scroll container —
 * runs identically whether the bag arrives via main.tsx's
 * `readCardStates` (production cold-boot) or via `seedDeckState`'s
 * cache merge (test cold-boot). The user's reported bug lives in
 * that apply code, not in the read path; the test exercises it.
 *
 * ## Status: PASSING (in the default Justfile sweep)
 *
 * Layer 4 (the `tug-region-scroll-set` event + SmartScroll
 * disengage-follow-bottom + MutationObserver `attributeFilter`
 * retry) flipped this from failing to passing. See
 * [AT0014] gating and scroll persistence contract.
 *
 * ## Closes
 *
 * [AT0014] cold-boot variant. The existing
 * `at0014-scroll-persistence.test.ts` already gates tab-switch +
 * `simulateAppResign` round-trips inside one Tug.app process; this
 * file adds the cross-process variant they cannot exercise.
 *
 * @foreground
 * @covers tugdeck/src/lib/region-map.ts
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/lib/tugbank-client.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-view.tsx
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

/** The known scroll offset Phase A pins. Picked well above viewport
 * so the bake-in's estimated heights almost certainly clamp the
 * first-pass apply, exposing the virtualization race the fix has
 * to handle. */
const REGION_SCROLL_TARGET = 600;

/** Px tolerance for "scroll settled at expected". Matches the
 * existing `at0014-scroll-persistence.test.ts` tolerance. */
const SCROLL_TOLERANCE = 8;

const CARD_ID = "A";

function markdownScrollSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-scroll-key="markdown-view"]`;
}

function deckShape() {
  return {
    cards: [
      { id: CARD_ID, componentId: "fixture-markdown-50kb", title: "MD A", closable: true },
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

describe.skipIf(!SHOULD_RUN)("m14: scroll cold-boot across full process restart", () => {
  test(
    "scroll position survives quitGracefully + relaunch",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);

      try {
        // ── Phase A: seed deck, scroll, quitGracefully. ──
        {
          const app = await launchTugApp({
            testName: "at0014-cold-boot-scroll-A",
            // Foreground: the test's resign leg needs a really-active app.
            foreground: true,
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
            persistInTestMode: true,
          });

          await app.seedDeckState({
            state: deckShape(),
            focusCardId: CARD_ID,
          });

          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD_ID)})`,
          );

          // Wait for the baked content to render — scrollHeight grows
          // past clientHeight when blocks land. Same gate as
          // `at0014-scroll-persistence.test.ts`.
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor(CARD_ID))});
              return el !== null && el.scrollHeight > el.clientHeight + 200;
            })()`,
            { timeoutMs: 4000 },
          );

          // Dispatch the `tug-region-scroll-set` event tug-markdown-view
          // listens for (the same event CardHost's applyRegionScrolls
          // uses during cold-boot restore). Setting scrollTop directly
          // would race SmartScroll's follow-bottom mode — by the time
          // the bag is captured at quitGracefully, ResizeObserver-driven
          // bake-in would have re-slammed scrollTop to the bottom.
          // Routing through the event tells SmartScroll to disengage
          // follow-bottom AND apply the requested position.
          await app.evalJS<void>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor(CARD_ID))});
              el.dispatchEvent(new CustomEvent('tug-region-scroll-set', {
                detail: { top: ${REGION_SCROLL_TARGET}, left: 0 },
                cancelable: true,
                bubbles: false,
              }));
            })()`,
          );
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor(CARD_ID))});
              return Math.abs(el.scrollTop - ${REGION_SCROLL_TARGET}) <= ${SCROLL_TOLERANCE};
            })()`,
            { timeoutMs: 2000 },
          );

          // Trigger applicationShouldTerminate → saveAndFlushSync →
          // sync XHR PUT each card's bag → tugcast → sqlite WAL.
          await app.quitGracefully();
        }

        // ── Phase A assertion: bag is on tugbank disk. ──
        const onDisk = tugbankRead<{
          regionScroll?: Record<string, { x: number; y: number }> | null;
        }>(
          tugbankPath,
          "dev.tugtool.deck.cardstate",
          CARD_ID,
        );
        expect(onDisk).not.toBeNull();
        expect(onDisk?.type).toBe("json");
        const regionScroll = onDisk?.value?.regionScroll;
        expect(regionScroll).toBeTruthy();
        expect(regionScroll?.["markdown-view"]?.y).toBeGreaterThanOrEqual(
          REGION_SCROLL_TARGET - SCROLL_TOLERANCE,
        );

        // ── Phase B: relaunch, re-seed bag from disk, assert live. ──
        {
          const app = await launchTugApp({
            testName: "at0014-cold-boot-scroll-B",
            foreground: true,
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
            persistInTestMode: true,
          });
          try {
            // In test mode, DeckManager starts empty regardless of
            // tugbank state. Re-inject the bag the disk holds via
            // seedDeckState.cardStates → cardStateCache.
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

            // Wait for content to render so scrollHeight is meaningful.
            await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor(CARD_ID))});
                return el !== null && el.scrollHeight > el.clientHeight + 200;
              })()`,
              { timeoutMs: 4000 },
            );

            // Wait for el.scrollTop to land at the saved offset AND
            // hold there across multiple polls — the bake-in race
            // can momentarily place it near the target before
            // ResizeObserver-driven height refinement nudges it
            // again. 3 stable polls @ ~16ms = ~48ms of stability.
            const settled = await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor(CARD_ID))});
                if (!el) return false;
                if (Math.abs(el.scrollTop - ${REGION_SCROLL_TARGET}) > ${SCROLL_TOLERANCE}) {
                  window.__m14ColdBootStable = 0;
                  window.__m14ColdBootLastY = el.scrollTop;
                  return false;
                }
                if (typeof window.__m14ColdBootStable !== "number") {
                  window.__m14ColdBootStable = 0;
                  window.__m14ColdBootLastY = el.scrollTop;
                }
                if (Math.abs(el.scrollTop - window.__m14ColdBootLastY) <= 1) {
                  window.__m14ColdBootStable += 1;
                } else {
                  window.__m14ColdBootStable = 1;
                  window.__m14ColdBootLastY = el.scrollTop;
                }
                return window.__m14ColdBootStable >= 3;
              })()`,
              { timeoutMs: 4000 },
            );
            expect(settled).toBe(true);

            const live = await app.evalJS<number>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(markdownScrollSelectorFor(CARD_ID))});
                return el ? el.scrollTop : -1;
              })()`,
            );
            expect(Math.abs(live - REGION_SCROLL_TARGET)).toBeLessThanOrEqual(SCROLL_TOLERANCE);
          } finally {
            // Use quitGracefully (NOT close) so tugcast shuts down via
            // UDS — see at0010-cold-boot-selection for rationale.
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
