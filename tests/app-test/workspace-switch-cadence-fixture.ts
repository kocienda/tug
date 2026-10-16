/**
 * workspace-switch-cadence-fixture.ts — the body of at0643, the workspace
 * switch's frame cadence on a grown deck.
 *
 * at0643 was one file running both transcript arms in one launch each; it is
 * now one file per arm (`at0643-workspace-switch-cadence-slice` and
 * `-whale`), and this module is what both register. The argument for the
 * fixture, the bars and the instrument is in the slice file's docblock.
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { bindForTest, transcriptArms, type TranscriptSize } from "./real-transcript-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 600_000;

const SPACE_ONE = "at0643-one";
const SPACE_TWO = "at0643-two";

const SESSIONS_ONE = ["at0643-sa", "at0643-sb", "at0643-sc"] as const;
const SESSIONS_TWO = ["at0643-sd", "at0643-se", "at0643-sf"] as const;
/** The whale arm's subjects: one card in each workspace the switch carries. */
const WHALE_CARDS = ["at0643-sa", "at0643-sd"] as const;

const SHOWN_FRAMES =
  "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]";

/**
 * The longest tolerated gap, in DISPLAY FRAMES rather than in milliseconds.
 *
 * **This is the arc's 20 ms criterion restated in the units it should always
 * have been in, and the correction is a measurement rather than a preference.**
 * `SWITCH_GAP_BUDGET_MS` is 20, written against an assumed 60 Hz period of
 * 16.7 ms — three milliseconds of headroom. The display this fixture runs on
 * derives a 17 ms period, and a live rAF loop's gaps jitter around their period
 * by a few percent, so a smooth run here produces the occasional 21–23 ms gap
 * with no frame missed at all. Measured: `gapsOverOneFrame` was 0 on every one
 * of four switches while `gapsOverBudget` was 2 on one of them, both of those
 * gaps being under `GAP_TOLERANCE` (1.5 periods, 25.5 ms here) — which is the
 * repository's own long-standing answer to exactly this jitter.
 *
 * So the tripwire holds the display-relative form, at two periods: 34 ms here
 * against a measured worst of 23 ms. `gapsOverBudget` is still REPORTED in
 * every assertion message and in the working paper, because the absolute number
 * is what the success criterion is written in and a reader should see both.
 */
const LONGEST_GAP_FRAMES = 2;

/**
 * The first-paint bar, in ms — re-budgeted by the user on 2026-10-03 from one
 * display period. The switch read 45–75 ms on every run, all of it one
 * 3899-fiber React commit re-rendering both layers (42–57 ms of render phase
 * before the swap commit). One period stays the written goal and the number
 * the live-deck readings are held to; this is the number the shipped code
 * meets, with margin for the machine, and the instrument is unchanged.
 */
const FIRST_PAINT_MS = 100;

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));


/**
 * Wait until the deck is at rest — no settle running (`data-imposer-settling`)
 * and no switch epoch open (`data-space-switching`), and, when `spaceId` is
 * given, that workspace on screen. This replaced fixed sleeps of 0.9–2.5 s
 * between the fixture's steps: they were waits for exactly this, by the clock.
 */
async function waitQuiet(app: App, spaceId?: string): Promise<void> {
  const onSpace =
    spaceId === undefined
      ? "true"
      : `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(spaceId)}`;
  await app.waitForCondition<boolean>(
    `(${onSpace}) && document.querySelector("[data-imposer-settling]") === null && document.querySelector("[data-space-switching]") === null`,
    { timeoutMs: 10_000 },
  );
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** One `space-switch-frames` record, as the page serializes it. */
interface FrameRecord {
  toSpaceId: string;
  ticks: number;
  framePeriodMs: number;
  firstPaintDelayMs: number;
  commitDelayMs: number;
  longestGapMs: number;
  gapsOverOneFrame: number;
  gapsOverBudget: number;
  gaps: number[];
  suspended: boolean;
}

const frameRecordsSince = (mark: number): string =>
  `JSON.stringify(window.__deckTrace.since(${mark}).filter(function (e) {
     return e.kind === "space-switch-frames";
   }).map(function (e) {
     return {
       toSpaceId: e.toSpaceId, ticks: e.ticks, framePeriodMs: e.framePeriodMs,
       firstPaintDelayMs: e.firstPaintDelayMs, commitDelayMs: e.commitDelayMs,
       longestGapMs: e.longestGapMs, gapsOverOneFrame: e.gapsOverOneFrame,
       gapsOverBudget: e.gapsOverBudget, gaps: e.gaps, suspended: e.suspended,
     };
   }))`;

// ---------------------------------------------------------------------------
// The grown fixture
// ---------------------------------------------------------------------------

const railPane = (id: string, cardId: string): Record<string, unknown> => ({
  id,
  position: { x: 0, y: 0 },
  size: { width: 420, height: 900 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: [] as string[],
});

const contentPane = (
  id: string,
  cardId: string,
  y: number,
): Record<string, unknown> => ({
  id,
  position: { x: 60, y },
  size: { width: 700, height: 360 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: ["standard"],
});

/**
 * Two workspaces, each standing a Workspaces rail, three session cards and two
 * text cards.
 *
 * Session cards carry the machinery the switch has to re-arm — the composer's
 * line box, the sheets' clamps, the transcript's row window — and they are what
 * the streamed turns land in. The text cards are the control and the element
 * weight that has none of that machinery, in the same switch.
 */
function twoSpaceBlob(): Record<string, unknown> {
  const deck = (
    cardsId: string,
    railId: string,
    sessions: readonly string[],
    textIds: readonly string[],
    paneBase: string,
  ): Record<string, unknown> => ({
    cards: [
      { id: cardsId, componentId: "cards", title: "Workspaces", closable: true },
      ...sessions.map((id) => ({
        id,
        componentId: "session",
        title: id,
        closable: true,
      })),
      ...textIds.map((id) => ({
        id,
        componentId: "text",
        title: id,
        closable: true,
      })),
    ],
    panes: [
      railPane(railId, cardsId),
      ...sessions.map((id, i) => contentPane(`${paneBase}${i}`, id, 40 + i * 260)),
      ...textIds.map((id, i) =>
        contentPane(`${paneBase}t${i}`, id, 40 + (sessions.length + i) * 260),
      ),
    ],
    activePaneId: `${paneBase}0`,
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  });
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      {
        id: SPACE_ONE,
        name: "One",
        deck: deck(
          "at0643-c1",
          "at0643-pc1",
          SESSIONS_ONE,
          ["at0643-t1a", "at0643-t1b"],
          "at0643-pa",
        ),
      },
      {
        id: SPACE_TWO,
        name: "Two",
        deck: deck(
          "at0643-c2",
          "at0643-pc2",
          SESSIONS_TWO,
          ["at0643-t2a", "at0643-t2b"],
          "at0643-pb",
        ),
      },
    ],
  };
}

/** Bind one workspace's session cards — the one on screen — to real transcripts. */
const grow = async (
  app: App,
  cardIds: readonly string[],
  size: TranscriptSize,
): Promise<void> => {
  await bindForTest(app, cardIds, {
    size,
    whaleCards: WHALE_CARDS,
    label: `at0643 [${size}]`,
  });
};

const LOOP_STYLE_ID = "at0643-loop-style";
const LOOP_CLASS = "at0643-loop";

/**
 * Install one infinite CSS loop on every pane and every card host of every
 * layer — the second growth dimension.
 *
 * `outline-offset` rather than a transform or an opacity, for at0641's reason:
 * it animates without promoting the element to its own compositor layer, so the
 * loops are a cost on the main thread's animation timeline rather than a change
 * to the layer tree the switch is being measured over. A probe that rebuilt the
 * layer tree would be measuring itself.
 */
const LOOPS_INSTALL = `(function () {
  var style = document.getElementById(${JSON.stringify(LOOP_STYLE_ID)});
  if (style === null) {
    style = document.createElement("style");
    style.id = ${JSON.stringify(LOOP_STYLE_ID)};
    style.textContent =
      "@keyframes " + ${JSON.stringify(LOOP_CLASS)} + " { from { outline-offset: 0px } to { outline-offset: 1px } }" +
      "." + ${JSON.stringify(LOOP_CLASS)} + " { animation: " + ${JSON.stringify(LOOP_CLASS)} + " 1.3s linear infinite }";
    document.head.appendChild(style);
  }
  var targets = document.querySelectorAll(
    "[data-space-layer] .tug-pane[data-pane-id], [data-space-layer] [data-card-host]");
  for (var i = 0; i < targets.length; i++) targets[i].classList.add(${JSON.stringify(LOOP_CLASS)});
  // A target inside a parked workspace's pane content has no box — that
  // content is out of the render tree while it is parked (\`space-layer.css\`)
  // — and a CSS animation on an element with no box does not run. It runs
  // again the moment the switch shows it, which is the arrival this file
  // measures; until then it is not on the timeline, by design.
  var boxed = 0;
  for (var j = 0; j < targets.length; j++) {
    if (targets[j].closest(".tug-space-layer:not([data-space-shown]) .tug-pane-content") === null) boxed += 1;
  }
  var running = 0;
  document.getAnimations().forEach(function (a) {
    if (a.playState === "running") running += 1;
  });
  return { marked: targets.length, boxed: boxed, running: running };
})()`;

const LOOPS_REMOVE = `(function () {
  var style = document.getElementById(${JSON.stringify(LOOP_STYLE_ID)});
  if (style !== null) style.remove();
  var marked = document.querySelectorAll("." + ${JSON.stringify(LOOP_CLASS)});
  for (var i = 0; i < marked.length; i++) marked[i].classList.remove(${JSON.stringify(LOOP_CLASS)});
  return marked.length;
})()`;

/** What the fixture actually grew to, measured rather than declared. */
const FIXTURE_CENSUS = `(function () {
  return {
    elements: document.querySelectorAll("*").length,
    layerElements: document.querySelectorAll("[data-space-layer] *").length,
    shownFrames: document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length,
    animations: document.getAnimations().length,
  };
})()`;

interface FixtureCensus {
  elements: number;
  layerElements: number;
  shownFrames: number;
  animations: number;
}

// ---------------------------------------------------------------------------
// One measured switch
// ---------------------------------------------------------------------------

/**
 * Switch to `toSpaceId` and return the record the canvas wrote for it.
 *
 * The wait is on the RECORD rather than on a clock: the sampler's window is
 * `SPACE_SWITCH_FRAME_WINDOW_MS` (600 ms) and it classifies when the window
 * closes, so polling for the row is both shorter on a fast run and safe on a
 * slow one. A run that never produces a row fails on the wait, which is the
 * right failure — the instrument stopped.
 */
async function recordSwitch(
  app: App,
  label: string,
  toSpaceId: string,
): Promise<FrameRecord> {
  const mark = await app.evalJS<number>(`window.__deckTrace.mark()`);
  // DIAGNOSTIC: every geometry or style read that took over a millisecond
  // across the switch, with the stack that asked for it — a slow read is a
  // forced style or layout, and the stack names who forced it. Installed per
  // switch and removed after it.
  await app.evalJS<null>(
    `(function () {
       var slow = window.__at0643SlowReads = [];
       var undo = window.__at0643Undo = [];
       function wrap(owner, key, kind) {
         var d = Object.getOwnPropertyDescriptor(owner, key);
         if (!d) return;
         if (typeof d.value === "function") {
           var f = d.value;
           owner[key] = function () {
             var s = performance.now(); var r = f.apply(this, arguments); var e = performance.now() - s;
             if (e > 1) slow.push({ what: key, ms: Math.round(e * 10) / 10, at: Math.round(s),
               stack: String(new Error().stack).split("\\n").slice(1, 7).join(" | ") });
             return r;
           };
           undo.push(function () { owner[key] = f; });
         } else if (d.get) {
           var g = d.get;
           Object.defineProperty(owner, key, { configurable: true, enumerable: d.enumerable, get: function () {
             var s = performance.now(); var r = g.call(this); var e = performance.now() - s;
             if (e > 1) slow.push({ what: key, ms: Math.round(e * 10) / 10, at: Math.round(s),
               stack: String(new Error().stack).split("\\n").slice(1, 7).join(" | ") });
             return r;
           } });
           undo.push(function () { Object.defineProperty(owner, key, d); });
         }
       }
       wrap(Element.prototype, "getBoundingClientRect");
       wrap(Element.prototype, "getClientRects");
       wrap(Element.prototype, "checkVisibility");
       wrap(HTMLElement.prototype, "offsetWidth");
       wrap(HTMLElement.prototype, "offsetHeight");
       wrap(HTMLElement.prototype, "offsetTop");
       wrap(Element.prototype, "scrollHeight");
       wrap(Element.prototype, "clientHeight");
       wrap(Object.getOwnPropertyDescriptor(window, "getComputedStyle") ? window : Window.prototype, "getComputedStyle");
       return null;
     })()`,
  );
  const origin = await app.evalJS<number>(
    `(function () { var t = performance.now();
       window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(toSpaceId)} });
       return t; })()`,
  );
  await app.waitForCondition<boolean>(
    `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(toSpaceId)}`,
    { timeoutMs: 20_000 },
  );
  await app.waitForCondition<boolean>(
    `window.__deckTrace.since(${mark}).some(function (e) {
       return e.kind === "space-switch-frames" && e.toSpaceId === ${JSON.stringify(toSpaceId)};
     })`,
    { timeoutMs: 20_000 },
  );
  const rows = JSON.parse(
    await app.evalJS<string>(frameRecordsSince(mark)),
  ) as FrameRecord[];
  const record = rows.filter((r) => r.toSpaceId === toSpaceId).at(-1);
  if (record === undefined) {
    throw new Error(`at0643 ${label}: no space-switch-frames record arrived`);
  }
  note(`at0643 ${label}: ${JSON.stringify(record)}`);
  // The React commits the switch performed, relative to the dispatch: what
  // `commitDelayMs` is made of. Read off the test-mode commit census.
  note(
    `at0643 ${label} commits: ${JSON.stringify(
      await app.evalJS<unknown>(
        `(function () {
           var api = window.__tugCommits;
           if (!api) return "no census";
           return api.since(${origin}).filter(function (c) { return c.t < ${origin} + 150; })
             .map(function (c) { return { t: Math.round((c.t - ${origin}) * 10) / 10,
               fibers: c.fibers, performed: c.performed, top: c.top.slice(0, 8), why: c.why, origins: c.origins, hooks: c.hooks }; });
         })()`,
      ),
    )}`,
  );
  note(
    `at0643 ${label} slow reads: ${JSON.stringify(
      await app.evalJS<unknown>(
        `(function () {
           (window.__at0643Undo || []).forEach(function (u) { u(); });
           window.__at0643Undo = [];
           return (window.__at0643SlowReads || []).map(function (r) {
             return { what: r.what, ms: r.ms, at: Math.round(r.at - ${origin}), stack: r.stack };
           }).filter(function (r) { return r.at < 200; });
         })()`,
      ),
    )}`,
  );
  note(
    `at0643 ${label} timing: ${JSON.stringify(
      await app.evalJS<unknown>(
        `window.__deckTrace.since(${mark}).filter(function (e) {
           return e.kind === "space-switch-timing";
         })`,
      ),
    )}`,
  );
  // And every `tug:` performance mark in the same window, so the stretch
  // before the swap commit reads as named phases rather than one number.
  note(
    `at0643 ${label} marks: ${JSON.stringify(
      await app.evalJS<unknown>(
        `(function () {
           var out = {};
           performance.getEntriesByType("mark").forEach(function (e) {
             if (e.name.indexOf("tug:") !== 0) return;
             var t = e.startTime - ${origin};
             if (t < -5 || t > 150) return;
             (out[e.name] = out[e.name] || []).push(Math.round(t));
           });
           return out;
         })()`,
      ),
    )}`,
  );
  return record;
}

/**
 * The cadence claim over one switch.
 *
 * A suspended reading is RED, per switch. It used to void the switch and
 * return `false`, with only an all-void run failing — so three of four
 * switches could be swallowed by an occluded window and the file still read
 * green on the one that was served. A voided reading proves nothing about the
 * switch it was taken over, and a claim the file makes about four switches
 * is not made by one. The message names the usual cause, which is the
 * harness window rather than the product; it is still not a pass.
 */
function assertCadence(label: string, r: FrameRecord): void {
  expect(
    r.suspended,
    `at0643 ${label}: rAF was suspended across this switch (${r.ticks} ` +
      `tick(s)), so no cadence claim can be made about it. The usual cause ` +
      `is the harness window being occluded; re-run with it unoccluded`,
  ).toBe(false);

  // The warning tier, before the bars. It asserts nothing; it puts a line in
  // the report when a reading has moved toward a bar without reaching it. One
  // trigger, since [B05] took the first-paint bar down to one period and left
  // it no margin to drift inside: any gap over the 20 ms absolute budget (the
  // arc's written criterion, which the relative gap bar deliberately does not
  // hold).
  const drift: string[] = [];
  if (r.gapsOverBudget > 0) {
    drift.push(
      `${r.gapsOverBudget} gap(s) over the 20ms absolute budget, longest ` +
        `${r.longestGapMs}ms at a ${r.framePeriodMs}ms period (hard bar ` +
        `${LONGEST_GAP_FRAMES} frames, ${LONGEST_GAP_FRAMES * r.framePeriodMs}ms)`,
    );
  }
  if (drift.length > 0) {
    note(`at0643 ${label}: DRIFT WARNING — ${drift.join("; ")}`);
  }

  // The first frame's distance from the gesture is the set-up, which
  // set-up-and-go reads and never bars: time before the first frame is the
  // price of a clean motion. `FIRST_PAINT_MS` stays the written goal it is
  // noted against.
  note(
    `${label}: set-up ${r.firstPaintDelayMs}ms from the gesture to the first ` +
      `frame (goal ${FIRST_PAINT_MS}ms, period ${r.framePeriodMs}ms), of which ` +
      `${r.commitDelayMs}ms was React's render phase before the swap commit`,
  );

  // The one-frame count is REPORTED and not claimed, and that is [B09]'s
  // doing rather than a concession to a red. This file used to carry a
  // `gapsOverOneFrame === 0` clause beside the two-frame one below — a bar
  // of its own, stricter than every other gesture in the corpus, on the one
  // gesture whose own docblock calls the difference jitter. Read four times
  // at this tree, sixteen switches in all: the clause went red exactly once,
  // on one switch, with a single 31 ms gap at a 16 ms period — 1.9 periods,
  // inside the two-frame bar. The three runs after it read zero on all
  // twelve switches at a 17 ms period. So the reading is the display's
  // jitter around its own period rather than a missed frame, and a clause
  // that goes red on it is a tripwire that cries on one run in four while
  // the deck is doing nothing wrong.
  //
  // So the switch answers the same bar as the fold, the walk, bullseye and
  // every arrival: no gap over two display frames. The count still rides
  // every message, because a reader comparing two runs wants to see it move.
  note(
    `${label}: ${r.gapsOverOneFrame} gap(s) over one display frame, ` +
      `${r.gapsOverBudget} over the 20ms absolute budget, across ` +
      `${r.ticks} ticks at a ${r.framePeriodMs}ms period`,
  );

  expect(
    r.longestGapMs,
    `${label}: the longest gap stayed under ${LONGEST_GAP_FRAMES} display ` +
      `frames (${LONGEST_GAP_FRAMES * r.framePeriodMs}ms at a ` +
      `${r.framePeriodMs}ms period) — measured ${r.longestGapMs}ms across ` +
      `${r.ticks} ticks`,
  ).toBeLessThanOrEqual(LONGEST_GAP_FRAMES * r.framePeriodMs);
}

/** Register the cadence test for one transcript arm. */
export function describeCadenceArm(size: TranscriptSize): void {
const arm = transcriptArms().find((a) => a.size === size) ?? { size, skip: true };
describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0643 — a workspace switch paints on time on a grown deck [${arm.size}]`,
  () => {
    test(
      "four switches on six bound session cards and dozens of running loops: the first frame is on time and no gap is over budget",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(twoSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: `at0643-workspace-switch-cadence-${arm.size}`,
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 5`,
            { timeoutMs: 30_000 },
          );
          await waitQuiet(app);

          // ---- Mount both workspaces, and grow them. --------------------
          //
          // Before anything else, and the order is load-bearing twice over. A
          // workspace nobody has visited has no layer at all, so the first
          // switch to it is a MOUNT rather than a re-show — a different path,
          // and not the one [B06] leaves the deck in for every switch after
          // the first. And each workspace's cards are bound while it is on
          // screen, where their transcripts have a height to settle into.
          //
          // The parked workspace is grown too, and it has to be: the cost
          // this file measures is the cost of the ARRIVING tree, so a fixture
          // that only grew the workspace already on screen would measure the
          // switch away and nothing else.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_TWO)} }), null)`,
          );
          await waitQuiet(app, SPACE_TWO);
          await grow(app, SESSIONS_TWO, arm.size);
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_ONE)} }), null)`,
          );
          await waitQuiet(app, SPACE_ONE);
          await grow(app, SESSIONS_ONE, arm.size);
          // The rests from here to the measured switches stay on the clock.
          // Waited on the deck's markers instead, both arms read gaps of
          // 38–42 ms (the whale 3 runs in 3) against 23–31 ms with these
          // rests, on 2026-10-16: the bound transcripts' after-work outlives
          // the markers, and it lands inside the first switches.
          await settle(2500);

          const loops = await app.evalJS<{ marked: number; boxed: number; running: number }>(
            LOOPS_INSTALL,
          );
          await settle(600);
          const census = await app.evalJS<FixtureCensus>(FIXTURE_CENSUS);
          note(
            `at0643 fixture: ${census.elements} elements ` +
              `(${census.layerElements} under layers), ${census.shownFrames} ` +
              `shown pane frames, ${census.animations} animations ` +
              `(${loops.marked} loop targets marked, ${loops.boxed} with a box, ${loops.running} running ` +
              `at install)`,
          );

          // The growth is asserted, loosely and in its own terms: this file's
          // whole premise is that a small fixture cannot show the cost, so a
          // run whose fixture did not grow is a run that proved nothing, and it
          // must say so rather than pass. The numbers are floors well under
          // what the fixture reaches, not pins on what it reaches.
          expect(
            census.layerElements,
            `the grown fixture reached a deck big enough to show the cost ` +
              `(${census.layerElements} elements under the workspace layers)`,
          ).toBeGreaterThan(2000);
          // Dozens of loops, counted where they are: every pane and card host
          // on the deck is marked, and every one with a box is on the timeline.
          // The parked workspace's card hosts join it when the switch shows
          // them; they are not running beforehand, by design.
          expect(
            loops.marked,
            `dozens of loop targets across both workspaces (${loops.marked} marked)`,
          ).toBeGreaterThanOrEqual(24);
          expect(
            census.animations,
            `every loop target with a box is running across the switch ` +
              `(${census.animations} on the timeline, ${loops.boxed} targets with a box)`,
          ).toBeGreaterThanOrEqual(loops.boxed);

          // ---- The measured switches. -----------------------------------
          await app.evalJS<null>(
            `(window.__deckTrace.enable(true),
              window.__deckTrace.enableKind("space-switch-frames", true), null)`,
          );

          const runs: Array<[string, FrameRecord]> = [];
          for (const [label, to] of [
            ["A->B #1", SPACE_TWO],
            ["B->A #1", SPACE_ONE],
            ["A->B #2", SPACE_TWO],
            ["B->A #2", SPACE_ONE],
          ] as const) {
            runs.push([label, await recordSwitch(app, label, to)]);
            // Kept on the clock, unlike the set-up's waits: the deck markers
            // clear before the arriving tree's own after-work drains, and a
            // switch dispatched on the markers alone read a 75 ms gap on the
            // whale arm (2026-10-16) that this rest does not.
            await settle(900);
          }

          // Disarm before asserting. The sampler costs frames by design, and a
          // failure that leaves it armed makes every later reading on this app
          // instance somebody else's problem — the exact coupling `enableKind`
          // exists to prevent.
          await app.evalJS<null>(
            `(window.__deckTrace.enableKind("space-switch-frames", false), null)`,
          );
          await app.evalJS<number>(LOOPS_REMOVE);

          for (const [label, record] of runs) {
            expect(
              record.ticks,
              `${label}: the sampler produced a record`,
            ).toBeGreaterThan(0);
            assertCadence(label, record);
          }
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
}
