/**
 * at0331-region-scroll-anchor-one-shot.test.ts — a cold-boot anchor
 * restore must not keep re-arming itself for the life of the card.
 *
 * ## The defect
 *
 * `CardHost`'s region-scroll restore re-applies on every cardRoot
 * mutation until `el.scrollTop` lands within tolerance of the SAVED
 * pixel `pos.y`, then marks the element settled and stops. That gate
 * cannot be satisfied by an ANCHOR restore. A `TugListView` restores an
 * anchor by handing `SmartScroll` a resolver that re-finds the anchored
 * row and returns its LIVE offset; the moment anything moves that row —
 * content paged in above it, a re-measure at a new width, an anchor
 * written under different height accounting — the resolved position
 * stops equalling the stale `pos.y` and the element never settles.
 *
 * From then on the restore is not a cold-boot placement but a standing
 * policy: every subtree mutation re-dispatches `tug-region-scroll-set`,
 * and the list view's anchor branch answers it by disengaging
 * follow-bottom and re-installing the restore target. A transcript the
 * user has scrolled to the live edge therefore loses the live edge and
 * snaps back to the old anchor on the very next turn — repeatedly, with
 * no gesture that makes it stop.
 *
 * The at-bottom branch of the same `apply()` was already fixed for this
 * exact shape (see its comment); the anchor branch was not.
 *
 * ## What this test does
 *
 * 1. Mount the scroll-keyed gallery list, park mid-list, reload, and
 *    re-seed the on-disk bag — the AT0061 / AT0083 cold-boot anchor
 *    round-trip, which lands the scroller on the anchor.
 * 2. **Insert rows at the TOP.** This is what makes the test bite: the
 *    front-insert scroll-hold pushes `scrollTop` past the saved `pos.y`
 *    while the anchored row keeps its content position, so the raw-pixel
 *    tolerance gate can never be satisfied again.
 * 3. Jump to the bottom (`scrollToBottom` — engages follow-bottom and
 *    supersedes the restore).
 * 4. Grow the list from the bottom, the way a streaming turn does.
 *
 * The assertion is that the scroller is still at the live edge. Against
 * the pre-fix code each `Insert bottom` mutation re-dispatches the
 * restore and the scroller snaps back to the anchor.
 *
 * Tuglaws referenced:
 *  - [L23] state preservation across teardown-and-replay — a restore
 *    places the scroller once; it does not own it forever.
 *  - [L06] the restore path writes DOM, never React state.
 *
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

type App = Awaited<ReturnType<typeof launchTugApp>>;

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const SCROLL_KEY = "fixture-list-view-scroll";
const RESTORE_TARGET_PX = 600;
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

function buttonFor(cardId: string, testid: string): string {
  return `[data-card-id="${cardId}"] [data-testid="${testid}"]`;
}

interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Distance from the absolute bottom — 0 (within tolerance) means pinned. */
  distanceFromBottom: number;
  itemCount: number;
}

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
 * Poll for content-settled signals on the inner scrollport (the AT0060
 * set): real scrollable layout exists, `scrollHeight` is stable across
 * two observations, and the anchor attribute is well-shaped.
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
  "AT0331: a cold-boot anchor restore is a one-shot, not a standing policy",
  () => {
    test(
      "the live edge survives content growth after an anchor restore that never matches its saved pixel",
      async () => {
        // `appReload` crosses a real `location.reload()`, so tugbank
        // persistence must actually write. Pair `persistInTestMode` with
        // a per-test temp tugbank so the developer's real DB is untouched.
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0331-region-scroll-anchor-one-shot",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);

          // -------- Phase 1: mount, settle, park mid-list, save.
          await app.seedDeckState({ state: DECK_STATE, focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await waitForSettled(app, "A");

          // Wheel-up first: SmartScroll releases the bottom pin only on a
          // real gesture ([D07]). A bare `scrollTop` write keeps
          // follow-bottom engaged, the save records `atBottom`, and the
          // reload takes the at-bottom branch instead of the anchor branch
          // this test is about.
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

          // Precondition: the restore landed on the anchor, away from
          // the bottom.
          const restored = await readScroll(app, "A");
          expect(
            Math.abs(restored.scrollTop - RESTORE_TARGET_PX),
          ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
          expect(restored.distanceFromBottom).toBeGreaterThan(200);

          // -------- Phase 3: move the anchored row.
          //
          // Front-inserts push every row down; the list view's
          // front-insert scroll-hold advances `scrollTop` to keep the
          // same content under the viewport. The anchored row is
          // therefore at the same CONTENT position and a different PIXEL
          // position — the state in which a raw-`pos.y` settle gate can
          // never be satisfied, which is what makes the restore a
          // standing policy instead of a one-shot.
          for (let i = 0; i < 3; i += 1) {
            const target = restored.itemCount + i + 1;
            await app.click(buttonFor("A", "gallery-list-view-insert-top"));
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(cellsSelectorFor("A"))}).length >= ${target}`,
              { timeoutMs: 2000 },
            );
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 200));

          const shifted = await readScroll(app, "A");
          expect(shifted.itemCount).toBe(restored.itemCount + 3);
          // The saved pixel is now unreachable by the anchored content.
          expect(
            Math.abs(shifted.scrollTop - RESTORE_TARGET_PX),
          ).toBeGreaterThan(SCROLL_TOLERANCE_PX);

          // -------- Phase 4: take the live edge, then stream into it.
          await app.click(buttonFor("A", "gallery-list-view-scroll-to-bottom"));
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              return el !== null &&
                (el.scrollHeight - el.clientHeight - el.scrollTop) <= ${SCROLL_TOLERANCE_PX};
            })()`,
            { timeoutMs: 3000 },
          );

          // Record every scroll position from here on, so a snap-back
          // shows up even if a later commit pins forward again.
          await app.evalJS<void>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              window.__at0331 = { tops: [], bottomAt: el.scrollHeight - el.clientHeight };
              el.addEventListener('scroll', function(){
                window.__at0331.tops.push(el.scrollTop);
              }, { passive: true });
            })()`,
          );

          const atEdge = await readScroll(app, "A");
          for (let i = 0; i < 3; i += 1) {
            const target = atEdge.itemCount + i + 1;
            await app.click(buttonFor("A", "gallery-list-view-insert-bottom"));
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(cellsSelectorFor("A"))}).length >= ${target}`,
              { timeoutMs: 2000 },
            );
          }
          // Grace window: the pre-fix pull arrives on the mutation's
          // following commit, not synchronously with the click.
          await new Promise<void>((resolve) => setTimeout(resolve, 400));

          // -------- Assertion: still following the live edge.
          const afterGrowth = await readScroll(app, "A");
          expect(afterGrowth.itemCount).toBe(atEdge.itemCount + 3);
          expect(afterGrowth.distanceFromBottom).toBeLessThanOrEqual(
            SCROLL_TOLERANCE_PX,
          );

          // Stronger signal: no recorded position regressed toward the
          // restore anchor. A re-armed restore lands `scrollTop` near the
          // anchored row, far above the growing bottom.
          const recorded = await app.evalJS<{
            tops: number[];
            bottomAt: number;
          }>(`window.__at0331`);
          const midpoint = (shifted.scrollTop + recorded.bottomAt) / 2;
          const pullbacks = recorded.tops.filter((t) => t < midpoint);
          expect(pullbacks).toEqual([]);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(
              `\n[at0331-region-scroll-anchor-one-shot] log tail:\n${tail}\n`,
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
