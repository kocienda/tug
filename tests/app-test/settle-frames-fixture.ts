/**
 * settle-frames-fixture.ts — the deck's settle, sampled frame by frame: the
 * fixture, the samplers and the bar that `at0622` and `at0654` both read.
 *
 * ## Why this is a module and not a test
 *
 * One bar, read over every gesture the original ask named, was written into
 * `at0622-deck-settle-frames.test.ts` as one file. Two of its legs are red on
 * real readings and two more sit at the edge of their bars and rotate, so the
 * file had been red for over a hundred consecutive recorded runs — and a file
 * that is always red cannot report a NEW red. The legs were split: `at0622`
 * keeps every leg that holds its bar and is the tripwire; `at0654` carries
 * the standing reds, each a recorded finding with its reading beside it. What
 * both need is the same fixture, the same two instruments and the same bar,
 * and a test file cannot import another test file without running its tests
 * twice. So the shared half lives here, exported, and neither test file
 * defines a sampler of its own.
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
 * Two instruments read one gesture, and which window a clause belongs over is
 * load-bearing. The canvas's own `settle-frames` trace row covers the SETTLE,
 * arm to release, so the timing clauses are read off it. The bench probe
 * covers the WHOLE window — the harness round trip that dispatches the
 * gesture, the click task and the React commit that run before the canvas
 * arms, then the settle, then the landing — so its `longestGapMs` is a number
 * about the window rather than about the beat. What the probe is for is the
 * per-tick census no trace row can carry: opacity, rects, fixed descendants,
 * and the suspension floor.
 *
 * ## What an occluded run looks like
 *
 * A covered harness window suspends `requestAnimationFrame`, and a suspended
 * window reports the same zeros as a perfect deck. The probe derives the
 * display's frame period from the run's own quiet ticks and sets `suspended`
 * when the tick count falls below the floor a served window would produce, so
 * an occluded run fails on `suspended` — naming the tick count and the derived
 * period — rather than passing silently. Every bar helper here asserts it
 * first.
 *
 * ## The fixture
 *
 * A four-up FLOW deck, following `at0621`: the band must be narrower than the
 * strip or the activation moves nothing and the claim is unfalsifiable. The
 * cards are `componentId: "session"` because a session card is the heaviest
 * thing the deck holds, and the per-frame cost this work is about is the cost
 * of settling those. `columnDeck` is the eight-card shared-column shape, where
 * a column divides and every member carries a `height` term, and `railDeck`
 * stands two sidebar rails up for the hide, show and retune legs.
 *
 * Not a test: no `describe` here, and nothing under `tests/app-test` runs a
 * file that does not end in `.test.ts`.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import type { SettleFrameReading } from "./_harness/client";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 300_000;

/**
 * An empty directory for every picker on the fixture's deck to list — made
 * once per process, removed at exit.
 *
 * The fixture's cards are unbound Session cards, so each shows its picker, and
 * a debug build seeds the picker's path with the repository's own source tree.
 * That tree is where this machine's live sessions write their transcripts, so
 * every picker re-rendered its whole form on each `session_updated` push the
 * host sent about them — a 270–550-fibre commit every 8–15 ms, inside every
 * gesture's window, at a rate set by whatever else was running on the machine
 * (`at0654`'s commit census and hook record, 2026-09-30). A bar that reads the
 * deck's settle cannot also be reading the neighbours' sessions. The picker's
 * own cost on a live listing is real and is recorded as its own finding; it is
 * not this fixture's subject.
 */
let quietProjectDir: string | null = null;
function quietProject(): string {
  if (quietProjectDir === null) {
    const dir = mkdtempSync(join(tmpdir(), "tug-settle-quiet-project-"));
    quietProjectDir = dir;
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return quietProjectDir;
}

export const SPACE_ID = "at0622-one";
export const RAIL_WIDTH = 420;
/** Narrower than the band, so a walk to the last slot has somewhere to go. */
export const SLIM_PX = 675;
/** The settle window, with room for a landing tween. */
export const AFTER_LAND_MS = 900;
/**
 * The long task the forcing leg plants.
 *
 * Chosen to sit well clear of the worst gap the deck produces on its own today
 * (~135ms at the branch point), so the forced leg's claim is about the INJECTOR
 * rather than about the deck: a busy loop of this length inside one tick
 * necessarily produces a gap at least this wide, and a dead injector can only
 * reach it if the deck itself stalled that long — which is the very thing this
 * arc is repairing, and which gets less likely with every step.
 */
export const FORCED_STALL_MS = 200;

/**
 * How long after the activation dispatch the forcing leg plants its task.
 *
 * It cannot be zero. The canvas opens its own frame record when the settle
 * ARMS, and a gap is the distance between two samples — so a stall that burns
 * before that record has taken its first sample is invisible to it, however
 * long it is. Measured: planted at zero, the canvas recorded 13 ticks and a
 * worst gap of 18ms while the bench probe recorded 249ms, because the canvas's
 * first sample landed on the far side of the burn. A short delay puts at least
 * one sample in front of the stall, and the 400ms settle has room for both.
 */
export const STALL_PLANTED_AT_MS = 60;

export const SHOWN_FRAMES =
  "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]";

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * A four-up FLOW deck of `count` session cards plus a Layout rail.
 *
 * Flow rather than fit for the reason `at0621` gives: under `fit` every slot is
 * already in view, the activation moves nothing, and "it travelled" is a claim
 * nothing could fail. Session cards rather than hello cards because the cost
 * this arc measures is the cost of settling the heaviest thing on the deck.
 */
export function flowDeck(count: number): Record<string, unknown> {
  const ids = Array.from({ length: count }, (_, i) => `at0622-c${i + 1}`);
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "session",
        title: id,
        closable: true,
      })),
      {
        id: "at0622-l1",
        componentId: "layout",
        title: "Layout",
        closable: true,
      },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `at0622-p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: SLIM_PX, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
      {
        id: "at0622-pl1",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["at0622-l1"],
        activeCardId: "at0622-l1",
        title: "Layout",
        acceptsFamilies: [] as string[],
      },
    ],
    activePaneId: "at0622-p1",
    imposition: {
      kind: "four-up",
      sidebars: { layout: { side: "right" } },
      layout: "flow",
    },
    hasFocus: true,
  };
}

export function blobFor(count: number): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACE_ID,
    spaces: [{ id: SPACE_ID, name: "One", deck: flowDeck(count) }],
  };
}

/**
 * Eight session cards as FOUR SHARED COLUMNS of two — the height-bearing
 * fixture, and the only one that can price a standing promotion honestly.
 *
 * The activation gesture the rest of this file samples is transform-only: the
 * strip translates and no frame's height changes. A standing promotion that
 * is free there can still be expensive on a gesture that carries a real
 * `height` term, because the main-thread walk's price scales with the number
 * of mounted layers and a `height` animation stays on the main thread. Two
 * cards to a slot is what makes a column able to divide, and dividing it is
 * what puts a height term on all eight frames at once.
 */
export function columnDeck(): Record<string, unknown> {
  const ids = Array.from({ length: 8 }, (_, i) => `at0622-c${i + 1}`);
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "session",
        title: id,
        closable: true,
      })),
      {
        id: "at0622-l1",
        componentId: "layout",
        title: "Layout",
        closable: true,
      },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `at0622-p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: SLIM_PX, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        // 0,0,1,1,2,2,3,3 — four columns, two members each.
        slot: index >> 1,
      })),
      {
        id: "at0622-pl1",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["at0622-l1"],
        activeCardId: "at0622-l1",
        title: "Layout",
        acceptsFamilies: [] as string[],
      },
    ],
    activePaneId: "at0622-p1",
    imposition: {
      kind: "four-up",
      sidebars: { layout: { side: "right" } },
      layout: "flow",
    },
    hasFocus: true,
  };
}

/**
 * Four session cards and TWO sidebar cards pinned to the same rail — the
 * fixture for the two-commits-in-one-task shape ([B02], [F03]).
 *
 * Two members is the whole point. `hideSidebarRail` writes the record of what
 * was standing in its own commit and then closes each member in its own, so a
 * rail of two produces THREE notifies inside one task and, under the
 * deferral, one coalesced React commit — which is exactly the arm sequence
 * where a second arm could pass the prelaunch predicate and throw the first's
 * measurement away. A rail of one produces two notifies and the shape is
 * weaker; a rail of none produces no gesture at all.
 */
export function railDeck(): Record<string, unknown> {
  const ids = Array.from({ length: 4 }, (_, i) => `at0622-c${i + 1}`);
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "session",
        title: id,
        closable: true,
      })),
      {
        id: "at0622-l1",
        componentId: "layout",
        title: "Layout",
        closable: true,
      },
      {
        id: "at0622-j1",
        componentId: "jots",
        title: "Jots",
        closable: true,
      },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `at0622-p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: SLIM_PX, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
      {
        id: "at0622-pl1",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["at0622-l1"],
        activeCardId: "at0622-l1",
        title: "Layout",
        acceptsFamilies: [] as string[],
      },
      {
        id: "at0622-pj1",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["at0622-j1"],
        activeCardId: "at0622-j1",
        title: "Jots",
        acceptsFamilies: [] as string[],
      },
    ],
    activePaneId: "at0622-p1",
    imposition: {
      kind: "four-up",
      sidebars: {
        // LEFT, and that is the fixture's other load-bearing choice. A rail
        // on the right widens the band when it goes and moves no frame in
        // it — the panes are laid out from the left edge, so their origins
        // are unchanged and "every moved frame carries a tween" is a claim
        // about an empty set. On the left the band shifts by the rail's
        // whole width and every frame in it has somewhere to be carried to.
        layout: { side: "left" },
        jots: { side: "left" },
      },
      layout: "flow",
    },
    hasFocus: true,
  };
}

export function railBlob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACE_ID,
    spaces: [{ id: SPACE_ID, name: "One", deck: railDeck() }],
  };
}

export function columnBlob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACE_ID,
    spaces: [{ id: SPACE_ID, name: "One", deck: columnDeck() }],
  };
}

/** The flow offset the strip currently stands at. */
export const flowOffset = (app: App): Promise<number> =>
  app.evalJS<number>(
    `(function () {
       try { return window.tugdeck.diag.getDeckState().flowOffset || 0; }
       catch (e) { return 0; }
     })()`,
  );

/**
 * Activate the LAST card from slot 1 through a raw `focus-session-card`
 * dispatch — the real path, flash included.
 *
 * Raw rather than a native click: the click's own hit-testing and scroll are
 * not what is being measured, and a dispatch puts the whole cost of the
 * activation inside the sampled window rather than spread across a gesture the
 * harness drives over several round trips.
 */
export async function activateLast(app: App, count: number): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("focus-session-card", ` +
      `{ cardId: "at0622-c${count}" }), null)`,
  );
}

/** Home the reader on slot 1, so the walk has the whole band to cross. */
export async function home(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("go-to-slot", { value: 1 }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

/**
 * The IDLE control: the same window, the same length, with no gesture in it.
 *
 * Without this, `longestGapMs` is a number about the sampled window rather than
 * about the settle, and every attribution built on it is unfalsifiable — a
 * harness round trip, a session card still mounting, or a stray compositor
 * stall all land in the same field as the defect. The control says what the
 * window costs when the deck is doing nothing, and the activation's reading is
 * only evidence to the extent it exceeds it.
 *
 * It is taken AFTER a home-and-land, so the deck is as quiet as it ever gets.
 */
export async function sampleIdle(app: App): Promise<SettleFrameReading> {
  await home(app);
  await app.armSettleFrameProbe();
  await wait(120 + AFTER_LAND_MS);
  const reading = await app.takeSettleFrameReading();
  await app.disarmSettleFrameProbe();
  return reading;
}

export function report(leg: string, reading: SettleFrameReading): void {
  note(`at0622 ${leg}: ${JSON.stringify(reading)}`);
}

/** The bar's own timeout: its one test launches two decks in sequence. */
export const BAR_TIMEOUT_MS = 600_000;

/** The bar's gap allowance, in display frames. */
export const GAP_FRAMES_BAR = 2;

/**
 * One activation, read by both instruments at once.
 *
 * `probe` is the bench probe over the WHOLE window — arm, quiet head, the
 * harness round trip that dispatches the activation, the click task, the React
 * commit, the settle, the landing. `row` is the product's own `settle-frames`
 * record over the SETTLE — opened when the canvas arms and closed when it
 * releases. Both come out of one classifier, so they are the same reading
 * taken over two different windows, and which window a clause belongs over is
 * the whole of why both are here. See `expectBar`.
 */
export interface BarLeg {
  readonly probe: SettleFrameReading;
  readonly row: SettleFramesRow;
  readonly before: number;
  readonly after: number;
}

export async function sampleBarActivation(
  app: App,
  count: number,
  stallMs: number,
  from: "home" | "here" = "home",
): Promise<BarLeg> {
  if (from === "home") await home(app);
  const before = await flowOffset(app);
  const mark = await traceMark(app);
  await app.armSettleFrameProbe();
  // A short head of quiet ticks before the gesture — the classifier derives the
  // display's frame period from exactly these, so the reading's whole scale
  // depends on there being some.
  await wait(120);
  await activateLast(app, count);
  // The stall is planted after the dispatch AND after the settle has taken a
  // sample or two, so it burns between two of the canvas's own samples rather
  // than ahead of its first. That is what makes the forcing leg falsify the
  // bar rather than only the bench probe.
  if (stallMs > 0) {
    await wait(STALL_PLANTED_AT_MS);
    await app.forceSettleStall(stallMs);
  }
  await wait(AFTER_LAND_MS);
  // The record is written at the release, so wait for one rather than for a
  // duration — a settle that retargets runs past any fixed sleep.
  await app.waitForCondition<boolean>(
    `window.__deckTrace.since(${mark}).some(function (e) {
       return e.kind === "settle-frames";
     })`,
    { timeoutMs: 20_000 },
  );
  const probe = await app.takeSettleFrameReading();
  await app.disarmSettleFrameProbe();
  const rows = await settleFrameRows(app, mark);
  const after = await flowOffset(app);
  return {
    probe,
    row: rows[rows.length - 1] as SettleFramesRow,
    before,
    after,
  };
}

/**
 * Spec S02's bar, over the reading of Spec S01.
 *
 * Two clauses are read off the product's own record and the rest off the bench
 * probe, and the split is not a convenience. The success criterion names "no
 * inter-frame gap longer than two display frames **across the move beat and
 * the focus flip**" — the settle — and the settle is exactly the window the
 * canvas's `settle-frames` record covers. The bench probe's window is opened
 * by a harness round trip and held across two more, and it also brackets the
 * click task and the React commit that run BEFORE the canvas arms. Its
 * `longestGapMs` is therefore a number about the window rather than about the
 * beat; the findings paper measures that difference and it is ~4 frames wide.
 *
 * What the probe is for is everything the canvas's record cannot carry: the
 * per-frame opacity and rect census, the fixed-descendant count, and the
 * suspension floor. Those are facts about the deck at every tick of the
 * window, and the window being generous only makes them harder to satisfy.
 */
export function expectBar(leg: string, r: BarLeg): void {
  const { probe, row } = r;

  // ---- The two that keep the rest from being vacuous. -------------------
  // A suspended window reports the same zeros as a perfect deck, and a deck
  // that never moved satisfies every smoothness claim by doing nothing.
  expect(
    probe.suspended,
    `${leg}: the window was served across the gesture — ${probe.ticks} ` +
      `ticks at ${probe.framePeriodMs.toFixed(2)}ms`,
  ).toBe(false);
  expect(
    r.before === r.after,
    `${leg}: the strip travelled the band — ${r.before} -> ${r.after}px`,
  ).toBe(false);

  // ---- The beat's own two, off the canvas's record. ---------------------
  // **This clause's WINDOW widened under [P01] and its number did not.** The
  // lead from the gesture to the first rendered frame is now a gap in the same
  // series, so `longestGapFrames` is a fact about the whole motion rather than
  // about the inter-tick stretch of it. Two frames stays, and the reason is
  // that this leg is standing red on the activation's own lead (81ms at the
  // arc's start, which IS the worst gap) — moving the bar to admit a number
  // the instrument was just changed to see would be calibrating against the
  // defect. The fold's bar is set separately, at one frame, over the same
  // widened window; see `FOLD_GAP_FRAMES_BAR`.
  expect(
    row.longestGapFrames,
    `${leg}: no gap longer than ${GAP_FRAMES_BAR} display frames across the ` +
      `move beat — ${row.longestGapMs.toFixed(0)}ms / ` +
      `${row.longestGapFrames.toFixed(2)} frames over ${row.ticks} ticks on ` +
      `${row.panes} panes, with ${row.gapsOverOneFrame} gap(s) over one frame`,
  ).toBeLessThanOrEqual(GAP_FRAMES_BAR);
  // The late-START clause, which now reads off `moveFirstPaintDelayMs`. Under
  // [P01] the row's `firstPaintDelayMs` became the lead from the GESTURE, and
  // the move animation's own birth-to-first-advance — the one reading that
  // separates a tween that started late from one that ran and painted late —
  // kept the old definition under the new name. The clause moved with the
  // definition rather than staying on the name.
  expect(
    row.moveFirstPaintDelayMs,
    `${leg}: the move's first painted frame lands within one display frame ` +
      `of its start — ${row.moveFirstPaintDelayMs}ms against a derived period ` +
      `of ${probe.framePeriodMs.toFixed(2)}ms. A late START and a late PAINT ` +
      `look identical from outside; this is the field that separates them`,
  ).toBeLessThanOrEqual(probe.framePeriodMs);
  expect(
    row.moveFirstPaintDelayMs,
    `${leg}: and there WAS a move to be late — the activation is a translate, ` +
      `so a -1 here would mean the clause above passed by having nothing to ` +
      `measure`,
  ).toBeGreaterThanOrEqual(0);
  // The lead's own clause, with its own bar. `firstPaintDelayMs` is now the
  // dead time between the gesture and the first frame the deck managed to
  // render, and under [P01] that lead also enters the gap series — so its bar
  // is the bar every other gap in the run answers to, and stating it here is
  // what makes the number readable as "how long the reader waited" rather
  // than as a component of a maximum.
  expect(
    row.firstPaintDelayMs,
    `${leg}: the lead from the gesture to the first rendered frame is held to ` +
      `the same ${GAP_FRAMES_BAR} display frames as any other gap — ` +
      `${row.firstPaintDelayMs}ms of which ${row.commitDelayMs}ms was spent ` +
      `before the canvas armed, against a derived period of ` +
      `${probe.framePeriodMs.toFixed(2)}ms`,
  ).toBeLessThanOrEqual(probe.framePeriodMs * GAP_FRAMES_BAR);

  // ---- The pose clause, off the canvas's record (Spec S02). -------------
  // The third failure, and the one the two clauses above are both blind to:
  // every frame arrived inside a period and every clock advanced, and the
  // frames were painting a pose their own curves do not pass through. A deck
  // that shows none of its travel satisfies a gap bar perfectly.
  //
  // The diagnostics beside it are noted rather than asserted. `offCurveTicks`
  // is [B04]'s bar on its own; where the run sat and how wide the pending
  // window was are what size the defect and say which mechanism owns it.
  note(
    `at0622 ${leg} off-curve: row pending=${row.pendingTicks} ` +
      `ticks=${row.offCurveTicks} run=${row.longestOffCurveRunTicks} ` +
      `offset=${row.longestOffCurveRunOffsetMs}ms | probe ` +
      `pending=${probe.pendingTicks} ticks=${probe.offCurveTicks} ` +
      `run=${probe.longestOffCurveRunTicks} ` +
      `offset=${probe.longestOffCurveRunOffsetMs}ms`,
  );
  expect(
    row.offCurveTicks,
    `${leg}: no shown frame painted a pose off its own settle's curve at any ` +
      `tick — ${row.offCurveTicks} of ${row.ticks} ticks were off, on ` +
      `[${row.offCurvePaneIds.join(", ")}], with the longest unbroken run ` +
      `${row.longestOffCurveRunTicks} ticks beginning ` +
      `${row.longestOffCurveRunOffsetMs}ms after the first tick a move ` +
      `existed. A frame that arrives on time carrying the wrong pose shows ` +
      `the reader none of the travel, and no gap counter can see it`,
  ).toBe(0);

  // ---- The window's own, off the bench probe. ---------------------------
  expect(
    probe.minOpacity,
    `${leg}: no shown frame's computed opacity dipped below 1 at any tick — ` +
      `worst was ${probe.minOpacity} on \`${probe.minOpacityPaneId}\`. The ` +
      `settle moves; it does not cross-fade`,
  ).toBe(1);
  expect(
    [...probe.rectsChangedAfterLanding],
    `${leg}: no shown frame's rect moved after the beat landed — a frame ` +
      `that settles twice reads as a correction`,
  ).toEqual([]);
  expect(
    probe.fixedDescendants,
    `${leg}: R01's runtime half — no \`position: fixed\` descendant inside a ` +
      `promoted frame, which the standing promotion would otherwise have ` +
      `re-parented to the frame instead of the viewport`,
  ).toBe(0);

  // ---- [D9], read by both. ----------------------------------------------
  expect(
    [...row.violations],
    `${leg}: [D9] — the settle window animates \`transform\` and \`opacity\` ` +
      `and nothing else, by the canvas's own guard`,
  ).toEqual([]);
  expect(
    [...probe.violations],
    `${leg}: and by the bench probe's, over the wider window`,
  ).toEqual([]);
}

export async function launch(
  count: number,
  blob: Record<string, unknown> = blobFor(count),
  testName = "at0622-deck-settle-frames",
): Promise<{ app: App; tugbankPath: string }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(tugbankPath, "dev.tugapp.app", "default-project-path", "string", quietProject());
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.deck.layout",
    "layout",
    "json",
    JSON.stringify(blob),
  );
  const app = await launchTugApp({
    testName,
    env: { TUGBANK_PATH: tugbankPath },
    skipAccessibilityPreflight: true,
    persistInTestMode: true,
    restoreInTestMode: true,
  });
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", ` +
      `{ kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= ${count + 1}`,
    { timeoutMs: 30_000 },
  );
  await wait(AFTER_LAND_MS);
  return { app, tugbankPath };
}

/**
 * One sampled HEIGHT-BEARING gesture: divide every column, then stack them
 * again, with the probe armed across both.
 *
 * A column that divides gives each member a share of the height, so every
 * frame in it animates `height` — a term the doctrine puts on the main thread
 * and keeps there. That is the gesture a standing promotion could make
 * expensive without ever showing up on a transform-only slide, because the
 * walk's price scales with the mounted layer population and a promotion adds
 * to that population whether or not the gesture uses it.
 */
export interface ColumnLeg {
  readonly probe: SettleFrameReading;
  /** Every settle the four dispatches armed, in release order. */
  readonly rows: readonly SettleFramesRow[];
}

export async function sampleColumnGesture(
  app: App,
  mode: "split" | "stack",
): Promise<ColumnLeg> {
  const mark = await traceMark(app);
  await app.armSettleFrameProbe();
  await wait(120);
  for (let slot = 0; slot < 4; slot += 1) {
    await app.evalJS<null>(
      `(window.__tug.dispatchControlAction("set-column-mode", ` +
        `{ slot: ${slot}, mode: ${JSON.stringify(mode)} }), null)`,
    );
  }
  await wait(AFTER_LAND_MS);
  // The record is written at the RELEASE, so wait for one rather than for a
  // duration: four dispatches land back to back and each retargets the
  // settle, so the choreography runs well past a single activation's window,
  // and a fixed sleep here read an unreleased settle and found no row at all
  // — which is exactly what the bar's row clause then reported. The timeout
  // is swallowed so the bar, not the sampler, says "no row".
  try {
    await app.waitForCondition<boolean>(
      `window.__deckTrace.since(${mark}).some(function (e) {
         return e.kind === "settle-frames";
       })`,
      { timeoutMs: 20_000 },
    );
  } catch {
    // No row; `expectColumnBar`'s row clause is what says so.
  }
  const probe = await app.takeSettleFrameReading();
  await app.disarmSettleFrameProbe();
  const rows = await settleFrameRows(app, mark);
  return { probe, rows };
}

/**
 * The height-bearing gesture's bar: every settle the four dispatches armed
 * delivered its frames under the same gap bar the flow slide answers to.
 *
 * The column leg used to assert only that the window was served, which is a
 * reading and not a bar — a division that cut every frame would have passed
 * it. The four `set-column-mode` dispatches arm up to four settles, each
 * retargeting the one before, so the bar is read over every row rather than
 * the last: a retarget that stalls is a stall the reader saw. The height
 * term itself is main-thread by construction ([D9]'s standing hit) and its
 * `:height` violation rows are asserted present by `at0622`'s violations
 * leg; what this bar asks is that the main-thread term still delivers.
 *
 * **It does not, and that is the reading `at0654` carries:** dividing four
 * shared columns of eight session cards read a 48 ms gap (2.82 frames at a
 * 17 ms period) over 65 ticks on nine panes, with five frames carrying a
 * `height` tween, on 2026-09-30 at a clean tree run alone. Stacking them
 * again read exactly 2.00 frames — on the bar's edge.
 */
export function expectColumnBar(leg: string, r: ColumnLeg): void {
  expect(
    r.probe.suspended,
    `${leg}: the window was served across the gesture — ${r.probe.ticks} ` +
      `ticks at ${r.probe.framePeriodMs.toFixed(2)}ms`,
  ).toBe(false);
  expect(
    r.rows.length,
    `${leg}: the canvas armed at least one settle and wrote its record — ` +
      `with no row there is no reading, and a column that changed mode ` +
      `without arming a settle changed it in one paint, which is a cut`,
  ).toBeGreaterThan(0);
  for (const [i, row] of r.rows.entries()) {
    expect(
      row.longestGapFrames,
      `${leg} row ${i + 1}/${r.rows.length}: no gap over ${GAP_FRAMES_BAR} ` +
        `display frames across the settle — ${row.longestGapMs.toFixed(0)}ms ` +
        `/ ${row.longestGapFrames.toFixed(2)} frames over ${row.ticks} ticks ` +
        `on ${row.panes} panes, with ${row.gapsOverOneFrame} gap(s) over one ` +
        `frame`,
    ).toBeLessThanOrEqual(GAP_FRAMES_BAR);
  }
}

// ---------------------------------------------------------------------------
// The session card's fold ([B01], [F02], [F05])
// ---------------------------------------------------------------------------

/**
 * The fold's gap bar: NO MISSED FRAME, across the whole motion — no gap over
 * 1.5 display periods.
 *
 * Not `GAP_FRAMES_BAR`'s two, and the difference is [B01]'s. Two frames was
 * chosen for the activation's move beat, where the bar covers a window that
 * opens at the canvas's arm and the first frame is the expensive one. The fold
 * is judged on the whole motion from the gesture — under [P01] the lead is a
 * gap in the same series — and the claim the user's report is about is that
 * nothing stalls at all, in either direction. A bar of two frames over a
 * window that now contains the lead would be a weaker claim than the one this
 * file already makes about a slide.
 *
 * **Why 1.5 and not 1.0, and why that is the same claim.** "Nothing stalls"
 * means no frame is missed, and the probe already says what a missed frame is:
 * a gap longer than `GAP_TOLERANCE` (1.5) periods, because a live rAF loop's
 * gaps jitter around the period by a few milliseconds and a strict
 * `> framePeriodMs` test "would count most of a perfectly smooth run"
 * (`settle-frame-probe.ts`). This bar was written as 1.0 against the
 * continuous `longestGapFrames`, which is exactly that strict test, and it
 * read red on runs the probe itself scored clean: 18 ms against a 16–17 ms
 * period, 1.06–1.13 frames, with `gapsOverOneFrame` 0 on every one of them
 * (`at0654`, 2026-09-30). One missed frame reads about 2.0 and is caught
 * with the same margin as before; only the jitter the probe was built to
 * forgive is forgiven.
 */
export const FOLD_GAP_FRAMES_BAR = 1.5;

/** The card, and the pane that holds it, that every fold leg gestures on. */
export const FOLD_CARD_ID = "at0622-c1";
export const FOLD_PANE_ID = "at0622-p1";

/**
 * One shown pane's laid-out height, rounded.
 *
 * The fold's equivalent of `flowOffset`: the reading that says the gesture did
 * something. A settle that folded nothing satisfies every smoothness claim
 * below by having no motion in it, which is the shape of unfalsifiable green
 * this file's forcing leg exists to refuse.
 */
export const paneHeightOf = (app: App, paneId: string): Promise<number> =>
  app.evalJS<number>(
    `(function () {
       var el = document.querySelector(
         '[data-space-layer][data-space-shown] .tug-pane[data-pane-id="${paneId}"]');
       return el === null ? -1 : Math.round(el.getBoundingClientRect().height);
     })()`,
  );

export interface FoldLeg {
  readonly probe: SettleFrameReading;
  readonly row: SettleFramesRow;
  readonly before: number;
  readonly after: number;
}

/**
 * One session-card fold, read by both instruments at once.
 *
 * Same shape as {@link sampleBarActivation} and for the same reasons: a quiet
 * head so the classifier can derive the display's period, the gesture through
 * a raw dispatch rather than a click, the stall planted after the dispatch so
 * it burns between two of the canvas's own samples, and a wait on the release
 * row rather than on a duration.
 *
 * The gesture is `set-card-folded`, which is the one door every fold reaches —
 * the Z2 control, Session ▸ Fold Session, ⌃⌘Y and `tugtool host tell` alike —
 * so the stamp [P02] puts on `setPaneFolded`'s committing path is the origin
 * the row measures from, and `commitDelayMs` says how much of the lead was
 * spent before the canvas armed at all.
 */
export async function sampleFold(
  app: App,
  folded: boolean,
  stallMs: number,
): Promise<FoldLeg> {
  const before = await paneHeightOf(app, FOLD_PANE_ID);
  const mark = await traceMark(app);
  await app.armSettleFrameProbe();
  await wait(120);
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", ` +
      `{ cardId: "${FOLD_CARD_ID}", folded: ${folded} }), null)`,
  );
  if (stallMs > 0) {
    await wait(STALL_PLANTED_AT_MS);
    await app.forceSettleStall(stallMs);
  }
  await wait(AFTER_LAND_MS);
  await app.waitForCondition<boolean>(
    `window.__deckTrace.since(${mark}).some(function (e) {
       return e.kind === "settle-frames";
     })`,
    { timeoutMs: 20_000 },
  );
  const probe = await app.takeSettleFrameReading();
  await app.disarmSettleFrameProbe();
  const rows = await settleFrameRows(app, mark);
  const after = await paneHeightOf(app, FOLD_PANE_ID);
  return {
    probe,
    row: rows[rows.length - 1] as SettleFramesRow,
    before,
    after,
  };
}

/**
 * [B01]'s bar on a fold: the reader waits under a frame, and then every frame
 * arrives.
 *
 * Both clauses are read off the canvas's own record, because under [P01] that
 * record now opens at the GESTURE — it is the only instrument whose window is
 * the motion the user actually watched. The bench probe's window opens at a
 * harness round trip before the gesture and closes after the land, so its
 * numbers are about the window; they are noted, not asserted.
 */
export function expectFoldBar(leg: string, r: FoldLeg): void {
  const { probe, row } = r;

  expect(
    probe.suspended,
    `${leg}: the window was served across the gesture — ${probe.ticks} ` +
      `ticks at ${probe.framePeriodMs.toFixed(2)}ms`,
  ).toBe(false);
  expect(
    r.before === r.after,
    `${leg}: the pane's height actually changed — ${r.before} -> ${r.after}px. ` +
      `A gesture that folded nothing satisfies every clause below by having ` +
      `no motion in it`,
  ).toBe(false);

  expect(
    row.firstPaintDelayMs,
    `${leg}: a fold's first rendered frame lands within one display frame of ` +
      `the gesture — ${row.firstPaintDelayMs}ms, of which ` +
      `${row.commitDelayMs}ms was spent before the canvas armed, against a ` +
      `derived period of ${probe.framePeriodMs.toFixed(2)}ms. This is the ` +
      `dead time the user reported and the instrument could not see: with a ` +
      `\`height\` term and no transform-bearing effect the old field read -1 ` +
      `and called three folds healthy`,
  ).toBeLessThanOrEqual(probe.framePeriodMs);
  expect(
    row.moveFirstPaintDelayMs,
    `${leg}: and the move clock says what it always said about a fold — -1, ` +
      `there is no transform-bearing effect here at all, which is exactly ` +
      `why the clause above had to stop reading it`,
  ).toBe(-1);
  expect(
    row.longestGapFrames,
    `${leg}: no missed frame across the whole motion, lead included — no ` +
      `gap over ${FOLD_GAP_FRAMES_BAR} display periods — ` +
      `${row.longestGapMs.toFixed(0)}ms / ` +
      `${row.longestGapFrames.toFixed(2)} frames over ${row.ticks} ticks on ` +
      `${row.panes} panes, with ${row.gapsOverOneFrame} gap(s) over one frame`,
  ).toBeLessThanOrEqual(FOLD_GAP_FRAMES_BAR);
}

export function reportFold(leg: string, r: FoldLeg): void {
  note(`at0622 ${leg} row: ${JSON.stringify(r.row)}`);
  note(`at0622 ${leg} probe: ${JSON.stringify(r.probe)}`);
  note(`at0622 ${leg} height: ${r.before} -> ${r.after}px`);
}

// ---------------------------------------------------------------------------
// The flash ([B05], [P06])
// ---------------------------------------------------------------------------

/** The settle's own length (`IMPOSER_SETTLE_MS`), so a post-landing read can be taken just after it. */
export const SETTLE_MS = 400;

/**
 * The flash, read from outside: whether a ring is lit, and on what terms.
 *
 * `properties` is the flash effect's own keyframe property names with the four
 * Web Animations bookkeeping keys dropped, so it reads as the list of things
 * the ring actually animates. That list is the whole of `[B05]`: it used to be
 * `box-shadow`, a repaint of a full-pane layer for nearly two seconds.
 */
export interface FlashCensus {
  readonly lit: number;
  readonly paneId: string;
  readonly properties: readonly string[];
  readonly currentTime: number;
}

export const BOOKKEEPING_KEYS = ["offset", "computedOffset", "easing", "composite"];

export const flashCensus = (app: App): Promise<FlashCensus> =>
  app.evalJS<FlashCensus>(
    `(function () {
       var lit = Array.prototype.slice.call(
         document.querySelectorAll(".tug-pane.tug-pane-flash"));
       var pane = lit[0] || null;
       var anim = null;
       if (pane !== null) {
         var running = pane.getAnimations({ subtree: true });
         for (var i = 0; i < running.length; i += 1) {
           if (running[i].animationName === "tug-pane-border-flash") {
             anim = running[i];
             break;
           }
         }
       }
       var props = {};
       if (anim !== null && anim.effect !== null) {
         (anim.effect.getKeyframes() || []).forEach(function (kf) {
           Object.keys(kf).forEach(function (k) { props[k] = true; });
         });
       }
       return {
         lit: lit.length,
         paneId: pane === null ? "" : (pane.getAttribute("data-pane-id") || ""),
         properties: Object.keys(props).sort(),
         currentTime: anim === null ? -1 : (anim.currentTime || 0),
       };
     })()`,
  );

/**
 * Dispatch the activation and read the deck back in the SAME task.
 *
 * That is the whole point of this leg and it could not be done across a
 * harness round trip: `raiseCard` runs its activation through `flushSync`, so
 * the settle's mark is already on the container when `dispatchControlAction`
 * returns, and a read taken here is a read taken inside the click's own frame.
 * Anything the flash did at call time is visible; anything it deferred is not.
 */
export const activateAndReadSameTask = (
  app: App,
  cardId: string,
): Promise<{ settling: boolean; lit: number }> =>
  app.evalJS<{ settling: boolean; lit: number }>(
    `(function () {
       window.__tug.dispatchControlAction(
         "focus-session-card", { cardId: ${JSON.stringify(cardId)} });
       return {
         settling: document.querySelector("[data-imposer-settling]") !== null,
         lit: document.querySelectorAll(".tug-pane.tug-pane-flash").length,
       };
     })()`,
  );

// ---------------------------------------------------------------------------
// The click task's budget, and the held cell relevance ([B06], [B07], [P07])
// ---------------------------------------------------------------------------

/**
 * What the click task raised, and what the settle is holding.
 *
 * `episodes` counts the frames wearing `data-resize-episode` — the mark
 * `beginResizeEpisode` writes, and therefore the exact count of scroller
 * subtrees the click task walked through `discoverScrollers` →
 * `watchGeneric` → `firstBoxReaching` ([F06]). A pure flow slide reflows
 * nothing, so it should raise none.
 *
 * `resolved` is the computed `content-visibility` of every cell that has
 * earned `data-cv-ready`, tallied by value. At rest the tally is `auto`; while
 * a settle is running every one of them must have been pinned to `hidden` or
 * `visible`, because `auto` is the value that re-resolves relevance against
 * the viewport mid-tween ([B07]).
 */
export interface BudgetCensus {
  readonly settling: boolean;
  readonly episodes: number;
  readonly cvEventSupported: boolean;
  readonly ready: number;
  readonly skipped: number;
  readonly resolved: Record<string, number>;
}

export const budgetCensus = (app: App): Promise<BudgetCensus> =>
  app.evalJS<BudgetCensus>(
    `(function () {
       var frames = Array.prototype.slice.call(
         document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}));
       var episodes = 0;
       frames.forEach(function (f) {
         if (f.hasAttribute("data-resize-episode")) episodes += 1;
       });
       var ready = Array.prototype.slice.call(
         document.querySelectorAll(".tug-list-view-cell[data-cv-ready]"));
       var resolved = {};
       var skipped = 0;
       ready.forEach(function (cell) {
         var v = getComputedStyle(cell).contentVisibility || "";
         resolved[v] = (resolved[v] || 0) + 1;
         if (cell.hasAttribute("data-cv-skipped")) skipped += 1;
       });
       return {
         settling: document.querySelector("[data-imposer-settling]") !== null,
         episodes: episodes,
         cvEventSupported:
           "oncontentvisibilityautostatechange" in
           document.createElement("div"),
         ready: ready.length,
         skipped: skipped,
         resolved: resolved,
       };
     })()`,
  );

// ---------------------------------------------------------------------------
// The settle's own frame record ([B10], [P09], [D9])
// ---------------------------------------------------------------------------

/**
 * The `settle-frames` row the product writes about itself.
 *
 * The row and the probe's reading come from ONE classifier —
 * `classifySettleFrames`, which the canvas calls at release and the bench
 * probe calls at `take()` — so the comparison below is not two
 * implementations agreeing. It is the product proving it sampled the settle it
 * says it sampled: a record written off an empty array, or off a pump that
 * never ran, reports zeros that nothing could catch unless something else
 * measured the same gesture.
 */
export interface SettleFramesRow {
  readonly kind: string;
  readonly panes: number;
  readonly ticks: number;
  readonly longestGapMs: number;
  readonly longestGapFrames: number;
  readonly gapsOverOneFrame: number;
  /** The GESTURE to the first rendered frame, with the lead also in the gaps. */
  readonly firstPaintDelayMs: number;
  /** The part of that lead spent before the canvas armed. */
  readonly commitDelayMs: number;
  /** A move animation's birth to the tick its clock advanced; `-1` with no move. */
  readonly moveFirstPaintDelayMs: number;
  // The pose half of Spec S01, mirrored off the trace variant. `offCurveTicks`
  // is the one the bar reads; the rest size the defect and say where in the
  // settle it sat, which is what separates the pending window from a seam.
  readonly pendingTicks: number;
  readonly offCurveTicks: number;
  readonly offCurvePaneIds: readonly string[];
  /** The retarget double-hop, which `offCurveTicks` cannot see ([B01]). */
  readonly strandedTicks: number;
  readonly strandedPaneIds: readonly string[];
  readonly longestOffCurveRunTicks: number;
  readonly longestOffCurveRunOffsetMs: number;
  readonly violations: readonly string[];
}

/**
 * Turn the trace on AND arm the `settle-frames` kind.
 *
 * The canvas's frame pump is cost-bearing — a rAF loop for the length of
 * every settle, a computed style per shown frame per tick — so since [B07] it
 * is armed by name rather than riding the global flag, the same door
 * `space-switch-frames` uses. A leg that reads the row asks for it; a deck
 * nobody is measuring runs no pump.
 */
export const traceWithSettleFrames = async (app: App): Promise<void> => {
  await app.enableDeckTrace(true);
  await app.evalJS<null>(
    `(window.__deckTrace.enableKind("settle-frames", true), null)`,
  );
};

/** One exit ghost's travel over the beat that took it away. */
export interface GhostTravel {
  /** The largest |translateX| the ghost was seen wearing. */
  readonly maxPx: number;
  /** How many frames it was in the document for. */
  readonly ticks: number;
}

/**
 * Start a per-frame census of every exit ghost's `translateX`.
 *
 * A departing RAIL leaves by the edge it stands on, and since [B10] its ghost
 * — and the shadow strip beside it — slide on the `depart` beat rather than
 * on a plant-time clock of their own. Nothing else in this file would notice
 * if that slide stopped happening: a rail that vanished on the spot still
 * moves the band, still carries every surviving frame, and still leaves no
 * ghost behind. The travel has to be read directly or it is not read at all.
 *
 * Sampled off computed style rather than off the animation, because what is
 * claimed is what the frame PAINTED — an effect that exists and applies
 * nothing is exactly the failure a `fill` or a play-pending window produces.
 *
 * Falsified with the depart beat's rail branch forced to the band's fade
 * under a `file probe`: every ghost read `maxPx: 0` over 15 frames and the
 * file dropped from 10/12 to 9/12. On the beat it reads 443.9px over 16
 * frames, the same number for both members and the strip.
 */
export const armGhostCensus = (app: App): Promise<null> =>
  app.evalJS<null>(
    `(function () {
       var seen = {};
       window.__at0622Ghosts = seen;
       var tick = function () {
         var els = document.querySelectorAll("[data-exit-ghost-for]");
         for (var i = 0; i < els.length; i++) {
           var el = els[i];
           var key = el.getAttribute("data-exit-ghost-for");
           var row = seen[key];
           if (row === undefined) { row = seen[key] = { maxPx: 0, ticks: 0 }; }
           var m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
           row.maxPx = Math.max(row.maxPx, Math.abs(m.m41));
           row.ticks += 1;
         }
         window.__at0622GhostRaf = requestAnimationFrame(tick);
       };
       window.__at0622GhostRaf = requestAnimationFrame(tick);
       return null;
     })()`,
  );

/** Stop the census and read it, with the ghosts still standing at rest. */
export const readGhostCensus = (
  app: App,
): Promise<{
  travel: Record<string, GhostTravel>;
  standing: readonly string[];
}> =>
  app.evalJS(
    `(function () {
       cancelAnimationFrame(window.__at0622GhostRaf);
       var standing = [];
       var els = document.querySelectorAll("[data-exit-ghost-for]");
       for (var i = 0; i < els.length; i++) {
         standing.push(els[i].getAttribute("data-exit-ghost-for"));
       }
       return { travel: window.__at0622Ghosts, standing: standing };
     })()`,
  );

/**
 * The click task's marks, milliseconds after the last `tug:arm-end`: count,
 * every occurrence, from 60ms before it to 200ms after.
 *
 * The names are the ones that survive [B07]'s gate. The four per-render marks
 * and the per-subscriber `tug:sync:*` pair are gone from the product — they
 * were a mark per React render and six pairs per commit, on every instance,
 * for a census this reader only ever printed.
 *
 * **Every occurrence, and [B06] is why.** A mark seen more than three times
 * used to fold to `{n, first, last, inFlush}`, and the fold is what the
 * in-flush pin reads: a Last pass in the MIDDLE of a longer run — the one
 * place the pin exists to look — was invisible to a filter that only ever
 * saw the two ends. The window is bounded at 260ms, so the list it keeps
 * instead is bounded too.
 */
export const clickTaskMarks = (app: App): Promise<Record<string, unknown>> =>
  app.evalJS<Record<string, unknown>>(
    `(function () {
       var names = ["tug:set-pane-folded",
                    "tug:arm-measured", "tug:arm-episodes-end", "tug:arm-planned",
                    "tug:arm-end", "tug:flushSync-start", "tug:flushSync-end", "tug:applyBagFocus-end",
                    "tug:action-end", "tug:action-microtask", "tug:action-next-task",
                    "tug:first-tick", "tug:react-notify",
                    "tug:react-notify-end", "tug:last-pass", "tug:canvas-render",
                    "tug:flip-will-end", "tug:flip-commit-end", "tug:flip-chain-key-end",
                    "tug:flip-did-deactivate-end", "tug:flip-did-activate-end",
                    "tug:chain-notify",
                    "tug:menu-flush", "tug:menu-facts", "tug:menu-commands", "tug:menu-serialized",
                    "tug:menu-flush-end", "tug:menu-caps", "tug:menu-caps-end",
                    "tug:focus-invariant", "tug:focus-invariant-end", "tug:focus-measure", "tug:focus-measure-end"];
       var out = {};
       var arm = performance.getEntriesByName("tug:arm-end");
       var origin = arm.length ? arm[arm.length - 1].startTime : 0;
       names.forEach(function (n) {
         var ts = performance.getEntriesByName(n)
           .map(function (e) { return Math.round((e.startTime - origin) * 10) / 10; })
           .filter(function (t) { return t > -60 && t < 200; });
         out[n] = ts;
       });
       // The origin itself, on the page's clock, so a reading's
       // longestGapEndsAt can be placed among the marks above.
       out["origin"] = Math.round(origin * 10) / 10;
       return out;
     })()`,
  );

/**
 * Every recorded offset for one mark.
 *
 * It used to reconstruct a list from the census's `{first, last}` fold, which
 * is the half of [F07] that made a middle occurrence invisible. The census
 * keeps every occurrence now ([B06]), so this is the read it always should
 * have been.
 */
export function markTimes(
  marks: Record<string, unknown>,
  name: string,
): readonly number[] {
  const v = marks[name];
  return Array.isArray(v) ? (v as readonly number[]) : [];
}

/** The same three readings the pin makes, as a diagnostics line. */
export function reportLastPassOrder(
  leg: string,
  marks: Record<string, unknown>,
): void {
  note(
    `at0622 ${leg} last-pass order: last-pass ` +
      `${JSON.stringify(markTimes(marks, "tug:last-pass"))}, react-notify ` +
      `${JSON.stringify(markTimes(marks, "tug:react-notify"))}, flush ` +
      `${JSON.stringify(markTimes(marks, "tug:flushSync-start"))}..` +
      `${JSON.stringify(markTimes(marks, "tug:flushSync-end"))}`,
  );
}

/**
 * [B04]'s pin: the Last pass may not run inside the click task's flush.
 *
 * `transferFocusForActivation` wraps the activation in a `flushSync`, and
 * anything that renders the canvas inside it pulls the whole FLIP Last pass —
 * measure, invert, plan, launch — back into the gesture's own task, which is
 * precisely the cost [D204]'s deferred notify exists to move off it. The
 * defect is not that some subscriber notifies the canvas: React reads
 * `getSnapshot` on every render whatever woke it, so ANY component that
 * re-renders in that window reads the deck's new state. So the claim is read
 * off the outcome rather than off the cause — where `tug:last-pass` lands
 * relative to `tug:react-notify` and to the flush's own two marks.
 *
 * Measured before [B04], and again with the change reverted under a
 * `file probe`: on the cold first activation `tug:last-pass` read at +10 ms
 * with `tug:flushSync-end` also at +10 and the first `tug:react-notify` not
 * until +21; the probe run read +8 against +19. Either way the Last pass ran
 * a whole frame before React was told, inside the flush, which is [F05]
 * exactly.
 *
 * After it, the same leg reads both marks at +20 with the flush closed at
 * +3: the Last pass is the layout effect of the commit the notify caused,
 * which is the shape the ordering is asserting and the reason the clause is
 * `>=` rather than `>`.
 *
 * **The flush marks are ASSERTED PRESENT, not read if present ([B06]).** The
 * in-flush clause used to sit behind an `if` on both marks being there, so a
 * change that stopped emitting them — a rename, a gate that swallowed them,
 * a `flushSync` removed from the path — skipped the pin in silence and the
 * leg stayed green having checked nothing. A missing mark is now the failure
 * it always was: the pin cannot be read, so the pin is red.
 */
export function expectLastPassAfterNotify(
  leg: string,
  marks: Record<string, unknown>,
): void {
  const lastPass = markTimes(marks, "tug:last-pass");
  const notify = markTimes(marks, "tug:react-notify");
  const flushStart = markTimes(marks, "tug:flushSync-start");
  const flushEnd = markTimes(marks, "tug:flushSync-end");

  // The guard: with no Last pass and no notify in the window there is no
  // ordering to read, and every clause below would pass by vacancy.
  expect(
    lastPass.length > 0 && notify.length > 0,
    `${leg}: the window really contains a Last pass and a React notify — ` +
      `last-pass ${JSON.stringify(lastPass)}, react-notify ` +
      `${JSON.stringify(notify)}`,
  ).toBe(true);

  expect(
    lastPass[0],
    `${leg}: the Last pass never runs BEFORE React is told ([B04]) — ` +
      `last-pass at ` +
      `${lastPass[0]}ms, first react-notify at ${notify[0]}ms, both relative ` +
      `to the arm. A Last pass that reads first is the canvas rendering from ` +
      `something else in the click task and taking the deck's new snapshot ` +
      `with it. Equal is the healthy reading and not a tie: the Last pass IS ` +
      `the layout effect of the commit the notify caused, and the host's ` +
      `clock resolves to 1ms, so a commit that lands promptly puts both ` +
      `marks in the same millisecond`,
  ).toBeGreaterThanOrEqual(notify[0]);

  expect(
    flushStart.length > 0 && flushEnd.length > 0,
    `${leg}: the activation's flushSync left both of its marks in the ` +
      `window — start ${JSON.stringify(flushStart)}, end ` +
      `${JSON.stringify(flushEnd)}. Without them the clause below cannot be ` +
      `read, and a pin that quietly skips itself is worse than one that ` +
      `fails: every leg that carries it would stay green having checked ` +
      `nothing ([B06])`,
  ).toBe(true);

  const inFlush = lastPass.filter(
    (t) => t >= flushStart[0] && t <= flushEnd[flushEnd.length - 1],
  );
  expect(
    inFlush,
    `${leg}: and no Last pass runs inside the activation's flushSync — ` +
      `the flush spans ${flushStart[0]}..` +
      `${flushEnd[flushEnd.length - 1]}ms and these landed in it: ` +
      `[${inFlush.join(", ")}]`,
  ).toEqual([]);
}

/**
 * DIAGNOSTIC: arm a recorder of every geometry or style read that takes over a
 * millisecond, with the stack that asked for it. A slow read is a forced style
 * or layout, and the stack names who forced it — the one thing a commit census
 * cannot say, because a forced layout is paid by whichever script reads first
 * and not by the commit that dirtied the tree. Take it with {@link slowReads},
 * which also removes it.
 */
export const armSlowReads = (app: App): Promise<null> =>
  app.evalJS<null>(
    `(function () {
       var slow = window.__tugSlowReads = [];
       var undo = window.__tugSlowReadsUndo = [];
       function record(key, s) {
         var e = performance.now() - s;
         if (e > 1) slow.push({ what: key, ms: Math.round(e * 10) / 10, at: s,
           stack: String(new Error().stack).split("\\n").slice(2, 7).join(" | ") });
       }
       function wrap(owner, key) {
         var d = Object.getOwnPropertyDescriptor(owner, key);
         if (!d) return;
         if (typeof d.value === "function") {
           var f = d.value;
           owner[key] = function () { var s = performance.now(); var r = f.apply(this, arguments); record(key, s); return r; };
           undo.push(function () { owner[key] = f; });
         } else if (d.get) {
           var g = d.get;
           Object.defineProperty(owner, key, { configurable: true, enumerable: d.enumerable, set: d.set,
             get: function () { var s = performance.now(); var r = g.call(this); record(key, s); return r; } });
           undo.push(function () { Object.defineProperty(owner, key, d); });
         }
       }
       wrap(Element.prototype, "getBoundingClientRect");
       wrap(Element.prototype, "getClientRects");
       wrap(Element.prototype, "checkVisibility");
       wrap(HTMLElement.prototype, "offsetWidth");
       wrap(HTMLElement.prototype, "offsetHeight");
       wrap(HTMLElement.prototype, "offsetTop");
       wrap(HTMLElement.prototype, "offsetLeft");
       wrap(Element.prototype, "scrollHeight");
       wrap(Element.prototype, "scrollTop");
       wrap(Element.prototype, "clientHeight");
       wrap(Element.prototype, "clientWidth");
       wrap(Object.getOwnPropertyDescriptor(window, "getComputedStyle") ? window : Window.prototype, "getComputedStyle");
       return null;
     })()`,
  );

/** Take and disarm {@link armSlowReads}' record, times relative to the last `tug:arm-end`. */
export const slowReads = (app: App): Promise<unknown> =>
  app.evalJS<unknown>(
    `(function () {
       (window.__tugSlowReadsUndo || []).forEach(function (u) { u(); });
       window.__tugSlowReadsUndo = [];
       var arm = performance.getEntriesByName("tug:arm-end");
       var origin = arm.length ? arm[arm.length - 1].startTime : 0;
       return (window.__tugSlowReads || []).map(function (r) {
         return { what: r.what, ms: r.ms, at: Math.round(r.at - origin), stack: r.stack };
       }).filter(function (r) { return r.at > -80 && r.at < 200; });
     })()`,
  );

/** PROBE: every React commit from 60ms before the last `tug:arm-end` to 200ms after, times relative to it. */
export const reactCommits = (app: App): Promise<unknown> =>
  app.evalJS<unknown>(
    `(function () {
       var arm = performance.getEntriesByName("tug:arm-end");
       var origin = arm.length ? arm[arm.length - 1].startTime : 0;
       var api = window.__tugCommits;
       if (!api) return "no census";
       return api.since(origin - 60).filter(function (c) { return c.t < origin + 200; })
         .map(function (c) { return { t: Math.round((c.t - origin) * 10) / 10, fibers: c.fibers, performed: c.performed, top: c.top.slice(0, 6), labels: c.labels, why: c.why, origins: c.origins, hooks: c.hooks }; });
     })()`,
  );

export const traceMark = (app: App): Promise<number> =>
  app.evalJS<number>(`window.__deckTrace.since(0).length`);

export const settleFrameRows = (
  app: App,
  mark: number,
): Promise<readonly SettleFramesRow[]> =>
  app.evalJS<readonly SettleFramesRow[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) {
       return e.kind === "settle-frames";
     })`,
  );

/**
 * Every `settle-retarget` the canvas recorded in the window, as
 * `paneId:mode:beat`.
 *
 * What makes a retarget leg falsifiable. A second gesture that arrives after
 * the first has landed, or one the arm takes the prelaunch path for, produces
 * no retarget at all — and then every clause about what a retarget does is a
 * claim about a gesture nobody made. The canvas writes one row per frame it
 * held `hold-at-current`, which is exactly the set of frames the third pass
 * hands residue back to.
 */
export const retargetRows = (app: App, mark: number): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) {
       return e.kind === "settle-retarget";
     }).map(function (e) { return e.paneId + ":" + e.mode + ":" + e.beat; })`,
  );

export const motionViolationRows = (
  app: App,
  mark: number,
): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) {
       return e.kind === "settle-motion-violation";
     }).map(function (e) { return e.paneId + ":" + e.property; })`,
  );

/**
 * Every shown frame computing a translate the deck is not carrying, as
 * `paneId@x,y`.
 *
 * Read once the deck is at rest, this is the cancel guarantee's whole
 * assertion. A frame at rest is committed at Last and the imposer owns nothing
 * on it, so the only transform it may compute is the identity; anything else is
 * an ORIGIN pose that outlived the settle that wrote it. Half a CSS pixel is
 * the same rounding floor `settle-frame-probe.ts` uses, for the same reason.
 *
 * The read is a computed-style matrix rather than the inline attribute because
 * a hold can arrive either way, and what the reader sees is the computed one.
 */
export const residualTranslates = (app: App): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}),
       function (el) {
         var t = getComputedStyle(el).transform;
         var x = 0, y = 0;
         if (t && t !== "none") {
           try { var m = new DOMMatrixReadOnly(t); x = m.m41; y = m.m42; }
           catch (e) { return "unparsed:" + t; }
         }
         if (Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5) return null;
         return el.getAttribute("data-pane-id") + "@" +
           x.toFixed(1) + "," + y.toFixed(1);
       }
     ).filter(function (v) { return v !== null; })`,
  );

/** Which clock released each settle in the window — "the exit it took". */
export const releaseSources = (app: App, mark: number): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) {
       return e.kind === "settle-release";
     }).map(function (e) { return e.source; })`,
  );

/** The pane the deck currently calls active — the retarget leg's landing. */
export const activePaneId = (app: App): Promise<string> =>
  app.evalJS<string>(
    `(function () {
       try { return window.tugdeck.diag.getDeckState().activePaneId || "-"; }
       catch (e) { return "-"; }
     })()`,
  );

// ---------------------------------------------------------------------------
// The retarget double-hop ([B01], [B08])
// ---------------------------------------------------------------------------

/**
 * A gesture interrupted by a second one, read for the hop the gap bar and the
 * off-curve bar are both blind to.
 *
 * The defect is a consequence of [D204]'s deferral and nothing else. `arm`
 * cancels the running tween `hold-at-current`, hands the residue back and
 * clears the flip on its own tick, under a comment saying nothing paints in
 * between — and under a deferred React commit something does. The frame paints
 * once carrying NO tween at all, at the interrupted settle's end pose, and the
 * Last pass a frame later measures Last and tweens from the mid pose it
 * inverted. The eye gets mid -> old end -> mid -> new end.
 *
 * Neither standing bar can see it. The gap bar counts ticks and every tick
 * arrived. The off-curve bar compares a pose against a curve and on that tick
 * there is no curve — the classifier's case 4 skips a frame carrying no
 * effect, which is exactly the frame in question. `strandedTicks` is the
 * reading added for it: travelling before, no effect now, travelling again
 * later, standing at the committed pose. Its bar is zero.
 *
 * **Neither gesture goes through focus, and that is load-bearing.** An
 * ACTIVATION cannot expose this defect, and the reason is [F05]: the cards
 * selection store rides the synchronous door, the canvas subscribes to it,
 * and the canvas therefore re-renders inside `transferFocusForActivation`'s
 * `flushSync` and runs its Last pass in the gesture's own task. The
 * deferral's hole accidentally patches the deferral's defect for the one
 * family of gestures that goes through focus — measured: with the [B01]
 * flush reverted out, an activation retargeted by an activation reads zero
 * stranded ticks, and so does a fold interrupted by a CLOSE, which routes
 * through `_removeCard` into the same `flushSync`. [F02] says so in its own
 * words: "every NON-ACTIVATION gesture that lands mid-settle takes this
 * path."
 *
 * `go-to-slot` is not the answer either, and the retarget guard below is
 * what said so: the walk writes the flow offset on its readers and runs no
 * FLIP tween at all, so a second walk finds `settleTweensRef` empty, holds
 * nothing, and records no `settle-retarget`. Every clause over it was
 * vacuous. The gestures that do put a frame in `settleTweensRef` without
 * touching focus are the ones with a real term of their own: a session
 * card's fold, and a content-width change. Both are used below, and the
 * guard is what keeps a future edit from quietly falling back into a
 * gesture that retargets nothing.
 *
 * The interruption lands at 140ms, inside the 400ms beat and late enough
 * that every tween has really started, where the 80ms retarget leg above
 * catches tweens that never did.
 *
 * **Which leg reads the defect, measured rather than assumed.** With the
 * [B01] flush reverted out, leg 2 fails — one stranded tick across
 * `p2`, `p3`, `p4` and the rail, which is the double hop in the flesh — and
 * leg 1 stays green. A fold retargeted by a fold holds ONE frame, and that
 * frame's replacement beat is planned soon enough that no sampled tick
 * catches it bare; the resize holds all five at once and one of them is
 * always caught. Both are kept: leg 1 is the narrow shape and costs a
 * gesture pair, and a defect that widens would show there first.
 */
export const RETARGET_AT_MS = 140;

// ---------------------------------------------------------------------------
// Two commits in one task ([B02], [B08])
// ---------------------------------------------------------------------------

/** Every shown frame's origin, as `paneId -> "x,y"`, rounded. */
export const frameOrigins = (app: App): Promise<Record<string, string>> =>
  app.evalJS<Record<string, string>>(
    `(function () {
       var out = {};
       document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).forEach(
         function (el) {
           var r = el.getBoundingClientRect();
           out[el.getAttribute("data-pane-id")] =
             Math.round(r.x) + "," + Math.round(r.y);
         });
       return out;
     })()`,
  );

// ---------------------------------------------------------------------------
// An arrival interrupted by a close ([B03], [F04])
// ---------------------------------------------------------------------------

/** When the close lands, measured from the `show-card` that starts the arrival. */
export const ARRIVAL_RETARGET_AT_MS = 140;
/** How long the per-frame opacity census runs. Two settles, back to back. */
export const ARRIVAL_CENSUS_MS = 2_000;

export interface ArrivalSample {
  t: number;
  /** The beat the imposer named on this frame, `""` outside a beat. */
  beat: string;
  /** Every shown frame's COMPUTED opacity, by pane id. */
  opacity: Record<string, number>;
  /** The pane ids wearing `data-arriving` — appended, not yet divided in. */
  arriving: readonly string[];
}

/**
 * Arm a per-frame census of every shown frame's computed opacity against the
 * beat the imposer names, and hand back what it saw.
 *
 * Computed rather than inline, and that is the whole point: the hold an
 * arrival wears is an inline `opacity: 0`, and the defect this leg reads is a
 * restorer handing that inline value back — after which the frame's computed
 * opacity is the stylesheet's 1 with no inline anything. A census of
 * `el.style.opacity` would read `""` in both the healthy and the broken case.
 */
export async function arrivalCensus(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
       window.__at0622arrival = [];
       var t0 = performance.now();
       var tick = function () {
         var canvas = document.querySelector("[data-imposer-settling]");
         var sample = {
           t: performance.now() - t0,
           beat: canvas === null
             ? ""
             : canvas.getAttribute("data-imposer-beat") || "",
           opacity: {},
           arriving: [],
         };
         document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).forEach(
           function (el) {
             var id = el.getAttribute("data-pane-id");
             sample.opacity[id] = Number(getComputedStyle(el).opacity);
             if (el.hasAttribute("data-arriving")) sample.arriving.push(id);
           });
         window.__at0622arrival.push(sample);
         if (performance.now() - t0 < ${ARRIVAL_CENSUS_MS}) {
           requestAnimationFrame(tick);
         }
       };
       requestAnimationFrame(tick);
       return null;
     })()`,
  );
}

// ---------------------------------------------------------------------------
// [B09]: the rest of the ask's behaviours, each against the one bar
// ---------------------------------------------------------------------------

/**
 * The one bar, stated once.
 *
 * The activation's bar and the fold's bar were each written for their own
 * gesture and each carries its own gap allowance, and the difference between
 * them is a fact about how much of the motion their window covers rather than
 * about how much stall the eye will take. [B09] asks the remaining behaviours
 * the same five questions, off the same instrument, at the same numbers:
 *
 *   1. the lead from the gesture to the first rendered frame is at most one
 *      display frame,
 *   2. no gap in the run is longer than two,
 *   3. no shown frame painted a pose off its own curve on any tick,
 *   4. no shown frame's rect moved again after the beat landed,
 *   5. and the window was served — the tick count is above the suspension
 *      floor, so the four clauses above are not four readings of an rAF that
 *      stopped.
 *
 * Which gesture is being judged is not one of the questions, and that is the
 * point of stating the bar once: a behaviour whose motion is cheaper than an
 * activation's does not get a looser number for being cheaper, and one whose
 * motion is more expensive does not get a looser number for being expensive.
 * A leg that reads red against this stays red and is recorded.
 */
export const B09_GAP_FRAMES_BAR = 2;

/**
 * Every shown pane, id and rounded rect, as one comparable string.
 *
 * The generic form of `flowOffset` and `paneHeightOf`: the reading that says
 * the gesture did something, for gestures whose "something" is not one number.
 * A card appearing adds an id, a card leaving takes one away, a walk moves
 * every origin, and bullseye changes one frame's width and every other
 * frame's place. Every one of those changes this string, and a gesture that
 * changed nothing leaves it identical — which is the whole of what the guard
 * needs to ask.
 */
export const bandCensus = (app: App): Promise<string> =>
  app.evalJS<string>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}),
       function (el) {
         var r = el.getBoundingClientRect();
         return el.getAttribute("data-pane-id") + "@" + Math.round(r.left) +
           "," + Math.round(r.top) + "+" + Math.round(r.width) + "x" +
           Math.round(r.height);
       }
     ).join(" ")`,
  );

/**
 * Start recording the distinct beats the imposer names, in the order it names
 * them.
 *
 * The settle-frames row says how the window was served and says nothing about
 * WHICH choreography served it, and three of the legs below make a claim
 * about a named beat — `room` then `arrive` for a card appearing, `depart`
 * for one leaving. Without this the appear leg passes just as well on a card
 * that popped into place with no arrival at all, which is precisely the
 * failure [F04] turned out to be.
 *
 * Read off `data-imposer-beat` on the settling container, the same attribute
 * `arrivalCensus` reads, because that is the imposer's own name for what it
 * is running rather than a test's inference from what moved.
 */
export const armBeatCensus = (app: App): Promise<null> =>
  app.evalJS<null>(
    `(function () {
       var seen = [];
       window.__at0622Beats = seen;
       var tick = function () {
         var canvas = document.querySelector("[data-imposer-settling]");
         var beat = canvas === null
           ? ""
           : canvas.getAttribute("data-imposer-beat") || "";
         if (beat !== "" && seen.indexOf(beat) < 0) seen.push(beat);
         window.__at0622BeatRaf = requestAnimationFrame(tick);
       };
       window.__at0622BeatRaf = requestAnimationFrame(tick);
       return null;
     })()`,
  );

export const readBeatCensus = (app: App): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `(cancelAnimationFrame(window.__at0622BeatRaf), window.__at0622Beats)`,
  );

/** One [B09] gesture, read by both instruments and by the beat census. */
export interface B09Leg {
  readonly probe: SettleFrameReading;
  /** The last settle-frames row in the window, or `null` if none was written. */
  readonly row: SettleFramesRow | null;
  /** How many rows the window carried — a coalesced settle writes one. */
  readonly rows: number;
  readonly before: string;
  readonly after: string;
  readonly beats: readonly string[];
  /** The runtime [D9] guard's report, as `paneId:property`. */
  readonly violations: readonly string[];
}

/**
 * One gesture, sampled the way {@link sampleFold} samples a fold: a quiet head
 * so the classifier can derive the display's period, the gesture through its
 * own real door, a wait on the release row rather than on a duration.
 *
 * `gestureJs` is the door's own call rather than an action name and payload,
 * because the behaviours below do not share one door: three go through
 * `dispatchControlAction` and the close goes through `closePane`, which is
 * what the pane's own close button calls.
 *
 * The settle-frames row is waited for rather than required. A gesture that
 * arms no settle writes no row, and that is a finding about the gesture worth
 * reading rather than a timeout worth throwing — so the wait is bounded, the
 * row may come back `null`, and the bar says for itself that a missing row is
 * a failure.
 */
export async function sampleB09Gesture(
  app: App,
  gestureJs: string,
  stallMs = 0,
): Promise<B09Leg> {
  const before = await bandCensus(app);
  const mark = await traceMark(app);
  await armBeatCensus(app);
  await app.armSettleFrameProbe();
  await wait(120);
  await app.evalJS<null>(`(${gestureJs}, null)`);
  // Planted after the dispatch and after the canvas has taken a sample or
  // two, so it burns between two of the canvas's own samples rather than
  // ahead of its first — the same reasoning `STALL_PLANTED_AT_MS` carries for
  // the activation leg, and the whole of why a forced leg falsifies the ROW
  // rather than only the bench probe.
  if (stallMs > 0) {
    await wait(STALL_PLANTED_AT_MS);
    await app.forceSettleStall(stallMs);
  }
  await wait(AFTER_LAND_MS);
  try {
    await app.waitForCondition<boolean>(
      `window.__deckTrace.since(${mark}).some(function (e) {
         return e.kind === "settle-frames";
       })`,
      { timeoutMs: 8_000 },
    );
  } catch {
    // No row. The bar's third clause is what says so; see the doc above.
  }
  const probe = await app.takeSettleFrameReading();
  await app.disarmSettleFrameProbe();
  const rows = await settleFrameRows(app, mark);
  const beats = await readBeatCensus(app);
  const violations = await motionViolationRows(app, mark);
  const after = await bandCensus(app);
  return {
    probe,
    row: rows.length === 0 ? null : (rows[rows.length - 1] as SettleFramesRow),
    rows: rows.length,
    before,
    after,
    beats,
    violations,
  };
}

/**
 * The pane ids that were NOT standing before this gesture — the frames that
 * arrived in it.
 *
 * What the pose clause's exemption is computed from on a gesture that brings
 * frames in. An arriving frame is held at inline `opacity: 0` for the whole
 * of `room`, painting the identity while its own curve says its origin, and
 * the reader sees none of it. Derived from the leg's own before-and-after
 * census rather than written down, so a gesture that stops bringing frames
 * in exempts nobody.
 */
export function arrivedIn(r: B09Leg): readonly string[] {
  const before = new Set(r.before.split(" ").map((s) => s.split("@")[0]));
  return r.after
    .split(" ")
    .map((s) => s.split("@")[0])
    .filter((id) => id !== "" && !before.has(id));
}

export function reportB09(leg: string, r: B09Leg): void {
  note(`at0622 ${leg} row: ${JSON.stringify(r.row)} (${r.rows} row(s))`);
  note(`at0622 ${leg} probe: ${JSON.stringify(r.probe)}`);
  note(
    `at0622 ${leg} beats: ${JSON.stringify(r.beats)}; violations ` +
      `${JSON.stringify(r.violations)}`,
  );
  note(`at0622 ${leg} band: ${r.before} -> ${r.after}`);
}

/**
 * The beats this leg's settle actually ran, asserted rather than printed
 * ([B04]).
 *
 * `expectB09Bar` judges lead, gap, pose and landing, and every one of those
 * is satisfiable by a settle that ran the WRONG choreography — a regression
 * that cuts one beat, or reorders two, leaves the frames arriving on time
 * along a path nobody asked for. `row !== null` narrows the hole to "armed
 * but ran the wrong beats" and no further, which is exactly the hole this
 * closes.
 *
 * The list is ordered, because the census names beats in the order the
 * imposer names them and the order IS the choreography: `["shrink","move"]`
 * and `["move","shrink"]` are two different gestures. A leg whose beats stop
 * matching is a finding to record, never a bar to loosen.
 */
export function expectBeats(leg: string, r: B09Leg, expected: readonly string[]): void {
  expect(
    [...r.beats],
    `${leg}: the settle ran the choreography this leg is named for, in order ` +
      `— expected ${JSON.stringify(expected)}, saw ` +
      `${JSON.stringify(r.beats)}. Every other clause of the bar passes on a ` +
      `settle that arrived on time along the wrong path`,
  ).toEqual([...expected]);
}

/**
 * The five clauses of the bar above, over one leg.
 *
 * `exempt` names panes the POSE clause does not judge, and it exists for
 * exactly one reading, measured rather than anticipated: an arriving frame is
 * held at inline `opacity: 0` for the whole of the `room` beat, and across
 * those 24 ticks it paints the identity while its own curve says its origin.
 * The reader sees none of it — the frame is invisible for every one of those
 * ticks — so counting them is the pose clause answering a question about a
 * frame nobody is looking at. Every other pane in the same settle is judged
 * in full, and the caller has to name the exemption and show it earned: the
 * appear leg exempts only the pane the probe itself reports at opacity 0.
 *
 * The count is still asserted for every pane that is NOT exempt, so an
 * off-curve tick on a visible frame fails this exactly as before.
 */
export function expectB09Bar(
  leg: string,
  r: B09Leg,
  exempt: readonly string[] = [],
): void {
  const { probe } = r;

  // ---- The three that keep the rest from being vacuous. -----------------
  expect(
    probe.suspended,
    `${leg}: the window was served across the gesture — ${probe.ticks} ` +
      `ticks at ${probe.framePeriodMs.toFixed(2)}ms. A suspended window ` +
      `reports the same zeros as a perfect deck`,
  ).toBe(false);
  expect(
    r.before === r.after,
    `${leg}: the band actually changed — a gesture that moved nothing ` +
      `satisfies every clause below by having no motion in it. before ` +
      `${r.before} / after ${r.after}`,
  ).toBe(false);
  expect(
    r.row,
    `${leg}: the canvas armed a settle and wrote its record — with no row ` +
      `there is no reading, and a gesture that changed the band without ` +
      `arming a settle changed it in one paint, which is a cut`,
  ).not.toBeNull();
  const row = r.row as SettleFramesRow;

  // ---- The bar. ---------------------------------------------------------
  expect(
    row.firstPaintDelayMs,
    `${leg}: the lead from the gesture to the first rendered frame is at ` +
      `most one display frame — ${row.firstPaintDelayMs}ms, of which ` +
      `${row.commitDelayMs}ms was spent before the canvas armed, against a ` +
      `derived period of ${probe.framePeriodMs.toFixed(2)}ms`,
  ).toBeLessThanOrEqual(probe.framePeriodMs);
  expect(
    row.longestGapFrames,
    `${leg}: no gap over ${B09_GAP_FRAMES_BAR} display frames across the ` +
      `whole motion, lead included — ${row.longestGapMs.toFixed(0)}ms / ` +
      `${row.longestGapFrames.toFixed(2)} frames over ${row.ticks} ticks on ` +
      `${row.panes} panes, with ${row.gapsOverOneFrame} gap(s) over one frame`,
  ).toBeLessThanOrEqual(B09_GAP_FRAMES_BAR);
  expect(
    row.offCurvePaneIds.filter((id) => !exempt.includes(id)),
    `${leg}: no shown frame painted a pose off its own settle's curve at any ` +
      `tick — ${row.offCurveTicks} of ${row.ticks} ticks were off, on ` +
      `[${row.offCurvePaneIds.join(", ")}], longest run ` +
      `${row.longestOffCurveRunTicks} ticks from ` +
      `${row.longestOffCurveRunOffsetMs}ms` +
      (exempt.length === 0 ? "" : `, with [${exempt.join(", ")}] exempt`) +
      `. A frame that arrives on time carrying the wrong pose shows the ` +
      `reader none of the travel`,
  ).toEqual([]);
  expect(
    [...probe.rectsChangedAfterLanding],
    `${leg}: no shown frame's rect moved after the beat landed — a frame ` +
      `that settles twice reads as a correction`,
  ).toEqual([]);
}

