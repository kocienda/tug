/**
 * at0700-settle-rail-hide-carries.test.ts — two commits in one task carry every frame they move.
 *
 * Hiding a two-member rail is three notifies in one task and one coalesced
 * React commit, so the canvas arms three times before it lands. This file
 * holds that every frame the hide moves is carried by a tween, and that the
 * rail members and the side's shadow strip each ride their own `depart` beat.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/sidebar-toggle.ts
 * @covers tugdeck/src/lib/settle-frame-probe.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  type DepartureTravel,
  armDepartureCensus,
  frameOrigins,
  home,
  launch,
  railBlob,
  readDepartureCensus,
  traceMark,
  traceWithSettleFrames,
  wait,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0700-settle-rail-hide-carries";
const ARMS = transcriptArms();

/**
 * A gesture whose whole cost is that it commits more than once inside one
 * task, read for the frames it forgets to carry.
 *
 * `hideSidebarRail` with two members is three notifies in one task: the
 * record of what was standing, then a close per member. Under [D204] those
 * three commits coalesce into ONE React commit a painted frame later, and the
 * canvas arms three times before it lands. The arm that matters is the
 * second: the tweens the first arm measured for have not been launched yet —
 * the Last pass that launches them has not run — so `settleTweensRef` is
 * empty, and before [B02] the whole prelaunch predicate was satisfiable. The
 * prelaunch then called `firstRects.clear()`, the coalesced Last pass found
 * no First rect for anything, and every frame the rail's disappearance moved
 * CUT while nothing on the deck glided ([F03]).
 *
 * `cutPaneIds` is the clause. It exists because nothing else could read this
 * one: a frame that carried no effect at any tick never enters the curve
 * comparison at all, so a run in which every frame jumped satisfies the gap
 * bar, the off-curve bar and the opacity bar together. The guards beside it
 * are what keep the zero from being free — the rail really went, and the band
 * really moved.
 *
 * **This leg is a live GUARD, not a reproduction, and the difference is
 * recorded rather than papered over.** [F03] is a finding verified by
 * reading, and this is the first attempt to reproduce it: with the [B02]
 * clause reverted out, the gesture below still carries every frame. The
 * reason measured is that a rail's commits are not flow-only — hiding a rail
 * moves the band's edge, so `flowOnly` is false and the prelaunch predicate
 * was never reachable on this path whatever the rects said. [F03]'s other
 * named shape, the flow retune inside `retuneSidebarAllocation`, commits the
 * flow-only retune FIRST and the rail retunes after, which is the safe order;
 * and the reveal `movePaneToSlot` holds back lands on `onceCardDidTravel`,
 * a later task. So the defect is real as a reachable state of the predicate
 * and was not reachable by any gesture tried here.
 *
 * What IS falsifiable is the reading, and it is proven as data:
 * `settle-frame-probe.test.ts` drives a cut frame, a frame that only resized,
 * and a frame that moved and was carried through the classifier directly. So
 * a `cutPaneIds` that stopped noticing fails there, and this leg is what
 * stands over the live gesture in case a future commit order reaches the
 * predicate the way [F03] describes.
 */
for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0700 — two commits in one task carry every frame they move [${arm.size}]`,
  () => {
    test(
      "hiding a two-member rail moves the band and leaves no frame uncarried",
      async () => {
        const { app, tugbankPath } = await launch(4, railBlob(), TEST_NAME, { transcripts: arm.size });
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          const before = await frameOrigins(app);
          const mark = await traceMark(app);
          // The side's shadow strip, held by identity: a hide carries out
          // the strip that stood, so the same element is still the strip
          // when the beat has landed.
          await app.evalJS<null>(
            `(window.__at0622Strip = document.querySelector('[data-rail-shadow="left"]'), null)`,
          );
          await app.armSettleFrameProbe();
          await armDepartureCensus(app);
          // The quiet head the classifier derives the display's period from.
          await wait(120);
          await app.dispatchControlAction("toggle-sidebars");
          await wait(AFTER_LAND_MS * 2);
          await app.waitForCondition<boolean>(
            `window.__deckTrace.since(${mark}).some(function (e) {
               return e.kind === "settle-frames";
             })`,
            { timeoutMs: 20_000 },
          );
          const probe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const departures = await readDepartureCensus(app);
          const after = await frameOrigins(app);
          note(`at0700 two-commit probe: ${JSON.stringify(probe)}`);
          note(`at0700 two-commit departures: ${JSON.stringify(departures)}`);
          note(
            `at0700 two-commit origins: ${JSON.stringify(before)} -> ` +
              `${JSON.stringify(after)}`,
          );

          expect(
            probe.suspended,
            `two-commit: the window was served across the gesture — ` +
              `${probe.ticks} ticks at ${probe.framePeriodMs.toFixed(2)}ms`,
          ).toBe(false);

          // ---- The two guards that keep the clause from being free. ----
          const railPanes = ["at0622-pl1", "at0622-pj1"];
          expect(
            railPanes.filter((id) => id in before),
            `two-commit: both rail members were standing before the ` +
              `gesture — ${JSON.stringify(Object.keys(before))}. A rail of ` +
              `one commits twice rather than three times and is not the ` +
              `shape this leg is for`,
          ).toEqual(railPanes);
          expect(
            railPanes.filter((id) => id in after),
            `two-commit: and the hide really took them — ` +
              `${JSON.stringify(Object.keys(after))}`,
          ).toEqual([]);
          const moved = Object.keys(after).filter(
            (id) => id in before && before[id] !== after[id],
          );
          expect(
            moved.length,
            `two-commit: and the band really moved when the rail went — ` +
              `moved [${moved.join(", ")}]. A gesture that moved nothing ` +
              `satisfies the clause below by having nothing to carry`,
          ).toBeGreaterThan(0);

          // ---- The clause. ---------------------------------------------
          expect(
            [...probe.cutPaneIds],
            `two-commit: every frame the gesture moved was carried by a ` +
              `tween — [${probe.cutPaneIds.join(", ")}] moved with nothing ` +
              `on them. This is the one reading that can see [F03]: a frame ` +
              `carrying no effect at any tick never enters the curve ` +
              `comparison, so a settle in which every frame jumped passes ` +
              `the gap bar and the off-curve bar together`,
          ).toEqual([]);
          expect(
            [...probe.rectsChangedAfterLanding],
            `two-commit: and no frame settled twice`,
          ).toEqual([]);

          // ---- The rail's own exit, on the beat ([B10]). ---------------
          //
          // The clause above is about the SURVIVORS. The rails themselves
          // are gone from the DOM by the time anything above reads it, and
          // their exit is the one motion in this gesture nothing else here
          // can see: a rail that vanished on the spot moves the band, leaves
          // nothing marked behind, and satisfies every bar above.
          const travelled = Object.keys(departures.travel).sort();
          expect(
            travelled,
            `two-commit: both rail members and the side's shadow strip got ` +
              `a depart beat — ${JSON.stringify(travelled)}. A missing strip is ` +
              `the depth of the panel blinking out while the panel slides`,
          ).toEqual(["at0622-pj1", "at0622-pl1", "rail-shadow:left"]);
          for (const key of travelled) {
            const row = departures.travel[key] as DepartureTravel;
            expect(
              row.maxPx,
              `two-commit: ${key} travelled off the edge — ` +
                `${row.maxPx.toFixed(1)}px over ${row.ticks} frame(s). Near ` +
                `zero is a rail that disappeared where it stood`,
            ).toBeGreaterThan(100);
            expect(
              row.ticks,
              `two-commit: and travelled ACROSS frames rather than in one ` +
                `jump — ${key} was in the document for ${row.ticks} frame(s)`,
            ).toBeGreaterThan(2);
            expect(
              row.maxStepPx,
              `two-commit: and no frame of it jumped — ${key}'s largest ` +
                `single-frame move was ${row.maxStepPx.toFixed(1)}px of ` +
                `${row.maxPx.toFixed(1)}px. A real strip held at the wrong ` +
                `First rect stands a rail's width off and jumps there`,
            ).toBeLessThan(row.maxPx / 4);
          }
          // One travel per side: the strip stands ten pixels inboard, so a
          // strip measured against the edge separately would take a longer
          // journey and drift away from the panel it is the depth of.
          const spans = travelled.map(
            (k) => (departures.travel[k] as DepartureTravel).maxPx,
          );
          expect(
            Math.max(...spans) - Math.min(...spans),
            `two-commit: every target on the side travelled the RAIL's ` +
              `distance — ${JSON.stringify(spans)}`,
          ).toBeLessThan(0.5);
          expect(
            [...departures.standing],
            `two-commit: and every target's mark came off when its beat landed`,
          ).toEqual([]);

          // ---- The strip was neither created nor destroyed ([D9]). ----
          const strip = await app.evalJS<{
            held: boolean;
            connected: boolean;
            same: boolean;
            parked: boolean;
            transform: string;
          }>(
            `(function () {
              var held = window.__at0622Strip;
              var now = document.querySelector('[data-rail-shadow="left"]');
              return {
                held: held instanceof HTMLElement,
                connected: held instanceof HTMLElement && held.isConnected,
                same: held === now,
                parked: now !== null && now.hasAttribute("data-rail-parked"),
                transform: now === null ? "" : now.style.transform,
              };
            })()`,
          );
          note(`at0700 two-commit strip: ${JSON.stringify(strip)}`);
          expect(
            strip,
            `two-commit: the left strip that stood before the hide is the ` +
              `one in the document after it — parked, with no inline ` +
              `transform left on it`,
          ).toEqual({
            held: true,
            connected: true,
            same: true,
            parked: true,
            transform: "",
          });
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
