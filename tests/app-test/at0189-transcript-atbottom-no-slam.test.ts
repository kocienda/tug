/**
 * at0189-transcript-atbottom-no-slam.test.ts — a transcript restored
 * from an `atBottom` bag must NOT slam a scrolled-up user back to the
 * bottom when the card subtree mutates.
 *
 * ## The bug
 *
 * CardHost's region-scroll restore installs a `MutationObserver` retry
 * whose settle gate is `scrollTop ≈ saved pos.y`. An `atBottom` region
 * re-pins to the LIVE bottom (taller than at save), so `scrollTop`
 * converges to `scrollHeight - clientHeight`, never the stale `pos.y` —
 * the gate never trips, the retry re-dispatches `tug-region-scroll-set`
 * on every mutation, and the list view's at-bottom branch re-engages
 * follow-bottom (`scrollToBottom`) each time, slamming a user who has
 * scrolled up. The fix makes the at-bottom restore a one-shot.
 *
 * ## Shape (two phases, one temp tugbank + one seeded fixture)
 *
 * | Phase | Action                                            | Assertion                                  |
 * |-------|---------------------------------------------------|--------------------------------------------|
 * | A     | resume fixture → settle at bottom → quitGracefully | saved bag's region meta has `atBottom:true`|
 * | B     | relaunch → restore bag → scroll up → mutate card   | scrollTop stays up (never reaches bottom)  |
 *
 * Real-derived, sanitized, committed fixture — no live archive, no
 * gallery fixture. See `fixtures/README.md`.
 *
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/lib/region-map.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
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

/** How far below the live bottom counts as "the user is NOT at the
 * bottom". The slam lands scrollTop at the bottom; a held position
 * sits at ~half the scrollable range, well outside this band. */
const SLAM_BAND_PX = 150;

interface RegionMeta {
  atBottom?: boolean;
  anchor?: { index: number; offset: number };
}
interface CardBag {
  regionScroll?: Record<string, { x: number; y: number; meta?: RegionMeta }>;
}

describe.skipIf(!SHOULD_RUN)("at0189: atBottom restore never slams a scrolled-up user", () => {
  test(
    "scroll up after restore, mutate the card, stay put",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession("session-transcript-basic", "at0189");

      // Pre-seed the picker's recent-projects to ONLY the temp fixture
      // dir, BEFORE launch — so the picker autofills that path on mount
      // and lists only the fixture session. Without this the picker
      // defaults its path to $HOME and would surface the user's real
      // sessions (a live-archive leak) and never autofill the temp dir.
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );

      try {
        // ── Phase A: resume → settle at bottom → quit (saves bag). ──
        {
          const app = await launchTugApp({
            testName: "at0189-A",
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
            persistInTestMode: true,
          });
          try {
            await openFixtureSession(app, seeded);
            await waitForTranscriptSettled(app);
            // The resumed list follows the bottom — confirm it is pinned
            // there so the saved bag records `atBottom`.
            await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(SCROLLER)});
                return el !== null &&
                  (el.scrollHeight - el.clientHeight - el.scrollTop) <= 4;
              })()`,
              { timeoutMs: 5000 },
            );
          } finally {
            await app.quitGracefully();
          }
        }

        // ── Phase A assertion: bag on disk is atBottom. ──
        const onDisk = tugbankRead<CardBag>(
          tugbankPath,
          "dev.tugapp.deck.cardstate",
          CARD_ID,
        );
        expect(onDisk).not.toBeNull();
        const regionA = onDisk?.value?.regionScroll?.["session-card-transcript"];
        expect(regionA).toBeTruthy();
        expect(regionA?.meta?.atBottom).toBe(true);

        // ── Phase B: restore → scroll up → mutate → assert no slam. ──
        {
          const app = await launchTugApp({
            testName: "at0189-B",
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
            persistInTestMode: true,
          });
          try {
            const bag: Record<string, unknown> = {};
            bag[CARD_ID] = onDisk!.value;
            await openFixtureSession(app, seeded, { cardStates: bag });
            await waitForTranscriptSettled(app);

            // Scroll up via a real wheel-up (disengages follow-bottom),
            // then land at ~half the scrollable range.
            const target = await app.evalJS<number>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(SCROLLER)});
                el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
                var t = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) / 2));
                el.scrollTop = t;
                el.dispatchEvent(new Event('scroll', { bubbles: true }));
                return el.scrollTop;
              })()`,
            );
            expect(target).toBeGreaterThan(SLAM_BAND_PX);

            // Install a max-scrollTop accumulator, then fire a cardRoot
            // subtree mutation (what content settling / tool expansion
            // does in real use) so CardHost's MutationObserver runs.
            await app.evalJS<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(SCROLLER)});
                window.__noSlam = { maxSeen: el.scrollTop, samples: 0 };
                window.__noSlamTimer = setInterval(function(){
                  var e = document.querySelector(${JSON.stringify(SCROLLER)});
                  if (e === null) return;
                  if (e.scrollTop > window.__noSlam.maxSeen) window.__noSlam.maxSeen = e.scrollTop;
                  window.__noSlam.samples += 1;
                }, 16);
                var root = document.querySelector('[data-card-id="${CARD_ID}"]');
                var d = document.createElement('div');
                d.style.display = 'none';
                root.appendChild(d);
                root.removeChild(d);
                return true;
              })()`,
            );

            // Let the observer fire and any slam play out (~500ms).
            await app.waitForCondition<boolean>(
              `(window.__noSlam && window.__noSlam.samples >= 28)`,
              { timeoutMs: 4000 },
            );

            const result = await app.evalJS<{
              maxSeen: number;
              maxScroll: number;
              finalTop: number;
            }>(
              `(function(){
                clearInterval(window.__noSlamTimer);
                var el = document.querySelector(${JSON.stringify(SCROLLER)});
                return {
                  maxSeen: window.__noSlam.maxSeen,
                  maxScroll: el.scrollHeight - el.clientHeight,
                  finalTop: el.scrollTop
                };
              })()`,
            );

            // No slam: scrollTop never climbed into the bottom band.
            expect(result.maxScroll - result.maxSeen).toBeGreaterThan(SLAM_BAND_PX);
            expect(result.maxScroll - result.finalTop).toBeGreaterThan(SLAM_BAND_PX);
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
