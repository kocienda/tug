/**
 * at0624-reveal-travel-on-curve.test.ts — a file opened outside the band
 * travels on its own curve, every tick of the way.
 *
 * ## The path nothing else walks
 *
 * `at0369` proves an opened file lands in the right slot. `at0622` proves an
 * ACTIVATION's settle shows all of its travel. Between them sits the gesture
 * neither reads: opening a file into a slot the band does not show, where the
 * deck owes the reader TWO beats — the card rising into the slot it landed in,
 * and then the band travelling to bring that slot into view. The second beat
 * is `deck-manager.ts`'s `_revealAfterArrival` → `onceCardDidArrive` →
 * `revealCard`, and it is a commit of its own with a crossing of its own.
 *
 * It is here because it was reported, twice, as a file that "just appears"
 * rather than one the deck walks to. A settle that paints every frame at its
 * destination shows exactly that, and no gap counter can see it: the frames
 * arrive on time, carrying the wrong pose. `settle-frame-probe.ts`'s
 * `offCurveTicks` is the field that can, and this file is the one pin on the
 * reveal path.
 *
 * ## The fixture, and why it is shaped this way
 *
 * A four-up FLOW deck whose four slots are each a column of session cards
 * `SLIM_PX` wide, so the strip is far wider than the band and the far slot is
 * genuinely off screen. `opening-placement` walks `slotCount(kind)` slots and
 * no more, so four is the run a four-up deck HAS; the two middle slots are
 * SPLIT columns, which it passes over while anything else qualifies
 * (`at0369`'s fourth claim), and the reader is homed on the first slot —
 * which is the origin, and is never the answer. That leaves exactly one
 * landing place, slot 3, and it is the one the band does not show. The travel
 * is therefore a property of the fixture rather than of the run, and the test
 * asserts it anyway: a reveal that did not travel proves nothing, so the flow
 * offset is read before and after and a stationary band fails the leg.
 *
 * The file is opened through the real `open-file` control action, the same
 * door `at0369` uses, against a real file on disk — so the whole of
 * `openFileInCard` → `store.addCard` → `_revealAfterArrival` → `revealCard`
 * runs, rather than a store call standing in for it.
 *
 * ## One window, and however many rows it holds
 *
 * The probe is armed before the dispatch and stays armed across BOTH settles.
 * The product's own `settle-frames` record belongs to the release window
 * rather than to a settle — `startSettleFrameRecord` returns early when a pump
 * is already running — so a reveal whose commit lands before the arrival's
 * settle releases shares one row with it, and one that lands after gets a row
 * of its own. Both shapes are correct; the assertion is over the LAST row
 * either way, and the row count is noted so the reading says which shape the
 * run took. A test that asserted two rows would be flaky by construction.
 *
 * ## The forcing leg
 *
 * An idle pin cannot show this class of defect: a deck that is never under
 * load and a deck that holds its poses perfectly report the same zeros. The
 * second leg plants a long task inside the window after the arrival has
 * landed, so the reveal's own settle runs loaded, and asserts the bench probe
 * saw a gap at least as wide as the planted task — which is what says the
 * injector fired rather than that nothing happened.
 *
 * ## What this pin is, and what it is not
 *
 * It was written to find out whether the reveal path shows its travel, and the
 * honest answer is that it already did. Reverting the settle's backwards fill
 * — the one change made for this class of defect — under
 * `tugtool file probe --patch` leaves both legs green at `offCurveTicks: 0`,
 * exactly as it leaves `at0622`'s four-up leg green. So this file is a pin
 * against REGRESSION rather than a proof that the fill repaired this path;
 * the reveal was never measured off its curve, before or after.
 *
 * It stays all the same. It is the user's second report, nothing else walks
 * this gesture, and a bar that can only be argued about after it goes red is
 * worth less than one standing before it does.
 *
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/settle-frame-probe.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import type { SettleFrameReading } from "./_harness/client";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 600_000;

const SPACE_ID = "at0624-one";
const RAIL_WIDTH = 420;
/** `at0622`'s slot width: narrower than the band, so a run of four is wider. */
const SLIM_PX = 675;
/** The settle window, with room for a landing tween. */
const AFTER_LAND_MS = 900;

/**
 * The long task the forcing leg plants, and when it plants it.
 *
 * The delay is measured from the dispatch and sized to clear the ARRIVAL: the
 * reveal is committed by `onceCardDidArrive`, so a task planted before that
 * burns inside the entrance rather than inside the travel this file is about.
 * The nominal settle is 400ms and an arrival runs its room and arrive beats
 * back to back, so the reveal's own window opens somewhere near 640ms and the
 * plant sits just past it.
 */
const FORCED_STALL_MS = 200;
const STALL_PLANTED_AT_MS = 700;

const SHOWN_FRAMES =
  "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]";

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * The four-up run: a stack at each end and a split column between, plus a
 * Layout rail.
 *
 * The shape is the whole forcing device. A split is not a landing place, and
 * the origin's own slot is never the answer, so the one slot an opened file
 * can take is slot 3 — and with four `SLIM_PX` slots the band cannot be
 * showing it while the reader stands on the first.
 */
function revealDeck(): Record<string, unknown> {
  const cards: Record<string, unknown>[] = [];
  const panes: Record<string, unknown>[] = [];
  const columns: Record<number, unknown> = {};

  const add = (n: number, slot: number) => {
    const id = `at0624-c${n}`;
    cards.push({ id, componentId: "session", title: id, closable: true });
    panes.push({
      id: `at0624-p${n}`,
      position: { x: 40, y: 40 },
      size: { width: SLIM_PX, height: 400 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
      slot,
    });
  };

  // slot 0 — the origin, a plain stack.
  add(1, 0);
  // slots 1..2 — split columns, which never qualify as a landing place.
  let n = 2;
  for (const slot of [1, 2]) {
    const a = n;
    const b = n + 1;
    add(a, slot);
    add(b, slot);
    columns[slot] = { mode: "split", order: [`at0624-p${a}`, `at0624-p${b}`] };
    n += 2;
  }
  // slot 3 — the only other stack, and the one the band does not show.
  add(n, 3);

  cards.push({
    id: "at0624-l1",
    componentId: "layout",
    title: "Layout",
    closable: true,
  });
  panes.push({
    id: "at0624-pl1",
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: ["at0624-l1"],
    activeCardId: "at0624-l1",
    title: "Layout",
    acceptsFamilies: [] as string[],
  });

  return {
    cards,
    panes,
    activePaneId: "at0624-p1",
    imposition: {
      kind: "four-up",
      sidebars: { layout: { side: "right" } },
      layout: "flow",
      columns,
    },
    hasFocus: true,
  };
}

/** How many `.tug-pane` frames the fixture stands up, rail included. */
const SEEDED_FRAMES = 6 + 1;

function blob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACE_ID,
    spaces: [{ id: SPACE_ID, name: "One", deck: revealDeck() }],
  };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** The `settle-frames` trace row, in the shape `deck-trace.ts` writes it. */
interface SettleFramesRow {
  readonly kind: string;
  readonly panes: number;
  readonly ticks: number;
  readonly longestGapMs: number;
  readonly longestGapFrames: number;
  readonly firstPaintDelayMs: number;
  readonly pendingTicks: number;
  readonly offCurveTicks: number;
  readonly offCurvePaneIds: readonly string[];
  readonly longestOffCurveRunTicks: number;
  readonly longestOffCurveRunOffsetMs: number;
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

/** The flow offset the strip currently stands at. */
const flowOffset = (app: App): Promise<number> =>
  app.evalJS<number>(
    `(function () {
       try { return window.tugdeck.diag.getDeckState().flowOffset || 0; }
       catch (e) { return 0; }
     })()`,
  );

const textCardIds = (app: App): Promise<string[]> =>
  app.evalJS<string[]>(
    `window.tugdeck.diag.getDeckState().cards
      .filter(function (c) { return c.componentId === "text"; })
      .map(function (c) { return c.id; })`,
  );

/** The stored slot of the pane holding `cardId`; null when it holds none. */
const slotOf = (app: App, cardId: string): Promise<number | null> =>
  app.evalJS<number | null>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
        return p.cardIds.indexOf(${JSON.stringify(cardId)}) !== -1;
      });
      return pane === undefined || pane.slot === undefined ? null : pane.slot;
    })()`,
  );

/**
 * Put the fixture back, and the reader with it.
 *
 * Re-seeded per leg rather than seeded once, because an opened file takes the
 * focus and the ORIGIN of the next open is the first responder — not the
 * deck's `activePaneId`, which a `go-to-slot` does move. A second leg run on
 * the first leg's deck therefore opens from the Text card in slot 3 and ranks
 * slot 0 nearest, which is the origin's own slot in the fixture and not a
 * travel at all. Re-seeding is the one gesture that answers both: the fixture
 * is the fixture again, and the responder is the card the fixture names.
 */
async function seed(app: App): Promise<void> {
  await app.seedDeckState({
    state: revealDeck(),
    focusCardId: "at0624-c1",
  });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= ${SEEDED_FRAMES}`,
    { timeoutMs: 30_000 },
  );
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("go-to-slot", { value: 1 }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

async function launch(): Promise<{ app: App; tugbankPath: string }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.deck.layout",
    "layout",
    "json",
    JSON.stringify(blob()),
  );
  const app = await launchTugApp({
    testName: "at0624-reveal-travel-on-curve",
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
    `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= ${SEEDED_FRAMES}`,
    { timeoutMs: 30_000 },
  );
  await wait(AFTER_LAND_MS);
  return { app, tugbankPath };
}

// ---------------------------------------------------------------------------
// The leg
// ---------------------------------------------------------------------------

interface RevealLeg {
  readonly probe: SettleFrameReading;
  readonly rows: readonly SettleFramesRow[];
  readonly before: number;
  readonly after: number;
  readonly landedSlot: number | null;
  readonly cardId: string;
}

/**
 * One opened file, read by both instruments across both of its beats.
 *
 * The probe covers the whole window — arm, a quiet head the classifier derives
 * the display's period from, the harness round trip, the card's arrival, the
 * reveal's travel, and the landing. The trace rows cover whatever the canvas
 * recorded inside it.
 */
async function sampleReveal(
  app: App,
  file: string,
  stallMs: number,
): Promise<RevealLeg> {
  await seed(app);
  const seen = await textCardIds(app);
  const before = await flowOffset(app);
  const mark = await traceMark(app);
  await app.armSettleFrameProbe();
  // The quiet head: the classifier's whole scale is derived from these ticks.
  await wait(120);
  await app.dispatchControlAction("open-file", { path: file });
  if (stallMs > 0) {
    await wait(STALL_PLANTED_AT_MS);
    await app.forceSettleStall(stallMs);
  }
  await app.waitForCondition<boolean>(
    `window.tugdeck.diag.getDeckState().cards.filter(function (c) {
       return c.componentId === "text";
     }).length === ${seen.length + 1}`,
    { timeoutMs: 20_000 },
  );
  // Both beats, and the landing after the second: the reveal is a commit of
  // its own and does not start until the arrival's settle has ended.
  await wait(2 * AFTER_LAND_MS);
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
  const fresh = (await textCardIds(app)).filter((id) => !seen.includes(id));
  expect(fresh, "the open produced exactly one Text card").toHaveLength(1);
  const cardId = fresh[0] as string;
  return {
    probe,
    rows,
    before,
    after,
    landedSlot: await slotOf(app, cardId),
    cardId,
  };
}

/**
 * The pin, over the last row of whatever the window recorded.
 *
 * Two clauses keep the rest from being vacuous — a suspended window reports
 * the same zeros as a perfect deck, and a band that never moved satisfies
 * every travel claim by standing still — and then the one clause this file
 * exists for.
 */
function expectReveal(leg: string, r: RevealLeg): void {
  const row = r.rows[r.rows.length - 1];

  note(
    `at0624 ${leg}`,
    `rows=${r.rows.length} landedSlot=${r.landedSlot} ` +
      `offset ${r.before} -> ${r.after} | probe ticks=${r.probe.ticks} ` +
      `period=${r.probe.framePeriodMs.toFixed(2)}ms ` +
      `gap=${r.probe.longestGapMs.toFixed(0)}ms/` +
      `${r.probe.longestGapFrames.toFixed(2)}f ` +
      `pending=${r.probe.pendingTicks} ticks=${r.probe.offCurveTicks} ` +
      `run=${r.probe.longestOffCurveRunTicks} ` +
      `offset=${r.probe.longestOffCurveRunOffsetMs}ms`,
  );
  note(
    `at0624 ${leg} last row`,
    row === undefined ? "none" : JSON.stringify(row),
  );

  expect(
    r.probe.suspended,
    `${leg}: the window was served across both beats — ${r.probe.ticks} ` +
      `ticks at ${r.probe.framePeriodMs.toFixed(2)}ms. A covered harness ` +
      `window suspends requestAnimationFrame and reports a perfect deck`,
  ).toBe(false);
  expect(
    r.landedSlot,
    `${leg}: the file landed in the last slot, which is the one the band ` +
      `does not show — every other slot is a split or the origin's own`,
  ).toBe(3);
  expect(
    r.before === r.after,
    `${leg}: the band travelled to bring the opened file into view — ` +
      `${r.before} -> ${r.after}px. A reveal that did not travel proves ` +
      `nothing, so this clause is what keeps the pose clause from being ` +
      `vacuous`,
  ).toBe(false);
  expect(
    r.rows.length,
    `${leg}: the window recorded at least one settle`,
  ).toBeGreaterThan(0);

  // ---- The pose clause. -------------------------------------------------
  const last = row as SettleFramesRow;
  expect(
    last.offCurveTicks,
    `${leg}: no shown frame painted a pose off its own settle's curve at any ` +
      `tick of the reveal — ${last.offCurveTicks} of ${last.ticks} ticks ` +
      `were off, on [${last.offCurvePaneIds.join(", ")}], with the longest ` +
      `unbroken run ${last.longestOffCurveRunTicks} ticks beginning ` +
      `${last.longestOffCurveRunOffsetMs}ms after the first tick a move ` +
      `existed. A file that appears already in view is this reading, and no ` +
      `gap counter can see it`,
  ).toBe(0);
}

describe.skipIf(!SHOULD_RUN)(
  "at0624 — a file opened outside the band travels on its own curve",
  () => {
    test(
      "the reveal after an arrival shows all of its travel, idle and under load",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0624-"));
        const { app, tugbankPath } = await launch();
        try {
          await app.enableDeckTrace(true);

          // ---- The plain leg. -------------------------------------------
          const plainFile = path.join(dir, "plain.txt");
          fs.writeFileSync(plainFile, "the reveal travels\n");
          expectReveal("plain", await sampleReveal(app, plainFile, 0));

          // ---- The forcing leg. -----------------------------------------
          // Without it every green reading above is unfalsifiable: a sampler
          // that stopped observing and a deck that holds its poses report the
          // same zeros.
          const forcedFile = path.join(dir, "forced.txt");
          fs.writeFileSync(forcedFile, "the reveal travels, loaded\n");
          const forced = await sampleReveal(app, forcedFile, FORCED_STALL_MS);
          expectReveal("forced", forced);
          expect(
            forced.probe.longestGapMs,
            `forced: the planted task burned inside the sampled window — a ` +
              `${FORCED_STALL_MS}ms busy loop in one tick necessarily makes a ` +
              `gap at least that wide, so a smaller one means the injector ` +
              `never fired and the leg proved nothing`,
          ).toBeGreaterThanOrEqual(FORCED_STALL_MS);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
