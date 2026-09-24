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
 * @covers tugdeck/src/lib/settle-frame-probe.ts
 * @covers tugdeck/scripts/audit-settle-motion.ts
 * @covers tuglaws/animation-doctrine.md
 * @covers tugdeck/src/lib/pane-recede.ts
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
): Promise<BarLeg> {
  await home(app);
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
  expect(
    row.longestGapFrames,
    `${leg}: no gap longer than ${GAP_FRAMES_BAR} display frames across the ` +
      `move beat — ${row.longestGapMs.toFixed(0)}ms / ` +
      `${row.longestGapFrames.toFixed(2)} frames over ${row.ticks} ticks on ` +
      `${row.panes} panes, with ${row.gapsOverOneFrame} gap(s) over one frame`,
  ).toBeLessThanOrEqual(GAP_FRAMES_BAR);
  expect(
    row.firstPaintDelayMs,
    `${leg}: the move's first painted frame lands within one display frame ` +
      `of its start — ${row.firstPaintDelayMs}ms against a derived period of ` +
      `${probe.framePeriodMs.toFixed(2)}ms. A late START and a late PAINT ` +
      `look identical from outside; this is the field that separates them`,
  ).toBeLessThanOrEqual(probe.framePeriodMs);

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
        await four.app.enableDeckTrace(true);
        const idle = await sampleIdle(four.app);
        report("four-up idle control", idle);
        expect(
          idle.suspended,
          `four-up idle control: the window was served — ${idle.ticks} ticks`,
        ).toBe(false);

        const plain = await sampleBarActivation(four.app, 4, 0);
        report("four-up plain probe", plain.probe);
        note(`at0622 four-up plain row: ${JSON.stringify(plain.row)}`);
        expectBar("four-up", plain);
        fourFrames = plain.row.longestGapFrames;
        fourGapMs = plain.row.longestGapMs;

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
            `plain leg's bench-probe worst was ` +
            `${plain.probe.longestGapMs.toFixed(0)}ms, so a claim the plain ` +
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
            `formality. Plain read ${fourGapMs.toFixed(0)}ms / ` +
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
        await eight.app.enableDeckTrace(true);
        const idle = await sampleIdle(eight.app);
        report("eight-up idle control", idle);
        expect(
          idle.suspended,
          `eight-up idle control: the window was served — ${idle.ticks} ticks`,
        ).toBe(false);

        const plain = await sampleBarActivation(eight.app, 8, 0);
        report("eight-up plain probe", plain.probe);
        note(`at0622 eight-up plain row: ${JSON.stringify(plain.row)}`);
        expectBar("eight-up", plain);

        // ---- The scaling clause. --------------------------------------
        // This is the claim the arc's purpose actually makes, and the one a
        // change that merely fits on today's four-up deck could not satisfy.
        // The baseline's whole signature of the defect was that the cost grew
        // with the card count: +51ms at four, +71ms at eight.
        expect(
          Math.abs(plain.row.longestGapFrames - fourFrames),
          `the worst gap does not grow with the card count — four-up read ` +
            `${fourGapMs.toFixed(0)}ms / ${fourFrames.toFixed(2)} frames, ` +
            `eight-up reads ${plain.row.longestGapMs.toFixed(0)}ms / ` +
            `${plain.row.longestGapFrames.toFixed(2)} frames on ` +
            `${plain.row.panes} panes. Within one display frame is the bar; ` +
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
// The recede ([B04], [P05])
// ---------------------------------------------------------------------------

/**
 * The settle's own length (`IMPOSER_SETTLE_MS`), so the mid-fade census can be
 * taken just after the landing rather than at a guess.
 */
const SETTLE_MS = 400;

/**
 * What the recede looks like from outside, in one round trip.
 *
 * Every field here answers one clause of `[P05]`: `layerless` counts frames
 * MISSING a wash pseudo (the existence claim), `reading`/`receded` are the two
 * opacity values the mark selects between, `retained` is the `getAnimations()`
 * census `[D6]` turns on, and `armed` says whether the fade's window is still
 * standing.
 *
 * `retained` counts only opacity transitions on a PSEUDO-element under a pane
 * frame, which is exactly the three recede layers and nothing a card happens
 * to be running on its own boxes.
 */
interface RecedeCensus {
  readonly frames: number;
  readonly reading: number;
  readonly layerless: number;
  readonly armed: boolean;
  readonly retained: number;
  readonly readingWash: number;
  readonly recededWash: number;
}

const recedeCensus = (app: App): Promise<RecedeCensus> =>
  app.evalJS<RecedeCensus>(
    `(function () {
       var frames = Array.prototype.slice.call(
         document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}));
       var washOf = function (frame) {
         var chrome = frame.querySelector(".tug-pane-chrome");
         if (chrome === null) return -1;
         return Number.parseFloat(
           getComputedStyle(chrome, "::after").opacity || "0");
       };
       var reading = frames.filter(function (f) {
         return !f.hasAttribute("data-receded");
       });
       var receded = frames.filter(function (f) {
         return f.hasAttribute("data-receded");
       });
       var layerless = frames.filter(function (f) {
         var chrome = f.querySelector(".tug-pane-chrome");
         return chrome === null ||
           getComputedStyle(chrome, "::after").content === "none";
       });
       var retained = frames.reduce(function (n, f) {
         return n + f.getAnimations({ subtree: true }).filter(function (a) {
           return a.transitionProperty === "opacity" &&
             a.effect !== null &&
             typeof a.effect.pseudoElement === "string" &&
             a.effect.pseudoElement !== null;
         }).length;
       }, 0);
       return {
         frames: frames.length,
         reading: reading.length,
         layerless: layerless.length,
         armed: document.querySelector("[data-recede-armed]") !== null,
         retained: retained,
         readingWash: reading.length > 0 ? washOf(reading[0]) : -1,
         recededWash: receded.length > 0 ? washOf(receded[0]) : -1,
       };
     })()`,
  );

describe.skipIf(!SHOULD_RUN)(
  "at0622 — the recede exists at rest, fades after the landing, and is dropped",
  () => {
    test(
      "eight session cards: the layers stand on every frame and no transition survives the fade",
      async () => {
        const { app, tugbankPath } = await launch(8);
        try {
          await home(app);
          await wait(AFTER_LAND_MS);

          // ---- At rest. ------------------------------------------------
          const rest = await recedeCensus(app);
          note(`at0622 recede at rest: ${JSON.stringify(rest)}`);
          expect(
            rest.layerless,
            `the wash exists on EVERY frame, focused and receded alike — that ` +
              `is the whole of [B04]'s "no layer is created by the gesture", ` +
              `and ${rest.layerless} of ${rest.frames} frames carry no wash ` +
              `pseudo at all`,
          ).toBe(0);
          expect(
            rest.readingWash,
            `the frame the reader is in carries the wash at zero rather than ` +
              `not carrying it`,
          ).toBe(0);
          expect(
            rest.recededWash,
            `and a receded frame carries it at a real value — ` +
              `${rest.recededWash}`,
          ).toBeGreaterThan(0);
          expect(
            rest.retained,
            `[D6]: a settled deck retains no finished recede transition. ` +
              `These layers are on every frame now, so a standing transition ` +
              `would be three retained effects per pane, growing with card ` +
              `count. Retained: ${rest.retained} across ${rest.frames} frames`,
          ).toBe(0);
          expect(
            rest.armed,
            `and the fade's window is not standing open at rest`,
          ).toBe(false);

          // ---- The falsifying leg ([D5]). ------------------------------
          // A census of zero over a recede that never runs proves nothing.
          // Catch the deck mid-fade and show the same census counting.
          await activateLast(app, 8);
          await wait(SETTLE_MS + 60);
          const during = await recedeCensus(app);
          note(`at0622 recede mid-fade: ${JSON.stringify(during)}`);
          expect(
            during.armed || during.retained > 0,
            `the census can count: caught just after the landing the fade is ` +
              `either armed or has effects to find — armed=${during.armed}, ` +
              `retained=${during.retained}. A zero at rest is only evidence ` +
              `if a non-zero was reachable`,
          ).toBe(true);

          // ---- And back to rest, with the reader in the new frame. -----
          await wait(AFTER_LAND_MS);
          const after = await recedeCensus(app);
          note(`at0622 recede after the landing: ${JSON.stringify(after)}`);
          expect(
            after.reading,
            `exactly one frame is the one the reader is in`,
          ).toBe(1);
          expect(
            after.retained,
            `and the fade dropped itself — retained ${after.retained}`,
          ).toBe(0);
          expect(
            after.armed,
            `and took its window with it`,
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
// The flash ([B05], [P06])
// ---------------------------------------------------------------------------

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
  readonly firstPaintDelayMs: number;
  readonly violations: readonly string[];
}

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

const motionViolationRows = (
  app: App,
  mark: number,
): Promise<readonly string[]> =>
  app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) {
       return e.kind === "settle-motion-violation";
     }).map(function (e) { return e.paneId + ":" + e.property; })`,
  );

describe.skipIf(!SHOULD_RUN)(
  "at0622 — the settle records its own frames, and its own violations",
  () => {
    test(
      "four session cards: one row per settle, agreeing with the probe, and none at rest",
      async () => {
        const { app, tugbankPath } = await launch(4);
        try {
          await app.enableDeckTrace(true);
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
          expect(
            row.firstPaintDelayMs,
            `one classifier over one gesture, so the field this arc moves has ` +
              `to agree: row ${row.firstPaintDelayMs}ms vs probe ` +
              `${probe.firstPaintDelayMs}ms`,
          ).toBe(probe.firstPaintDelayMs);

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
          await app.enableDeckTrace(true);
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
