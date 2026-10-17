/**
 * at0430-resize-scroll-preservation-transcript.test.ts — changing a Session
 * card's width never moves the transcript row the reader is looking at.
 *
 * One piece of the at0430 split; the decks and instruments are
 * `resize-scroll-preservation-fixture.ts`.
 *
 * The scroller survives a width change intact, and that is the whole problem:
 * `scrollTop` is faithfully preserved while the content it names re-wraps out
 * from under it. WebKit implements no CSS scroll anchoring, so before the
 * resize episode a bullseye toggle on a scrolled-up transcript left the reader
 * somewhere else in the document with nothing in the DOM to show for it.
 *
 *  1. **The episode actually ran.** A `MutationObserver` on the frame's
 *     `data-resize-episode` stamp records every episode raised during the run,
 *     and each gesture is asserted to have raised one.
 *  2. **Every raise site, not one.** The width popup and bullseye come in
 *     through the FLIP settle; the west-edge drag comes in at pointer-down and
 *     lives across a gesture the settle never sees; the deck-wide Card Width
 *     bypasses `movePane` entirely. Three doors, three different lifetimes.
 *     The drag applies its width from a rAF loop, and a background app-test
 *     window suspends rAF, so that door asserts its raise only.
 *  3. **Follow-bottom is not an anchor.** A transcript pinned to the bottom
 *     must still be pinned after the width change.
 *  4. **The displacement guard.** `data-scroll-displacements` counts
 *     `scrollTop` moves the list view could not account for. The episode
 *     writes `scrollTop` deliberately and repeatedly; if those writes are not
 *     attributed through SmartScroll the counter climbs. Read before and
 *     after, asserted equal.
 *
 * Every measurement is taken after the episode's stamp has cleared; an
 * assertion hung on mid-flight motion is banned by the harness doctrine.
 *
 * @covers tugdeck/src/lib/resize-episode.ts
 * @covers tugdeck/src/lib/cm6-scroll-anchor.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/cards/pdf-view.tsx
 * @covers tugdeck/src/lib/pdf-layout.ts
 * @family at0430-resize-scroll-preservation
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { chooseWidth } from "./fixtures/card-width";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER,
  waitForTranscriptSettled,
} from "./fixtures/runner";
import {
  ANCHOR_TOLERANCE_PX,
  FRAME,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  armEpisodeWatch,
  claimSubject,
  displacements,
  episodeCount,
  isAtBottom,
  paneWidth,
  readSubject,
  wait,
  waitForEpisodesClosed,
} from "./resize-scroll-preservation-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0430 — a width change never moves what the reader is looking at",
  () => {
    test(
      "a virtualized transcript holds its anchored row through every width door",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const seeded = await seedFixtureSession(
          "session-transcript-basic",
          "at0430",
        );
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.dev",
          "recent-projects",
          "json",
          JSON.stringify({ paths: [seeded.projectDir] }),
        );

        const app = await launchTugApp({
          testName: "at0430-transcript",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
        });
        try {
          await openFixtureSession(app, seeded);
          await waitForTranscriptSettled(app);
          await armEpisodeWatch(app, FRAME);

          const displacementsBefore = await displacements(app.body("A"), SCROLLER);

          // Wheel-up disengages follow-bottom, then land at ~40% of the range:
          // a mid anchor with document above and below it, so a width change
          // can move the position in either direction.
          await app.body("A").evalJS<number>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              el.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true, cancelable: true }));
              el.scrollTop = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) * 0.4));
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return el.scrollTop;
            })()`,
          );
          await wait(400);

          /**
           * Run one width gesture and assert the anchored row did not move.
           * The anchor is re-read before each gesture rather than carried
           * across all of them: each door is a separate claim, and a chain
           * that drifted a pixel per door would otherwise read as one failure
           * at the end instead of at the door that caused it.
           */
          const holdsThrough = async (
            label: string,
            gesture: () => Promise<void>,
          ): Promise<void> => {
            const before = await claimSubject(app.body("A"), SCROLLER);
            const widthBefore = await paneWidth(app, FRAME);
            const episodesBefore = await episodeCount(app);

            await gesture();
            await waitForEpisodesClosed(app, FRAME);

            const widthAfter = await paneWidth(app, FRAME);
            expect(widthAfter).not.toBe(widthBefore);
            // The mechanism ran. Without this the position assertion below is
            // satisfied by content that simply did not reflow.
            expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

            const after = await readSubject(app.body("A"), SCROLLER);
            expect(after).not.toBeNull();
            note(
              `${label}: width ${widthBefore}→${widthAfter}, subject in row ${before.index}` +
                ` delta ${before.delta}→${after!.delta},` +
                ` scrollTop ${before.scrollTop}→${after!.scrollTop}`,
            );
            expect(Math.abs(after!.delta - before.delta)).toBeLessThanOrEqual(
              ANCHOR_TOLERANCE_PX,
            );
          };

          // ── Door 1: the width popup, through the FLIP settle. ────────────
          await holdsThrough("wide", async () => {
            await chooseWidth(app, "p1", "wide");
          });

          // ── Door 2: bullseye in, a 400-odd pixel narrowing. ──────────────
          await holdsThrough("bullseye on", async () => {
            await app.nativeKey("b", ["ctrl", "cmd"]);
          });

          // ── Door 3: bullseye out, the same distance back. ────────────────
          await holdsThrough("bullseye off", async () => {
            await app.nativeKey("b", ["ctrl", "cmd"]);
          });

          // ── Door 4: the popup again, the other way. ──────────────────────
          await holdsThrough("slim", async () => {
            await chooseWidth(app, "p1", "slim");
          });

          // ── Door 5: a west-edge drag — the gesture the settle never sees. ─
          // The episode is raised at pointer-down and lives across the whole
          // drag, so this is the one door whose lifetime is bounded by the
          // user's hand rather than by an animation.
          //
          // Only the raise is asserted. The drag applies its geometry from a
          // rAF loop and a background app-test window suspends rAF entirely,
          // so the width cannot move here and the position claim the other
          // four doors make would have nothing to bite on. What this door
          // contributes is the pointer-down raise — the episode must open
          // while the pre-gesture layout is still on screen, not at the move
          // latch — and that is what fails if the call is removed.
          const beforeDrag = await claimSubject(app.body("A"), SCROLLER);
          const episodesBeforeDrag = await episodeCount(app);
          const handle = await app.evalJS<{ x: number; y: number }>(
            `(function () {
              var h = document.querySelector(${JSON.stringify(`${FRAME} .tug-pane-resize-w`)});
              if (h === null) throw new Error("west resize handle not found");
              var r = h.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`,
          );
          // Rightward narrows the pane from its west edge, which keeps the
          // drag inside the canvas wherever the pane happens to sit.
          await app.nativeDrag(handle, { x: handle.x + 180, y: handle.y });
          await waitForEpisodesClosed(app, FRAME);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBeforeDrag);
          // And a gesture that changed no geometry left the reader alone.
          const afterDrag = await readSubject(app.body("A"), SCROLLER);
          expect(afterDrag).not.toBeNull();
          note(`west-edge drag: subject delta ${beforeDrag.delta}→${afterDrag!.delta}`);
          expect(
            Math.abs(afterDrag!.delta - beforeDrag.delta),
          ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);

          // ── Follow-bottom is not an anchor. ──────────────────────────────
          // A transcript riding the tail must still be riding it afterwards.
          await app.body("A").evalJS<null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              el.scrollTop = el.scrollHeight;
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(600);
          expect(await isAtBottom(app.body("A"), SCROLLER)).toBe(true);

          const episodesBeforeTail = await episodeCount(app);
          await chooseWidth(app, "p1", "wide");
          await waitForEpisodesClosed(app, FRAME);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBeforeTail);
          expect(await isAtBottom(app.body("A"), SCROLLER)).toBe(true);

          // ── The guard. ───────────────────────────────────────────────────
          // Every `scrollTop` the episode wrote was attributed; nothing in
          // this run looked to the list view like an unexplained move.
          const displacementsAfter = await displacements(app.body("A"), SCROLLER);
          note(`displacements ${displacementsBefore} → ${displacementsAfter}`);
          expect(displacementsAfter).toBe(displacementsBefore);
        } finally {
          await app.close();
          seeded.cleanup();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
