/**
 * at0748-grip-resize-reading.test.ts — what a live grip resize of the largest
 * Session card costs its page, read against the sash sampler's bars.
 *
 * A card's grip press hands the card to the host, which resizes the view
 * under the hand step by step; the card's page reflows at every step, since
 * nothing holds its interior still. The sash sampler (`at0626`) holds a
 * divided column's drag to two bars — no frame overruns 1.5× the display
 * interval, and the render cost's p95 stays under the interval — and this
 * file reads a grip resize against the same two, on the same instruments,
 * taken in the card's own page: a `setTimeout` heartbeat whose gap is how long
 * the thread was away, and the gauge's own `sampleFrame` reading of each
 * frame's rendering cost.
 *
 * The outcomes are decided ahead of the reading ([B12]): under the bars, live
 * reflow stands; over them, the gesture writes the crossing hold for the card
 * in hand. So the two bars are asserted here as they are in `at0626`, and a
 * red is the reading that says the hold is owed.
 *
 * The drag is the east edge of a 1000px Session card holding a real,
 * overflowing transcript, pulled 200px inward over 96 steps posted at the
 * display's own interval: a width change is the reflow that wraps every row.
 *
 * @motion
 * @foreground
 * @covers tugdeck/src/body/body-chrome.ts
 * @covers tugdeck/src/lib/host-card-gesture.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { chromeRect, heldRectOf } from "../card-chrome-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

/** The card in hand: the largest Session card on the deck. */
const CARD = "S1";
const OTHER = "S2";
const PANE_WIDTH = 1000;
/** Turns seeded into each transcript, so the card is a real overflowing transcript. */
const TURNS = 24;
/** How far the east edge travels inward, px. */
const DRAG_PX = 200;
/** Trail steps, one per display interval. */
const DRAG_STEPS = 96;
/** An overrun frame is a heartbeat gap this many display intervals long (`at0626`'s bar). */
const OVERRUN_FACTOR = 1.5;
/** How long after the press the asserted window opens: the gesture's own first commits land here. */
const SETTLE_IN_MS = 60;
const KNOWN_RATES_HZ = [120, 90, 60, 50, 30] as const;

const ROOT = '[data-slot="session-card"]';
const LIST = '[data-slot="tug-list-view"]';

const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
const sid = (card: string): string => `at0748-session-${card}`;

/** Two Session cards in a two-up flow, the card in hand 1000px wide in slot 0. */
function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, width: number) => ({
    id: `p${id}`,
    position: { x: 40, y: 40 },
    size: { width, height: 400 },
    cardIds: [id],
    activeCardId: id,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [CARD, OTHER].map((id) => ({ id, componentId: "session", title: `Session ${id}`, closable: true })),
    panes: [pane(CARD, 0, PANE_WIDTH), pane(OTHER, 1, 600)],
    activePaneId: `p${CARD}`,
    imposition: { kind: "two-up", layout: "flow" },
    hasFocus: true,
  };
}

async function seedTurn(app: App, card: string, n: number): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession(card, { op: "ingestFrame", feedId: FEED_CODE_OUTPUT, decoded: { tug_session_id: sid(card), ...decoded } });
  const msgId = `${sid(card)}-m${n}`;
  await app.driveSession(card, { op: "send", text: `prompt ${n}` });
  await frame({ type: "prompt_anchor", promptUuid: `${sid(card)}-u${n}` });
  await frame({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
  await frame({
    type: "assistant_text",
    seq: 0,
    rev: 0,
    status: "complete",
    msg_id: msgId,
    block_index: 0,
    text:
      `## step ${n}\n\n` +
      `Reply number ${n}, long enough to take several lines in a card of this width, with a second paragraph so the row has real height.\n\n` +
      `- one thing it found\n- another thing it decided\n- a third it left open, stated at length so the list wraps too.\n\n` +
      "```\n$ some command\nsome output, a few lines of it\nand another\n```\n",
    is_partial: false,
  });
  await frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" });
}

async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(`document.querySelector("[data-imposer-settling]") === null`, { timeoutMs: 12_000 });
  await wait(900);
}

/** The display interval, off an idle `requestAnimationFrame` control in the card's page, snapped to a known rate. */
async function displayInterval(app: App, ms: number): Promise<{ measuredMs: number; intervalMs: number; hz: number }> {
  const body = app.body(CARD);
  await body.evalJS<null>(
    `(function () {
      var out = []; var t0 = performance.now(); var last = t0;
      var tick = function () { var now = performance.now(); out.push(now - last); last = now; if (now - t0 < ${ms}) requestAnimationFrame(tick); };
      window.__at0748idle = out; requestAnimationFrame(tick); return null;
    })()`,
  );
  await wait(ms + 400);
  const gaps = await body.evalJS<number[]>(`window.__at0748idle.slice(1)`);
  if (gaps.length < 10) {
    throw new Error(`the idle control saw ${gaps.length} animation frame(s) in ${ms}ms: an occluded window suspends requestAnimationFrame`);
  }
  const measuredMs = median(gaps);
  let hz: number = KNOWN_RATES_HZ[0];
  for (const rate of KNOWN_RATES_HZ) if (Math.abs(1000 / rate - measuredMs) < Math.abs(1000 / hz - measuredMs)) hz = rate;
  return { measuredMs, intervalMs: 1000 / hz, hz };
}

interface Run {
  ticks: { t: number; gap: number }[];
  costs: { t: number; costMs: number }[];
  deliveries: { t: number; box: string }[];
  mutations: number;
}

/** Arm the heartbeat, the cost loop and the interior observers in the card's page. */
async function arm(app: App): Promise<void> {
  await app.body(CARD).evalJS<null>(
    `(function () {
      var state = { armed: true, ticks: [], costs: [], deliveries: [], mutations: 0, costLoopDone: false, labels: new Map() };
      var resize = new ResizeObserver(function (entries) {
        if (!state.armed) return;
        var now = performance.now();
        entries.forEach(function (e) { state.deliveries.push({ t: now, box: state.labels.get(e.target) }); });
      });
      var root = document.querySelector(${JSON.stringify(ROOT)});
      var list = document.querySelector(${JSON.stringify(LIST)});
      if (root) { state.labels.set(root, "root"); resize.observe(root); }
      if (list) {
        state.labels.set(list, "list"); resize.observe(list);
        new MutationObserver(function (records) { if (state.armed) state.mutations += records.length; })
          .observe(list, { attributes: true, childList: true, subtree: true });
      }
      var last = performance.now();
      var beat = function () {
        if (!state.armed) return;
        var now = performance.now();
        state.ticks.push({ t: now, gap: now - last });
        last = now;
        setTimeout(beat, 0);
      };
      var costLoop = function () {
        if (!state.armed) { state.costLoopDone = true; return; }
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            var start = performance.now();
            setTimeout(function () { state.costs.push({ t: performance.now(), costMs: performance.now() - start }); costLoop(); }, 0);
          });
        });
      };
      window.__at0748 = state;
      // The observers' initial deliveries land on the next frame; the record opens after them.
      setTimeout(function () { state.deliveries = []; state.mutations = 0; setTimeout(beat, 0); costLoop(); }, 120);
      return null;
    })()`,
  );
  await wait(200);
}

async function harvest(app: App): Promise<Run> {
  const body = app.body(CARD);
  await body.evalJS<null>(`(window.__at0748.armed = false, null)`);
  await body.waitForCondition<boolean>(`window.__at0748.costLoopDone === true`, { timeoutMs: 10_000 });
  return body.evalJS<Run>(
    `({ ticks: window.__at0748.ticks, costs: window.__at0748.costs, deliveries: window.__at0748.deliveries, mutations: window.__at0748.mutations })`,
  );
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const fmt = (x: number): string => x.toFixed(1);

describe.skipIf(!SHOULD_RUN)("at0748 — a grip resize of the largest Session card, read against the sash sampler's bars", () => {
  test(
    "no frame overruns and the render cost stays under the display interval while the hand resizes the card",
    async () => {
      const app = await launchTugApp({ testName: "at0748-grip-resize-reading" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: CARD });
        for (const card of [CARD, OTHER]) {
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(card)})`,
            { timeoutMs: 30_000 },
          );
        }
        for (const card of [CARD, OTHER]) {
          await app.bindSession(card, { tugSessionId: sid(card) });
          await app.awaitEngineReady(card, { timeoutMs: 30_000 });
        }
        for (const card of [CARD, OTHER]) for (let n = 0; n < TURNS; n += 1) await seedTurn(app, card, n);
        await settled(app);

        const grips = await app.evalJS<string>(
          `(document.querySelector('.tug-pane[data-pane-id="p${CARD}"]')?.getAttribute("data-grips") ?? "")`,
        );
        expect(grips.split(" "), "the card in hand offers its east edge").toContain("e");
        const display = await displayInterval(app, 1_000);
        const { intervalMs } = display;
        const overrunMs = intervalMs * OVERRUN_FACTOR;
        note(
          "at0748 display",
          `idle animation frame median ${fmt(display.measuredMs)}ms, read as ${display.hz}Hz: interval ${fmt(intervalMs)}ms, overrun bar ${fmt(overrunMs)}ms`,
        );

        const handle = await chromeRect(app, CARD, ".tug-pane-resize-e");
        const from = { x: Math.round(handle.x + handle.width / 2), y: Math.round(handle.y + handle.height / 2) };
        const to = { x: from.x - DRAG_PX, y: from.y };
        const before = (await heldRectOf(app, CARD))!;

        await arm(app);
        const stepMs = Math.round(intervalMs);
        const pressAt = await app.body(CARD).evalJS<number>(`performance.now()`);
        await app.nativeDragWithoutRelease(from, to, { interpolationSteps: DRAG_STEPS, interpolationDelayMs: stepMs });
        const held = (await heldRectOf(app, CARD))!;
        const releaseAt = await app.body(CARD).evalJS<number>(`performance.now()`);
        await app.nativeMouseUp(to);
        await wait(1_000);
        const run = await harvest(app);
        await settled(app);
        const after = (await heldRectOf(app, CARD))!;

        const travel = before.width - held.width;
        note(
          "at0748 gesture",
          `trail posted ${DRAG_STEPS} moves ${stepMs}ms apart over ${Math.round(releaseAt - pressAt)}ms; ` +
            `the view went ${fmt(before.width)} → ${fmt(held.width)}px in hand, ${fmt(after.width)}px at rest`,
        );
        expect(travel, "the hand really narrowed the card").toBeGreaterThan(DRAG_PX / 2);

        const opens = pressAt + SETTLE_IN_MS;
        const closes = releaseAt;
        const inHand = <T extends { t: number }>(xs: T[]): T[] => xs.filter((x) => x.t >= opens && x.t <= closes);
        const gaps = inHand(run.ticks).map((t) => t.gap);
        const overruns = gaps.filter((g) => g > overrunMs);
        const costs = inHand(run.costs).map((c) => c.costMs);
        const quiet = run.costs.filter((c) => c.t > closes + 600).map((c) => c.costMs);
        const deliveries = inHand(run.deliveries);
        expect(gaps.length, "the heartbeat recorded ticks while the hand held the grip").toBeGreaterThan(20);
        expect(costs.length, "the gauge took render-cost samples while the hand held the grip").toBeGreaterThan(8);
        note(
          "at0748 heartbeat",
          `in hand ${Math.round(closes - opens)}ms, ${gaps.length} ticks: gap median ${fmt(median(gaps))}ms, ` +
            `p95 ${fmt(percentile(gaps, 0.95))}ms, max ${fmt(Math.max(...gaps))}ms; ` +
            `over the interval (${fmt(intervalMs)}ms): ${gaps.filter((g) => g > intervalMs).length}/${gaps.length}; ` +
            `overruns (>${fmt(overrunMs)}ms): ${overruns.length}`,
        );
        note(
          "at0748 render cost",
          `in hand, ${costs.length} samples: p50 ${fmt(percentile(costs, 0.5))}ms, p95 ${fmt(percentile(costs, 0.95))}ms, ` +
            `max ${fmt(Math.max(...costs))}ms; after the release, ${quiet.length} samples: p50 ${fmt(percentile(quiet, 0.5))}ms, p95 ${fmt(percentile(quiet, 0.95))}ms`,
        );
        note(
          "at0748 interior",
          `root deliveries ${deliveries.filter((d) => d.box === "root").length}, list deliveries ${deliveries.filter((d) => d.box === "list").length}, ` +
            `transcript mutations ${run.mutations} over the gesture: live reflow at every step`,
        );
        const under = overruns.length === 0 && percentile(costs, 0.95) < intervalMs;
        note("at0748 verdict", under ? "under the sash sampler's bars: live reflow stands" : "over the sash sampler's bars: the gesture owes the crossing hold");

        expect(overruns.length, `no animation frame in hand runs longer than ${fmt(overrunMs)}ms (1.5× the ${fmt(intervalMs)}ms display interval)`).toBe(0);
        expect(percentile(costs, 0.95), `the render cost p95 in hand is under the ${fmt(intervalMs)}ms display interval`).toBeLessThan(intervalMs);
      } finally {
        await app.close().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
