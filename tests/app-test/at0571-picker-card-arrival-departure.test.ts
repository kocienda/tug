/**
 * at0571-picker-card-arrival-departure.test.ts — a Session card's departure
 * from a split column is two motions: `depart`, then `room`.
 *
 * One piece of the at0571 split; the deck shapes, the frame census and the
 * trace readings are `picker-card-arrival-fixture.ts`.
 *
 * The departure is the arrival's design read backwards. What fades where the
 * card was is the card's OWN frame, kept mounted for the settle and marked
 * `data-settle-departing` with its pane id: it stands at the rect it stood at
 * before the close for the whole of its beat, fades there, and its mark is
 * gone before the survivor takes the room back. At rest nothing is left
 * behind.
 *
 * The sitting member is a `hello` card rather than a second Session card: an
 * unbound Session card raises its picker the moment it activates, and a
 * fixture with two of them has two pickers up and two claims against one run.
 *
 * `session-card.tsx`, where the picker is raised, stands at its recorded
 * fan-out and is deliberately not named; `card-lifecycle.ts` owns the channel
 * the picker's presentation rides, so an edit that changes when a card is
 * said to have activated selects this file through it.
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/fold.ts
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/card-lifecycle.ts
 * @covers tugdeck/src/lib/settle-notice.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/opening-placement.ts
 * @family at0571-picker-card-arrival
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { PIXEL_TOL } from "./_harness/tolerances";
import {
  AFTER_LAND_MS,
  PICKER_FORM,
  SHOULD_RUN,
  SITTER,
  TEST_TIMEOUT_MS,
  addSessionCard,
  arrivedPaneId,
  atRest,
  beatFrames,
  beatOrder,
  cancelPicker,
  census,
  launchArrivalApp,
  assertFitAtListCap,
  paneRects,
  removeArrivalPickerSessions,
  seed,
  seedArrivalPickerSessions,
  spread,
  wait,
  worstHeightStep,
} from "./picker-card-arrival-fixture";

beforeAll(seedArrivalPickerSessions);
afterAll(removeArrivalPickerSessions);

describe.skipIf(!SHOULD_RUN)("AT0571: the divided arrival", () => {
  test(
    "cancelling the picker takes the card away, on its own frame, where it stood",
    async () => {
      const app = await launchArrivalApp("at0571-departure");
      try {
        await seed(app);
        await app.evalJS<null>(`(${addSessionCard}, null)`);
        // The picker is in the new Session card's body — the deck's only one.
        await kindBody(app, "session").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);
        await assertFitAtListCap(app, "departure picker");

        // The height the leaving card stands at, read before it goes: the
        // survivor's travel is measured against it below, and once the card
        // is gone there is nothing left to read it off.
        const leaving = await arrivedPaneId(app);
        expect(leaving, "the card to cancel is on the canvas").not.toBeNull();
        const leavingRect = (await paneRects(app, [leaving ?? ""]))[leaving ?? ""];
        const leavingHeight = leavingRect.height;

        const samples = await census(app, cancelPicker, kindBody(app, "session"));
        const order = beatOrder(samples);
        const depart = beatFrames(samples, "depart");
        const room = beatFrames(samples, "room");
        note(
          "departure beats",
          `order=${JSON.stringify(order)} depart=${depart.length}f room=${room.length}f leaving=${leavingHeight.toFixed(1)}`,
        );

        // ── TWO MOTIONS, read backwards. The card fades on its own beat,
        //    then the column re-divides in one — there is no separate grow,
        //    because the survivor taking the room back IS the arrangement
        //    change ([P08]). ──
        expect(order, "the departure is exactly depart then room").toEqual([
          "depart",
          "room",
        ]);
        expect(
          depart.length,
          "the depart beat must be sampled mid-motion",
        ).toBeGreaterThan(3);
        expect(
          room.length,
          "the room beat must be sampled mid-motion",
        ).toBeGreaterThan(3);

        // The survivor holds still for the whole of the card's fade — the
        // departure's half of "one kind of thing at a time".
        const departStep = worstHeightStep(depart);
        note(
          "departure hold",
          `worst height step during depart: ${departStep.step.toFixed(2)}px on ${departStep.pane || "nothing"}`,
        );
        expect(
          departStep.step,
          "no frame changes size during the depart beat",
        ).toBeLessThan(PIXEL_TOL);

        // ── What departs is the CARD'S OWN FRAME, marked with its own pane
        //    id, standing where it stood before the close and fading there.
        //    Nothing is planted to stand in for it ([D9]). ──
        const own = depart.flatMap((s) =>
          s.departing.filter((d) => d.key === leaving),
        );
        const others = samples.flatMap((s) =>
          s.departing.filter((d) => d.key !== leaving),
        );
        const worstDrift = own.reduce(
          (worst, d) =>
            Math.max(
              worst,
              Math.abs(d.top - leavingRect.top),
              Math.abs(d.height - leavingRect.height),
            ),
          0,
        );
        const opacities = own.map((d) => d.opacity);
        note(
          "departing frame",
          `${own.length} depart sample(s) carrying ${leaving}, worst drift ${worstDrift.toFixed(2)}px, opacity ${opacities.length === 0 ? "—" : `${Math.max(...opacities).toFixed(2)}→${Math.min(...opacities).toFixed(2)}`}, ${others.length} other target sample(s)`,
        );
        expect(
          own.length,
          "the card's own frame is carried on the depart beat",
        ).toBeGreaterThan(0);
        expect(others.length, "and nothing else is").toBe(0);
        expect(
          worstDrift,
          "it stands at the rect it stood at before the close",
        ).toBeLessThan(1);
        expect(
          Math.max(...opacities) - Math.min(...opacities),
          "and it fades there",
        ).toBeGreaterThan(0.5);

        // The departure is the depart beat's whole subject, so its mark is
        // gone by the time the survivor takes the room back.
        const ghostsDuringRoom = room.filter((s) => s.ghosts > 0);
        note(
          "departing mark",
          `standing on ${depart.filter((s) => s.ghosts > 0).length} depart sample(s), ${ghostsDuringRoom.length} room sample(s)`,
        );
        expect(
          ghostsDuringRoom.length,
          "the departure is over before the room beat starts",
        ).toBe(0);

        // And the survivor really did grow back over the whole run.
        const growTravel = spread(room, (s) => s.heights[SITTER] ?? 0);
        note("departure extent", `survivor travel=${growTravel.toFixed(2)}`);
        expect(
          growTravel,
          "the survivor grows back over the room the card left",
        ).toBeGreaterThan(leavingHeight * 0.8);


        await wait(AFTER_LAND_MS);
        const rest = await atRest(app);
        note("departure at rest", JSON.stringify(rest));
        expect(rest.settling, "the settle mark is off the canvas").toBe(false);
        expect(rest.beat, "and so is the beat attribute").toBeNull();
        expect(
          rest.inlineOpacities,
          "no frame keeps an inline opacity hold",
        ).toEqual([]);
        expect(rest.ghosts, "and no departing target is still marked").toBe(0);
        expect(rest.picker, "the picker went with its card").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
