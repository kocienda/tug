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
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
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

import { launchTugApp, note, type App } from "./_harness";
import type { SettleFrameReading } from "./_harness/client";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SPACE_ID = "at0622-one";
const RAIL_WIDTH = 420;
/** Narrower than the band, so a walk to the last slot has somewhere to go. */
const SLIM_PX = 675;
/** The settle window, with room for a landing tween. */
const AFTER_LAND_MS = 900;
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
const FORCED_STALL_MS = 200;

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
const STALL_PLANTED_AT_MS = 60;

const SHOWN_FRAMES =
  "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]";

const wait = (ms: number): Promise<void> =>
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
function flowDeck(count: number): Record<string, unknown> {
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

function blobFor(count: number): Record<string, unknown> {
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
function columnDeck(): Record<string, unknown> {
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
function railDeck(): Record<string, unknown> {
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

function railBlob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACE_ID,
    spaces: [{ id: SPACE_ID, name: "One", deck: railDeck() }],
  };
}

function columnBlob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACE_ID,
    spaces: [{ id: SPACE_ID, name: "One", deck: columnDeck() }],
  };
}

/** The flow offset the strip currently stands at. */
const flowOffset = (app: App): Promise<number> =>
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
async function activateLast(app: App, count: number): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("focus-session-card", ` +
      `{ cardId: "at0622-c${count}" }), null)`,
  );
}

/** Home the reader on slot 1, so the walk has the whole band to cross. */
async function home(app: App): Promise<void> {
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
async function sampleIdle(app: App): Promise<SettleFrameReading> {
  await home(app);
  await app.armSettleFrameProbe();
  await wait(120 + AFTER_LAND_MS);
  const reading = await app.takeSettleFrameReading();
  await app.disarmSettleFrameProbe();
  return reading;
}

function report(leg: string, reading: SettleFrameReading): void {
  note(`at0622 ${leg}: ${JSON.stringify(reading)}`);
}

/** The bar's own timeout: its one test launches two decks in sequence. */
const BAR_TIMEOUT_MS = 600_000;

/** The bar's gap allowance, in display frames. */
const GAP_FRAMES_BAR = 2;

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
interface BarLeg {
  readonly probe: SettleFrameReading;
  readonly row: SettleFramesRow;
  readonly before: number;
  readonly after: number;
}

async function sampleBarActivation(
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
function expectBar(leg: string, r: BarLeg): void {
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

async function launch(
  count: number,
  blob: Record<string, unknown> = blobFor(count),
): Promise<{ app: App; tugbankPath: string }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.deck.layout",
    "layout",
    "json",
    JSON.stringify(blob),
  );
  const app = await launchTugApp({
    testName: "at0622-deck-settle-frames",
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
async function sampleColumnGesture(
  app: App,
  mode: "split" | "stack",
): Promise<SettleFrameReading> {
  await app.armSettleFrameProbe();
  await wait(120);
  for (let slot = 0; slot < 4; slot += 1) {
    await app.evalJS<null>(
      `(window.__tug.dispatchControlAction("set-column-mode", ` +
        `{ slot: ${slot}, mode: ${JSON.stringify(mode)} }), null)`,
    );
  }
  await wait(AFTER_LAND_MS);
  const reading = await app.takeSettleFrameReading();
  await app.disarmSettleFrameProbe();
  return reading;
}

describe.skipIf(!SHOULD_RUN)("at0622 — the deck's settle, at the bar", () => {
  test(
    "the bar holds at four session cards and at eight, the gap does not grow with the count, and a planted stall fails it",
    async () => {
      // Both legs live in one test because the scaling clause is a comparison
      // between them. Split across two tests it could only be smuggled through
      // a module-level variable, and a claim that depends on the order two
      // tests happen to run in is not a claim.
      let fourFrames = Number.NaN;
      let fourGapMs = Number.NaN;

      const four = await launch(4);
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
        note(`at0622 four-up cold-first row: ${JSON.stringify(plain.row)}`);
        const coldMarks = await clickTaskMarks(four.app);
        note(`at0622 four-up cold-first click task: ${JSON.stringify(coldMarks)}`);
        note(`at0622 four-up cold-first commits: ${JSON.stringify(await reactCommits(four.app))}`);

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
        // already stand complete, and that is what the bar is now pinned to.
        // Card 1's picker presented at launch (it is the active pane) and
        // card 4's on the cold leg, so from where that leg left the strip,
        // activating card 1 is a flip the other way across the same band with
        // both pickers warm. From HERE, not from home: at home card 1 already
        // stands in the band and the activation would move nothing, so no
        // settle row would ever be written and `expectBar`'s travel guard
        // would be the clause that caught it.
        const warm = await sampleBarActivation(four.app, 1, 0, "here");
        report("four-up warm-flip probe", warm.probe);
        note(`at0622 four-up warm-flip row: ${JSON.stringify(warm.row)}`);
        const warmMarks = await clickTaskMarks(four.app);
        note(`at0622 four-up warm-flip click task: ${JSON.stringify(warmMarks)}`);
        note(`at0622 four-up warm-flip commits: ${JSON.stringify(await reactCommits(four.app))}`);

        // [B04]'s pin, on the pinned bar leg — the warm flip.
        //
        // The cold first activation is a READING here for the same reason
        // its gap numbers are ([B08]): its flush carries the picker's whole
        // mount cascade, which renders the canvas inside the window on some
        // runs and not others, and a canvas that renders for ANY reason in
        // that window reads the deck's new snapshot and runs the Last pass
        // with it. Measured across four runs at one commit the cold leg's
        // Last pass landed at +20, +20, +8 and +7 against flush windows of
        // 6ms and 17ms — inside on one of them. That residue is real and is
        // recorded rather than pinned: [B04] closed the cards-selection
        // route into the flush, and the picker's mount is a second route
        // this arc does not touch.
        reportLastPassOrder("four-up cold first", coldMarks);
        expectLastPassAfterNotify("four-up warm flip", warmMarks);

        expectBar("four-up warm flip", warm);
        fourFrames = warm.row.longestGapFrames;
        fourGapMs = warm.row.longestGapMs;

        // ---- The forcing leg ([D5]). ----------------------------------
        // Both instruments have to be shown noticing a defect put there on
        // purpose, or every green reading above is unfalsifiable: a sampler
        // that silently stopped observing and a deck that genuinely stopped
        // dropping frames produce the same zeros. That is the exact failure
        // the 2026-09-18 drop fix made.
        const forced = await sampleBarActivation(
          four.app,
          4,
          FORCED_STALL_MS,
        );
        report("four-up forced probe", forced.probe);
        note(`at0622 four-up forced row: ${JSON.stringify(forced.row)}`);
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
          `four-up forced: and the CANVAS's own record fails the bar it just ` +
            `passed, which is what makes the bar a measurement rather than a ` +
            `formality. The warm flip read ${fourGapMs.toFixed(0)}ms / ` +
            `${fourFrames.toFixed(2)} frames; forced reads ` +
            `${forced.row.longestGapMs.toFixed(0)}ms / ` +
            `${forced.row.longestGapFrames.toFixed(2)} frames`,
        ).toBeGreaterThan(GAP_FRAMES_BAR);
      } finally {
        await four.app.close();
        rmTempTugbank(four.tugbankPath);
      }

      const eight = await launch(8);
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
        note(`at0622 eight-up cold-first row: ${JSON.stringify(plain.row)}`);

        // The same flip, at twice the card count. The bar and the scaling
        // clause below are both read off it rather than off the cold leg, so
        // the comparison is warm against warm: a picker cascade that mounts
        // once per unbound card would otherwise put the whole difference
        // between four and eight into the clause that is supposed to be
        // measuring the settle.
        const warm = await sampleBarActivation(eight.app, 1, 0, "here");
        report("eight-up warm-flip probe", warm.probe);
        note(`at0622 eight-up warm-flip row: ${JSON.stringify(warm.row)}`);
        expectBar("eight-up warm flip", warm);

        // ---- The scaling clause. --------------------------------------
        // This is the claim the arc's purpose actually makes, and the one a
        // change that merely fits on today's four-up deck could not satisfy.
        // The baseline's whole signature of the defect was that the cost grew
        // with the card count: +51ms at four, +71ms at eight.
        expect(
          Math.abs(warm.row.longestGapFrames - fourFrames),
          `the worst gap does not grow with the card count — four-up read ` +
            `${fourGapMs.toFixed(0)}ms / ${fourFrames.toFixed(2)} frames, ` +
            `eight-up reads ${warm.row.longestGapMs.toFixed(0)}ms / ` +
            `${warm.row.longestGapFrames.toFixed(2)} frames on ` +
            `${warm.row.panes} panes, both on the WARM FLIP. Within one ` +
            `display frame is the bar; ` +
            `a settle whose price is proportional to how much has to be ` +
            `rasterized would miss it`,
        ).toBeLessThanOrEqual(1);
      } finally {
        await eight.app.close();
        rmTempTugbank(eight.tugbankPath);
      }
    },
    BAR_TIMEOUT_MS,
  );
});

describe.skipIf(!SHOULD_RUN)(
  "at0622 — eight standing layers, priced on a height-bearing gesture",
  () => {
    test(
      "four shared columns divide and stack again, sampled",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob());
        try {
          const idle = await sampleIdle(app);
          report("column idle control", idle);
          expect(
            idle.suspended,
            `column idle control: the window was served — ${idle.ticks} ticks`,
          ).toBe(false);

          const split = await sampleColumnGesture(app, "split");
          report("column split (height-bearing)", split);
          expect(
            split.suspended,
            `column split: the window was served — ${split.ticks} ticks`,
          ).toBe(false);

          const stack = await sampleColumnGesture(app, "stack");
          report("column stack (height-bearing)", stack);
          expect(
            stack.suspended,
            `column stack: the window was served — ${stack.ticks} ticks`,
          ).toBe(false);
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
// The session card's fold ([B01], [F02], [F05])
// ---------------------------------------------------------------------------

/**
 * The fold's gap bar: ONE display frame, across the whole motion.
 *
 * Not `GAP_FRAMES_BAR`'s two, and the difference is [B01]'s. Two frames was
 * chosen for the activation's move beat, where the bar covers a window that
 * opens at the canvas's arm and the first frame is the expensive one. The fold
 * is judged on the whole motion from the gesture — under [P01] the lead is a
 * gap in the same series — and the claim the user's report is about is that
 * nothing stalls at all, in either direction. A bar of two frames over a
 * window that now contains the lead would be a weaker claim than the one this
 * file already makes about a slide.
 */
const FOLD_GAP_FRAMES_BAR = 1;

/** The card, and the pane that holds it, that every fold leg gestures on. */
const FOLD_CARD_ID = "at0622-c1";
const FOLD_PANE_ID = "at0622-p1";

/**
 * One shown pane's laid-out height, rounded.
 *
 * The fold's equivalent of `flowOffset`: the reading that says the gesture did
 * something. A settle that folded nothing satisfies every smoothness claim
 * below by having no motion in it, which is the shape of unfalsifiable green
 * this file's forcing leg exists to refuse.
 */
const paneHeightOf = (app: App, paneId: string): Promise<number> =>
  app.evalJS<number>(
    `(function () {
       var el = document.querySelector(
         '[data-space-layer][data-space-shown] .tug-pane[data-pane-id="${paneId}"]');
       return el === null ? -1 : Math.round(el.getBoundingClientRect().height);
     })()`,
  );

interface FoldLeg {
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
async function sampleFold(
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
function expectFoldBar(leg: string, r: FoldLeg): void {
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
    `${leg}: no gap over ${FOLD_GAP_FRAMES_BAR} display frame across the ` +
      `whole motion, lead included — ${row.longestGapMs.toFixed(0)}ms / ` +
      `${row.longestGapFrames.toFixed(2)} frames over ${row.ticks} ticks on ` +
      `${row.panes} panes, with ${row.gapsOverOneFrame} gap(s) over one frame`,
  ).toBeLessThanOrEqual(FOLD_GAP_FRAMES_BAR);
}

function reportFold(leg: string, r: FoldLeg): void {
  note(`at0622 ${leg} row: ${JSON.stringify(r.row)}`);
  note(`at0622 ${leg} probe: ${JSON.stringify(r.probe)}`);
  note(`at0622 ${leg} height: ${r.before} -> ${r.after}px`);
}

describe.skipIf(!SHOULD_RUN)(
  "at0622 — a session card's fold, across the whole motion",
  () => {
    test(
      "folding and unfolding a session card delivers every frame from the gesture, and a planted stall fails it",
      async () => {
        // `flowDeck` and not `columnDeck`, and the choice is load-bearing. A
        // flow column holds one card, so it never divides, so the only
        // `height` term anywhere in this window is the folding pane's own.
        // The eight-card shared-column fixture gives every member of a
        // dividing column a `height` tween — the standing [D9] hit
        // `tuglaws/animation-doctrine.md` records by name and the test above
        // asserts PRESENT — and on it the fold's row and the division's row
        // are the same row, so nothing read there could ever say whether the
        // FOLD still carries height.
        const { app, tugbankPath } = await launch(4);
        try {
          await traceWithSettleFrames(app);
          await home(app);
          await wait(AFTER_LAND_MS);

          const fold = await sampleFold(app, true, 0);
          reportFold("fold", fold);
          // The fold's click-task timeline, with the preamble split ([B08]).
          // `tug:set-pane-folded` is the store mutator's entry and the three
          // `tug:arm-*` marks are the arm's own phases, so the stretch that
          // used to read as one unattributed 11–12 ms before `tug:arm-end`
          // now has a left edge and three interior cuts.
          note(`at0622 fold click task: ${JSON.stringify(await clickTaskMarks(app))}`);
          expectFoldBar("fold", fold);

          const unfold = await sampleFold(app, false, 0);
          reportFold("unfold", unfold);
          expectFoldBar("unfold", unfold);

          // ---- The forcing leg ([D5]). ----------------------------------
          // Both readings have to be shown noticing a defect planted on
          // purpose, or the two greens above are unfalsifiable in exactly the
          // way [F05] records: a sampler that stopped observing and a fold
          // that stopped stalling produce the same numbers.
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

// ---------------------------------------------------------------------------
// The flash ([B05], [P06])
// ---------------------------------------------------------------------------

/** The settle's own length (`IMPOSER_SETTLE_MS`), so a post-landing read can be taken just after it. */
const SETTLE_MS = 400;

/**
 * The flash, read from outside: whether a ring is lit, and on what terms.
 *
 * `properties` is the flash effect's own keyframe property names with the four
 * Web Animations bookkeeping keys dropped, so it reads as the list of things
 * the ring actually animates. That list is the whole of `[B05]`: it used to be
 * `box-shadow`, a repaint of a full-pane layer for nearly two seconds.
 */
interface FlashCensus {
  readonly lit: number;
  readonly paneId: string;
  readonly properties: readonly string[];
  readonly currentTime: number;
}

const BOOKKEEPING_KEYS = ["offset", "computedOffset", "easing", "composite"];

const flashCensus = (app: App): Promise<FlashCensus> =>
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
const activateAndReadSameTask = (
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
interface BudgetCensus {
  readonly settling: boolean;
  readonly episodes: number;
  readonly cvEventSupported: boolean;
  readonly ready: number;
  readonly skipped: number;
  readonly resolved: Record<string, number>;
}

const budgetCensus = (app: App): Promise<BudgetCensus> =>
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
interface SettleFramesRow {
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
const traceWithSettleFrames = async (app: App): Promise<void> => {
  await app.enableDeckTrace(true);
  await app.evalJS<null>(
    `(window.__deckTrace.enableKind("settle-frames", true), null)`,
  );
};

/** One exit ghost's travel over the beat that took it away. */
interface GhostTravel {
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
const armGhostCensus = (app: App): Promise<null> =>
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
const readGhostCensus = (
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
const clickTaskMarks = (app: App): Promise<Record<string, unknown>> =>
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
function markTimes(
  marks: Record<string, unknown>,
  name: string,
): readonly number[] {
  const v = marks[name];
  return Array.isArray(v) ? (v as readonly number[]) : [];
}

/** The same three readings the pin makes, as a diagnostics line. */
function reportLastPassOrder(
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
function expectLastPassAfterNotify(
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

/** PROBE: every React commit from 60ms before the last `tug:arm-end` to 200ms after, times relative to it. */
const reactCommits = (app: App): Promise<unknown> =>
  app.evalJS<unknown>(
    `(function () {
       var arm = performance.getEntriesByName("tug:arm-end");
       var origin = arm.length ? arm[arm.length - 1].startTime : 0;
       var api = window.__tugCommits;
       if (!api) return "no census";
       return api.since(origin - 60).filter(function (c) { return c.t < origin + 200; })
         .map(function (c) { return { t: Math.round((c.t - origin) * 10) / 10, fibers: c.fibers, performed: c.performed, top: c.top.slice(0, 6), labels: c.labels }; });
     })()`,
  );

const traceMark = (app: App): Promise<number> =>
  app.evalJS<number>(`window.__deckTrace.since(0).length`);

const settleFrameRows = (
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
const retargetRows = (app: App, mark: number): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) {
       return e.kind === "settle-retarget";
     }).map(function (e) { return e.paneId + ":" + e.mode + ":" + e.beat; })`,
  );

const motionViolationRows = (
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
const residualTranslates = (app: App): Promise<readonly string[]> =>
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
const releaseSources = (app: App, mark: number): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) {
       return e.kind === "settle-release";
     }).map(function (e) { return e.source; })`,
  );

/** The pane the deck currently calls active — the retarget leg's landing. */
const activePaneId = (app: App): Promise<string> =>
  app.evalJS<string>(
    `(function () {
       try { return window.tugdeck.diag.getDeckState().activePaneId || "-"; }
       catch (e) { return "-"; }
     })()`,
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
const RETARGET_AT_MS = 140;

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

// ---------------------------------------------------------------------------
// Two commits in one task ([B02], [B08])
// ---------------------------------------------------------------------------

/** Every shown frame's origin, as `paneId -> "x,y"`, rounded. */
const frameOrigins = (app: App): Promise<Record<string, string>> =>
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
          await app.armSettleFrameProbe();
          await armGhostCensus(app);
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
          const ghosts = await readGhostCensus(app);
          const after = await frameOrigins(app);
          note(`at0622 two-commit probe: ${JSON.stringify(probe)}`);
          note(`at0622 two-commit ghosts: ${JSON.stringify(ghosts)}`);
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
          // no ghost behind, and satisfies every bar above.
          const travelled = Object.keys(ghosts.travel).sort();
          expect(
            travelled,
            `two-commit: both rail members and the side's shadow strip got ` +
              `a ghost — ${JSON.stringify(travelled)}. A missing strip is ` +
              `the depth of the panel blinking out while the panel slides`,
          ).toEqual(["at0622-pj1", "at0622-pl1", "rail-shadow:left"]);
          for (const key of travelled) {
            const row = ghosts.travel[key] as GhostTravel;
            expect(
              row.maxPx,
              `two-commit: ${key}'s ghost travelled off the edge — ` +
                `${row.maxPx.toFixed(1)}px over ${row.ticks} frame(s). Near ` +
                `zero is a rail that disappeared where it stood`,
            ).toBeGreaterThan(100);
            expect(
              row.ticks,
              `two-commit: and travelled ACROSS frames rather than in one ` +
                `jump — ${key} was in the document for ${row.ticks} frame(s)`,
            ).toBeGreaterThan(2);
          }
          // One travel per side: the strip stands ten pixels inboard, so a
          // strip measured against the edge separately would take a longer
          // journey and drift away from the panel it is the depth of.
          const spans = travelled.map(
            (k) => (ghosts.travel[k] as GhostTravel).maxPx,
          );
          expect(
            Math.max(...spans) - Math.min(...spans),
            `two-commit: every ghost on the side travelled the RAIL's ` +
              `distance — ${JSON.stringify(spans)}`,
          ).toBeLessThan(0.5);
          expect(
            [...ghosts.standing],
            `two-commit: and every ghost was collected when its beat landed`,
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

// ---------------------------------------------------------------------------
// An arrival interrupted by a close ([B03], [F04])
// ---------------------------------------------------------------------------

/** When the close lands, measured from the `show-card` that starts the arrival. */
const ARRIVAL_RETARGET_AT_MS = 140;
/** How long the per-frame opacity census runs. Two settles, back to back. */
const ARRIVAL_CENSUS_MS = 2_000;

interface ArrivalSample {
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
async function arrivalCensus(app: App): Promise<void> {
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
const B09_GAP_FRAMES_BAR = 2;

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
const bandCensus = (app: App): Promise<string> =>
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
const armBeatCensus = (app: App): Promise<null> =>
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

const readBeatCensus = (app: App): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `(cancelAnimationFrame(window.__at0622BeatRaf), window.__at0622Beats)`,
  );

/** One [B09] gesture, read by both instruments and by the beat census. */
interface B09Leg {
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
async function sampleB09Gesture(
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
function arrivedIn(r: B09Leg): readonly string[] {
  const before = new Set(r.before.split(" ").map((s) => s.split("@")[0]));
  return r.after
    .split(" ")
    .map((s) => s.split("@")[0])
    .filter((id) => id !== "" && !before.has(id));
}

function reportB09(leg: string, r: B09Leg): void {
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
function expectBeats(leg: string, r: B09Leg, expected: readonly string[]): void {
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
function expectB09Bar(
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
 * the `depart` beat while the ghost of the departing frame leaves.
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
 * **The DISAPPEAR leg stands red on its lead, and it is not loosened.**
 * Measured across three runs at this tree: 29ms, 33ms and 24ms from the
 * gesture to the first rendered frame, with `commitDelayMs` 0 on all three —
 * so none of it is spent before the canvas arms, and every millisecond of it
 * is the deck's own. Against a 17ms period that is one and a half to two
 * display frames of nothing after the user closes a card. Every other clause
 * passes: `["depart", "room"]` both run, no off-curve tick, no rect moved
 * after landing, worst gap 1.7–1.9 frames. The bar is the same bar the walk
 * and bullseye both clear from the same sampler, so the number is the deck's
 * and not the instrument's.
 */
describe.skipIf(!SHOULD_RUN)(
  "at0622 — a card appears and leaves, at the bar",
  () => {
    test(
      "a card arriving into a split column, and the same card closed out of it, hold the bar across room, arrive and depart",
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
          expect(
            appear.beats,
            `appear: the arrival really ran its choreography — beats seen ` +
              `${JSON.stringify(appear.beats)}. A card that popped into ` +
              `place satisfies every clause of the bar by having no motion`,
          ).toContain("arrive");
          expect(
            appear.beats,
            `appear: and the sitters really made room for it first — beats ` +
              `${JSON.stringify(appear.beats)}`,
          ).toContain("room");

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

          const disappear = await sampleB09Gesture(
            app,
            `window.__tug.closePane(${JSON.stringify(newcomers[0])})`,
          );
          reportB09("disappear", disappear);
          // [B10] of the cleanup: the departure's gap is the one this file
          // reports most reliably, so the census that names it rides the leg
          // rather than a probe somebody has to rebuild.
          note(`at0622 disappear commits: ${JSON.stringify(await reactCommits(app))}`);
          note(`at0622 disappear click task: ${JSON.stringify(await clickTaskMarks(app))}`);
          expect(
            disappear.beats,
            `disappear: the departure really ran its beat — beats seen ` +
              `${JSON.stringify(disappear.beats)}`,
          ).toContain("depart");
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
  "at0622 — the sidebars and the settled-resize retune, at the bar",
  () => {
    test(
      "hiding and showing a two-member rail, and the resize retune, each hold the bar",
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

          const show = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("toggle-sidebars", {})`,
          );
          reportB09("sidebars show", show);
          // [B10] of the cleanup, the show rail's half. Read with the
          // departure's above: the two are the file's standing reds.
          note(`at0622 sidebars show commits: ${JSON.stringify(await reactCommits(app))}`);
          note(`at0622 sidebars show click task: ${JSON.stringify(await clickTaskMarks(app))}`);

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
          // The rails ARRIVE on the way back, so the show leg carries the
          // same exemption the appear leg does and for the same measured
          // reason: each arriving rail frame is held at inline `opacity: 0`
          // across the whole of `room` and paints the identity while its own
          // curve says its origin. Two rails, two exempt panes, and the
          // exemption is earned the same way — the probe names one of them
          // at `minOpacity: 0`, and the other is its sibling in the same
          // arrival. Every frame that was already standing is judged.
          expectB09Bar("sidebars show", show, arrivedIn(show));
          expectB09Bar("resize to fit", retune);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);
