/**
 * at0701-settle-arrival-close.test.ts — an arrival interrupted by a close keeps its hold.
 *
 * A card arriving is planned as `room` then `arrive`, held at inline
 * `opacity: 0` until the fade begins. A close landing during `room`
 * retargets the settle, and this file holds that the arriving frame never
 * stands at full opacity before its arrive beat.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  ARRIVAL_CENSUS_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  type ArrivalSample,
  arrivalCensus,
  blobFor,
  frameOrigins,
  home,
  launch,
  retargetRows,
  traceMark,
  traceWithSettleFrames,
  wait,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0701-settle-arrival-close";
const ARMS = transcriptArms();

/**
 * A card arriving, interrupted during its `room` beat by a close.
 *
 * This is [P08]'s case read at the frame level. An arrival is planned as
 * `room` then `arrive`: the Last pass holds the newcomer at inline
 * `opacity: 0`, builds both beats up front with delays, and the fade's active
 * phase does not begin until `room` has run. Before [B03] the newcomer left
 * `pendingArrivalsRef` at the moment its fade was CONSTRUCTED — synchronously,
 * inside that same Last pass — so for the whole length of `room` the deck held
 * an invisible frame that nothing was protecting. A commit landing in that
 * window armed a settle whose First pass measured the held frame like any
 * other: `hold-at-current` committed the underlying `opacity: 0`, the
 * restorers handed the pre-hold opacity back, and the card stood at full
 * opacity a beat before the room it was arriving into had been made ([F04]).
 *
 * The claim is the one the eye makes: **the arriving frame's computed opacity
 * never reads 1 before an arrive beat has begun.** A frame wearing
 * `data-arriving` is excluded — that is a newcomer appended to its column and
 * not yet part of its division, which no settle is carrying and which its own
 * commit reveals ([B01] of the imposer's arrival rules).
 *
 * Three guards keep the green from being free, and the third is the one the
 * earlier steps of this pass taught: a reading is only evidence if the gesture
 * it reads demonstrably happened.
 *
 *   1. A frame really arrived — a pane id in the census that was not standing
 *      before the dispatch.
 *   2. The close really took `at0622-p1`, and an arrive beat really ran, so
 *      "never 1 before arrive" is a window rather than the whole record.
 *   3. The close really retargeted a settle in flight — a `settle-retarget`
 *      trace row — and it landed before the arrive beat began. Without this
 *      the leg passes on a close that arrived after the arrival was over,
 *      which is a gesture pair that cannot expose the defect at all.
 *
 * **What the pre-fix reading actually was**, taken with the [B03] change
 * reverted out under a `file probe`: the newcomer's own id appears in the
 * retarget rows (`<uuid>:matched:room` beside `at0622-p3:matched:room`),
 * and the beats the census saw across the whole window are `room` and
 * `depart` — **no arrive beat ever ran**. That is [F04] read from its far
 * end. The arm found the frame unprotected, measured it as TRAVELLING
 * because it had a First rect now, and the replacement Last pass planned the
 * chain with nothing arriving in it; the restorers had already handed the
 * opacity back, so the card stood full-strength through a settle that owed
 * it no fade. After the fix the newcomer is absent from the retarget rows —
 * the arm skipped it — and the arrive beat runs at ~840ms. So the leg fails
 * pre-fix on the arrive-beat clause rather than on the opacity list, and
 * both are the same defect: a card that pops in has no arrival to be early
 * to.
 */
for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0701 — an arrival interrupted by a close keeps its hold [${arm.size}]`,
  () => {
    test(
      "a card arriving, closed into during its room beat, never stands at full opacity before its arrive beat",
      async () => {
        const { app, tugbankPath } = await launch(3, blobFor(3), TEST_NAME, { transcripts: arm.size });
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          const before = await frameOrigins(app);
          const mark = await traceMark(app);
          await arrivalCensus(app);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("show-card", ` +
              `{ component: "session" }), null)`,
          );
          // The close lands while the arrival's `room` beat is running, read
          // off the census rather than a fixed delay: a constant raced the
          // arrival, and once the arrival had landed by then the leg read no
          // retarget and could not reach the defect it tests.
          await app.waitForCondition<boolean>(
            `window.__at0622arrival.some(function (s) { return s.beat === "room"; })`,
            { timeoutMs: 4_000 },
          );
          const closeAt = await app.evalJS<number>(
            `(window.__tug.closePane("at0622-p1"), ` +
              `performance.now() - window.__at0622arrivalT0)`,
          );
          await wait(ARRIVAL_CENSUS_MS + 400);
          const samples = await app.evalJS<ArrivalSample[]>(
            `window.__at0622arrival`,
          );
          const after = await frameOrigins(app);
          const retargets = await retargetRows(app, mark);

          const standing = new Set(Object.keys(before));
          const seen = new Set<string>();
          for (const s of samples) {
            for (const id of Object.keys(s.opacity)) seen.add(id);
          }
          const newcomers = [...seen].filter((id) => !standing.has(id));
          const beats: string[] = [];
          for (const s of samples) {
            if (s.beat !== "" && !beats.includes(s.beat)) beats.push(s.beat);
          }
          const firstArrive = samples.findIndex((s) => s.beat === "arrive");

          note(
            `at0701 arrival/close panes: ${JSON.stringify([...standing])} -> ` +
              `${JSON.stringify(Object.keys(after))}, newcomers ` +
              `${JSON.stringify(newcomers)}`,
          );
          note(
            `at0701 arrival/close beats: ${JSON.stringify(beats)} over ` +
              `${samples.length} frames; first arrive at ` +
              `${firstArrive < 0 ? "never" : Math.round(samples[firstArrive].t) + "ms"}`,
          );
          note(
            `at0701 arrival/close retargets: ${JSON.stringify(retargets)}`,
          );

          // ---- The guards. ---------------------------------------------
          expect(
            newcomers.length,
            `arrival/close: a frame really arrived — the census saw ` +
              `${JSON.stringify([...seen])} and the deck was standing at ` +
              `${JSON.stringify([...standing])}. With no newcomer there is ` +
              `no arrival and the claim below is about nothing`,
          ).toBe(1);
          const newcomer = newcomers[0];
          expect(
            "at0622-p1" in after,
            `arrival/close: and the close really took at0622-p1 — ` +
              `${JSON.stringify(Object.keys(after))}`,
          ).toBe(false);
          expect(
            beats,
            `arrival/close: and an arrive beat really ran, so the window ` +
              `below is a window — beats seen ${JSON.stringify(beats)}`,
          ).toContain("arrive");
          expect(
            retargets.length,
            `arrival/close: and the close really retargeted a settle in ` +
              `flight — rows ${JSON.stringify(retargets)}. A close that ` +
              `landed after the arrival was over cannot reach the defect`,
          ).toBeGreaterThan(0);
          expect(
            samples[firstArrive].t,
            `arrival/close: and the arrive beat began AFTER the close, ` +
              `which is what makes the pre-arrive window real`,
          ).toBeGreaterThan(closeAt);

          // ---- The claim. -----------------------------------------------
          const bare = samples
            .slice(0, firstArrive)
            .filter(
              (s) =>
                newcomer in s.opacity &&
                !s.arriving.includes(newcomer) &&
                s.opacity[newcomer] >= 1,
            )
            .map((s) => `${Math.round(s.t)}ms/${s.beat || "-"}`);
          expect(
            bare,
            `arrival/close: the arriving frame never stood at full opacity ` +
              `before its arrive beat began — it did at [${bare.join(", ")}]. ` +
              `Each of those is a frame on which the card was fully visible ` +
              `in a room that had not been made for it: the retarget ran the ` +
              `arrival's own restorers and handed the hold back ([F04])`,
          ).toEqual([]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
