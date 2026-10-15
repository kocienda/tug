/**
 * row-15-skew.test.ts — the skew between a carried body and its chrome, as
 * the composite shows it, at an offset of 0 and at the offset that ships.
 *
 * The bar's fifteenth row. A carried body and its chrome start on one
 * number (`shellWallMs(T)` on the shell, the plan's `startWallMs` moved onto
 * the media clock on the host), but each side's paint reaches the screen
 * through its own pipeline: the host's layer change through the render
 * server, the chrome's through the shell page's composite. The host starts
 * its beats `BodyGeometry.beatOffsetPeriods` display periods late to line
 * the two up, and this row is the reading that sets that number.
 *
 * A session body's page is the pane's surface colour, so where the body
 * stands cannot be read by colour; the row paints its own marker — a
 * magenta stripe fixed to the left edge of the body's page, which moves
 * with the body's container — and reads, on every composite frame of a flow
 * slide out and back, the stripe's left edge on a content row and the title
 * bar's left edge on the masthead row. Less the gap the two stand apart at
 * rest, that is the body's lead over its chrome in px; over the chrome's
 * speed at that moment it is the lead in display periods.
 *
 * Three legs, one launch each. Leg A runs the host at an offset of 0
 * (`TUG_BODY_BEAT_OFFSET_PERIODS=0`) and notes the distribution and its
 * median: the median is what `shippedBeatOffsetPeriods` is set to. Leg B
 * launches with no override, so it reads the offset that ships, notes its
 * distribution, and asserts the bar: on every frame judged in motion the
 * body stands within two frames of the slide's travel of its chrome, as
 * row 2's bar. Leg C is leg B with three bodies streaming through the
 * slides — each is sent a prompt whose stub turn runs for minutes — and asserts the
 * same bar. The row asserts what ships, never a value it computed. Each
 * shipped leg also notes whether the program's escalation trigger is met:
 * the two edges more than one display period of travel apart.
 *
 * @foreground
 * @covers tugapp/Sources/BodyBeats.swift
 * @covers tugdeck/src/lib/body-beat-plan.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstFrame, CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, promptPhase, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { fillOnRow, framesDiffer, near, type Rgb } from "./_frames";
import {
  CORNER_INSET_PX,
  MOVED_PX,
  armSampler,
  bodyOf,
  edgeGap,
  expectAtRest,
  frameOf,
  planDiag,
  readSampler,
  rectOf,
  sampleIndexAt,
  samplerState,
  type Rect,
  type Sample,
} from "./_motion";

const TEST_NAME = "body-grounding-row-15-skew";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 480_000;

const BURST_MS = 2_000;
/** The burst's own floor: one capture per display period at 60 Hz. */
const BURST_INTERVAL_MS = 16;
const SETTLE_MS = 6_000;
/** The title bar's row, from the frame's top, in px. */
const MASTHEAD_ROW_PX = 14;
/** The stripe's row, from the content box's top, in px. */
const STRIPE_ROW_PX = 40;
const STRIPE_WIDTH_PX = 6;
const MAGENTA: Rgb = { r: 255, g: 0, b: 255 };
/** Below this speed, px per period, a lead in periods is noise over a near-zero divisor. */
const MIN_STEP_PX = 2;

/** A turn long enough to stream through every slide a leg reads. */
const STREAM_MESSAGES = 40;

/** Six session cards in a four-up flow, body cards in slots 1, 2 and 3. */
function flowDeck(bodies: readonly string[]): Record<string, unknown> {
  const ids = ["r15-n0", bodies[0], bodies[1], bodies[2], "r15-n4", "r15-n5"];
  return {
    cards: ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: ids.map((id, slot) => sessionPane(id, slot)),
    activePaneId: `${bodies[0]}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/** The stripe in `cardId`'s own page: fixed to its left edge, so it moves with the container. */
async function paintStripe(app: App, cardId: string): Promise<void> {
  await app.body(cardId).evalJS<null>(
    `(function () {
      var el = document.createElement("div");
      el.setAttribute("data-skew-stripe", "");
      el.style.cssText = "position: fixed; left: 0; top: 0; bottom: 0; width: ${STRIPE_WIDTH_PX}px; background: #ff00ff; z-index: 2147483647; pointer-events: none";
      document.body.appendChild(el);
      return null;
    })()`,
  );
}

/** Every x (device px) on row `y` where a run of at least `minRun` pixels near `colour` begins. */
function runStartsOnRow(frame: CaptureBurstFrame, y: number, colour: Rgb, tolerance: number, minRun: number): number[] {
  const png = decodePngFile(frame.path);
  const row = Math.min(png.height - 1, Math.max(0, Math.round(y)));
  const starts: number[] = [];
  let run = 0;
  for (let x = 0; x < png.width; x++) {
    const i = (row * png.width + x) * 4;
    if (near({ r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] }, colour, tolerance)) {
      run += 1;
      if (run === minRun) starts.push(x - run + 1);
    } else {
      run = 0;
    }
  }
  return starts;
}

const nearest = (xs: readonly number[], to: number): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => (Math.abs(b - to) < Math.abs(a - to) ? b : a));

/** The placeholder's horizontal speed at `i`, px per ms, over the samples either side. */
function speedAt(samples: readonly Sample[], i: number): number {
  const a = samples[Math.max(0, i - 1)];
  const b = samples[Math.min(samples.length - 1, i + 1)];
  if (a.placeholder === null || b.placeholder === null || b.wall === a.wall) return 0;
  return (b.placeholder.x - a.placeholder.x) / (b.wall - a.wall);
}

interface SkewReading {
  /** The body's lead over its chrome on each frame judged in motion, px (positive: ahead). */
  leadPx: number[];
  /** The same over the chrome's travel per display period, where it moved enough to divide by. */
  leadPeriods: number[];
  /** The worst |lead| over the chrome's travel per period on the same frame, every frame read. */
  worstPeriodsOfTravel: number;
  motion: number;
  fastestStep: number;
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const describe1 = (xs: readonly number[], unit: string): string => {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): string => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  return `n ${s.length}, min ${s[0].toFixed(2)}, p25 ${q(0.25)}, median ${median(s).toFixed(2)}, p75 ${q(0.75)}, max ${s[s.length - 1].toFixed(2)} ${unit}`;
};

/** One slide: arm the sampler and the burst, run it, and read the lead off every frame judged in motion. */
async function readSlide(app: App, card: string, label: string, js: string, crop: Rect, periodMs: number): Promise<SkewReading> {
  const before = await expectAtRest(app, card, `${label}: before`);
  const frameBefore = (await rectOf(app, frameOf(card)))!;
  const runsBefore = (await planDiag(app)).runs;
  await armSampler(app, card);
  await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
  const gestureWall = Date.now();
  await app.evalJS<null>(`(${js}, null)`);
  await pollFor(() => samplerState(app), (s) => s.saw && !s.now, SETTLE_MS);
  const plan = await pollFor(() => planDiag(app), (p) => p.runs > runsBefore && (p.last?.landed.some((l) => l.cardId === card) ?? false), 3_000);
  expect(plan.last?.planned.includes(card), `${label}: ${card} is carried by the host`).toBe(true);
  expect(plan.last?.cancelled ?? [], `${label}: no carried body was cancelled`).toEqual([]);
  const samples = await readSampler(app);
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
  expect(reading.done, `${label}: the burst finished`).toBe(true);
  const after = await expectAtRest(app, card, `${label}: after`);
  expect(edgeGap(before, after), `${label}: the slide moved the card`).toBeGreaterThan(20);

  const scale = reading.scale;
  const dir = Math.sign(after.x - before.x);
  const mastheadRow = (frame: Rect): number => (frame.y + MASTHEAD_ROW_PX - crop.y) * scale;
  const stripeRow = (ph: Rect): number => (ph.y + STRIPE_ROW_PX - crop.y) * scale;
  const standing = reading.frames.filter((f) => f.wall < gestureWall).pop() ?? reading.frames[0];
  // The chrome's colour: the title bar's own fill on its row, at rest, clear of its corners.
  const chrome = fillOnRow(
    standing,
    mastheadRow(frameBefore),
    (frameBefore.x - crop.x + CORNER_INSET_PX) * scale,
    (frameBefore.x + frameBefore.width - crop.x - CORNER_INSET_PX) * scale,
  );
  const stripeRun = Math.max(3, Math.floor(STRIPE_WIDTH_PX * scale * 0.6));
  const stripeOn = (f: CaptureBurstFrame, ph: Rect): number | null =>
    nearest(runStartsOnRow(f, stripeRow(ph), MAGENTA, 60, stripeRun), (ph.x - crop.x) * scale);
  const chromeOn = (f: CaptureBurstFrame, frame: Rect, stripe: number, rest: number): number | null =>
    nearest(runStartsOnRow(f, mastheadRow(frame), chrome, 8, 16), stripe - rest);
  // How far apart the two stand at rest, device px: what every reading is taken against.
  const ph0 = before;
  const stripe0 = stripeOn(standing, ph0);
  const chrome0 = stripe0 === null ? null : chromeOn(standing, frameBefore, stripe0, (ph0.x - frameBefore.x) * scale);
  note(`${label}: chrome ${JSON.stringify(chrome)}; at rest the stripe stands at ${stripe0} and the title bar at ${chrome0} device px (scale ${scale})`);
  expect(stripe0, `${label}: the stripe reads at rest`).not.toBeNull();
  expect(chrome0, `${label}: the title bar reads at rest`).not.toBeNull();
  const rest = stripe0! - chrome0!;

  const moved = (k: number): boolean => {
    const p = k >= 0 ? samples[k].placeholder : null;
    return p !== null && edgeGap(p, before) > MOVED_PX && edgeGap(p, after) > MOVED_PX;
  };
  let fastestStep = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].placeholder;
    const b = samples[i].placeholder;
    if (a !== null && b !== null) fastestStep = Math.max(fastestStep, edgeGap(a, b));
  }
  const leadPx: number[] = [];
  const leadPeriods: number[] = [];
  const rows: string[] = [];
  let motion = 0;
  let noStripe = 0;
  let noBar = 0;
  let worstPeriodsOfTravel = 0;
  for (const f of reading.frames) {
    if (f.wall < gestureWall) continue;
    const i = sampleIndexAt(samples, f.wall);
    if (i < 0 || samples[i].placeholder === null) continue;
    if (!(moved(i) && moved(i - 1) && framesDiffer(f, standing))) continue;
    motion += 1;
    const s = samples[i];
    const stripe = stripeOn(f, s.placeholder!);
    if (stripe === null) {
      noStripe += 1;
      rows.push(`${Math.round(f.t)}ms no stripe on its row`);
      continue;
    }
    const bar = chromeOn(f, s.frame, stripe, rest);
    if (bar === null) {
      noBar += 1;
      rows.push(`${Math.round(f.t)}ms no title bar on its row`);
      continue;
    }
    const lead = (((stripe - bar) - rest) / scale) * dir;
    leadPx.push(lead);
    const step = Math.abs(speedAt(samples, i)) * periodMs;
    const periods = step >= MIN_STEP_PX ? lead / step : null;
    if (periods !== null) leadPeriods.push(periods);
    worstPeriodsOfTravel = Math.max(worstPeriodsOfTravel, Math.abs(lead) / Math.max(step, MIN_STEP_PX));
    rows.push(`${Math.round(f.t)}ms lead ${lead.toFixed(1)} px, step ${step.toFixed(1)} px/period${periods === null ? "" : `, ${periods.toFixed(2)} periods`}`);
  }
  note(
    `${label}: ${reading.frames.length} frames, ${motion} judged in motion, ${leadPx.length} read (${noStripe} with no stripe, ${noBar} with no title bar); ` +
      `fastest shell step ${fastestStep.toFixed(1)} px\n${rows.join("\n")}`,
  );
  expect(motion, `${label}: frames were captured while the chrome moved`).toBeGreaterThan(3);
  expect(leadPx.length, `${label}: the lead was read on frames in motion`).toBeGreaterThan(3);
  return { leadPx, leadPeriods, worstPeriodsOfTravel, motion, fastestStep };
}

/**
 * One launch: the slide out and back, read at whatever offset the host
 * runs. With `streaming`, all three bodies are mid-turn through both slides.
 */
async function runLeg(leg: string, env: Record<string, string>, streaming = false): Promise<{ readings: SkewReading[]; offset: number; periodMs: number }> {
  const stubDir = stubDirectory();
  const bodies = ["r15-a", "r15-b", "r15-c"];
  const card = bodies[0];
  const app = await launchTugApp({
    testName: `${TEST_NAME}-${leg}`,
    foreground: true,
    env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir, ...env },
  });
  try {
    await app.seedDeckState({ state: flowDeck(bodies), focusCardId: card });
    for (const id of bodies) await spawnStub(app, id, stubDir, streaming ? STREAM_MESSAGES : 2);
    for (const id of bodies) await waitForBody(app, id);
    if (streaming) {
      // The stub plays a turn per prompt it is sent; each one streams for minutes.
      for (const id of bodies) await app.body(id).driveSession({ op: "send", text: "Walk the module and report each pass." });
      for (const id of bodies) await app.body(id).waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 30_000 });
      note(`${leg}: ${bodies.join(", ")} are streaming`);
    }
    await focusBody(app, card, { composer: false });
    await paintStripe(app, card);
    await Bun.sleep(400);
    const host = (await bodyOf(app, card)) as (Awaited<ReturnType<typeof bodyOf>> & { beatOffsetPeriods?: number; displayPeriodMs?: number }) | null;
    const offset = host?.beatOffsetPeriods ?? NaN;
    const periodMs = host?.displayPeriodMs ?? NaN;
    note(`${leg}: the host runs beats ${offset} periods late; its screen's period is ${periodMs.toFixed(3)} ms (${(1000 / periodMs).toFixed(0)} Hz)`);
    expect(Number.isFinite(offset), `${leg}: the host reports its offset`).toBe(true);
    expect(Number.isFinite(periodMs), `${leg}: the host reports its display period`).toBe(true);
    const start = await expectAtRest(app, card, `${leg}: at the start`);
    const frame = (await rectOf(app, frameOf(card)))!;
    const content = await app.evalJS<number>(`window.innerWidth`);
    const crop = { x: 0, y: Math.floor(frame.y), width: Math.floor(content), height: Math.ceil(start.y - frame.y + STRIPE_ROW_PX + 24) };
    const out = await readSlide(app, card, `${leg} go to slot 2`, `window.__tug.dispatchControlAction("go-to-slot", { value: 2 })`, crop, periodMs);
    await focusBody(app, card, { composer: false });
    await Bun.sleep(300);
    const back = await readSlide(app, card, `${leg} go to slot 1`, `window.__tug.dispatchControlAction("go-to-slot", { value: 1 })`, crop, periodMs);
    if (streaming) {
      for (const id of bodies) {
        const phase = await app.body(id).evalJS<string>(promptPhase);
        note(`${leg}: ${id} is ${phase} after the slides`);
        expect(phase, `${leg}: ${id} streamed through both slides`).toBe("streaming");
      }
    }
    return { readings: [out, back], offset, periodMs };
  } finally {
    await app.close();
  }
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 15: the carried body's skew against its chrome", () => {
  test(
    "the skew at an offset of 0, and within two frames of travel at the offset that ships, at rest and streaming",
    async () => {
      const a = await runLeg("leg A (offset 0)", { TUG_BODY_BEAT_OFFSET_PERIODS: "0" });
      const aPeriods = a.readings.flatMap((r) => r.leadPeriods);
      const aPx = a.readings.flatMap((r) => r.leadPx);
      note(`leg A at ${a.offset} periods, ${a.periodMs.toFixed(3)} ms period: lead in periods ${describe1(aPeriods, "periods")}; in px ${describe1(aPx, "px")}`);
      note(`leg A's median lead, the offset to ship: ${median(aPeriods).toFixed(2)} periods`);
      expect(a.offset, "leg A runs at an offset of 0").toBe(0);

      for (const [name, streaming] of [["leg B (shipped)", false], ["leg C (shipped, three streams)", true]] as const) {
        const b = await runLeg(name, {}, streaming);
        const bPeriods = b.readings.flatMap((r) => r.leadPeriods);
        note(`${name} at ${b.offset} periods, ${b.periodMs.toFixed(3)} ms period: lead in periods ${describe1(bPeriods, "periods")}; in px ${describe1(b.readings.flatMap((r) => r.leadPx), "px")}`);
        const worstTravel = Math.max(...b.readings.map((r) => r.worstPeriodsOfTravel));
        note(`${name}: the edges stand at most ${worstTravel.toFixed(2)} periods of travel apart; the escalation trigger (over one) is ${worstTravel > 1 ? "MET" : "not met"}`);
        for (const [i, r] of b.readings.entries()) {
          const worst = r.leadPx.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
          const bar = 2 * r.fastestStep + 2;
          note(`${name} slide ${i + 1}: worst |lead| ${Math.abs(worst).toFixed(1)} px against a bar of ${bar.toFixed(1)} px (two frames of the slide's fastest step ${r.fastestStep.toFixed(1)} px, plus 2)`);
          expect(Math.abs(worst), `${name} slide ${i + 1}: the body stands within two frames of travel of its chrome on every frame in motion`).toBeLessThanOrEqual(bar);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
