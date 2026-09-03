/**
 * at0190-transcript-anchor-restore.test.ts — pixel-perfect scroll
 * restore for a transcript saved SCROLLED-UP (the anchor case, req #4).
 *
 * `at0189` covers the `atBottom` save/restore (resume-following). This
 * covers the complementary case: the user scrolled up to a mid
 * position, the save records an `{index, offset}` anchor (not
 * `atBottom`), and a reload must land `scrollTop` back on the SAME
 * pixel. With all-rich real heights ([P01]/[P02]) the anchor resolver's
 * `offsetForIndex(anchorIndex) + anchorOffset` reproduces the exact
 * saved offset on the first settled commit — no estimate-then-refine
 * hop, no drift.
 *
 * ## Shape (two phases, one temp tugbank + one seeded fixture)
 *
 * | Phase | Action                                              | Assertion                               |
 * |-------|-----------------------------------------------------|-----------------------------------------|
 * | A     | resume → settle → scroll up to mid → quitGracefully | saved bag has `meta.anchor`, not atBottom |
 * | B     | relaunch → restore bag → settle                     | restored scrollTop == saved (≤ 2px)     |
 *
 * Real-derived, sanitized, committed fixture — no live archive.
 *
 * @covers tugdeck/src/lib/region-map.ts
 * @covers tugdeck/src/lib/block-height-index.ts
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const CARD_ID = "A";

/** Pixel tolerance for "landed on the same spot" (req #4). */
const RESTORE_TOLERANCE_PX = 2;

interface RegionMeta {
  atBottom?: boolean;
  anchor?: { index: number; offset: number; turnDepthFromEnd?: number; depthFromEnd?: number };
}
interface CardBag {
  regionScroll?: Record<string, { x: number; y: number; meta?: RegionMeta }>;
}

describe.skipIf(!SHOULD_RUN)("at0190: scrolled-up transcript restores pixel-perfectly", () => {
  test(
    "scroll to a mid anchor, reload, land on the same pixel",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession("session-transcript-basic", "at0190");
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );

      let savedTop = -1;

      try {
        // ── Phase A: resume → scroll up to mid → quit (saves anchor). ──
        {
          const app = await launchTugApp({
            testName: "at0190-A",
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
            persistInTestMode: true,
          });
          try {
            await openFixtureSession(app, seeded);
            await waitForTranscriptSettled(app);

            // Wheel-up disengages follow-bottom; land at ~40% of the
            // scrollable range — a mid anchor, well off the bottom.
            savedTop = await app.evalJS<number>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(SCROLLER)});
                el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
                el.scrollTop = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) * 0.4));
                el.dispatchEvent(new Event('scroll', { bubbles: true }));
                return el.scrollTop;
              })()`,
            );
            expect(savedTop).toBeGreaterThan(RESTORE_TOLERANCE_PX);

            // Let the anchor-state writer commit the new position onto
            // `data-tug-scroll-state` (it runs on the scroll-driven
            // commit), and confirm scrollTop held (no re-pin).
            await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(SCROLLER)});
                if (el === null) return false;
                if (Math.abs(el.scrollTop - ${savedTop}) > ${RESTORE_TOLERANCE_PX}) return false;
                return el.getAttribute("data-tug-scroll-state") !== null;
              })()`,
              { timeoutMs: 4000 },
            );
          } finally {
            await app.quitGracefully();
          }
        }

        // ── Phase A assertion: bag carries an anchor, not atBottom. ──
        const onDisk = tugbankRead<CardBag>(
          tugbankPath,
          "dev.tugapp.deck.cardstate",
          CARD_ID,
        );
        expect(onDisk).not.toBeNull();
        const regionA = onDisk?.value?.regionScroll?.["session-card-transcript"];
        expect(regionA).toBeTruthy();
        expect(regionA?.meta?.atBottom).not.toBe(true);
        expect(typeof regionA?.meta?.anchor?.index).toBe("number");
        // The anchor records its distance-from-bottom — the invariant that
        // drives faithful restore under recency windowing ([recency P05],
        // #step-6): it sizes the resume window and relocates the anchor
        // regardless of how much is paged in. The transcript is a
        // turn-windowed source, so this depth is persisted as
        // `turnDepthFromEnd` (a non-turn list would persist a row
        // `depthFromEnd` instead — see the anchor-state writer in
        // tug-list-view.tsx).
        expect(typeof regionA?.meta?.anchor?.turnDepthFromEnd).toBe("number");
        expect(regionA?.meta?.anchor?.turnDepthFromEnd).toBeGreaterThan(0);
        expect(Math.abs((regionA?.y ?? -1) - savedTop)).toBeLessThanOrEqual(
          RESTORE_TOLERANCE_PX,
        );

        // ── Phase B: restore → settle → assert pixel-perfect landing. ──
        {
          const app = await launchTugApp({
            testName: "at0190-B",
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
            persistInTestMode: true,
          });
          try {
            const bag: Record<string, unknown> = {};
            bag[CARD_ID] = onDisk!.value;
            await openFixtureSession(app, seeded, { cardStates: bag });
            await waitForTranscriptSettled(app);

            // Wait for the restored scrollTop to land AND hold near the
            // saved offset across consecutive samples — the async
            // markdown settle can nudge heights for a frame or two.
            const landed = await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(SCROLLER)});
                if (el === null) return false;
                if (Math.abs(el.scrollTop - ${savedTop}) > ${RESTORE_TOLERANCE_PX}) {
                  window.__r = 0; window.__rLast = el.scrollTop; return false;
                }
                if (typeof window.__r !== "number") { window.__r = 0; window.__rLast = el.scrollTop; }
                if (Math.abs(el.scrollTop - window.__rLast) <= 1) window.__r += 1;
                else { window.__r = 1; window.__rLast = el.scrollTop; }
                return window.__r >= 3;
              })()`,
              { timeoutMs: 6000 },
            );
            expect(landed).toBe(true);

            const restoredTop = await app.evalJS<number>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(SCROLLER)});
                return el ? el.scrollTop : -1;
              })()`,
            );
            expect(Math.abs(restoredTop - savedTop)).toBeLessThanOrEqual(
              RESTORE_TOLERANCE_PX,
            );
          } finally {
            await app.quitGracefully();
          }
        }
      } finally {
        seeded.cleanup();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
