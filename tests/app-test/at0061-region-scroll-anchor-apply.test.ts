/**
 * at0061-region-scroll-anchor-apply.test.ts — region-scroll anchor
 * apply-side proof.
 *
 * Full save → reload → apply round-trip on the
 * `fixture-list-view-scroll-keyed` fixture (which mounts
 * `GalleryListView` with `scrollKey="fixture-list-view-scroll"`,
 * `inline=true`, `disableStreaming=true`). The fixture mirrors the
 * session-card transcript's configuration: every cell rendered at mount,
 * region scroll opted into the [A9] region-scroll axis, no
 * continuous-mutation effect competing with settle detection.
 *
 * ## What this proves
 *
 * AT0059 proved save works (anchor metadata captured into
 * `bag.regionScroll[key].meta`). AT0060 proved we can identify when
 * content has settled. This test closes the loop:
 *
 *   1. Mount → wait for settled.
 *   2. Scroll to a known position; record `scrollTop` + the live
 *      anchor on `data-tug-scroll-state`.
 *   3. `app.appReload()` — same code path as Maker > Reload.
 *      `prepareForReload` flushes the bag to tugbank; the page
 *      reloads; the fresh CardHost reads the bag and dispatches
 *      `tug-region-scroll-set` with `meta.anchor` to TugListView's
 *      listener.
 *   4. On the new page, wait for content to settle again.
 *   5. Assert the scrollport's `scrollTop` has been restored to
 *      within tolerance of the saved value.
 *   6. Assert the live `data-tug-scroll-state` anchor matches the
 *      saved anchor — proving the user is looking at the same
 *      content-relative position.
 *
 * ## Why both assertions
 *
 * `scrollTop` alone proves the bag's raw `{x, y}` was applied.
 * Anchor match proves the meta channel survived the round-trip and
 * the apply effect honored it. If cell-height drift
 * had moved the anchor between save and restore, scrollTop would
 * be restored to the wrong pixel value (the apply effect would
 * have computed `desired = cellTop + offset` against the new
 * heights). Asserting anchor match validates the drift-resistance
 * property the meta channel was introduced for.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * Tuglaws referenced:
 *  - [L23] state preservation across teardown-and-replay — the
 *    end-to-end gate.
 *  - [L03] `useLayoutEffect` — writer + apply effects both fire
 *    before paint so the very first paint after reload sees the
 *    restored position.
 *  - [L06] DOM-attribute write (`data-tug-scroll-state`) drives the
 *    anchor lifecycle; no React state.
 *  - [L07] writer + apply effects read live refs each commit.
 *  - [L19] new attribute + meta field documented in
 *    `state-preservation.md` and `RegionScrollSnapshot`.
 *
 * @covers tugdeck/src/lib/region-map.ts
 * @covers tugdeck/src/lib/block-height-index.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/serialization.ts
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

const SCROLL_KEY = "fixture-list-view-scroll";
const REGION_SCROLL_TARGET = 600;
const SCROLL_TOLERANCE_PX = 8;

function scrollContainerSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-scroll-key="${SCROLL_KEY}"]`;
}

function cellsSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-list-cell-index]`;
}

interface AnchorPayload {
  anchor: { index: number; offset: number };
}

/**
 * Poll for content-settled signals (AT0060 set) on the inner
 * scrollport. Resolves when:
 *   - scrollHeight > clientHeight + 100 (real layout exists)
 *   - scrollHeight stable across two observations 250ms apart
 *   - data-tug-scroll-state attribute carries a well-shaped anchor
 *
 * Throws on timeout.
 */
async function waitForSettled(
  app: {
    evalJS: <T>(s: string) => Promise<T>;
    waitForCondition: <T>(s: string, o?: { timeoutMs?: number }) => Promise<T>;
  },
  cardId: string,
  timeoutMs: number = 5000,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor(cardId))});
      if (el === null) return false;
      return el.scrollHeight > el.clientHeight + 100;
    })()`,
    { timeoutMs },
  );

  // Stability across two observations.
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

  // Anchor attribute is well-shaped.
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
  "AT0061: region-scroll anchor metadata — full save-reload-apply round-trip",
  () => {
    test(
      "scrollTop and anchor are both restored after appReload",
      async () => {
        // App reload across a real `location.reload()` requires
        // tugbank persistence to actually write (test mode bypasses
        // tugbank writes by default). Pair `persistInTestMode: true`
        // with a per-test temp tugbank file so the developer's real
        // `~/.tugbank.db` is untouched.
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0061-region-scroll-anchor-apply",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);

          await app.seedDeckState({
            state: {
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
            },
            focusCardId: "A",
          });

          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );

          // -------- Phase 1: pre-reload — settle, scroll, save.

          await waitForSettled(app, "A");

          // Scroll to a known offset that is NOT the bottom. A wheel-up
          // gesture FIRST disengages follow-bottom — SmartScroll only
          // releases the bottom pin on a real user gesture ([D07]); a bare
          // `scrollTop` write + synthetic `scroll` event stays in the idle
          // phase and the list keeps following the bottom, so the save
          // would record `atBottom` and the reload would re-pin to the
          // bottom (defeating the anchor round-trip this test exercises).
          await app.evalJS<void>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
              el.scrollTop = ${REGION_SCROLL_TARGET};
              el.dispatchEvent(new Event('scroll', { bubbles: true }));
            })()`,
          );

          // Wait for writer to commit the new anchor.
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

          const preReload = await app.evalJS<{
            scrollTop: number;
            anchor: { index: number; offset: number };
            itemCount: number;
          }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              var raw = el.getAttribute("data-tug-scroll-state");
              var parsed = JSON.parse(raw);
              return {
                scrollTop: el.scrollTop,
                anchor: parsed.anchor,
                itemCount: document.querySelectorAll(${JSON.stringify(cellsSelectorFor("A"))}).length,
              };
            })()`,
          );

          expect(preReload.scrollTop).toBe(REGION_SCROLL_TARGET);
          // Anchor must be non-trivial (not (0,0)) — we scrolled
          // away from the top.
          const anchorNonTrivial =
            preReload.anchor.index > 0 || preReload.anchor.offset > 0;
          expect(anchorNonTrivial).toBe(true);

          // -------- Phase 2: reload. Same code path as Maker >
          // Reload — `prepareForReload` flushes the bag to tugbank
          // synchronously, then `location.reload()` fires.
          //
          // Note: `prepareForReload` saves the per-card bag (via
          // `invokeSaveCallback`) but the test-mode `seedDeckState`
          // does not itself round-trip through tugbank. So after
          // `appReload()` the new page has the bag content on disk
          // but no deck-layout entry; we re-seed the deck shape
          // and feed the on-disk bag back via `cardStates` so the
          // CardHost mount sees the restored bag and exercises the
          // [A9] region-scroll apply path. Same pattern as AT0025.

          await app.appReload();

          // Read the bag the previous session wrote to disk. Must
          // contain `regionScroll[scrollKey].meta.anchor`.
          const onDiskBag = tugbankRead<{
            regionScroll?: Record<
              string,
              { x: number; y: number; meta?: AnchorPayload }
            >;
          }>(tugbankPath, "dev.tugapp.deck.cardstate", "A");
          expect(onDiskBag).not.toBeNull();
          if (onDiskBag === null) throw new Error("bag missing on disk");
          const bagValue = onDiskBag.value;
          expect(bagValue.regionScroll).toBeDefined();
          if (bagValue.regionScroll === undefined) {
            throw new Error("regionScroll axis missing on disk");
          }
          const diskEntry = bagValue.regionScroll[SCROLL_KEY];
          expect(diskEntry).toBeDefined();
          expect(diskEntry.meta).toBeDefined();
          if (diskEntry.meta === undefined) {
            throw new Error("meta missing on disk");
          }
          expect(diskEntry.meta.anchor.index).toBe(preReload.anchor.index);
          expect(diskEntry.meta.anchor.offset).toBe(preReload.anchor.offset);

          // Re-seed deck shape (same as Phase 1) AND feed the
          // on-disk bag back so the CardHost mount-restore reads
          // `bag.regionScroll[scrollKey]` and dispatches
          // `tug-region-scroll-set` with `meta.anchor` to
          // TugListView's listener.
          //
          // Note: the harness's `cardStates` field is wire-typed as
          // `Record<string, unknown>` (a plain object), not a Map.
          // JSON.stringify of a Map serializes to `{}` and the bag
          // never crosses the wire.
          const cardStates: Record<string, unknown> = { A: bagValue };
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: {
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
            },
            cardStates,
            focusCardId: "A",
          });

          // -------- Phase 3: post-reload — settle again, then assert.
          //
          // Wait for the card host to register on the new page
          // (signals tugdeck has fully booted and CardHost has mounted).
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5000 },
          );

          await waitForSettled(app, "A");

          // Restored state.
          const postReload = await app.evalJS<{
            scrollTop: number;
            anchor: { index: number; offset: number } | null;
            itemCount: number;
          }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(scrollContainerSelectorFor("A"))});
              var raw = el.getAttribute("data-tug-scroll-state");
              var parsed = null;
              try { parsed = JSON.parse(raw); } catch (_) {}
              return {
                scrollTop: el.scrollTop,
                anchor: parsed ? parsed.anchor : null,
                itemCount: document.querySelectorAll(${JSON.stringify(cellsSelectorFor("A"))}).length,
              };
            })()`,
          );

          // Same dataset on the new page.
          expect(postReload.itemCount).toBe(preReload.itemCount);

          // -------- Assertion: scrollTop restored within tolerance.
          //
          // Anchor-based restore writes
          // `desired = heightIndex.offsetForIndex(anchorIndex) + anchorOffset`.
          // Cell heights for the same content should be deterministic
          // across reload, so `desired === preReload.scrollTop`. We
          // allow a small tolerance for sub-pixel rounding.
          const scrollTopDelta = Math.abs(
            postReload.scrollTop - preReload.scrollTop,
          );
          expect(scrollTopDelta).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);

          // -------- Assertion: anchor match.
          //
          // The post-restore writer should observe the same content
          // at the same viewport position, so `data-tug-scroll-state`
          // produces the same `{index, offset}` payload. Proves the
          // user is looking at the same content, not just at the
          // same pixel position.
          expect(postReload.anchor).not.toBeNull();
          if (postReload.anchor === null) {
            throw new Error("expected post-reload anchor");
          }
          expect(postReload.anchor.index).toBe(preReload.anchor.index);
          // Offset can drift by at most the scrollTop tolerance.
          const offsetDelta = Math.abs(
            postReload.anchor.offset - preReload.anchor.offset,
          );
          expect(offsetDelta).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(
              `\n[at0061-region-scroll-anchor-apply] log tail:\n${tail}\n`,
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
