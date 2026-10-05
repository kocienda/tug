/**
 * at0697-settle-activation.test.ts — an activation's settle, its ring, its click task and its record.
 *
 * `at0621` asks whether the activation SLID rather than faded. This file asks
 * the question underneath it: when the strip travelled, did the picture arrive
 * on time, and did the settle record its own frames honestly? Three legs read
 * one gesture, activating a card on a four-up flow deck:
 *
 *   - the focus ring waits for the landing and moves only opacity;
 *   - the click task is bounded — a pure slide raises no resize episode, and a
 *     width change still does, which is what makes the zero evidence;
 *   - the canvas writes one `settle-frames` row per settle and none at rest,
 *     agreeing with the bench probe, and its [D9] guard reads clean.
 *
 * The fourth leg is that guard's falsifier: eight cards in shared columns,
 * divided, whose settle carries a real `height` tween the guard must report.
 * An empty `violations` on the activation means nothing unless a non-empty
 * one is reachable through the same guard, on the same build.
 *
 * Two instruments read one gesture, and which window a clause belongs over is
 * load-bearing. The canvas's own `settle-frames` trace row covers the SETTLE,
 * arm to release, so the timing clauses are read off it. The bench probe
 * covers the WHOLE window — the harness round trip that dispatches the
 * activation, the click task and the React commit that run before the canvas
 * arms, then the settle, then the landing. What the probe is for is the
 * per-tick census no trace row can carry: opacity, rects, fixed descendants,
 * and the suspension floor.
 *
 * The forcing leg — the sabotage that proves the sampler sees — is
 * `at0704-settle-walk`'s, beside the bar it falsifies: it plants its task
 * inside a walk and must fail `expectB09Bar`, which the walk holds and no
 * leg here asserts.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/lib/flash-pane-border.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/chrome/slot-vacancy.css
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/default-focus.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/tug-list-view.css
 * @covers tugdeck/src/lib/settle-frame-probe.ts
 * @covers tugdeck/src/deck-trace.ts
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/scripts/audit-motion.ts
 * @covers tuglaws/animation-doctrine.md
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BOOKKEEPING_KEYS,
  SETTLE_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  type SettleFramesRow,
  activateAndReadSameTask,
  activateLast,
  budgetCensus,
  blobFor,
  columnBlob,
  flashCensus,
  home,
  launch,
  motionViolationRows,
  settleFrameRows,
  traceMark,
  traceWithSettleFrames,
  wait,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0697-settle-activation";
const ARMS = transcriptArms();

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0697 — the flash waits for the landing, and moves only opacity [${arm.size}]`,
  () => {
    test(
      "four session cards: no ring in the click's frame, an opacity-only ring after it lands",
      async () => {
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, { transcripts: arm.size });
        try {
          await home(app);
          await wait(AFTER_LAND_MS);

          // ---- Inside the click's own frame. ---------------------------
          const atClick = await activateAndReadSameTask(app, "at0622-c4");
          note(`at0697 flash at click: ${JSON.stringify(atClick)}`);
          expect(
            atClick.settling,
            `the activation armed a settle, or "the flash did not start" is a ` +
              `claim about a gesture with nothing to wait for`,
          ).toBe(true);
          expect(
            atClick.lit,
            `and no ring is lit in the frame the click ran in — the flash runs ` +
              `for nearly two seconds and the settle for a few hundred ` +
              `milliseconds, so a ring that starts here spends its first third ` +
              `over the motion it is announcing ([B05])`,
          ).toBe(0);

          // ---- After the landing. --------------------------------------
          await wait(SETTLE_MS + 120);
          const after = await flashCensus(app);
          note(`at0697 flash after the landing: ${JSON.stringify(after)}`);
          expect(
            after.lit,
            `the ring is lit once the frames have stopped, and on exactly one ` +
              `pane — the at-most-one-ring rule. A zero here would mean the ` +
              `zero above proved nothing`,
          ).toBe(1);
          expect(
            after.paneId,
            `and it is lit on the pane the gesture named`,
          ).toBe("at0622-p4");
          expect(
            after.properties.filter((p) => !BOOKKEEPING_KEYS.includes(p)),
            `[B03]: the ring is drawn once and only its opacity moves. It ` +
              `animated \`box-shadow\` before this arc, which is a repaint of ` +
              `a full-pane layer on every frame of a 1750ms run`,
          ).toEqual(["opacity"]);

          // ---- The restart is a seek, not a cancel. --------------------
          // The card is now in the reader's slot, so this activation arms no
          // settle and the flash runs immediately — which is the path that
          // must not go unanswered, and the path the seek lives on.
          const before = await flashCensus(app);
          await activateLast(app, 4);
          const restarted = await flashCensus(app);
          note(
            `at0697 flash restart: ${before.currentTime.toFixed(0)}ms -> ` +
              `${restarted.currentTime.toFixed(0)}ms`,
          );
          expect(
            restarted.lit,
            `a re-request on the pane already ringing leaves exactly one ring`,
          ).toBe(1);
          expect(
            restarted.currentTime,
            `and restarts it in place: the effect is sought back to zero ` +
              `rather than cancelled. A cancel leaves the engine nothing to ` +
              `diff at the next recalc, so the ring would simply stop — which ` +
              `is why this reads the clock rather than the class. Was ` +
              `${before.currentTime.toFixed(0)}ms`,
          ).toBeLessThan(before.currentTime);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0697 — the click task is bounded, and a settling frame holds its cells [${arm.size}]`,
  () => {
    test(
      "four session cards: a slide raises no episode, a width change does",
      async () => {
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, { transcripts: arm.size });
        try {
          await home(app);
          await wait(AFTER_LAND_MS);

          // ---- At rest. ------------------------------------------------
          const rest = await budgetCensus(app);
          note(`at0697 budget at rest: ${JSON.stringify(rest)}`);
          expect(
            rest.cvEventSupported,
            `[P07] reads cell relevance off the engine's own ` +
              `\`contentvisibilityautostatechange\`. Risk R03's fallback — a ` +
              `\`checkVisibility\` pass per cell at settle-arm — is a real ` +
              `cost at exactly the moment [B06] is protecting, so whether ` +
              `this engine has the event is a fact worth pinning rather ` +
              `than assuming`,
          ).toBe(true);
          expect(
            rest.episodes,
            `no episode is standing open on a settled deck`,
          ).toBe(0);

          // ---- The slide: the gesture this arc exists for. -------------
          await activateLast(app, 4);
          await wait(80);
          const sliding = await budgetCensus(app);
          note(`at0697 budget mid-slide: ${JSON.stringify(sliding)}`);
          expect(
            sliding.settling,
            `the activation armed a settle, or "it raised no episode" is a ` +
              `claim about a gesture that never happened`,
          ).toBe(true);
          expect(
            sliding.episodes,
            `[B06]: a pure flow slide raises NO resize episode. The frames ` +
              `travel and nothing reflows, so there is no place to hold and ` +
              `no reason to walk a scroller subtree with ` +
              `\`getComputedStyle\` up to twelve deep, per frame, inside the ` +
              `task that is about to hand the compositor its first frame ` +
              `([F06]). Raised on ${sliding.episodes}`,
          ).toBe(0);

          // ---- The falsifying leg ([D5]). ------------------------------
          // A census that reads zero everywhere proves nothing. A width
          // change is a real reflow, and it must still raise its episodes:
          // the gate is on the SIZE half of the signature, not on the
          // episode machinery.
          await wait(AFTER_LAND_MS);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", ` +
              `{ preset: "wide" }), null)`,
          );
          await wait(80);
          const resizing = await budgetCensus(app);
          note(`at0697 budget mid-resize: ${JSON.stringify(resizing)}`);
          expect(
            resizing.episodes,
            `a gesture that really does resize every frame still raises its ` +
              `episodes. A zero here would mean the zero above was the ` +
              `census being blind rather than the click task being bounded`,
          ).toBeGreaterThan(0);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0697 — the settle records its own frames, and its own violations [${arm.size}]`,
  () => {
    test(
      "four session cards: one row per settle, agreeing with the probe, and none at rest",
      async () => {
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, { transcripts: arm.size });
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          // ---- At rest, nothing is recorded. ---------------------------
          const restMark = await traceMark(app);
          await wait(AFTER_LAND_MS);
          const atRest = await settleFrameRows(app, restMark);
          note(`at0697 settle-frames at rest: ${atRest.length}`);
          expect(
            atRest.length,
            `[D1]: a deck nobody is touching writes no row, because the pump ` +
              `that feeds it is armed by a settle and cancelled by the ` +
              `release. A row here would mean something samples at rest`,
          ).toBe(0);

          // ---- One gesture, one row. -----------------------------------
          const mark = await traceMark(app);
          await app.armSettleFrameProbe();
          await wait(120);
          await activateLast(app, 4);
          await wait(AFTER_LAND_MS);
          const probe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const rows = await settleFrameRows(app, mark);
          note(`at0697 settle-frames row: ${JSON.stringify(rows)}`);

          expect(
            rows.length,
            `one activation, one record — written at the release, which fires ` +
              `once for the whole window however many times the settle ` +
              `retargeted inside it`,
          ).toBe(1);
          const row = rows[0] as SettleFramesRow;
          expect(
            row.panes,
            `and it counted the frames it sampled`,
          ).toBeGreaterThan(0);
          expect(
            row.ticks,
            `and it sampled the window rather than reporting an empty array — ` +
              `the probe saw ${probe.ticks} ticks over the same gesture`,
          ).toBeGreaterThan(10);
          // One classifier over one gesture, read against each window's own
          // origin. `firstPaintDelayMs` no longer agrees and must not be
          // asserted to: under [P01] the row measures from the gesture — the
          // canvas's arm here, since an activation leaves no fold stamp — and
          // the bench probe measures from its own arm, which opened 120ms and
          // a harness round trip earlier. Two different questions about two
          // different windows, both correct.
          //
          // `moveFirstPaintDelayMs` is the field that still has to agree, and
          // it is the same assertion this clause always made: the move
          // animation's own birth-to-first-advance is a fact about the deck,
          // not about either sampler's window, so a record written off an
          // empty array or a pump that never ran cannot reproduce it.
          note(
            `at0697 leads: row=${row.firstPaintDelayMs}ms ` +
              `(commit ${row.commitDelayMs}ms) vs probe ` +
              `${probe.firstPaintDelayMs}ms — different origins by design`,
          );
          expect(
            row.firstPaintDelayMs,
            `the row's lead is a real measurement from its own origin`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            probe.firstPaintDelayMs,
            `and so is the probe's, from its`,
          ).toBeGreaterThanOrEqual(0);
          // Agree to within a millisecond, not exactly: both readings are
          // rounded to whole milliseconds off clocks that tick apart, so the
          // same instant reads 24 on one and 25 on the other. A record written
          // off an empty array or a pump that never ran misses by a frame,
          // which this still catches.
          expect(
            Math.abs(row.moveFirstPaintDelayMs - probe.moveFirstPaintDelayMs),
            `one classifier over one gesture, so the move's own clock has to ` +
              `agree to within the rounding: row ${row.moveFirstPaintDelayMs}ms ` +
              `vs probe ${probe.moveFirstPaintDelayMs}ms`,
          ).toBeLessThanOrEqual(1);

          // ---- [D9]'s runtime guard. -----------------------------------
          const violations = await motionViolationRows(app, mark);
          note(`at0697 settle-motion-violation: ${JSON.stringify(violations)}`);
          expect(
            [...violations],
            `[D9]: the activation is a translate over layers that already ` +
              `stand, so no frame animates anything but \`transform\` and ` +
              `\`opacity\`. The row's own field reads ` +
              `${JSON.stringify(row.violations)}`,
          ).toEqual([]);
          expect(
            [...row.violations],
            `and the record and the guard are split from one field, so they ` +
              `cannot disagree`,
          ).toEqual([...violations]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "eight cards in shared columns: the height-bearing gesture IS reported, which is what makes the zero above evidence",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob(), TEST_NAME, { transcripts: arm.size });
        try {
          await traceWithSettleFrames(app);
          await wait(AFTER_LAND_MS);

          const mark = await traceMark(app);
          for (let slot = 0; slot < 4; slot += 1) {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-column-mode", ` +
                `{ slot: ${slot}, mode: "split" }), null)`,
            );
          }
          // The record is written at the RELEASE, so the read waits for one
          // rather than for a duration. Four dispatches land back to back and
          // each retargets the settle, so the choreography this leg produces
          // runs well past a single activation's window — a fixed sleep here
          // read an unreleased settle and found no row at all, which looked
          // exactly like a guard that could not see `height`.
          await app.waitForCondition<boolean>(
            `window.__deckTrace.since(${mark}).some(function (e) {
               return e.kind === "settle-frames";
             })`,
            { timeoutMs: 20_000 },
          );

          const violations = await motionViolationRows(app, mark);
          note(`at0697 column violations: ${JSON.stringify(violations)}`);
          note(`at0697 column rows: ${JSON.stringify(await settleFrameRows(app, mark))}`);
          note(`at0697 column arms: ${JSON.stringify(await app.evalJS<unknown>(`window.__deckTrace.since(${mark}).filter(function (e) { return e.kind === "settle-arm" || e.kind === "settle-release" || e.kind === "store-notify"; }).map(function (e) { return e.kind + ":" + (e.outcome || e.source || e.caller || "") + ":" + (e.panes === undefined ? "" : e.panes); })`))}`);

          // This is a FINDING, not a fixture. A column that divides gives
          // each member a share of the height, and the settle carries that as
          // a real `height` tween — a main-thread property inside the settle
          // window, which is precisely what [D9] forbids. The law is written
          // knowing it, and this guard's job is to keep saying so rather than
          // to be tuned until it stops.
          //
          // It is also the [D5] leg for the whole record: the activation's
          // empty `violations` above means nothing unless a non-empty one is
          // reachable through the same guard, on the same deck, in the same
          // build. It is.
          expect(
            violations.length,
            `the guard reports the settle's own height tween. A zero here ` +
              `would mean the zero on the activation was the guard being ` +
              `blind rather than that gesture being clean`,
          ).toBeGreaterThan(0);
          expect(
            violations.every((v) => v.endsWith(":height")),
            `and every row names \`height\`, the one property the ` +
              `choreography genuinely animates off the compositor. Anything ` +
              `else here is a new violation worth reading: ` +
              `${JSON.stringify(violations)}`,
          ).toBe(true);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
