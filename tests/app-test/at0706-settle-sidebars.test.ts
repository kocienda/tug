/**
 * at0706-settle-sidebars.test.ts — hiding the sidebars and the settled-resize retune, at the bar.
 *
 * Hiding and showing a two-member rail, and resizing the rails to fit. The
 * show's settle window holds its main-thread time under
 * `MAIN_THREAD_BAR_MS.rails`: a parked rail stands again without mounting.
 *
 * **The resize-to-fit leg's bar is 2.5 frames, not 2** — re-budgeted by the
 * user on 2026-10-03. It read 2.06–2.18 on every run: one jittered frame,
 * the same reading `FOLD_GAP_FRAMES_BAR` forgives, over a settle whose commit
 * retunes every rail at once. The instrument and the clause are unchanged.
 *
 * **The sidebars-show leg's land bar is 2.0 frames, not 1.5** — re-budgeted
 * by the user on 2026-10-06. It read 25–32 ms (1.47–1.88 frames) across
 * runs, and a mutation probe over the land frame found only compositing
 * hand-backs in it: the arrive beat's inline opacity and `translateX(0)` off
 * the rails, the session panes' FLIP transforms off, and two marks no
 * stylesheet keys on. No commit, forced layout, delivery or layout write
 * lands there. The hide's land, without the rails' hand-back, reads 20–22 ms.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/sidebar-toggle.ts
 * @covers tugdeck/src/lib/gesture-drivers.ts
 * @covers tugdeck/src/deck-manager-store.ts
 * @covers tugdeck/src/lib/motion-guard/settle-bar.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  SHOULD_RUN,
  armedMainThreadMark,
  arrivedIn,
  expectB09Bar,
  expectBeats,
  expectMainThreadUnderBar,
  home,
  largestCommit,
  launch,
  railBlob,
  readMainThread,
  reportB09,
  sampleB09Gesture,
  traceWithSettleFrames,
  wait,
  windowCommits,
  transcriptArms,
} from "./settle-frames-fixture";
import { settleBarsFor } from "../../tugdeck/src/lib/motion-guard/settle-bar";

const TEST_NAME = "at0706-settle-sidebars";
const ARMS = transcriptArms();

/** The two re-budgeted legs' bars — resize-to-fit's gap and the sidebars'
 *  show land, by the user's rulings (see the header). They live in
 *  `settle-bar.ts`, the one table `tugtool deck motion settle` also reads. */
const RESIZE_TO_FIT_BARS = settleBarsFor("fit");
const SIDEBARS_SHOW_BARS = settleBarsFor("sidebar-show");

/**
 * The sidebars, and the retune that follows a resize — the last two of
 * [B09]'s eleven, against the same bar.
 *
 * **Hide and show, on a TWO-MEMBER rail.** One member is a weaker gesture:
 * `hideSidebarRail` writes the record of what was standing in its own commit
 * and then closes each member in its own, so a rail of two produces three
 * notifies inside one task and one coalesced React commit — which is the arm
 * sequence the whole of [B02] is about. The bar is read across the whole
 * choreography including the rail's own exit, which since [B10] rides the
 * `depart` beat rather than a plant-time clock: a rail that vanished where it
 * stood moves the band exactly as one that slid away, and only the beat name
 * tells them apart.
 *
 * **Resize to fit** is the settled-resize retune, through its own door
 * (`resize-sidebars-to-fit`, ⌥⇧⌘S and View ▸ Resize Sidebars To Fit). It is
 * the gesture whose commit is a RETUNE rather than a structural change — no
 * pane arrives, none leaves, none changes slot, and every rail's allocation
 * moves at once. The row is read from that commit, which is the point: a
 * retune that reached the canvas a frame late would show as lead here and
 * nowhere else in this file.
 */
for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0706 — hiding the sidebars and the settled-resize retune, at the bar [${arm.size}]`,
  () => {
    test(
      "hiding and showing a two-member rail hold the bar and the resize retune holds its re-budgeted one",
      async () => {
        const { app, tugbankPath } = await launch(4, railBlob(), TEST_NAME, {
          transcripts: arm.size,
          leadRecorder: true,
        });
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          // All three sampled BEFORE any of them is judged. One red leg
          // would otherwise take the whole test down before the gestures
          // after it ever ran, and a reading nobody took is worse than a
          // red one: the arc's rule is that a red leg is recorded, and it
          // cannot be recorded if the run stopped above it.
          const hide = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("toggle-sidebars", {})`,
          );
          reportB09("sidebars hide", hide);

          const showMark = await armedMainThreadMark(app);
          const show = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("toggle-sidebars", {})`,
          );
          reportB09("sidebars show", show);
          const showWindow = await windowCommits(app, showMark);
          const showLargest =
            showWindow === null ? null : largestCommit(showWindow.commits);
          const showMainThread =
            showWindow === null
              ? null
              : await readMainThread(app, "at0706 sidebars show", showWindow);
          note(
            `at0706 sidebars show window: ${showWindow?.commits.length ?? 0} ` +
              `commit(s); largest ${JSON.stringify(
                showLargest === null
                  ? null
                  : {
                      t: showLargest.t,
                      performed: showLargest.performed,
                      mounted: showLargest.mounted,
                      fibers: showLargest.fibers,
                      reactMs: showLargest.reactMs,
                      origins: showLargest.origins,
                    },
              )}`,
          );
          // Judged below with the others. Showing the rail used to mount its
          // whole contents inside the settle window (a 4501-fiber commit,
          // 2.9–3.1 frames against 2); a parked rail keeps them mounted, and
          // the show's largest in-window commit is now 45 performed fibers,
          // 1.59–1.82 frames on three solo runs
          // (`briefs/departing-and-height-crossing-readings.md`).

          // The retune wants a deck whose rails do NOT already fit, or it
          // commits nothing and the band guard is what catches it. Widening
          // both rails past their share is what gives the retune something
          // to take back.
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", ` +
              `{ kind: "i64", value: 900 }), null)`,
          );
          await wait(AFTER_LAND_MS);

          const retune = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("resize-sidebars-to-fit", {})`,
          );
          reportB09("resize to fit", retune);

          // The beats go with the bar, below the three samples, for the
          // reason the comment above gives: a beat assertion is a judgement
          // like any other, and one thrown between the gestures would cost
          // the readings the legs after it were sampled for.
          expectBeats("sidebars hide", hide, ["depart", "room"]);
          expectBeats("sidebars show", show, ["room", "arrive"]);
          expectBeats("resize to fit", retune, ["shrink", "move", "grow"]);

          expect(showWindow, `sidebars show: the settle window was found in the trace`).not.toBeNull();
          const showMounted = (showWindow?.commits ?? []).reduce((s, c) => s + c.mounted, 0);
          expect(showMounted, `sidebars show: the show mounted nothing in its window`).toBe(0);
          expectMainThreadUnderBar(
            "sidebars show",
            "rails",
            showMainThread as NonNullable<typeof showMainThread>,
          );

          expectB09Bar("sidebars hide", hide);
          // The show's pose exemption, earned the way the appear leg earns
          // its own: the rail's frames ARRIVE, each held at inline
          // `opacity: 0` across `room`, so the probe must have watched an
          // arriving frame be invisible, and that frame must be one that
          // arrived. Anything else and the pose clause judges every pane.
          const arrived = arrivedIn(show);
          expect(
            arrived.length,
            `sidebars show: the rail's frames arrived in this gesture — ` +
              `${JSON.stringify(arrived)}`,
          ).toBeGreaterThan(0);
          expect(
            show.probe.minOpacity,
            `sidebars show: an arriving frame really was held invisible — ` +
              `the probe's worst opacity was ${show.probe.minOpacity} on ` +
              `\`${show.probe.minOpacityPaneId}\``,
          ).toBe(0);
          expect(
            arrived,
            `sidebars show: and the frame held invisible is one that arrived ` +
              `— ${show.probe.minOpacityPaneId} against ${JSON.stringify(arrived)}`,
          ).toContain(show.probe.minOpacityPaneId);
          expectB09Bar(
            "sidebars show",
            show,
            arrived,
            SIDEBARS_SHOW_BARS,
          );
          expectB09Bar("resize to fit", retune, [], RESIZE_TO_FIT_BARS);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);
