/**
 * at0083-list-view-submit-pin.test.ts — scroll-to-bottom reliability +
 * auto-pin funnel for `TugListView`.
 *
 * # What this gates
 *
 * Two behaviors of the real `TugListView` + `SmartScroll` + CardHost
 * region-scroll restore, driven through `fixture-list-view-scroll-keyed`
 * (an `inline`, region-scroll-keyed, streaming-disabled fixture that
 * mirrors the session-card transcript's configuration — the same fixture
 * AT0059–AT0061 / AT0069 use).
 *
 * ## An explicit `scrollToBottom()` must beat a cold-boot restore anchor
 *
 * When a card cold-boots into a saved mid-list scroll position, the
 * restore-anchor apply effect re-applies that position on every commit
 * while `restoreAnchorRef` is set. An imperative `scrollToBottom()` —
 * the jump-to-latest the session-card transcript host issues on submit —
 * is a supersede signal: it must land at the bottom AND hold there, not
 * be pulled back to the saved anchor.
 *
 * `SmartScroll`'s `onFollowBottomChanged` callback clears the restore
 * anchor the moment follow-bottom engages, so every engage path
 * (`scrollToBottom`, keyboard End/Cmd-Down, idle re-engagement,
 * gesture-end re-engage — all routing through `_setFollowingBottom(true)`)
 * supersedes the restore.
 *
 * Test 1 reproduces the failure shape: cold-boot a card restored to a
 * mid-list anchor, drive `scrollToBottom()`, assert the scroller lands
 * — and STAYS — at the bottom with no restore-anchor pullback.
 *
 * ## Auto-pin funnel: one gate, `SmartScroll.maybePinToBottom`
 *
 * "If following the bottom and content grew, pin to the bottom" is
 * gated by `SmartScroll.shouldAutoPin` (`isFollowingBottom &&
 * !isUserScrolling`), with `maybePinToBottom()` as the pure-pin
 * wrapper. Test 2 exercises the funnel end-to-end:
 *
 *   - content growth while following the bottom auto-pins (gate true);
 *   - content growth after follow-bottom is disengaged does NOT pin
 *     (gate false — the user's position is the user's);
 *   - `scrollToBottom()` re-engages follow-bottom so subsequent growth
 *     pins again;
 *   - `scrollToBottom()` while already at the bottom is a no-op.
 *
 * The disengage half is driven by a real scroll-up wheel gesture:
 * SmartScroll's wheel handler flips `isFollowingBottom` to false on
 * `deltaY < 0`. A block-fold collapse reaches the same
 * `_setFollowingBottom(false)` through `useScroller().disengage` —
 * the typed funnel that replaced the old `tug-disengage-follow-bottom`
 * DOM event — so test 2's "growth does not pin after disengage" phase
 * gates the auto-pin funnel against a genuine user disengage.
 *
 * `SmartScroll.maybePinToBottom` / `shouldAutoPin` are SmartScroll-level
 * and shared verbatim by `TugMarkdownView`; exercising them through
 * `TugListView` gates the funnel itself.
 *
 * # Tuglaws referenced
 *
 *  - [D07] auto-follow-bottom semantics — engagement is a user-intent
 *    signal; the restore anchor yields to it.
 *  - [L06] `scrollTop` writes are DOM-appearance updates owned by
 *    `SmartScroll`, never React state.
 *  - [L07] `isFollowingBottom` / `isUserScrolling` read live at call
 *    time via `shouldAutoPin`.
 *  - [L23] user-visible state is honest: an explicit jump-to-latest
 *    always lands; a cold-boot restore reproduces the saved viewport
 *    until the user supersedes it.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/lib/region-map.ts
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/components/tugways/cards/gallery-list-view.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const SCROLL_KEY = "fixture-list-view-scroll";
/** Mid-list save target — not the bottom, so the restore anchor is non-trivial. */
const RESTORE_TARGET_PX = 600;
/** Sub-pixel rounding slack for scroll-position comparisons. */
const SCROLL_TOLERANCE_PX = 8;

const DECK_STATE = {
  cards: [
    {
      id: "A",
      componentId: "fixture-list-view-scroll-keyed",
      title: "List",
      closable: true,
    },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 600, height: 480 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["fixture"],
    },
  ],
  activePaneId: "p1",
  hasFocus: true,
};

function scrollContainerSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-scroll-key="${SCROLL_KEY}"]`;
}

function cellsSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-list-cell-index]`;
}

function scrollToBottomButtonFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-testid="gallery-list-view-scroll-to-bottom"]`;
}

function insertBottomButtonFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-testid="gallery-list-view-insert-bottom"]`;
}

interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Distance from the absolute bottom — 0 (within tolerance) means pinned. */
  distanceFromBottom: number;
  itemCount: number;
}

/** Read the inner scrollport geometry + the rendered cell count. */
async function readScroll(app: App, cardId: string): Promise<ScrollSnapshot> {
  return app.evalJS<ScrollSnapshot>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor(cardId))});
      if (el === null) {
        return { scrollTop: -1, scrollHeight: -1, clientHeight: -1, distanceFromBottom: -1, itemCount: -1 };
      }
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop,
        itemCount: document.querySelectorAll(${JSON.stringify(cellsSelectorFor(cardId))}).length,
      };
    })()`,
  );
}

/**
 * Poll for content-settled signals on the inner scrollport (the
 * AT0060 set): real scrollable layout exists, scrollHeight is stable
 * across two observations, and the anchor attribute is well-shaped.
 */
async function waitForSettled(
  app: App,
  cardId: string,
  timeoutMs = 5000,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor(cardId))});
      if (el === null) return false;
      return el.scrollHeight > el.clientHeight + 100;
    })()`,
    { timeoutMs },
  );
  const firstHeight = await app.evalJS<number>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor(cardId))});
      return el === null ? -1 : el.scrollHeight;
    })()`,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  const secondHeight = await app.evalJS<number>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor(cardId))});
      return el === null ? -1 : el.scrollHeight;
    })()`,
  );
  if (firstHeight !== secondHeight) {
    throw new Error(
      `waitForSettled: scrollHeight unstable (${firstHeight} → ${secondHeight})`,
    );
  }
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor(cardId))});
      var raw = el && el.getAttribute("data-tug-scroll-state");
      if (raw === null) return false;
      try {
        var parsed = JSON.parse(raw);
        return parsed && parsed.anchor &&
          typeof parsed.anchor.index === "number" &&
          typeof parsed.anchor.offset === "number";
      } catch (_) { return false; }
    })()`,
    { timeoutMs: 1000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0083: TugListView scroll-to-bottom reliability + auto-pin funnel",
  () => {
    // -------------------------------------------------------------------
    // test 1 — scrollToBottom() beats a cold-boot restore anchor.
    // -------------------------------------------------------------------
    test(
      "scrollToBottom() lands and HOLDS at the bottom after a cold-boot restore to a mid-list anchor",
      async () => {
        // appReload crosses a real location.reload(); tugbank
        // persistence must actually write. Pair persistInTestMode
        // with a per-test temp tugbank so the developer's real DB is
        // untouched.
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0083-list-view-submit-pin-restore",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);

          // -------- Phase 1: mount, settle, scroll mid-list, save.
          await app.seedDeckState({ state: DECK_STATE, focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await waitForSettled(app, "A");

          // Wheel-up first to disengage follow-bottom before parking at a
          // mid-list offset — SmartScroll only releases the bottom pin on a
          // real gesture ([D07]); a bare `scrollTop` write + synthetic
          // `scroll` event keeps following the bottom, so the save records
          // `atBottom` and the cold-boot restore re-pins to the bottom
          // instead of the mid anchor this test asserts. (The file's second
          // test already does this.)
          await app.evalJS<void>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
              el.scrollTop = ${RESTORE_TARGET_PX};
              el.dispatchEvent(new Event('scroll', { bubbles: true }));
            })()`,
          );
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              var raw = el && el.getAttribute("data-tug-scroll-state");
              if (raw === null) return false;
              try {
                var parsed = JSON.parse(raw);
                return parsed && parsed.anchor &&
                  (parsed.anchor.index > 0 || parsed.anchor.offset > 0);
              } catch (_) { return false; }
            })()`,
            { timeoutMs: 2000 },
          );

          // -------- Phase 2: reload + re-seed with the on-disk bag.
          await app.appReload();

          const onDiskBag = tugbankRead<{
            regionScroll?: Record<
              string,
              { x: number; y: number; meta?: { anchor?: unknown } }
            >;
          }>(tugbankPath, "dev.tugtool.deck.cardstate", "A");
          expect(onDiskBag).not.toBeNull();
          if (onDiskBag === null) throw new Error("bag missing on disk");
          const bagValue = onDiskBag.value;
          expect(bagValue.regionScroll?.[SCROLL_KEY]?.meta).toBeDefined();

          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: DECK_STATE,
            cardStates: { A: bagValue },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5000 },
          );
          await waitForSettled(app, "A");

          // -------- Phase 3: confirm the restore landed mid-list.
          // This is the precondition that makes the test meaningful:
          // the restore-anchor is active and is holding the scroller
          // away from the bottom.
          const restored = await readScroll(app, "A");
          expect(
            Math.abs(restored.scrollTop - RESTORE_TARGET_PX),
          ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
          // ...and is genuinely NOT at the bottom — otherwise a
          // scroll-to-bottom that "lands at the bottom" would be
          // vacuously true.
          expect(restored.distanceFromBottom).toBeGreaterThan(200);

          // -------- Phase 4: install a scroll recorder, drive
          // scrollToBottom(), and prove it lands AND holds.
          await app.evalJS<void>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              window.__at0083 = { tops: [] };
              el.addEventListener('scroll', function(){
                window.__at0083.tops.push(el.scrollTop);
              }, { passive: true });
            })()`,
          );

          await app.click(scrollToBottomButtonFor("A"));

          // Wait for the scroller to reach the bottom.
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              return el !== null &&
                (el.scrollHeight - el.clientHeight - el.scrollTop) <= ${SCROLL_TOLERANCE_PX};
            })()`,
            { timeoutMs: 3000 },
          );

          // Grace window: against the pre-fix code the restore-anchor
          // apply effect re-writes scrollTop back to the saved anchor
          // on the next commit. Hold long enough to catch that pull.
          await new Promise<void>((resolve) => setTimeout(resolve, 400));

          const afterJump = await readScroll(app, "A");
          // Decisive assertion: still at the bottom — the restore
          // anchor did NOT pull it back.
          expect(afterJump.distanceFromBottom).toBeLessThanOrEqual(
            SCROLL_TOLERANCE_PX,
          );

          // Stronger signal: no scroll event after the jump regressed
          // toward the saved anchor. A pullback would land a recorded
          // scrollTop near RESTORE_TARGET_PX; every post-jump value
          // must sit well below `distanceFromBottom` of that.
          const recorded = await app.evalJS<{ tops: number[] }>(
            `window.__at0083`,
          );
          const midpoint =
            (RESTORE_TARGET_PX + (afterJump.scrollHeight - afterJump.clientHeight)) /
            2;
          const pullbacks = recorded.tops.filter((t) => t < midpoint);
          expect(pullbacks).toEqual([]);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(
              `\n[at0083-list-view-submit-pin restore] log tail:\n${tail}\n`,
            );
          }
          throw err;
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    // -------------------------------------------------------------------
    // test 2 — follow-bottom engage/disengage gates the auto-pin funnel.
    // -------------------------------------------------------------------
    test(
      "content growth auto-pins only while following the bottom; scrollToBottom re-engages it",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0083-list-view-submit-pin-funnel",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: DECK_STATE, focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await waitForSettled(app, "A");

          // The fixture mounts with `followBottom`, so first paint
          // pins to the bottom. Wait for that to land.
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              return el !== null &&
                (el.scrollHeight - el.clientHeight - el.scrollTop) <= ${SCROLL_TOLERANCE_PX};
            })()`,
            { timeoutMs: 3000 },
          );

          // -------- Phase A — scrollToBottom() while already pinned
          // is a no-op.
          const beforeNoop = await readScroll(app, "A");
          await app.click(scrollToBottomButtonFor("A"));
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          const afterNoop = await readScroll(app, "A");
          expect(afterNoop.distanceFromBottom).toBeLessThanOrEqual(
            SCROLL_TOLERANCE_PX,
          );
          expect(
            Math.abs(afterNoop.scrollTop - beforeNoop.scrollTop),
          ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);

          // -------- Phase D — disengage follow-bottom via a real
          // scroll-up wheel gesture, then grow the list: content
          // growth must NOT pin (the gate is false). SmartScroll's
          // wheel handler flips `isFollowingBottom` to false on
          // `deltaY < 0` and enters the dragging phase; the explicit
          // `scrollend` returns it to idle so the growth below is
          // gated purely by `isFollowingBottom`. A collapsed Bash/diff
          // hunk reaches the same `_setFollowingBottom(false)` through
          // `useScroller().disengage`.
          await app.evalJS<void>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
              el.scrollTop = 200;
              el.dispatchEvent(new Event('scroll', { bubbles: true }));
              el.dispatchEvent(new Event('scrollend', { bubbles: true }));
            })()`,
          );

          const beforeGrowth = await readScroll(app, "A");
          expect(
            Math.abs(beforeGrowth.scrollTop - 200),
          ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);

          for (let i = 0; i < 3; i += 1) {
            const target = beforeGrowth.itemCount + i + 1;
            await app.click(insertBottomButtonFor("A"));
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(cellsSelectorFor("A"))}).length >= ${target}`,
              { timeoutMs: 2000 },
            );
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 200));

          const afterGrowth = await readScroll(app, "A");
          // The new rows appended below the viewport; a non-following
          // scroller must keep the user's position. scrollTop unchanged.
          expect(
            Math.abs(afterGrowth.scrollTop - beforeGrowth.scrollTop),
          ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
          // ...and it genuinely grew (otherwise the no-pin assertion
          // is vacuous).
          expect(afterGrowth.itemCount).toBe(beforeGrowth.itemCount + 3);
          expect(afterGrowth.distanceFromBottom).toBeGreaterThan(200);

          // -------- Phase B — scrollToBottom() re-engages follow-bottom.
          await app.click(scrollToBottomButtonFor("A"));
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              return el !== null &&
                (el.scrollHeight - el.clientHeight - el.scrollTop) <= ${SCROLL_TOLERANCE_PX};
            })()`,
            { timeoutMs: 3000 },
          );

          // -------- Phase C — with follow-bottom re-engaged, content
          // growth auto-pins again (the gate is true).
          const beforePin = await readScroll(app, "A");
          for (let i = 0; i < 3; i += 1) {
            const target = beforePin.itemCount + i + 1;
            await app.click(insertBottomButtonFor("A"));
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(cellsSelectorFor("A"))}).length >= ${target}`,
              { timeoutMs: 2000 },
            );
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 200));

          const afterPin = await readScroll(app, "A");
          expect(afterPin.itemCount).toBe(beforePin.itemCount + 3);
          // Followed the bottom down as the list grew.
          expect(afterPin.distanceFromBottom).toBeLessThanOrEqual(
            SCROLL_TOLERANCE_PX,
          );
          expect(afterPin.scrollTop).toBeGreaterThan(beforePin.scrollTop);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(
              `\n[at0083-list-view-submit-pin funnel] log tail:\n${tail}\n`,
            );
          }
          throw err;
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
