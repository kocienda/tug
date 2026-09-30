/**
 * at0654-deck-settle-standing-reds.test.ts — the settle's legs that are RED
 * on real readings, held to the same bar and expected to fail.
 *
 * ## Why these live apart from `at0622`
 *
 * `at0622-deck-settle-frames.test.ts` reads one bar over every gesture the
 * original ask named. Four of its legs do not hold it on a clean tree, and
 * they had put the file into a red streak of over a hundred consecutive
 * recorded runs — at which point the file could no longer report a NEW red,
 * because there was no green for one to break. So the legs that are red on
 * real readings live here, each with its reading and its attribution written
 * beside it, and `at0622` is the tripwire again: a red THERE is new.
 *
 * Nothing about the bar is different here. Every leg reads the same fixture,
 * the same two instruments and the same clauses through
 * `settle-frames-fixture.ts`, and the arc's rule holds: a bar is never
 * loosened to go green. What is different is what a red MEANS. Here it is the
 * expected state, recorded in `briefs/deck-animation-pipeline-findings.md`;
 * a GREEN here is the news, and it means a leg has come under its bar and
 * belongs back in `at0622`.
 *
 * ## The five, and what each reads
 *
 * - **The warm flip across the band, at four and eight cards.** At the edge
 *   of its bars and rotating: one run fails the four-up gap (2.41 frames
 *   against 2), the next the eight-up move lead (34 ms against a 17 ms
 *   period). The residual is one 917-fiber deck commit re-rendering every
 *   pane's title bar on a commit that changed one pane's focus — the
 *   pane-chrome grain, program item 1.
 * - **The fold, in both directions.** Lead 18–19 ms against a 17 ms period,
 *   or a 1.06-frame gap against a one-frame bar; which clause fails rotates.
 *   The lead is [D204]'s deferral plus the Last pass that plans and launches
 *   every tween — the fold still plans after React commits.
 * - **A card's departure from a split column.** Lead 24–33 ms with
 *   `commitDelayMs` 0 on every run, so all of it is the deck's own after the
 *   arm. Attributed: closing a pane renumbers every surviving pane's position
 *   label, and each survivor's whole rollup popover tree re-renders inside
 *   the settle window (1828 of 2947 fibers performed at +14 ms).
 * - **Showing a two-member rail.** Gap 3.2–3.8 frames against 2, where
 *   hiding the same rail reads 1.29. Attributed: showing a rail MOUNTS its
 *   entire contents inside the settle window (3898 of 4341 fibers at +33 ms,
 *   four milliseconds after the Last pass) — concept 3 of the ask, nothing
 *   created inside a gesture, still owed.
 * - **Dividing four shared columns of eight session cards.** The
 *   height-bearing gesture, and the first time it has had a frame bar at
 *   all: 48 ms / 2.82 frames over 65 ticks on nine panes, with five frames
 *   carrying a real `height` tween — [D9]'s standing hit, delivering late.
 *   Stacking them again reads exactly 2.00 frames, on the edge. This is
 *   concept 5 of the ask (height by translation and occlusion) read as a
 *   number rather than a design note.
 *
 * The forcing legs ride with the flip and the fold, because a red leg is only
 * a reading if the instrument can be shown noticing a stall put there on
 * purpose; without them a red here and a broken sampler read the same.
 *
 * ## Why this file does not name `deck-canvas.tsx`
 *
 * `at0622` names it, and so does every other test that reads the deck's
 * geometry; the file already fans out to the ceiling `ACCEPTED_FANOUT`
 * records for it, and a file whose every leg is EXPECTED to be red is not a
 * tripwire an edit to the canvas should select. Its reds are recorded
 * findings, re-read on purpose — `just app-test at0654-…` — when someone is
 * working on one of them, not derived from a diff. So it names the fixture it
 * reads through and the libraries whose contracts its legs assert, and
 * leaves the canvas and the pane frame to the tripwire.
 *
 * @covers tests/app-test/settle-frames-fixture.ts
 * @covers tugdeck/src/lib/settle-frame-probe.ts
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/deck-manager-store.ts
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/deck-trace.ts
 * @covers tuglaws/animation-doctrine.md
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  FOLD_GAP_FRAMES_BAR,
  FORCED_STALL_MS,
  GAP_FRAMES_BAR,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  arrivedIn,
  bandCensus,
  blobFor,
  clickTaskMarks,
  columnBlob,
  expectB09Bar,
  expectBar,
  expectBeats,
  expectColumnBar,
  expectFoldBar,
  expectLastPassAfterNotify,
  home,
  launch,
  railBlob,
  reactCommits,
  report,
  reportB09,
  reportFold,
  reportLastPassOrder,
  sampleB09Gesture,
  sampleBarActivation,
  sampleColumnGesture,
  sampleFold,
  sampleIdle,
  traceWithSettleFrames,
  wait,
} from "./settle-frames-fixture";

/** The harness names this file's logs after it, not after the fixture's. */
const TEST_NAME = "at0654-deck-settle-standing-reds";

describe.skipIf(!SHOULD_RUN)(
  "at0654 — the warm flip across the band, at its bar's edge",
  () => {
    test(
      "the bar at four session cards and at eight, the scaling clause, and a planted stall that fails it",
      async () => {
        // Both legs live in one test because the scaling clause is a comparison
        // between them. Split across two tests it could only be smuggled through
        // a module-level variable, and a claim that depends on the order two
        // tests happen to run in is not a claim.
        let fourFrames = Number.NaN;
        let fourGapMs = Number.NaN;

        const four = await launch(4, blobFor(4), TEST_NAME);
        try {
          await traceWithSettleFrames(four.app);
          const idle = await sampleIdle(four.app);
          report("four-up idle control", idle);
          expect(
            idle.suspended,
            `four-up idle control: the window was served — ${idle.ticks} ticks`,
          ).toBe(false);

          const plain = await sampleBarActivation(four.app, 4, 0);
          report("four-up cold-first probe", plain.probe);
          note(`at0654 four-up cold-first row: ${JSON.stringify(plain.row)}`);
          const coldMarks = await clickTaskMarks(four.app);
          note(`at0654 four-up cold-first click task: ${JSON.stringify(coldMarks)}`);
          note(`at0654 four-up cold-first commits: ${JSON.stringify(await reactCommits(four.app))}`);

          // ---- The WARM FLIP is the bar ([B08]). --------------------------
          //
          // The cold first activation above is a reading and nothing more. It
          // activates a card whose picker has never been presented, so its
          // window carries the picker's whole mount cascade — a cost a real
          // deck pays once per unbound card, at launch, and never again. A bar
          // pinned there is a bar over fixture cost, and it moves whenever the
          // picker's mount does.
          //
          // The gesture a user makes all day is a flip between two cards that
          // already stand complete, and that is what the bar is pinned to.
          // Card 1's picker presented at launch (it is the active pane) and
          // card 4's on the cold leg, so from where that leg left the strip,
          // activating card 1 is a flip the other way across the same band with
          // both pickers warm. From HERE, not from home: at home card 1 already
          // stands in the band and the activation would move nothing, so no
          // settle row would ever be written and `expectBar`'s travel guard
          // would be the clause that caught it.
          const warm = await sampleBarActivation(four.app, 1, 0, "here");
          report("four-up warm-flip probe", warm.probe);
          note(`at0654 four-up warm-flip row: ${JSON.stringify(warm.row)}`);
          const warmMarks = await clickTaskMarks(four.app);
          note(`at0654 four-up warm-flip click task: ${JSON.stringify(warmMarks)}`);
          note(`at0654 four-up warm-flip commits: ${JSON.stringify(await reactCommits(four.app))}`);

          // [B04]'s pin, on the pinned bar leg — the warm flip. The cold first
          // activation is a READING here for the same reason its gap numbers
          // are ([B08]): its flush carries the picker's whole mount cascade,
          // which renders the canvas inside the window on some runs and not
          // others, and a canvas that renders for ANY reason in that window
          // reads the deck's new snapshot and runs the Last pass with it.
          reportLastPassOrder("four-up cold first", coldMarks);
          expectLastPassAfterNotify("four-up warm flip", warmMarks);

          expectBar("four-up warm flip", warm);
          fourFrames = warm.row.longestGapFrames;
          fourGapMs = warm.row.longestGapMs;

          // ---- The forcing leg ([D5]). ----------------------------------
          // Both instruments have to be shown noticing a defect put there on
          // purpose, or every reading above is unfalsifiable: a sampler that
          // silently stopped observing and a deck that genuinely stopped
          // dropping frames produce the same zeros.
          const forced = await sampleBarActivation(
            four.app,
            4,
            FORCED_STALL_MS,
          );
          report("four-up forced probe", forced.probe);
          note(`at0654 four-up forced row: ${JSON.stringify(forced.row)}`);
          expect(
            forced.probe.longestGapMs,
            `four-up forced: a ${FORCED_STALL_MS}ms task planted inside the ` +
              `settle window must show up as a gap at least that wide — the ` +
              `warm flip's bench-probe worst was ` +
              `${warm.probe.longestGapMs.toFixed(0)}ms, so a claim the pinned ` +
              `leg could also satisfy would prove nothing about whether the ` +
              `injector ran at all. Forced: ` +
              `${forced.probe.longestGapMs.toFixed(0)}ms / ` +
              `${forced.probe.longestGapFrames.toFixed(2)} frames at ` +
              `${forced.probe.framePeriodMs.toFixed(2)}ms`,
          ).toBeGreaterThanOrEqual(FORCED_STALL_MS);
          expect(
            forced.row.longestGapFrames,
            `four-up forced: and the CANVAS's own record fails the bar, which ` +
              `is what makes the bar a measurement rather than a formality. ` +
              `The warm flip read ${fourGapMs.toFixed(0)}ms / ` +
              `${fourFrames.toFixed(2)} frames; forced reads ` +
              `${forced.row.longestGapMs.toFixed(0)}ms / ` +
              `${forced.row.longestGapFrames.toFixed(2)} frames`,
          ).toBeGreaterThan(GAP_FRAMES_BAR);
        } finally {
          await four.app.close();
          rmTempTugbank(four.tugbankPath);
        }

        const eight = await launch(8, blobFor(8), TEST_NAME);
        try {
          await traceWithSettleFrames(eight.app);
          const idle = await sampleIdle(eight.app);
          report("eight-up idle control", idle);
          expect(
            idle.suspended,
            `eight-up idle control: the window was served — ${idle.ticks} ticks`,
          ).toBe(false);

          const plain = await sampleBarActivation(eight.app, 8, 0);
          report("eight-up cold-first probe", plain.probe);
          note(`at0654 eight-up cold-first row: ${JSON.stringify(plain.row)}`);

          // The same flip, at twice the card count. The bar and the scaling
          // clause below are both read off it rather than off the cold leg, so
          // the comparison is warm against warm.
          const warm = await sampleBarActivation(eight.app, 1, 0, "here");
          report("eight-up warm-flip probe", warm.probe);
          note(`at0654 eight-up warm-flip row: ${JSON.stringify(warm.row)}`);
          expectBar("eight-up warm flip", warm);

          // ---- The scaling clause. --------------------------------------
          // The claim the pipeline arc's purpose actually makes, and the one a
          // change that merely fits on today's four-up deck could not satisfy.
          expect(
            Math.abs(warm.row.longestGapFrames - fourFrames),
            `the worst gap does not grow with the card count — four-up read ` +
              `${fourGapMs.toFixed(0)}ms / ${fourFrames.toFixed(2)} frames, ` +
              `eight-up reads ${warm.row.longestGapMs.toFixed(0)}ms / ` +
              `${warm.row.longestGapFrames.toFixed(2)} frames on ` +
              `${warm.row.panes} panes, both on the WARM FLIP. Within one ` +
              `display frame is the bar; a settle whose price is proportional ` +
              `to how much has to be rasterized would miss it`,
          ).toBeLessThanOrEqual(1);
        } finally {
          await eight.app.close();
          rmTempTugbank(eight.tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!SHOULD_RUN)(
  "at0654 — a session card's fold, across the whole motion",
  () => {
    test(
      "folding and unfolding a session card delivers every frame from the gesture, and a planted stall fails it",
      async () => {
        // `flowDeck` and not `columnDeck`, and the choice is load-bearing. A
        // flow column holds one card, so it never divides, so the only
        // `height` term anywhere in this window is the folding pane's own. On
        // the eight-card shared-column fixture the fold's row and the
        // division's row are the same row, so nothing read there could ever
        // say whether the FOLD still carries height.
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME);
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          const fold = await sampleFold(app, true, 0);
          reportFold("fold", fold);
          // The fold's click-task timeline, with the preamble split ([B08]).
          // `tug:set-pane-folded` is the store mutator's entry and the three
          // `tug:arm-*` marks are the arm's own phases.
          note(`at0654 fold click task: ${JSON.stringify(await clickTaskMarks(app))}`);
          expectFoldBar("fold", fold);

          const unfold = await sampleFold(app, false, 0);
          reportFold("unfold", unfold);
          expectFoldBar("unfold", unfold);

          // ---- The forcing leg ([D5]). ----------------------------------
          const forced = await sampleFold(app, true, FORCED_STALL_MS);
          reportFold("fold forced", forced);
          expect(
            forced.probe.longestGapMs,
            `fold forced: a ${FORCED_STALL_MS}ms task planted inside the ` +
              `settle window must show up as a gap at least that wide — the ` +
              `plain fold's bench-probe worst was ` +
              `${fold.probe.longestGapMs.toFixed(0)}ms. Forced: ` +
              `${forced.probe.longestGapMs.toFixed(0)}ms / ` +
              `${forced.probe.longestGapFrames.toFixed(2)} frames at ` +
              `${forced.probe.framePeriodMs.toFixed(2)}ms`,
          ).toBeGreaterThanOrEqual(FORCED_STALL_MS);
          expect(
            forced.row.longestGapFrames,
            `fold forced: and the CANVAS's own record fails the bar — plain ` +
              `read ${fold.row.longestGapMs.toFixed(0)}ms / ` +
              `${fold.row.longestGapFrames.toFixed(2)} frames; forced reads ` +
              `${forced.row.longestGapMs.toFixed(0)}ms / ` +
              `${forced.row.longestGapFrames.toFixed(2)} frames`,
          ).toBeGreaterThan(FOLD_GAP_FRAMES_BAR);
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
 * The arrival that precedes it is `at0622`'s appear leg, sampled here as the
 * setup and not judged — a departure needs a card to depart. The close is
 * `closePane`, the pane's own close button's call, and it takes the newcomer
 * back out of the same column: the sitters reclaim the height on the `room`
 * beat while the ghost of the departing frame leaves on `depart`.
 *
 * The commit census and the click-task marks ride the leg, because the
 * attribution (the survivors' popover trees re-rendering on a renumbered
 * position label) was read off exactly these rows and the next reader should
 * re-read the same rows rather than rebuild the probe.
 */
describe.skipIf(!SHOULD_RUN)(
  "at0654 — a card's departure from a split column",
  () => {
    test(
      "the same card closed out of the column it arrived in, across depart and room",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob(), TEST_NAME);
        try {
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

          const disappear = await sampleB09Gesture(
            app,
            `window.__tug.closePane(${JSON.stringify(newcomers[0])})`,
          );
          reportB09("disappear", disappear);
          note(`at0654 disappear commits: ${JSON.stringify(await reactCommits(app))}`);
          note(`at0654 disappear click task: ${JSON.stringify(await clickTaskMarks(app))}`);
          expectBeats("disappear", disappear, ["depart", "room"]);
          expectB09Bar("disappear", disappear);
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
 * Showing a two-member rail, against the bar.
 *
 * The hide that precedes it is `at0622`'s leg, sampled here as the setup and
 * not judged. The rails ARRIVE on the way back, so the show leg carries the
 * same pose exemption the appear leg does and for the same measured reason:
 * each arriving rail frame is held at inline `opacity: 0` across the whole of
 * `room` and paints the identity while its own curve says its origin. Unlike
 * the appear leg, the exemption here used to be claimed by a comment and
 * earned by nothing; the two clauses before the bar are what earn it now —
 * the probe must have watched one of the exempt frames be invisible, and the
 * frame it names must be one that arrived.
 */
describe.skipIf(!SHOULD_RUN)(
  "at0654 — showing the sidebars",
  () => {
    test(
      "showing a two-member rail after hiding it, across room and arrive",
      async () => {
        const { app, tugbankPath } = await launch(4, railBlob(), TEST_NAME);
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          const hide = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("toggle-sidebars", {})`,
          );
          reportB09("sidebars hide (setup)", hide);

          const show = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("toggle-sidebars", {})`,
          );
          reportB09("sidebars show", show);
          note(`at0654 sidebars show commits: ${JSON.stringify(await reactCommits(app))}`);
          note(`at0654 sidebars show click task: ${JSON.stringify(await clickTaskMarks(app))}`);

          expectBeats("sidebars show", show, ["room", "arrive"]);

          const arrived = arrivedIn(show);
          expect(
            arrived.length,
            `sidebars show: the rail's frames arrived in this gesture — ` +
              `${JSON.stringify(arrived)}. With nothing arriving there is ` +
              `nothing to exempt from the pose clause`,
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
 * The height-bearing gesture, against the bar.
 *
 * Four shared columns of eight session cards divide and stack again. A
 * column that divides gives each member a share of the height, and the settle
 * carries that as a real `height` tween on every frame in the column — the
 * main-thread term [D9] names as its first standing hit. `at0622`'s
 * violations leg asserts those `:height` rows are PRESENT; this leg asks
 * whether the term still delivers its frames, and the answer on a clean tree
 * is no: the division reads 2.82 frames against 2, the stack exactly 2.00.
 * Each of the four dispatches retargets the settle before it, so every row
 * the gesture wrote is held to the bar, not only the last.
 */
describe.skipIf(!SHOULD_RUN)(
  "at0654 — eight standing layers, priced on a height-bearing gesture",
  () => {
    test(
      "four shared columns divide and stack again, each settle under the gap bar",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob(), TEST_NAME);
        try {
          await traceWithSettleFrames(app);
          const idle = await sampleIdle(app);
          report("column idle control", idle);
          expect(
            idle.suspended,
            `column idle control: the window was served — ${idle.ticks} ticks`,
          ).toBe(false);

          const split = await sampleColumnGesture(app, "split");
          report("column split (height-bearing)", split.probe);
          note(`at0654 column split rows: ${JSON.stringify(split.rows)}`);

          const stack = await sampleColumnGesture(app, "stack");
          report("column stack (height-bearing)", stack.probe);
          note(`at0654 column stack rows: ${JSON.stringify(stack.rows)}`);

          expectColumnBar("column split", split);
          expectColumnBar("column stack", stack);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
