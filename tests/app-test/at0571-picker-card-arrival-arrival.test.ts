/**
 * at0571-picker-card-arrival-arrival.test.ts — a Session card's arrival is
 * TWO motions, and the height it arrives at was known before the commit.
 *
 * One piece of the at0571 split; the deck shapes, the frame census and the
 * trace readings are `picker-card-arrival-fixture.ts`.
 *
 * Opening a Session card into a split column used to be one commit's worth of
 * everything at once, then three motions. An arrival is one thing happening —
 * the column re-dividing to seat a newcomer — so the arrangement change and
 * the newcomer's entrance are FUSED into a single `room` beat, the card's own
 * entrance rides the second, and the picker rides the frame rather than
 * waiting behind a beat it cannot see ([P07], [P08]). The height the card
 * arrives at is MEASURED before the commit that appends the pane ([P02]).
 *
 *   1. **The arrival is exactly `room` then `arrive`, and nothing else.**
 *   2. **The picker is on the frame from the first frame the reader can see
 *      it**, and on every sample after.
 *   3. **Nothing re-targets the settle once it is launched.** Exactly one
 *      armed `settle-arm` is recorded across the whole gesture.
 *   4. **The bid was measured, and the picker agrees with it.** No
 *      `opening-bid-mismatch` row is recorded.
 *   5. **Nothing is left behind.** At rest no frame carries an inline
 *      `opacity`, the canvas carries neither `data-imposer-settling` nor
 *      `data-imposer-beat`, and no departing target is marked.
 *
 * The fixture SEALS slot 1 — the focused card in a split of its own — so the
 * arrival read is the fallback, the bottom of the nearest split. The second
 * test is the ordinary deck: the same split with an empty slot beside it,
 * and the card opens in the empty slot, picker and all.
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

import { launchTugApp, note } from "./_harness";
import { kindBody, waitForBodyReady } from "./_harness/card-reach";
import { PIXEL_TOL } from "./_harness/tolerances";
import { IMPOSITION_GAP_PX } from "../../tugdeck/src/lib/layout-imposer";
import { pickerPanelNaturalHeight } from "./picker-sessions-fixture";
import {
  AFTER_LAND_MS,
  BID_DRIFT_PX,
  PICKER_FORM,
  SHEET_PANEL_TO_MEMBER_PX,
  SHOULD_RUN,
  SITTER,
  TEST_TIMEOUT_MS,
  addSessionCard,
  arrivedPanes,
  atRest,
  beatFrames,
  beatOrder,
  census,
  heldFor,
  measureAtListCap,
  openDeckShape,
  removeArrivalPickerSessions,
  seed,
  seedArrivalPickerSessions,
  spread,
  traceMark,
  traceSince,
  wait,
} from "./picker-card-arrival-fixture";

beforeAll(seedArrivalPickerSessions);
afterAll(removeArrivalPickerSessions);

describe.skipIf(!SHOULD_RUN)("AT0571: the divided arrival", () => {
  test(
    "the column makes room and the card rides in on the picker it already measured",
    async () => {
      const app = await launchTugApp({ testName: "at0571-arrival" });
      try {
        await seed(app);
        const runBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="${SITTER}"]').getBoundingClientRect().height`,
        );

        const mark = await traceMark(app);
        const samples = await census(app, addSessionCard);
        const arrived = arrivedPanes(samples);
        note("arrival", `panes arrived: ${JSON.stringify(arrived)}`);
        expect(arrived.length, "exactly one frame arrived").toBe(1);
        const newcomer = arrived[0];

        const order = beatOrder(samples);
        const room = beatFrames(samples, "room");
        const arrive = beatFrames(samples, "arrive");
        note(
          "arrival beats",
          `order=${JSON.stringify(order)} room=${room.length}f arrive=${arrive.length}f run before=${runBefore.toFixed(2)}`,
        );

        // ── 1. TWO MOTIONS. The arrangement change and the newcomer's
        //    entrance are one beat and its successor, and there is no third.
        //    Asserted as the whole census rather than as a presence check, so
        //    a shrink or a move creeping back in fails here rather than
        //    passing under an assertion that only looked for what it wanted
        //    ([P08]). ──
        expect(order, "the arrival is exactly room then arrive").toEqual([
          "room",
          "arrive",
        ]);
        expect(
          room.length,
          "the room beat must be sampled mid-motion",
        ).toBeGreaterThan(3);
        expect(
          arrive.length,
          "the arrive beat must be sampled mid-motion",
        ).toBeGreaterThan(3);

        // 4, next, because 1 to 3 are only claims if there was a real arrival
        // to read them over. The sitter's own height is the motion, and the
        // bid is the number the app measured before it committed.
        const sitterTravel = spread(room, (s) => s.heights[SITTER] ?? 0);
        // Both resting heights are read from the LAST sample rather than from
        // the extreme of the room beat. The beat's last sampled frame is a
        // pixel or so short of where the spring finally lands, and reading the
        // minimum there would build that overshoot into the arithmetic — which
        // is what turned an exact claim into a tolerance on the first run of
        // this file.
        const last = samples[samples.length - 1];
        const sitterRest = last.heights[SITTER] ?? -1;
        const newcomerRest = last.heights[newcomer] ?? -1;
        // The bid the card was REVEALED on, which is the LAST one the deck
        // held while the pane was hidden — not the first the sampler caught.
        // A hidden pane's sheet reports more than once as its list settles
        // (446 then 444, on this fixture), and the reveal spends the most
        // recent report by construction, so the first is a superseded number
        // and the claim below would be asked against a floor the allocator
        // never saw. The first live report hands the bid over and clears it,
        // so the last sample carrying one is the number the reveal used.
        const bidSamples = samples
          .map((s) => s.held[newcomer])
          .filter((v): v is number => typeof v === "number");
        const bid = bidSamples[bidSamples.length - 1] ?? -1;
        note(
          "arrival extent",
          `sitter travel=${sitterTravel.toFixed(2)} run before=${runBefore.toFixed(2)} at rest sitter=${sitterRest.toFixed(2)} newcomer=${newcomerRest.toFixed(2)} held=${bid.toFixed(2)} on ${bidSamples.length} sample(s)`,
        );
        expect(
          bid,
          "addCard measured the opening form and the deck holds the number, on the production path",
        ).toBeGreaterThan(0);
        // The bid is a FLOOR, so the newcomer stands at least there — this
        // fixture's column has nothing spare to lift it past, but the claim is
        // written the way the allocator reads the number rather than the way
        // this run happens to land ([P02]).
        expect(
          newcomerRest,
          "the arriving card stands at least at the height the app bid for it",
        ).toBeGreaterThanOrEqual(bid - PIXEL_TOL);
        // And the sitter holds every pixel the newcomer did not take: the two
        // members and the gap between them are the run the sitter held alone.
        expect(
          sitterRest + IMPOSITION_GAP_PX + newcomerRest,
          "the sitter holds every pixel the newcomer did not take",
        ).toBeCloseTo(runBefore, 0);
        expect(
          sitterTravel,
          "and it travelled the whole extent to get there",
        ).toBeGreaterThan(bid * 0.8);

        // ── 2. The picker RIDES THE FRAME. The reverse of what this file
        //    used to assert: on the first sample the arriving frame is visible
        //    at all, the picker is already in the document, and it is there on
        //    every sample after ([P07]). A picker that waited for the beats
        //    would be absent on the first visible sample and would make the
        //    arrival three motions again. The picker is in the card's body,
        //    so what the shell reads per frame is that body on screen: shown
        //    only once it reported ready, which for an unbound card is its
        //    picker mounted and quiet. ──
        const visible = samples.filter((s) => {
          const o = s.opacity[newcomer];
          return o !== undefined && Number.parseFloat(o) > 0;
        });
        const firstVisible = visible[0];
        const visibleWithoutPicker = visible.filter((s) => s.bodyShown[newcomer] !== true);
        note(
          "picker",
          `first visible at t=${(firstVisible?.t ?? -1).toFixed(0)}ms beat=${firstVisible?.beat || "none"} body shown=${firstVisible?.bodyShown[newcomer] ?? false}; ${visible.length} visible sample(s), ${visibleWithoutPicker.length} without the picker`,
        );
        expect(
          visible.length,
          "the arriving frame becomes visible during the census",
        ).toBeGreaterThan(0);
        expect(
          visibleWithoutPicker.length,
          "the picker is on the frame from the first sample the reader can see it",
        ).toBe(0);

        // ── 3. Nothing re-targeted the settle. One armed arm for the whole
        //    gesture: a second one is a number that landed after the commit
        //    and re-aimed a settle already in flight, which is precisely what
        //    measuring before the commit removes ([P02], [B06]).
        //    4, continued: and the app itself says the first live report and
        //    the bid were the same number, because the guard that would have
        //    recorded a disagreement recorded nothing ([P04], [Spec S04]). ──
        const trace = await traceSince(app, mark);
        note(
          "arrival trace",
          `${trace.armedArms} armed of ${trace.arms} arm(s); mismatches=${JSON.stringify(trace.mismatches)}`,
        );
        expect(
          trace.armedArms,
          "the arrival is one armed settle, and nothing re-targeted it",
        ).toBe(1);
        expect(
          trace.mismatches,
          "no opening-bid mismatch — the first live report was the bid",
        ).toEqual([]);

        // 5. Nothing is left behind.
        await wait(AFTER_LAND_MS);
        const rest = await atRest(app);
        note("arrival at rest", JSON.stringify(rest));
        expect(rest.settling, "the settle mark is off the canvas").toBe(false);
        expect(rest.beat, "and so is the beat attribute").toBeNull();
        expect(
          rest.inlineOpacities,
          "no frame keeps an inline opacity hold",
        ).toEqual([]);
        expect(rest.ghosts, "and no departing target is still marked").toBe(0);
        expect(rest.picker, "the picker is up at rest").toBe(true);

        // ── 4, finished. The bid the app wrote before the commit, against a
        //    fresh reading of the panel the user is now looking at, put
        //    through the same chrome arithmetic the deck used. This is the
        //    arc's whole claim in one comparison, and neither side of it is a
        //    number anybody wrote down. ──
        const liveNatural = await pickerPanelNaturalHeight(kindBody(app, "session"));
        const held = await heldFor(app, newcomer);
        note(
          "bid vs first report",
          `bid=${bid.toFixed(1)} held=${held.toFixed(1)} live panel natural=${(liveNatural ?? -1).toFixed(1)} → member floor ${((liveNatural ?? -1) + SHEET_PANEL_TO_MEMBER_PX).toFixed(1)}`,
        );
        expect(liveNatural, "the picker's panel is on screen").not.toBeNull();
        expect(
          Math.abs(bid - ((liveNatural ?? -1) + SHEET_PANEL_TO_MEMBER_PX)),
          "the bid is the panel the user sees, through the deck's own arithmetic",
        ).toBeLessThanOrEqual(BID_DRIFT_PX);
        // And the handoff carried the same number across: the bid is gone and
        // the member's own claim stands at it, which is what a first report
        // AGREEING with a bid does ([B02]).
        expect(
          Math.abs(held - bid),
          "the number the deck holds for the member is still the number it bid",
        ).toBeLessThanOrEqual(BID_DRIFT_PX);

        // The picker over a project with more sessions than the list's cap
        // holds — the case a real project presents. It comes LAST, because
        // filling the list changes the panel and so the claim above is only
        // readable before it ([P05]: a genuinely-changed picker is an honest
        // update, not a defect).
        await measureAtListCap(app, "arrival picker");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
  test(
    "with an empty slot beside the split, the card opens there instead",
    async () => {
      const app = await launchTugApp({ testName: "at0571-open-slot" });
      try {
        await app.seedDeckState({ state: openDeckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        await app.evalJS<null>(`(${addSessionCard}, null)`);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getDeckState().cards.some(function (c) {
            return c.componentId === "session";
          })`,
          { timeoutMs: 8_000 },
        );
        const placed = await app.evalJS<{ paneId: string; cardId: string; slot: number | null }>(
          `(function () {
            var state = window.tugdeck.diag.getDeckState();
            var card = state.cards.filter(function (c) {
              return c.componentId === "session";
            })[0];
            var pane = state.panes.filter(function (p) {
              return p.cardIds.indexOf(card.id) !== -1;
            })[0];
            return { paneId: pane.id, cardId: card.id, slot: pane.slot === undefined ? null : pane.slot };
          })()`,
        );
        note("open slot", JSON.stringify(placed));
        expect(
          placed.slot,
          "the empty slot beside the focused card's split, never the split itself",
        ).toBe(1);

        // It still rides in on its picker: the arrival is the same one, only
        // somewhere better. The picker is in the body of the card that pane
        // holds.
        const placedBody = await waitForBodyReady(app, placed.cardId);
        await placedBody.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 8_000 },
        );

        // The split column was not joined: its one member is still its only one.
        expect(
          await app.evalJS<number>(
            `window.tugdeck.diag.getDeckState().panes.filter(function (p) {
              return p.slot === 0;
            }).length`,
          ),
          "the split at slot 0 took no newcomer",
        ).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
