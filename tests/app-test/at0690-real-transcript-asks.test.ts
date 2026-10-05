/**
 * at0690-real-transcript-asks.test.ts — the asks no other settle test reads,
 * on cards that carry real transcripts.
 *
 * ## What this file is for
 *
 * Every gesture a user's deck runs has a leg somewhere in the corpus except
 * four, and this file is where those four are read: seating a card into a
 * column, closing and reopening one sidebar, resizing the sidebars to fit,
 * and the deck at rest with its loops running. Each runs on the gesture's own
 * door (`window.tugdeck.lab.drive`), the same door the settle verb drives on
 * a user's deck, so a reading here and a reading there are of one gesture.
 *
 * Every Session card is bound to a REAL resumed transcript
 * (`real-transcript-fixture.ts`), on two arms: the slice everywhere, and in
 * the whale arm the corpus's whale rides the cards the gesture resizes. A card
 * with a transcript answers its own height change — its list view pins,
 * restores and rebases — and an empty card pays none of that.
 *
 * ## The legs
 *
 *  - **Seat.** On a four-up flow deck whose slot 1 is already split, card 3
 *    is seated into slot 1, landing at the column's bottom while the sitter
 *    gives it half its height, and then seated back into slot 2, the sitter
 *    growing again. Each is held to the activation's bar with one clause
 *    changed: a seat need not move the strip, so "the strip travelled" is
 *    replaced by "both frames' heights changed". [D9]'s guard is read as the
 *    column leg in `at0622` reads it: a column that divides carries a real
 *    `height` tween, the standing main-thread hit the law was written
 *    knowing, so every violation must name `height` and nothing else.
 *  - **One sidebar.** The Jots rail member is closed and reopened, alone,
 *    on a two-member rail. Held to the two-frame gap bar and to [D9]'s guard,
 *    with the rail retune's `height` and `width` allowed as `at0622` allows
 *    them.
 *  - **Fit.** The rails are widened past their share, then resized to fit.
 *    The same bar and the same allowed declarations.
 *  - **Loops.** The deck at rest on four bound cards: rendering updates that
 *    hold the main thread stay at or under the motion probe's own at-rest
 *    budget.
 *
 * Every beat's `startDelayMs` — how long after planning the beat's first
 * frame ran — and the lead before the first frame are noted on every leg:
 * they are the set-up, read and never barred. What is barred is the motion
 * from the first frame on, and the land, which is one frame.
 *
 * `tug-list-view.tsx`, whose reaction to a height change is much of what a
 * bound card costs, is deliberately NOT named below: it stands at its recorded
 * fan-out, and recorded debt may be paid down but never refinanced. A change
 * there names this file in its own checkpoint.
 *
 * @covers tugdeck/src/lib/gesture-drivers.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  GAP_FRAMES_BAR,
  SHOULD_RUN,
  blobFor,
  expectLand,
  expectMotionSealed,
  noteBeatStarts,
  noteLead,
  launch,
  paneHeightOf,
  railBlob,
  reportB09,
  sampleB09Gesture,
  slotBlob,
  traceMark,
  traceWithSettleFrames,
  transcriptArms,
  wait,
  type B09Leg,
  type SettleFramesRow,
} from "./settle-frames-fixture";

const ARMS = transcriptArms();

/** The card seated, and the column it is seated into and back out of. */
const SEATED_CARD = "at0622-c3";
const SEATED_PANE = "at0622-p3";
const SITTER_PANE = "at0622-p2";
/** The whale rides the two cards the seat resizes. */
const SEAT_WHALES = ["at0622-c2", "at0622-c3"] as const;

/** The gesture's own door, as a page expression. */
const drive = (gesture: string, args: Record<string, unknown>): string =>
  `window.tugdeck.lab.drive(${JSON.stringify(gesture)}, ${JSON.stringify(args)})`;

/** Every beat's start, noted under the leg's name. */
function noteStarts(leg: string, r: B09Leg): void {
  note(
    `at0690 ${leg} beat starts: ` +
      (r.beatRows.length === 0
        ? "(no beats)"
        : r.beatRows
            .map((b) => `${b.recipe} ${b.startDelayMs}ms (${b.landing})`)
            .join(", ")),
  );
}

/** Which properties the [D9] guard reported, deduplicated and sorted. */
const violatedProperties = (violations: readonly string[]): string[] =>
  [...new Set(violations.map((v) => v.slice(v.lastIndexOf(":") + 1)))].sort();

/**
 * The forced-layout census of one seat: the chain probe armed WITH stacks
 * around the drive, every chain noted with its task, its time from the drive,
 * its ms and the site of the read that paid, beside the settle's own arm and
 * beat rows on the same clock. Driven after the sampled legs, so the probe's
 * stack capture never touches a reading the bar judges.
 */
async function noteSeatCensus(app: App, leg: string, slot: number): Promise<void> {
  const mark = await traceMark(app);
  await app.evalJS<null>(`(window.__tugMotion.chains("arm", { stacks: true }), null)`);
  const t0 = await app.evalJS<number>(
    `(function () { var t = performance.now(); ${drive("slot", { card: SEATED_CARD, slot })}; return t; })()`,
  );
  await wait(AFTER_LAND_MS * 2);
  const reading = await app.evalJS<{
    chains: number;
    longestChainMs: number;
    totalChainMs: number;
    truncated: boolean;
    chainTimes: {
      t: number;
      ms: number;
      taskId: number;
      name: string;
      site: string;
      writes: { name: string; site: string }[];
    }[];
  }>(
    `(function () { var r = window.__tugMotion.chains("read"); window.__tugMotion.chains("disarm"); return r; })()`,
  );
  const rows = await app.evalJS<{ kind: string; timestamp: number; recipe?: string }[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) { return e.kind === "settle-arm" || e.kind === "settle-beat" || e.kind === "settle-frames"; }).map(function (e) { return { kind: e.kind, timestamp: e.timestamp, recipe: e.recipe }; })`,
  );
  note(
    `at0690 census ${leg}: ${reading.chains} chain(s), longest ${reading.longestChainMs}ms, ` +
      `total ${reading.totalChainMs}ms${reading.truncated ? " (TRUNCATED)" : ""}; rows ` +
      rows.map((r) => `${r.kind}${r.recipe ? `:${r.recipe}` : ""}@${Math.round(r.timestamp - t0)}`).join(" "),
  );
  for (const c of reading.chainTimes) {
    note(
      `at0690 census ${leg} chain: task ${c.taskId} at ${Math.round(c.t - t0)}ms, ${c.ms}ms, ` +
        `${c.name} | ${c.site.replace(/\n/g, " < ")} || after ` +
        [...new Set(c.writes.map((w) => `${w.name}@${w.site.split("\n")[0]}`))].join(", "),
    );
  }
}

interface SeatLeg {
  readonly sample: B09Leg;
  readonly sitter: readonly [number, number];
  readonly seated: readonly [number, number];
}

/** Seat the card into `slot`, read by both instruments and both heights. */
async function sampleSeat(app: App, slot: number): Promise<SeatLeg> {
  const sitterBefore = await paneHeightOf(app, SITTER_PANE);
  const seatedBefore = await paneHeightOf(app, SEATED_PANE);
  const sample = await sampleB09Gesture(app, drive("slot", { card: SEATED_CARD, slot }));
  return {
    sample,
    sitter: [sitterBefore, await paneHeightOf(app, SITTER_PANE)],
    seated: [seatedBefore, await paneHeightOf(app, SEATED_PANE)],
  };
}

/**
 * The activation's bar (`expectBar` in `settle-frames-fixture.ts`), clause
 * for clause, with its travel clause replaced by the seat's own evidence that
 * it moved and its [D9] clause read as the column leg reads it.
 */
function expectSeatBar(leg: string, r: SeatLeg): void {
  const { probe } = r.sample;
  expect(
    probe.suspended,
    `${leg}: the window was served across the gesture — ${probe.ticks} ` +
      `ticks at ${probe.framePeriodMs.toFixed(2)}ms`,
  ).toBe(false);
  expect(
    r.sitter[0] !== r.sitter[1] && r.seated[0] !== r.seated[1],
    `${leg}: both frames' heights changed — the sitter ${r.sitter[0]} -> ` +
      `${r.sitter[1]}px, the seated card ${r.seated[0]} -> ${r.seated[1]}px. ` +
      `A seat that resized nothing satisfies every clause below`,
  ).toBe(true);
  expect(
    r.sample.row,
    `${leg}: the canvas armed a settle and wrote its record`,
  ).not.toBeNull();
  const row = r.sample.row as SettleFramesRow;
  expect(
    row.motionLongestGapFrames,
    `${leg}: no gap longer than ${GAP_FRAMES_BAR} display frames across the ` +
      `motion — ${row.motionLongestGapMs.toFixed(0)}ms / ` +
      `${row.motionLongestGapFrames.toFixed(2)} frames over ${row.ticks} ticks on ` +
      `${row.panes} panes, with ${row.motionGapsOverOneFrame} gap(s) over one frame`,
  ).toBeLessThanOrEqual(GAP_FRAMES_BAR);
  expect(
    row.moveFirstPaintDelayMs,
    `${leg}: the move's first painted frame lands within one display frame ` +
      `of its start — ${row.moveFirstPaintDelayMs}ms against a derived period ` +
      `of ${probe.framePeriodMs.toFixed(2)}ms`,
  ).toBeLessThanOrEqual(probe.framePeriodMs);
  expect(
    row.moveFirstPaintDelayMs,
    `${leg}: and there WAS a move to be late`,
  ).toBeGreaterThanOrEqual(0);
  noteLead(leg, row);
  expect(
    row.offCurveTicks,
    `${leg}: no shown frame painted a pose off its own settle's curve — ` +
      `${row.offCurveTicks} of ${row.ticks} ticks were off, on ` +
      `[${row.offCurvePaneIds.join(", ")}]`,
  ).toBe(0);
  expect(
    probe.minOpacity,
    `${leg}: no shown frame's computed opacity dipped below 1 — worst was ` +
      `${probe.minOpacity} on \`${probe.minOpacityPaneId}\``,
  ).toBe(1);
  expect(
    [...probe.rectsChangedAfterLanding],
    `${leg}: no shown frame's rect moved after the beat landed`,
  ).toEqual([]);
  expect(
    probe.fixedDescendants,
    `${leg}: no \`position: fixed\` descendant inside a promoted frame`,
  ).toBe(0);
  for (const [who, violations] of [
    ["the canvas's guard", r.sample.violations],
    ["the bench probe's", [...probe.violations]],
  ] as const) {
    expect(
      violatedProperties(violations).filter((p) => p !== "height"),
      `${leg}: [D9] by ${who} — a seat divides a column, so \`height\` is the ` +
        `one main-thread property it may animate; anything else is a new ` +
        `violation: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  }
  noteBeatStarts(leg, r.sample.beatRows, probe.framePeriodMs);
  expectMotionSealed(leg, row);
  expectLand(leg, r.sample.land);
}

/**
 * The rail's bar: the gesture changed the band and was served, the canvas
 * wrote its record, no gap over two frames from the first frame on, [D9]'s
 * guard reports only the rail retune's declared `height` and `width`, and the
 * land is one frame.
 */
function expectRailBar(leg: string, r: B09Leg): void {
  expect(
    r.probe.suspended,
    `${leg}: the window was served across the gesture — ${r.probe.ticks} ` +
      `ticks at ${r.probe.framePeriodMs.toFixed(2)}ms`,
  ).toBe(false);
  expect(
    r.before === r.after,
    `${leg}: the band actually changed — before ${r.before} / after ${r.after}`,
  ).toBe(false);
  expect(r.row, `${leg}: the canvas armed a settle and wrote its record`).not.toBeNull();
  const row = r.row as SettleFramesRow;
  noteLead(leg, row);
  expect(
    row.motionLongestGapFrames,
    `${leg}: no gap over ${GAP_FRAMES_BAR} display frames across the ` +
      `motion, from the first frame on — ${row.motionLongestGapMs.toFixed(0)}ms / ` +
      `${row.motionLongestGapFrames.toFixed(2)} frames over ${row.ticks} ticks on ` +
      `${row.panes} panes`,
  ).toBeLessThanOrEqual(GAP_FRAMES_BAR);
  expect(
    violatedProperties(r.violations).filter((p) => p !== "height" && p !== "width"),
    `${leg}: [D9] — the rail retune declares \`height\` and \`width\`, and ` +
      `nothing else may be animated off the compositor: ` +
      `${JSON.stringify(r.violations)}`,
  ).toEqual([]);
  noteBeatStarts(leg, r.beatRows, r.probe.framePeriodMs);
  expectMotionSealed(leg, row);
  expectLand(leg, r.land);
}

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0690 — seating a card into a column [${arm.size}]`,
  () => {
    test(
      "a card seated into a split column and back holds the activation's bar",
      async () => {
        const { app, tugbankPath } = await launch(4, slotBlob(), "at0690-seat", {
          transcripts: arm.size,
          whaleCards: SEAT_WHALES,
        });
        try {
          await traceWithSettleFrames(app);
          await wait(AFTER_LAND_MS);
          // Both sampled before either is judged, so a red seat still leaves
          // the reading of the one after it.
          const into = await sampleSeat(app, 1);
          reportB09("seat into slot 1", into.sample);
          noteStarts("seat into slot 1", into.sample);
          note(`at0690 seat into slot 1 heights: sitter ${into.sitter.join(" -> ")}, seated ${into.seated.join(" -> ")}`);
          await wait(AFTER_LAND_MS);
          const back = await sampleSeat(app, 2);
          reportB09("seat back to slot 2", back.sample);
          noteStarts("seat back to slot 2", back.sample);
          note(`at0690 seat back to slot 2 heights: sitter ${back.sitter.join(" -> ")}, seated ${back.seated.join(" -> ")}`);

          // The census (the held interior's gate is drawn from it): the whale arm only,
          // both directions, before any clause is judged so a red seat still
          // leaves it, and after both sampled legs so it touches neither.
          if (arm.size === "whale") {
            await wait(AFTER_LAND_MS);
            await noteSeatCensus(app, "seat into slot 1", 1);
            await wait(AFTER_LAND_MS);
            await noteSeatCensus(app, "seat back to slot 2", 2);
          }

          expectSeatBar("seat into slot 1", into);
          expectSeatBar("seat back to slot 2", back);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0690 — one sidebar, and resize to fit [${arm.size}]`,
  () => {
    test(
      "closing and reopening one rail member, and resizing the rails to fit, hold the gap bar",
      async () => {
        const { app, tugbankPath } = await launch(4, railBlob(), "at0690-rail", {
          transcripts: arm.size,
        });
        try {
          await traceWithSettleFrames(app);
          await wait(AFTER_LAND_MS);

          const hide = await sampleB09Gesture(app, drive("sidebar", { component: "jots", open: false }));
          reportB09("one sidebar hide", hide);
          noteStarts("one sidebar hide", hide);
          await wait(AFTER_LAND_MS);
          const show = await sampleB09Gesture(app, drive("sidebar", { component: "jots", open: true }));
          reportB09("one sidebar show", show);
          noteStarts("one sidebar show", show);
          await wait(AFTER_LAND_MS);

          // The retune wants rails that do NOT already fit, or it commits
          // nothing; widening them past their share is what gives it work.
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", ` +
              `{ kind: "i64", value: 900 }), null)`,
          );
          await wait(AFTER_LAND_MS);
          const fit = await sampleB09Gesture(app, drive("fit", {}));
          reportB09("fit", fit);
          noteStarts("fit", fit);

          expectRailBar("one sidebar hide", hide);
          expectRailBar("one sidebar show", show);
          expectRailBar("fit", fit);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0690 — the deck at rest [${arm.size}]`,
  () => {
    test(
      "a resting deck of bound cards stays inside the at-rest budget",
      async () => {
        const { app, tugbankPath } = await launch(4, blobFor(4), "at0690-rest", {
          transcripts: arm.size,
        });
        try {
          await wait(AFTER_LAND_MS * 2);
          const budget = await app.evalJS<number>(
            `window.__tugMotion.probe().restBudgetPerSecond`,
          );
          // `rest()` answers with a promise, which `evalJS` does not await:
          // the reading is parked on the page and waited for, as `at0652`
          // reads it.
          await app.evalJS<null>(`(function(){
            window.__at0690Rest = { done: false };
            window.__tugMotion.rest().then(function (reading) {
              window.__at0690Rest = { done: true, reading: reading };
            });
            return null;
          })()`);
          await app.waitForCondition<boolean>(
            `window.__at0690Rest !== undefined && window.__at0690Rest.done === true`,
            { timeoutMs: 30_000 },
          );
          const rest = await app.evalJS<{
            updatesPerSecond: number;
            busyMsPerSecond: number;
            windowMs: number;
            ticks: number;
            maxGapMs: number;
          }>(`window.__at0690Rest.reading`);
          note(`at0690 loops at rest: ${JSON.stringify(rest)} against ${budget}/s`);
          note("at0690 loops beat starts: (no gesture, no beats)");
          expect(
            rest.ticks,
            `the at-rest chain ran — ${rest.ticks} ticks over ${rest.windowMs}ms`,
          ).toBeGreaterThan(0);
          expect(
            rest.updatesPerSecond,
            `a resting deck of bound cards holds the main thread at most ` +
              `${budget} times a second — ${rest.updatesPerSecond}/s, ` +
              `${rest.busyMsPerSecond}ms/s busy, worst gap ${rest.maxGapMs}ms`,
          ).toBeLessThanOrEqual(budget);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);
