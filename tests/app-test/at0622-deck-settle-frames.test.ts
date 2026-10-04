/**
 * at0622-deck-settle-frames.test.ts — the deck's settle, sampled frame by
 * frame.
 *
 * ## What this file is for
 *
 * `at0621` asks whether the activation SLID rather than faded. This one asks
 * the question underneath it: when the strip travelled, did the picture arrive
 * on time? A settle can satisfy every opacity and rect claim in `at0621` and
 * still read as a cut, because the move beat's spring is critically damped —
 * most of the travel is in the first third of the 400ms window — so a raster
 * hole in the first frame swallows most of the visible motion. The picture
 * arrives already mostly moved and the eye reads a jump.
 *
 * ## The instrument
 *
 * `tugdeck/src/lib/settle-frame-probe.ts`, driven through the harness. Once per
 * animation frame it records every shown frame's rect, computed opacity,
 * animation count and any paint property its effects animate, beside the move
 * animation's own `currentTime`. The classifier over that run separates the two
 * failures that look identical from outside: the tween STARTED late (a long
 * task delayed the first rendering opportunity, so `currentTime` is still zero
 * when the first tick lands) and the tween RAN but PAINTED late (`currentTime`
 * advanced normally while the wall-clock gaps blew out).
 *
 * ## What the gesture owes, and where each clause is read
 *
 * The activation owes the eye a slide: no inter-frame gap longer than two
 * display frames across the move beat, a first painted frame within one frame
 * of the tween's start, no opacity dip, no rect that moves again after the
 * beat lands, no `position: fixed` descendant inside a promoted frame, and no
 * property animated off the compositor. And it owes that at eight cards as
 * well as at four, within one display frame — the cost must not grow with the
 * count, which is the whole signature the baseline found (+51ms at four,
 * +71ms at eight over an idle control).
 *
 * Two instruments read one gesture, and which window a clause belongs over is
 * load-bearing. The canvas's own `settle-frames` trace row covers the SETTLE,
 * arm to release, so the two timing clauses are read off it. The bench probe
 * covers the WHOLE window — the harness round trip that dispatches the
 * activation, the click task and the React commit that run before the canvas
 * arms, then the settle, then the landing — so its `longestGapMs` is a number
 * about the window rather than about the beat. What the probe is for is the
 * per-tick census no trace row can carry: opacity, rects, fixed descendants,
 * and the suspension floor. Every field of both goes through `note()`, so a
 * failure arrives with its full reading rather than with one number.
 *
 * ## The forcing leg
 *
 * A third leg sabotages the settle on purpose, with a long task planted inside
 * the window AFTER the activation dispatch, so it burns while the canvas is
 * armed rather than ahead of it. It asserts that BOTH readings notice: the
 * bench probe reports a gap at least as wide as the planted task, and the
 * canvas's own record fails the bar it had just passed. Without it every green
 * reading this file takes is unfalsifiable — a sampler that has silently
 * stopped observing and a deck that genuinely stopped dropping frames produce
 * the same zeros. That is the exact failure the 2026-09-18 drop fix made,
 * where a fix was "verified" green and had not fixed anything.
 *
 * ## What an occluded run looks like
 *
 * A covered harness window suspends `requestAnimationFrame`, and a suspended
 * window reports the same zeros as a perfect deck. The probe derives the
 * display's frame period from the run's own quiet ticks and sets `suspended`
 * when the tick count falls below the floor a served window would produce, so
 * an occluded run fails on `suspended` — naming the tick count and the derived
 * period — rather than passing silently.
 *
 * ## The standing reds lived in `at0654`
 *
 * This file is the TRIPWIRE: every leg in it holds its bar on a clean tree,
 * so a red here is new. The legs that are red on real readings — the warm
 * flip and the fold, which sit at the edge of their bars and rotate between
 * clauses run to run, and a card's departure and the sidebars' show, which
 * fail the same way on every run — were moved to
 * `at0654-deck-settle-standing-reds.test.ts`, where each is a recorded finding
 * with its reading beside it, and that file was deleted on 2026-10-03: a test
 * built to stay red is a carry wearing a file's name. Its readings are in
 * `briefs/zero-red-app-tests-brief.md`. This file is now the only reader of
 * `settle-frames-fixture.ts`.
 *
 * **The resize-to-fit leg's bar is 2.5 frames, not 2** — re-budgeted by the
 * user on 2026-10-03. It read 2.06–2.18 on every run: one jittered frame,
 * the same reading `FOLD_GAP_FRAMES_BAR` forgives, over a settle whose commit
 * retunes every rail at once. The instrument and the clause are unchanged.
 *
 * ## The fixture
 *
 * A four-up FLOW deck, following `at0621`: the band must be narrower than the
 * strip or the activation moves nothing and the claim is unfalsifiable. The
 * cards are `componentId: "session"` because a session card is the heaviest
 * thing the deck holds, and the per-frame cost this arc is about is the cost of
 * settling those. The second leg runs eight of them, which is the whole
 * question of whether the cost grows with the card count.
 *
 * ## The fold leg
 *
 * A session card's fold is the same question asked of a gesture with no
 * transform in it at all: its term is a real `height`, so the move animation
 * every clause above reads simply does not exist, and the instrument reported
 * `-1` — "there was no move to be late" — about a fold that froze for 86–130ms
 * in front of the user. The record now measures from the GESTURE and carries
 * the lead as a gap, so a fold is readable at all; the fold leg holds it to
 * ONE display frame across the whole motion, in both directions, on the
 * four-up flow fixture. Flow and not the shared-column one: a flow column
 * never divides, so the folding pane's own `height` is the only height term in
 * the window, where on the column fixture the fold's row and the division's
 * standing row are the same row.
 *
 * `deck-manager.ts` is deliberately NOT named, and the absence is the
 * selection budget's answer rather than an oversight: that file already fans
 * out to the 22 tests `ACCEPTED_FANOUT` records, and a 23rd would turn a
 * one-line edit there into a sweep. What the fold leg needs covered is the
 * gesture stamp's CONTRACT — when it may be published and when it may not —
 * and that is `deck-manager-store.ts`'s doc comment, which is named below.
 *
 * @covers tugdeck/src/deck-manager-store.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/lib/settle-frame-probe.ts
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/scripts/audit-motion.ts
 * @covers tuglaws/animation-doctrine.md
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/flash-pane-border.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/styles/chrome.css
 * @covers tugdeck/src/components/chrome/slot-vacancy.css
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/tug-list-view.css
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/default-focus.ts
 * @covers tugdeck/src/deck-trace.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { mkTempTugbank, rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  ARRIVAL_CENSUS_MS,
  ARRIVAL_RETARGET_AT_MS,
  B09_GAP_FRAMES_BAR,
  BAR_TIMEOUT_MS,
  BOOKKEEPING_KEYS,
  FORCED_STALL_MS,
  RETARGET_AT_MS,
  SETTLE_MS,
  SHOULD_RUN,
  SHOWN_FRAMES,
  SPACE_ID,
  STALL_PLANTED_AT_MS,
  TEST_TIMEOUT_MS,
  type ArrivalSample,
  type DepartureTravel,
  type SettleFramesRow,
  activateAndReadSameTask,
  activateLast,
  activePaneId,
  armDepartureCensus,
  arrivedIn,
  arrivalCensus,
  bandCensus,
  budgetCensus,
  columnBlob,
  expectB09Bar,
  expectBeats,
  flashCensus,
  frameOrigins,
  home,
  installLeadRecorder,
  largestCommit,
  launch,
  motionViolationRows,
  paneHeightOf,
  railBlob,
  reactCommits,
  readDepartureCensus,
  releaseSources,
  report,
  reportB09,
  residualTranslates,
  retargetRows,
  sampleB09Gesture,
  sampleBarActivation,
  sampleFold,
  sampleIdle,
  settleFrameRows,
  traceMark,
  traceWithSettleFrames,
  wait,
  windowCommits,
} from "./settle-frames-fixture";

/** The resize-to-fit leg's gap bar — re-budgeted from 2 by the user on
 *  2026-10-03 after reading 2.06–2.18 on every run (see the header). */
const RESIZE_TO_FIT_GAP_FRAMES_BAR = 2.5;

/**
describe.skipIf(!SHOULD_RUN)(
  "at0622 — the fold's gesture stamp",
  () => {
    test(
      "the fold's gesture stamp is spent once — the next settle measures from its own arm",
      async () => {
        // The stamp `setPaneFolded` publishes is never retired: nothing in the
        // store knows when it has been read. So the settle that FOLLOWS a fold
        // by a second or two finds a stamp that is fresh — well inside the
        // reader's five-second staleness guard — and belongs to somebody else.
        // Unguarded, this activation would report the whole distance back to
        // the fold as dead lead, in the row [D9]'s guard and the bar above both
        // read.
        const { app, tugbankPath } = await launch(4);
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          const fold = await sampleFold(app, true, 0);
          note(`at0622 spend-once fold row: ${JSON.stringify(fold.row)}`);
          expect(
            fold.row.commitDelayMs,
            `the fold itself DID measure from its stamp — a zero here would ` +
              `mean the clause below passed by there being no stamp to spend`,
          ).toBeGreaterThan(0);

          const after = await sampleBarActivation(app, 4, 0);
          note(`at0622 spend-once next row: ${JSON.stringify(after.row)}`);
          expect(
            after.row.commitDelayMs,
            `the activation is a gesture of its own and leaves no stamp, so ` +
              `its record measures from its own arm — ${after.row.commitDelayMs}ms ` +
              `here is the fold's stamp being spent a second time`,
          ).toBe(0);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!SHOULD_RUN)(
  "at0622 — the flash waits for the landing, and moves only opacity",
  () => {
    test(
      "four session cards: no ring in the click's frame, an opacity-only ring after it lands",
      async () => {
        const { app, tugbankPath } = await launch(4);
        try {
          await home(app);
          await wait(AFTER_LAND_MS);

          // ---- Inside the click's own frame. ---------------------------
          const atClick = await activateAndReadSameTask(app, "at0622-c4");
          note(`at0622 flash at click: ${JSON.stringify(atClick)}`);
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
          note(`at0622 flash after the landing: ${JSON.stringify(after)}`);
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
            `at0622 flash restart: ${before.currentTime.toFixed(0)}ms -> ` +
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

describe.skipIf(!SHOULD_RUN)(
  "at0622 — the click task is bounded, and a settling frame holds its cells",
  () => {
    test(
      "four session cards: a slide raises no episode, a width change does",
      async () => {
        const { app, tugbankPath } = await launch(4);
        try {
          await home(app);
          await wait(AFTER_LAND_MS);

          // ---- At rest. ------------------------------------------------
          const rest = await budgetCensus(app);
          note(`at0622 budget at rest: ${JSON.stringify(rest)}`);
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
          note(`at0622 budget mid-slide: ${JSON.stringify(sliding)}`);
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
          note(`at0622 budget mid-resize: ${JSON.stringify(resizing)}`);
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

describe.skipIf(!SHOULD_RUN)(
  "at0622 — the settle records its own frames, and its own violations",
  () => {
    test(
      "four session cards: one row per settle, agreeing with the probe, and none at rest",
      async () => {
        const { app, tugbankPath } = await launch(4);
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          // ---- At rest, nothing is recorded. ---------------------------
          const restMark = await traceMark(app);
          await wait(AFTER_LAND_MS);
          const atRest = await settleFrameRows(app, restMark);
          note(`at0622 settle-frames at rest: ${atRest.length}`);
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
          note(`at0622 settle-frames row: ${JSON.stringify(rows)}`);

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
            `at0622 leads: row=${row.firstPaintDelayMs}ms ` +
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
          expect(
            row.moveFirstPaintDelayMs,
            `one classifier over one gesture, so the move's own clock has to ` +
              `agree: row ${row.moveFirstPaintDelayMs}ms vs probe ` +
              `${probe.moveFirstPaintDelayMs}ms`,
          ).toBe(probe.moveFirstPaintDelayMs);

          // ---- [D9]'s runtime guard. -----------------------------------
          const violations = await motionViolationRows(app, mark);
          note(`at0622 settle-motion-violation: ${JSON.stringify(violations)}`);
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
        const { app, tugbankPath } = await launch(8, columnBlob());
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
          note(`at0622 column violations: ${JSON.stringify(violations)}`);
          note(`at0622 column rows: ${JSON.stringify(await settleFrameRows(app, mark))}`);
          note(`at0622 column arms: ${JSON.stringify(await app.evalJS<unknown>(`window.__deckTrace.since(${mark}).filter(function (e) { return e.kind === "settle-arm" || e.kind === "settle-release" || e.kind === "store-notify"; }).map(function (e) { return e.kind + ":" + (e.outcome || e.source || e.caller || "") + ":" + (e.panes === undefined ? "" : e.panes); })`))}`);

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

// ---------------------------------------------------------------------------
// The cancel guarantee
// ---------------------------------------------------------------------------

/**
 * A settle dropped before its tweens finish leaves no frame at its origin.
 *
 * This is the claim the settle's `fill: "backwards"` rests on, and the reason
 * it is a separate test rather than another clause on the bar. A backwards fill
 * holds each frame's start pose BEFORE the active phase, which is exactly the
 * window an interrupted settle dies in — so every way out of a settle is now a
 * way of leaving a frame wearing its origin, and "the deck looks right
 * afterwards" is a claim that has to be made on each exit separately rather
 * than inferred from a gesture that completed.
 *
 * Three gestures, one per leg: a settle carrying a task three times longer than
 * its own window, a retarget dispatched mid-beat, and a space switch thrown at
 * a settle in flight. What each asserts is the same thing — once the deck is at
 * rest, no shown frame computes a translate — because a frame at rest is
 * committed at Last and the imposer owns nothing on it.
 *
 * **What these legs do NOT yet prove, measured rather than assumed.** Each one
 * `note()`s which clock released, and on every run so far all three have
 * released from `"completion"`. So the residue claim is established over three
 * real gestures, and the two exits that run no landing — the window sweep and
 * the canvas unmount — have not been reached by any of them: the stall does not
 * outlast the settle's own completion handler, and a space switch swaps the
 * shown layer without tearing this canvas down. The legs are named for the
 * gestures they make rather than for exits they do not reach, because a leg
 * that claimed the sweep and released from completion would be a green proving
 * a different thing than the one on its label. Reaching those two clocks wants
 * a door this file does not have.
 */
describe.skipIf(!SHOULD_RUN)(
  "at0622 — a settle dropped mid-flight leaves no frame at its origin",
  () => {
    test(
      "a stalled settle, a retarget and a space switch each land the deck with every frame at Last",
      async () => {
        const { app, tugbankPath } = await launch(4);
        try {
          await traceWithSettleFrames(app);

          // ---- Leg 1: a long task planted inside the settle window. ----
          //
          // The stall makes the pending window wide, which is the window a
          // backwards fill is applying a start pose through. If the fill's
          // pose could outlive the settle, a run whose tweens were still
          // pending when the window closed is where it would show.
          //
          // It was written to reach the window sweep and does not: three times
          // the forcing stall still releases from `"completion"`, because the
          // completion handler runs as soon as the thread comes back. The leg
          // is kept for the reading it does take.
          await home(app);
          let mark = await traceMark(app);
          await app.armSettleFrameProbe();
          await wait(120);
          await activateLast(app, 4);
          await wait(STALL_PLANTED_AT_MS);
          await app.forceSettleStall(FORCED_STALL_MS * 3);
          await wait(AFTER_LAND_MS * 2);
          const stalledProbe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const stalledExits = await releaseSources(app, mark);
          const stalledResidue = await residualTranslates(app);
          note(
            `at0622 cancel/stall: exits=${JSON.stringify(stalledExits)} ` +
              `residue=${JSON.stringify(stalledResidue)} ` +
              `offCurveTicks=${stalledProbe.offCurveTicks} ` +
              `pendingTicks=${stalledProbe.pendingTicks}`,
          );
          expect(
            stalledProbe.suspended,
            `stall leg: the window was served — ${stalledProbe.ticks} ticks. ` +
              `A suspended window reports the same zeros as a clean exit`,
          ).toBe(false);
          expect(
            [...stalledResidue],
            `stall leg: a settle carrying a ${FORCED_STALL_MS * 3}ms task left ` +
              `every frame at Last. A pane named here is wearing the opening ` +
              `pose of a beat that is over, which is what a fill that outlived ` +
              `its own active phase would produce`,
          ).toEqual([]);

          // ---- Leg 2: a retarget mid-settle. ---------------------------
          //
          // The second activation's `arm` cancels tweens that had not started
          // — `hold-at-current` on a tween with no progress to hold — and
          // bumps the generation so the first gesture's landing is ignored.
          // The two are not separable, so this leg covers both.
          await home(app);
          mark = await traceMark(app);
          await app.armSettleFrameProbe();
          await wait(120);
          await activateLast(app, 4);
          // Inside the 400ms move beat, and early enough that some tweens
          // have not started: this is the retarget's own window.
          await wait(80);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("focus-session-card", ` +
              `{ cardId: "at0622-c1" }), null)`,
          );
          await wait(AFTER_LAND_MS * 2);
          const retargetProbe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const retargetExits = await releaseSources(app, mark);
          const retargetResidue = await residualTranslates(app);
          const landedOn = await activePaneId(app);
          note(
            `at0622 cancel/retarget: exits=${JSON.stringify(retargetExits)} ` +
              `residue=${JSON.stringify(retargetResidue)} ` +
              `landedOn=${landedOn} ` +
              `offCurveTicks=${retargetProbe.offCurveTicks} ` +
              `run=${retargetProbe.longestOffCurveRunTicks} ` +
              `offset=${retargetProbe.longestOffCurveRunOffsetMs}ms`,
          );
          expect(
            retargetProbe.suspended,
            `retarget leg: the window was served — ${retargetProbe.ticks} ticks`,
          ).toBe(false);
          expect(
            landedOn,
            `retarget leg: the deck landed at the SECOND gesture's ` +
              `arrangement. Landing on the first would mean the retarget's ` +
              `generation bump did not take, and every other claim here would ` +
              `be about a gesture nobody made`,
          ).toBe("at0622-p1");
          expect(
            [...retargetResidue],
            `retarget leg: and no frame kept the cancelled gesture's opening ` +
              `pose. A tween cancelled before it started is the exact case a ` +
              `backwards fill changes, because it is the case where the fill ` +
              `was the only thing painting the frame`,
          ).toEqual([]);

          // ---- Leg 3: a space switch thrown at a settle in flight. -----
          //
          // The frames the switch leaves behind are checked, and then the
          // original space is brought back and ITS frames are checked —
          // without the second half the leg would be asserting over a layer
          // that never animated, which nothing could fail. The second half is
          // where the claim actually lives: a deck whose settle was
          // interrupted by the switch comes back with every frame at Last.
          //
          // It does NOT reach the `"unmount"` release. The switch swaps the
          // shown layer and this canvas survives it, so the settle still
          // releases from `"completion"`. Said here so a later reader does not
          // take this leg for the teardown proof it is not.
          await home(app);
          mark = await traceMark(app);
          await wait(120);
          await activateLast(app, 4);
          await wait(80);
          await app.dispatchControlAction("new-space");
          await wait(AFTER_LAND_MS * 2);
          const unmountExits = await releaseSources(app, mark);
          const arrivedResidue = await residualTranslates(app);
          note(
            `at0622 cancel/unmount: exits=${JSON.stringify(unmountExits)} ` +
              `arrivedResidue=${JSON.stringify(arrivedResidue)}`,
          );
          expect(
            [...arrivedResidue],
            `unmount leg: the layer that survives the switch carries no ` +
              `translate`,
          ).toEqual([]);

          await app.dispatchControlAction("activate-space", {
            spaceId: SPACE_ID,
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 5`,
            { timeoutMs: 30_000 },
          );
          await wait(AFTER_LAND_MS * 2);
          const returnedResidue = await residualTranslates(app);
          note(
            `at0622 cancel/unmount returned: ` +
              `residue=${JSON.stringify(returnedResidue)}`,
          );
          note(
            `at0622 cancel/exits covered: stall=${JSON.stringify(stalledExits)} ` +
              `retarget=${JSON.stringify(retargetExits)} ` +
              `switch=${JSON.stringify(unmountExits)} — the "sweep" and ` +
              `"unmount" clocks are NOT among them, so [B02]'s "every exit" ` +
              `is satisfied for completion-released gestures only`,
          );
          expect(
            [...returnedResidue],
            `unmount leg: and the deck the switch interrupted comes back with ` +
              `every frame at Last. A pane named here kept an origin pose ` +
              `across a teardown that ran no landing — the one exit where ` +
              `nothing is left to put it right`,
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

describe.skipIf(!SHOULD_RUN)(
  "at0622 — a settle interrupted mid-flight leaves no frame stranded",
  () => {
    test(
      "a fold retargeted at 140ms, and a resize interrupted by a fold, strand no frame at the first gesture's end pose",
      async () => {
        const { app, tugbankPath } = await launch(4);
        try {
          await traceWithSettleFrames(app);

          // ---- Leg 1: one fold interrupted by another. ----------------
          //
          // Two folds on two different panes. The second arm finds the
          // first's pane still in `settleTweensRef`, holds it
          // `hold-at-current`, measures, and hands the residue back — the
          // third pass, which is the whole subject.
          await home(app);
          let mark = await traceMark(app);
          await app.armSettleFrameProbe();
          // The classifier derives the display's period from the quiet head,
          // so the whole reading's scale depends on there being one.
          await wait(120);
          const beforeSlide = await paneHeightOf(app, "at0622-p2");
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-card-folded", ` +
              `{ cardId: "at0622-c2", folded: true }), null)`,
          );
          await wait(RETARGET_AT_MS);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-card-folded", ` +
              `{ cardId: "at0622-c3", folded: true }), null)`,
          );
          await wait(AFTER_LAND_MS * 2);
          await app.waitForCondition<boolean>(
            `window.__deckTrace.since(${mark}).some(function (e) {
               return e.kind === "settle-frames";
             })`,
            { timeoutMs: 20_000 },
          );
          const slideProbe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const slideRows = await settleFrameRows(app, mark);
          const slideRow = slideRows[slideRows.length - 1] as SettleFramesRow;
          const afterSlide = await paneHeightOf(app, "at0622-p2");
          const slideRetargets = await retargetRows(app, mark);
          note(`at0622 retarget/slide probe: ${JSON.stringify(slideProbe)}`);
          note(`at0622 retarget/slide row: ${JSON.stringify(slideRow)}`);
          note(
            `at0622 retarget/slide height p2: ${beforeSlide} -> ${afterSlide}px`,
          );
          note(
            `at0622 retarget/slide retargets: ` +
              `${JSON.stringify(slideRetargets)}`,
          );

          expect(
            slideProbe.suspended,
            `slide retarget: the window was served across both gestures — ` +
              `${slideProbe.ticks} ticks at ` +
              `${slideProbe.framePeriodMs.toFixed(2)}ms. A suspended window ` +
              `reports the same zeros as a deck that never hopped`,
          ).toBe(false);
          expect(
            slideRetargets.length,
            `slide retarget: the second walk really caught the first in ` +
              `flight — the canvas recorded ` +
              `${slideRetargets.length} \`settle-retarget\` row(s): ` +
              `${JSON.stringify(slideRetargets)}. Without one there is no ` +
              `interrupted tween, no residue handed back, and the clause ` +
              `below is a claim about a gesture nobody made`,
          ).toBeGreaterThan(0);
          expect(
            beforeSlide === afterSlide,
            `slide retarget: and the FIRST fold really landed — ` +
              `${beforeSlide} -> ${afterSlide}px on p2. A gesture that moved ` +
              `nothing satisfies the clause below by having no travel to ` +
              `interrupt`,
          ).toBe(false);
          expect(
            slideProbe.strandedTicks,
            `slide retarget: no shown frame stood at the FIRST gesture's end ` +
              `pose with no tween on it — ${slideProbe.strandedTicks} tick(s) ` +
              `on [${slideProbe.strandedPaneIds.join(", ")}]. Every frame's ` +
              `pose on the tick after the second gesture lies on the first ` +
              `tween's curve or the second's; a stranded tick is the one that ` +
              `lies on neither, and it is the double hop the reader sees`,
          ).toBe(0);
          expect(
            slideRow.strandedTicks,
            `slide retarget: and the product's own record, over the settle ` +
              `rather than the window, agrees — ` +
              `${slideRow.strandedTicks} tick(s) on ` +
              `[${slideRow.strandedPaneIds.join(", ")}]`,
          ).toBe(0);

          // ---- Leg 2: a resize interrupted by a fold. -----------------
          //
          // The mixed shape, and the one the first leg cannot be: a content
          // width change resizes every frame, so the arm takes the MEASURED
          // path with `sizeChanged` true and opens a resize episode per
          // frame, and the fold that interrupts it carries a `height` term
          // of its own. The settle crosses between the arm's prelaunch and
          // the Last pass that [F13] says are two mechanisms rather than
          // one, which is where a double hop has two places to come from
          // instead of one.
          await home(app);
          const foldHeightBefore = await paneHeightOf(app, "at0622-p4");
          mark = await traceMark(app);
          await app.armSettleFrameProbe();
          await wait(120);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", ` +
              `{ preset: "wide" }), null)`,
          );
          await wait(RETARGET_AT_MS);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-card-folded", ` +
              `{ cardId: "at0622-c4", folded: true }), null)`,
          );
          await wait(AFTER_LAND_MS * 2);
          await app.waitForCondition<boolean>(
            `window.__deckTrace.since(${mark}).some(function (e) {
               return e.kind === "settle-frames";
             })`,
            { timeoutMs: 20_000 },
          );
          const foldProbe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const foldRows = await settleFrameRows(app, mark);
          const foldRow = foldRows[foldRows.length - 1] as SettleFramesRow;
          const foldHeightAfter = await paneHeightOf(app, "at0622-p4");
          const foldRetargets = await retargetRows(app, mark);
          note(`at0622 retarget/fold probe: ${JSON.stringify(foldProbe)}`);
          note(`at0622 retarget/fold row: ${JSON.stringify(foldRow)}`);
          note(
            `at0622 retarget/fold height: ${foldHeightBefore} -> ` +
              `${foldHeightAfter}px`,
          );
          note(
            `at0622 retarget/fold retargets: ${JSON.stringify(foldRetargets)}`,
          );

          expect(
            foldProbe.suspended,
            `resize/fold: the window was served across both gestures — ` +
              `${foldProbe.ticks} ticks`,
          ).toBe(false);
          expect(
            foldRetargets.length,
            `resize/fold: the fold really caught the resize in flight — the ` +
              `canvas recorded ${foldRetargets.length} ` +
              `\`settle-retarget\` row(s): ${JSON.stringify(foldRetargets)}`,
          ).toBeGreaterThan(0);
          expect(
            foldHeightBefore === foldHeightAfter,
            `resize/fold: the fold really landed — ${foldHeightBefore} -> ` +
              `${foldHeightAfter}px on p4`,
          ).toBe(false);
          expect(
            foldProbe.strandedTicks,
            `resize/fold: no frame stood at the resize's end pose with ` +
              `no tween on it — ${foldProbe.strandedTicks} tick(s) on ` +
              `[${foldProbe.strandedPaneIds.join(", ")}]`,
          ).toBe(0);
          expect(
            foldRow.strandedTicks,
            `resize/fold: and the product's own record agrees — ` +
              `${foldRow.strandedTicks} tick(s) on ` +
              `[${foldRow.strandedPaneIds.join(", ")}]`,
          ).toBe(0);

          // ---- The residue clause, for both. --------------------------
          // A settle that strands nothing and leaves an opening pose on is
          // still a settle that ended wrong, and the two failures are
          // independent.
          const residue = await residualTranslates(app);
          expect(
            [...residue],
            `both legs: every surviving frame landed at Last. A pane named ` +
              `here kept the opening pose of a beat that is over`,
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
describe.skipIf(!SHOULD_RUN)(
  "at0622 — two commits in one task carry every frame they move",
  () => {
    test(
      "hiding a two-member rail moves the band and leaves no frame uncarried",
      async () => {
        const { app, tugbankPath } = await launch(4, railBlob());
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
          note(`at0622 two-commit probe: ${JSON.stringify(probe)}`);
          note(`at0622 two-commit departures: ${JSON.stringify(departures)}`);
          note(
            `at0622 two-commit origins: ${JSON.stringify(before)} -> ` +
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
          note(`at0622 two-commit strip: ${JSON.stringify(strip)}`);
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
describe.skipIf(!SHOULD_RUN)(
  "at0622 — an arrival interrupted by a close keeps its hold",
  () => {
    test(
      "a card arriving, closed into at 140ms, never stands at full opacity before its arrive beat",
      async () => {
        const { app, tugbankPath } = await launch(3);
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
          await wait(ARRIVAL_RETARGET_AT_MS);
          await app.evalJS<null>(`(window.__tug.closePane("at0622-p1"), null)`);
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
            `at0622 arrival/close panes: ${JSON.stringify([...standing])} -> ` +
              `${JSON.stringify(Object.keys(after))}, newcomers ` +
              `${JSON.stringify(newcomers)}`,
          );
          note(
            `at0622 arrival/close beats: ${JSON.stringify(beats)} over ` +
              `${samples.length} frames; first arrive at ` +
              `${firstArrive < 0 ? "never" : Math.round(samples[firstArrive].t) + "ms"}`,
          );
          note(
            `at0622 arrival/close retargets: ${JSON.stringify(retargets)}`,
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
          ).toBeGreaterThan(ARRIVAL_RETARGET_AT_MS);

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

/**
 * A card appearing and a card leaving, each against the bar.
 *
 * On the SHARED-COLUMN fixture with one column split, which is the shape the
 * ask names and the one where an arrival has a room to be made for it. A new
 * card opening into a split column is seated at that column's bottom in the
 * arriving commit ([D194]), so the sitters give up height for it — the `room`
 * beat — before its own fade runs — the `arrive` beat. On a flow deck of
 * one-card columns the newcomer takes a slot of its own and `room` is a beat
 * about nobody.
 *
 * The close is `closePane`, the pane's own close button's call, and it takes
 * the newcomer back out of the same column: the sitters reclaim the height on
 * the `depart` beat while the departing frame fades where it stood.
 *
 * Both legs assert the beat by name off the imposer's own attribute, because
 * every timing clause in the bar is satisfied perfectly by a card that popped
 * into place with no choreography at all — which is what [F04] turned out to
 * be when it was read from its far end.
 *
 * **What the two legs read, at this arc's end.** The appear leg holds the bar
 * — `["room", "arrive"]`, a 3ms lead, a worst gap of 1.9 frames — with the
 * one exemption `expectB09Bar` documents: the arriving frame paints 24–25
 * ticks off its own curve across the whole of `room`, held at opacity 0
 * throughout, which is the `backwards` question the doctrine's worked example
 * still has open rather than anything the reader sees.
 *
 * **The DISAPPEAR leg is not read here.** It read 24–33ms from the gesture to
 * the first rendered frame with `commitDelayMs` 0 on every run: closing a
 * pane renumbers every surviving pane's position label inside the settle
 * window. The reading is in `briefs/zero-red-app-tests-brief.md`.
 */
describe.skipIf(!SHOULD_RUN)(
  "at0622 — a card appears, at the bar",
  () => {
    test(
      "a card arriving into a split column holds the bar across room and arrive",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob());
        try {
          await traceWithSettleFrames(app);
          await home(app);
          // The active pane is `at0622-p1`, which sits in slot 0; splitting
          // that column is what gives the newcomer a division to be seated
          // at the bottom of.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-column-mode", ` +
              `{ slot: 0, mode: "split" }), null)`,
          );
          await wait(AFTER_LAND_MS);

          const standing = new Set(
            (await bandCensus(app)).split(" ").map((s) => s.split("@")[0]),
          );

          const appear = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("show-card", ` +
              `{ component: "session" })`,
          );
          reportB09("appear", appear);
          // By equality and in order, like every other [B09] leg: `toContain`
          // on each name passed a settle that ran a third beat, or ran the
          // two in the wrong order, and a card that popped into place
          // satisfies every clause of the bar by having no motion.
          expectBeats("appear", appear, ["room", "arrive"]);

          const newcomers = appear.after
            .split(" ")
            .map((s) => s.split("@")[0])
            .filter((id) => id !== "" && !standing.has(id));
          expect(
            newcomers.length,
            `appear: exactly one frame arrived — ${JSON.stringify(newcomers)}`,
          ).toBe(1);

          // ---- The pose clause's one exemption, and what earns it. ------
          //
          // The arriving frame is held at inline `opacity: 0` until its
          // `arrive` beat begins, and across the whole of `room` it paints
          // the identity while its own curve says its origin. Measured on
          // this leg: 24 of 40 ticks, one unbroken run from 0ms, on the
          // newcomer alone, with the probe reporting `minOpacity: 0` on that
          // same pane. So the exemption is not "the arriving frame is
          // special" — it is "the probe watched this frame be invisible for
          // the whole run", which is a fact the reading itself carries.
          //
          // The two clauses below are what keep it from being a hole. The
          // exempt pane must be the newcomer, and it must be the one the
          // probe saw at zero opacity; anything else and the exemption does
          // not apply and the pose clause judges every pane.
          expect(
            appear.probe.minOpacity,
            `appear: the arriving frame really was held invisible — the ` +
              `probe's worst opacity was ${appear.probe.minOpacity} on ` +
              `\`${appear.probe.minOpacityPaneId}\`. Without a held frame ` +
              `there is nothing to exempt and the clause below judges it`,
          ).toBe(0);
          expect(
            appear.probe.minOpacityPaneId,
            `appear: and the frame held invisible is the one that arrived — ` +
              `${JSON.stringify(newcomers)}`,
          ).toBe(newcomers[0]);
          note(
            `at0622 appear off-curve: ${appear.row?.offCurveTicks} tick(s) ` +
              `on [${appear.row?.offCurvePaneIds.join(", ")}], longest run ` +
              `${appear.row?.longestOffCurveRunTicks} from ` +
              `${appear.row?.longestOffCurveRunOffsetMs}ms — the arriving ` +
              `frame across \`room\`, held at opacity 0 throughout`,
          );
          expectB09Bar("appear", appear, [appear.probe.minOpacityPaneId]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);

/**
 * A card's departure from a split column, against the bar.
 *
 * The arrival that precedes it is the appear leg above, sampled here as the
 * setup and not judged: a departure needs a card to depart. The close is
 * `closePane`, the pane's own close button's call, and it takes the newcomer
 * back out of the column it arrived in. The departing frame fades where it
 * stood on `depart` while the sitters reclaim the height on `room`.
 *
 * The lead recorder is installed first, so every commit in the window carries
 * its render time; the departing pane renders in the close's commit and is
 * unmounted by the land's, and the largest in-window commit is what the
 * reading names beside the gap.
 *
 * **Sampled and reported, NOT judged.** On three solo runs its gap read
 * 2.06–2.24 frames against 2, with a first paint at 2–4 ms and
 * `commitDelayMs` 0. What lands in the window is the close's own deck commit
 * (580 performed fibers, the survivors re-rendering for `placement`) followed
 * within 30 ms by the survivors' tooltip and popover-button trees (450, 192,
 * 184 performed). The departing frame itself renders nothing new. The
 * readings and the cause are in
 * `briefs/departing-and-height-crossing-readings.md`; the beats are asserted,
 * and the bar waits on that cause.
 */
describe.skipIf(!SHOULD_RUN)(
  "at0622 — a card's departure from a split column",
  () => {
    test(
      "the same card closed out of the column it arrived in, across depart and room",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob());
        try {
          await installLeadRecorder(app);
          await traceWithSettleFrames(app);
          await home(app);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-column-mode", ` +
              `{ slot: 0, mode: "split" }), null)`,
          );
          await wait(AFTER_LAND_MS);

          const standing = new Set(
            (await bandCensus(app)).split(" ").map((s) => s.split("@")[0]),
          );
          const appear = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("show-card", ` +
              `{ component: "session" })`,
          );
          reportB09("appear (setup)", appear);
          const newcomers = appear.after
            .split(" ")
            .map((s) => s.split("@")[0])
            .filter((id) => id !== "" && !standing.has(id));
          expect(
            newcomers.length,
            `appear (setup): exactly one frame arrived — ${JSON.stringify(newcomers)}`,
          ).toBe(1);

          const mark = await traceMark(app);
          const disappear = await sampleB09Gesture(
            app,
            `window.__tug.closePane(${JSON.stringify(newcomers[0])})`,
          );
          reportB09("disappear", disappear);
          note(`at0622 disappear commits: ${JSON.stringify(await reactCommits(app))}`);
          const window_ = await windowCommits(app, mark);
          const largest = window_ === null ? null : largestCommit(window_.commits);
          note(
            `at0622 disappear window: ${window_?.commits.length ?? 0} commit(s); ` +
              `largest ${JSON.stringify(
                largest === null
                  ? null
                  : {
                      t: largest.t,
                      performed: largest.performed,
                      mounted: largest.mounted,
                      fibers: largest.fibers,
                      reactMs: largest.reactMs,
                      origins: largest.origins,
                    },
              )}`,
          );
          expectBeats("disappear", disappear, ["depart", "room"]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);

/**
 * The walk across the band, both directions, against the bar.
 *
 * `go-to-slot` is the Go ▸ Go to Slot N door, and on a flow deck it is the
 * gesture that carries the reader from one end of the strip to the other with
 * no activation, no focus transfer and no card count change in it — the
 * cheapest motion the deck makes, and therefore the one with the least excuse
 * for a hole in it.
 *
 * Both directions, because the strip's two ends are not symmetric: the walk
 * out runs against a band whose far slots have never been laid out at their
 * final width, and the walk home runs against frames that have.
 */
describe.skipIf(!SHOULD_RUN)("at0622 — the walk across the band", () => {
  test(
    "go-to-slot out and home holds the bar in both directions",
    async () => {
      const { app, tugbankPath } = await launch(4);
      try {
        await traceWithSettleFrames(app);
        await home(app);
        await wait(AFTER_LAND_MS);

        const out = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("go-to-slot", { value: 4 })`,
        );
        reportB09("go-to-slot out", out);
        expectBeats("go-to-slot out", out, ["move"]);
        expectB09Bar("go-to-slot out", out);

        const back = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("go-to-slot", { value: 1 })`,
        );
        reportB09("go-to-slot home", back);
        expectBeats("go-to-slot home", back, ["move"]);
        expectB09Bar("go-to-slot home", back);

        // ---- The forcing leg ([D5]), for all three of [B09]'s bars. -----
        //
        // One leg, not three, and the reason is that the three legs above
        // read one instrument through one sampler. What has to be shown is
        // that `sampleB09Gesture` and the bar over it notice a defect put
        // there on purpose; which gesture it is planted inside says nothing
        // more. The walk is the cheapest of the three to run and the one
        // whose plain reading sits furthest inside the bar, so a forced
        // failure here cannot be the deck's own noise.
        const forced = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("go-to-slot", { value: 4 })`,
          FORCED_STALL_MS,
        );
        reportB09("go-to-slot forced", forced);
        expect(
          (forced.row as SettleFramesRow).longestGapFrames,
          `go-to-slot forced: a ${FORCED_STALL_MS}ms task planted inside the ` +
            `settle window must fail the bar the two legs above just ` +
            `passed — out read ` +
            `${(out.row as SettleFramesRow).longestGapMs.toFixed(0)}ms / ` +
            `${(out.row as SettleFramesRow).longestGapFrames.toFixed(2)} ` +
            `frames; forced reads ` +
            `${(forced.row as SettleFramesRow).longestGapMs.toFixed(0)}ms / ` +
            `${(forced.row as SettleFramesRow).longestGapFrames.toFixed(2)}. ` +
            `Without this every green above is unfalsifiable: a sampler that ` +
            `stopped observing and a deck that stopped stalling read the same`,
        ).toBeGreaterThan(B09_GAP_FRAMES_BAR);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    BAR_TIMEOUT_MS,
  );
});

/**
 * Bullseye in and out, against the bar — and [F15] named by a test.
 *
 * `toggle-bullseye` puts the frontmost pane alone in the band and takes it
 * out again. Its term is a real `width`: the distortion the flip would have
 * to carry as `scaleX` is past `MAX_FLIP_SCALE_DISTORTION`, so `pane-flip.ts`
 * tweens width keyframes instead and re-wraps the subtree every frame. That
 * is a [D9] violation the doctrine does not name — the worked example still
 * says width crosses as `scaleX` — and until this leg existed the runtime
 * guard had never been SHOWN reporting `:width` on any gesture. The column
 * leg asserts `:height` the same way, and for the same reason: a standing
 * violation the doctrine records in prose and no test exercises is a comment,
 * not a fact.
 *
 * **On a WIDE deck rather than the fixture's own width, and that is [F15]
 * read narrower than the brief states it.** Whether a width change rides as
 * a real term or as a raster `scaleX` is a question about the distortion,
 * not about the gesture, and `MAX_FLIP_SCALE_DISTORTION` was chosen to admit
 * the ADJACENT preset — `pane-flip.ts` says so where the constant is
 * declared. The deck's three widths are slim 675, comfy 800 and wide 1230,
 * and bullseye opens the frontmost pane at comfy; from slim that is one step
 * and reads 0.185, just inside the cap. Run at the fixture's own width this
 * leg's first reading was an empty violation list — the guard saw nothing
 * because there was nothing to see. So the leg sets the deck to wide first,
 * through `set-content-width`, which is the Layout card's own door: 1230 →
 * 800 is two steps and a distortion of 0.54, and the width really rides.
 *
 * What that costs [F15] is its generality, and the finding is worth more
 * stated correctly: the width-over-cap path is bullseye's ON A WIDE DECK,
 * not bullseye's as such.
 *
 * So the violation clause here is two-sided. The guard must report something
 * — an empty list would mean the gesture never took the width path and the
 * clause proved nothing — and everything it reports must be `:width`. Any
 * other property is a second standing violation nobody has written down.
 */
describe.skipIf(!SHOULD_RUN)("at0622 — bullseye, and [F15]'s width", () => {
  test(
    "bullseye in and out holds the bar, and the runtime guard reports :width and nothing else",
    async () => {
      const { app, tugbankPath } = await launch(4);
      try {
        await traceWithSettleFrames(app);
        await home(app);
        // Two preset steps from where bullseye opens, so the flip crosses by
        // real geometry rather than by raster; see the docblock.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-content-width", ` +
            `{ preset: "wide" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        await home(app);
        await wait(AFTER_LAND_MS);
        note(`at0622 bullseye fixture at wide: ${await bandCensus(app)}`);

        const enter = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("toggle-bullseye", {})`,
        );
        reportB09("bullseye enter", enter);
        expectBeats("bullseye enter", enter, ["shrink", "move"]);
        expect(
          enter.violations.length,
          `bullseye enter: the runtime [D9] guard reported something — an ` +
            `empty list here means the gesture never took the width path and ` +
            `the clause below is about nothing ([F15])`,
        ).toBeGreaterThan(0);
        expect(
          [
            ...new Set(
              enter.violations.map((v) => v.slice(v.lastIndexOf(":") + 1)),
            ),
          ].sort(),
          `bullseye enter: and every property it reported is \`width\` — ` +
            `${JSON.stringify(enter.violations)}. [F15]: width over the ` +
            `scale cap is the second standing [D9] hit, and anything else ` +
            `here is a third nobody has written down`,
        ).toEqual(["width"]);
        expectB09Bar("bullseye enter", enter);

        const exit = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("toggle-bullseye", {})`,
        );
        reportB09("bullseye exit", exit);
        expectBeats("bullseye exit", exit, ["move", "grow"]);
        expect(
          [
            ...new Set(
              exit.violations.map((v) => v.slice(v.lastIndexOf(":") + 1)),
            ),
          ].sort(),
          `bullseye exit: the same on the way out — ` +
            `${JSON.stringify(exit.violations)}`,
        ).toEqual(["width"]);
        expectB09Bar("bullseye exit", exit);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    BAR_TIMEOUT_MS,
  );
});

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
describe.skipIf(!SHOULD_RUN)(
  "at0622 — hiding the sidebars and the settled-resize retune, at the bar",
  () => {
    test(
      "hiding and showing a two-member rail hold the bar and the resize retune holds its re-budgeted one",
      async () => {
        const { app, tugbankPath } = await launch(4, railBlob());
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

          const showMark = await traceMark(app);
          const show = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("toggle-sidebars", {})`,
          );
          reportB09("sidebars show", show);
          const showWindow = await windowCommits(app, showMark);
          const showLargest =
            showWindow === null ? null : largestCommit(showWindow.commits);
          note(
            `at0622 sidebars show window: ${showWindow?.commits.length ?? 0} ` +
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
          expectB09Bar("sidebars show", show, arrived);
          expectB09Bar("resize to fit", retune, [], RESIZE_TO_FIT_GAP_FRAMES_BAR);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);
